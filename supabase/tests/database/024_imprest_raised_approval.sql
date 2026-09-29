-- Issue #70 · Imprest: raise a disbursement's approval before paying more
--
-- The claims under test, each traceable to issue #70's acceptance criteria:
--
--   1   Only the proposing Cashier asks, only while the disbursement is handed out or sent back,
--       for a whole-shilling increase above zero with a reason of 3 to 500 characters. One open
--       request at a time.
--   2   Only a live Manager raises or refuses. Raising sets the increase aside and is refused when
--       Free to approve is less than the increase. Version-checked and idempotent.
--   3   The original approval and every raise stay visible with who, when and why. The approved
--       amount is their sum, calculated.
--   4   The Cashier records handing out the extra. Until then it is set aside, not awaiting
--       verification.
--   5   Settlement and every later cycle use the raised approved amount; verification posts against
--       it and releases only what came back.
--   6   A sent-back disbursement can get a raise and be settled again in the next cycle.
--   7   A Director reads; another Cashier and a Sales Representative read nothing.
--   8   Every success and committed refusal is on the audit trail.

create extension if not exists pgtap with schema extensions;

begin;
select * from no_plan();

create schema if not exists tests;
grant usage on schema tests to public;

create or replace function tests.mk_user(p_id uuid) returns void language plpgsql as $$
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          created_at, updated_at)
  values (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          p_id::text || '@test.local', extensions.crypt('x', extensions.gen_salt('bf')),
          now(), now());
end $$;

create or replace function tests.acting_as(p_id uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_id::text, 'role', 'authenticated')::text, true);
$$;

select tests.mk_user('e7000000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('e7000000-0000-0000-0000-000000000003'::uuid);  -- Manager
select tests.mk_user('e7000000-0000-0000-0000-000000000004'::uuid);  -- Cashier A
select tests.mk_user('e7000000-0000-0000-0000-000000000005'::uuid);  -- Sales Representative
select tests.mk_user('e7000000-0000-0000-0000-000000000006'::uuid);  -- Disabled Manager
select tests.mk_user('e7000000-0000-0000-0000-000000000007'::uuid);  -- Cashier B

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('e7000000-0000-0000-0000-000000000001', 'Raise Director',  '+255700007001', true,  false),
  ('e7000000-0000-0000-0000-000000000003', 'Raise Manager',   '+255700007003', true,  false),
  ('e7000000-0000-0000-0000-000000000004', 'Raise Cashier A', '+255700007004', true,  false),
  ('e7000000-0000-0000-0000-000000000005', 'Raise Rep',       '+255700007005', true,  false),
  ('e7000000-0000-0000-0000-000000000006', 'Gone Manager',    '+255700007006', false, false),
  ('e7000000-0000-0000-0000-000000000007', 'Raise Cashier B', '+255700007007', true,  false);

insert into public.user_roles (user_id, role) values
  ('e7000000-0000-0000-0000-000000000001', 'director'),
  ('e7000000-0000-0000-0000-000000000003', 'manager'),
  ('e7000000-0000-0000-0000-000000000004', 'cashier'),
  ('e7000000-0000-0000-0000-000000000005', 'sales_rep'),
  ('e7000000-0000-0000-0000-000000000006', 'manager'),
  ('e7000000-0000-0000-0000-000000000007', 'cashier');

create or replace function tests.director() returns void language sql as $$
  select tests.acting_as('e7000000-0000-0000-0000-000000000001'::uuid); $$;
create or replace function tests.manager() returns void language sql as $$
  select tests.acting_as('e7000000-0000-0000-0000-000000000003'::uuid); $$;
create or replace function tests.cashier() returns void language sql as $$
  select tests.acting_as('e7000000-0000-0000-0000-000000000004'::uuid); $$;
create or replace function tests.rep() returns void language sql as $$
  select tests.acting_as('e7000000-0000-0000-0000-000000000005'::uuid); $$;
create or replace function tests.cashier_b() returns void language sql as $$
  select tests.acting_as('e7000000-0000-0000-0000-000000000007'::uuid); $$;

create temp table r (name text primary key, res jsonb not null);
grant all on r to public;
create or replace function tests.keep(p_name text, p_res jsonb) returns text language sql as $$
  insert into r values (p_name, p_res) returning res ->> 'reason';
$$;
create or replace function tests.did(p_name text) returns uuid language sql as $$
  select (res -> 'disbursement' ->> 'id')::uuid from r where name = p_name; $$;
create or replace function tests.rzid(p_name text) returns uuid language sql as $$
  select (res -> 'raise' ->> 'id')::uuid from r where name = p_name; $$;
create or replace function tests.ver(p_id uuid) returns integer language sql
  security definer as $$ select version from public.imprest_disbursements where id = p_id; $$;
create or replace function tests.status(p_id uuid) returns text language sql
  security definer as $$ select status::text from public.imprest_disbursements where id = p_id; $$;
create or replace function tests.sid(p_id uuid, p_cycle integer default null) returns uuid
language sql security definer as $$
  select id from public.imprest_settlements
   where disbursement_id = p_id and (p_cycle is null or cycle = p_cycle)
   order by cycle desc limit 1; $$;
-- posted funding / posted balance / set aside / free to approve / awaiting verification
create or replace function tests.figures() returns text language sql security definer as $$
  select s.posted_funding_tzs || '/' || s.posted_balance_tzs || '/' || s.set_aside_tzs || '/'
         || s.free_to_approve_tzs || '/' || private.imprest_awaiting_verification_tzs(f.id)
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active; $$;
create or replace function tests.line(p_amount bigint, p_purpose text, p_receipt uuid,
                                      p_reason text default null, p_note text default null)
returns jsonb language sql as $$
  select jsonb_build_object('amount_tzs', p_amount, 'purpose', p_purpose, 'receipt_id', p_receipt,
                            'no_receipt_reason', p_reason, 'no_receipt_note', p_note); $$;
create or replace function tests.ask(p_id uuid, p_version integer, p_amount bigint, p_reason text,
                                     p_key text) returns text language sql as $$
  select api.staff_request_imprest_raise(p_id, p_version, p_amount, p_reason, p_key) ->> 'reason'; $$;
create or replace function tests.decide(p_id uuid, p_version integer, p_raise uuid, p_raised boolean,
                                        p_reason text, p_key text) returns text language sql as $$
  select api.staff_decide_imprest_raise(p_id, p_version, p_raise, p_raised, p_reason, p_key)
           ->> 'reason'; $$;
create or replace function tests.give(p_id uuid, p_version integer, p_raise uuid, p_recipient text,
                                      p_key text) returns text language sql as $$
  select api.staff_hand_out_imprest_raise(p_id, p_version, p_raise, p_recipient, p_key) ->> 'reason'; $$;
create or replace function tests.decide_context(p_id uuid, p_version integer, p_raise uuid,
                                                p_key text) returns text language sql as $$
  select (v ->> 'free_to_approve_tzs') || '/' || (v ->> 'amount_tzs')
    from api.staff_decide_imprest_raise(p_id, p_version, p_raise, true, null, p_key) v; $$;
create or replace function tests.approved(p_id uuid) returns bigint language sql
  security definer as $$ select private.imprest_approved_tzs(p_id); $$;

-- ---------------------------------------------------------------------------
-- The shape: one table no client writes, three commands, a calculated approved amount
-- ---------------------------------------------------------------------------
select ok(
  not has_table_privilege('authenticated', 'public.imprest_approval_raises', 'insert')
  and not has_table_privilege('authenticated', 'public.imprest_approval_raises', 'update')
  and not has_table_privilege('authenticated', 'public.imprest_approval_raises', 'delete')
  and has_table_privilege('authenticated', 'public.imprest_approval_raises', 'select')
  and not has_table_privilege('service_role', 'public.imprest_approval_raises', 'select')
  and not has_table_privilege('service_role', 'public.imprest_approval_raises', 'insert')
  and not has_table_privilege('anon', 'public.imprest_approval_raises', 'select')
  and not has_table_privilege('fv_definer_owner', 'public.imprest_approval_raises', 'delete'),
  'no role writes a raise except through the commands; anon and the service role read none');

select ok((select relrowsecurity from pg_class where oid = 'public.imprest_approval_raises'::regclass),
          'the raises table has row-level security');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     join pg_roles o on o.oid = p.proowner
    where n.nspname = 'api'
      and p.proname in ('staff_request_imprest_raise', 'staff_decide_imprest_raise',
                        'staff_hand_out_imprest_raise')
      and p.prosecdef and o.rolname = 'fv_definer_owner'
      and has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('service_role', p.oid, 'execute')),
  3,
  'the three commands are security definer, owned by fv_definer_owner, callable by staff sessions only');

select ok(
  not exists (select 1 from information_schema.parameters
               where specific_schema = 'api'
                 and specific_name like 'staff_decide_imprest_raise%'
                 and (parameter_name like '%amount%' or parameter_name like '%tzs%')),
  'the Manager raises or refuses the request as asked: deciding takes no amount');

-- ---------------------------------------------------------------------------
-- TZS 200,000 posted, built directly as its owner would
-- ---------------------------------------------------------------------------
set local role fv_definer_owner;
insert into public.imprest_funds (id, opened_by) values
  ('e7000000-0000-0000-0000-00000000f001', 'e7000000-0000-0000-0000-000000000003');
insert into public.imprest_fundings (id, funding_no, fund_id, requested_amount_tzs, reason,
                                     requested_by)
values ('e7000000-0000-0000-0000-00000000f101', 'FV-IMP-TEST-7001',
        'e7000000-0000-0000-0000-00000000f001', 200000, 'Opening float',
        'e7000000-0000-0000-0000-000000000003');
insert into public.imprest_funding_handovers (id, funding_id, cycle, amount_tzs, provided_by)
values ('e7000000-0000-0000-0000-00000000f201', 'e7000000-0000-0000-0000-00000000f101', 1, 200000,
        'e7000000-0000-0000-0000-000000000001');
update public.imprest_fundings
   set status = 'received', version = version + 1,
       received_handover_id = 'e7000000-0000-0000-0000-00000000f201',
       received_amount_tzs = 200000, received_by = 'e7000000-0000-0000-0000-000000000003',
       received_at = now()
 where id = 'e7000000-0000-0000-0000-00000000f101';
reset role;

-- The trip: 60,000 by Cashier A, approved and handed out. The levy: 10,000 by Cashier B, approved
-- only. Set aside is 70,000 and Free to approve 130,000.
select tests.cashier();
select tests.keep('trip', api.staff_propose_imprest_disbursement(
  60000, 'transport_and_delivery', 'Trip allowance, Dar to Kibaha', 'p-trip'));
select tests.cashier_b();
select tests.keep('levy', api.staff_propose_imprest_disbursement(
  10000, 'fees_and_charges', 'Council levy', 'p-levy'));
select tests.manager();
select tests.keep('a-trip', api.staff_decide_imprest_disbursement(tests.did('trip'), 1, true, null, 'a-trip'));
select tests.keep('a-levy', api.staff_decide_imprest_disbursement(tests.did('levy'), 1, true, null, 'a-levy'));
select tests.cashier();
select tests.keep('h-trip', api.staff_hand_out_imprest_disbursement(tests.did('trip'), 2, 'Juma', 'h-trip'));

select is(tests.figures(), '200000/200000/70000/130000/60000',
          'before any raise: set aside 70,000, Free 130,000, Awaiting verification the trip''s 60,000');
select is(tests.approved(tests.did('trip')), 60000::bigint,
          'criterion 3: with no raise the approved amount is the original approval');

-- ---------------------------------------------------------------------------
-- Criterion 1 · Who may ask, when, and for what
-- ---------------------------------------------------------------------------
select tests.manager();
select throws_ok(
  format($$ select tests.ask(%L, 3, 20000, 'The road toll rose', 'q-mgr') $$, tests.did('trip')),
  '42501', null, 'the Manager does not ask');
select tests.director();
select throws_ok(
  format($$ select tests.ask(%L, 3, 20000, 'The road toll rose', 'q-dir') $$, tests.did('trip')),
  '42501', null, 'a Director reads and does not ask');
select tests.rep();
select throws_ok(
  format($$ select tests.ask(%L, 3, 20000, 'The road toll rose', 'q-rep') $$, tests.did('trip')),
  '42501', null, 'a Sales Representative cannot ask');

select tests.cashier_b();
select is(tests.ask(tests.did('trip'), 3, 20000, 'The road toll rose', 'q-other'),
          'no_disbursement', 'another Cashier''s disbursement is answered as missing');

select tests.cashier();
select is(tests.ask(gen_random_uuid(), 1, 20000, 'The road toll rose', 'q-none'),
          'no_disbursement', 'a disbursement that does not exist is refused');
select is(tests.ask(tests.did('trip'), 2, 20000, 'The road toll rose', 'q-stale'),
          'stale', 'a request against an older version is refused');
select is(tests.ask(tests.did('trip'), 3, 0, 'The road toll rose', 'q-zero'),
          'amount_invalid', 'an increase of nothing is refused');
select is(tests.ask(tests.did('trip'), 3, -5, 'The road toll rose', 'q-neg'),
          'amount_invalid', 'so is a negative one');
select is(tests.ask(tests.did('trip'), 3, null, 'The road toll rose', 'q-null'),
          'amount_invalid', 'so is a missing one');
select is(tests.ask(tests.did('trip'), 3, 100000001, 'The road toll rose', 'q-huge'),
          'amount_invalid', 'and one above the 100,000,000 ceiling');
select is(tests.ask(tests.did('trip'), 3, 20000, null, 'q-noreason'),
          'reason_required', 'a request without a reason is refused');
select is(tests.ask(tests.did('trip'), 3, 20000, '   ', 'q-blank'),
          'reason_required', 'so is one whose reason is only spaces');
select is(tests.ask(tests.did('trip'), 3, 20000, 'no', 'q-short'),
          'reason_required', 'so is a reason under 3 characters');
select is(tests.ask(tests.did('trip'), 3, 20000, repeat('x', 501), 'q-long'),
          'reason_required', 'and one over 500');
select ok(exists (select 1 from public.audit_events
                   where action = 'command_refused' and entity_id = tests.did('trip')
                     and entity_type = 'imprest_disbursement'
                     and source_operation = 'api.staff_request_imprest_raise'
                     and actor_id = 'e7000000-0000-0000-0000-000000000004'
                     and actor_role = 'cashier'
                     and after_state ->> 'reason' = 'reason_required'
                     and correlation_id is not null and occurred_at is not null),
          'criterion 8: the refusal is committed with actor, live role, operation, reason, entity, '
          'time and correlation id');
select is((select count(*)::int from public.imprest_approval_raises), 0,
          'no refusal wrote a raise');

select tests.cashier_b();
select is(tests.ask(tests.did('levy'), 2, 20000, 'The levy rose', 'q-approved'),
          'not_handed_out', 'an approved disbursement that is not yet handed out cannot ask');

-- ---------------------------------------------------------------------------
-- The request, one at a time
-- ---------------------------------------------------------------------------
select tests.cashier();
select is(tests.keep('ask-big', api.staff_request_imprest_raise(
            tests.did('trip'), 3, 500000, '  The   supplier   wants   more  ', 'q-big')),
          'requested', 'the Cashier asks for more, with a reason');
select is(tests.ver(tests.did('trip')), 4, 'the disbursement moves one version');
select is(tests.status(tests.did('trip')), 'handed_out', 'it stays handed out');
select is(tests.figures(), '200000/200000/70000/130000/60000',
          'asking sets nothing aside and adds nothing to Awaiting verification');
select is(tests.approved(tests.did('trip')), 60000::bigint, 'the approved amount has not moved');
select results_eq(
  format($$ select status::text, amount_tzs, reason, requested_by::text, raise_no
              from public.imprest_approval_raises where disbursement_id = %L $$, tests.did('trip')),
  $$ values ('requested'::text, 500000::bigint, 'The supplier wants more'::text,
             'e7000000-0000-0000-0000-000000000004'::text, 1) $$,
  'the request keeps the amount, the tidied reason, who asked and its number');
select is(tests.ask(tests.did('trip'), 4, 1000, 'One more thing', 'q-second'),
          'raise_open', 'only one request is open at a time');
select is(tests.keep('ask-big-again', api.staff_request_imprest_raise(
            tests.did('trip'), 3, 500000, '  The   supplier   wants   more  ', 'q-big')),
          'replayed', 'a retry of the same request replays it');
select is(tests.ask(tests.did('trip'), 3, 400000, 'A different figure', 'q-big'),
          'idempotency_key_conflict', 'the same key with another figure is a conflict');
select is((select count(*)::int from public.imprest_approval_raises), 1,
          'the replay and the conflict wrote nothing');
select ok(exists (select 1 from public.audit_events
                   where action = 'imprest_raise_requested' and entity_id = tests.did('trip')
                     and actor_role = 'cashier' and correlation_id is not null
                     and after_state ->> 'amount_tzs' = '500000'),
          'criterion 8: the request is on the audit trail');

-- ---------------------------------------------------------------------------
-- Criterion 2 · Who may decide, and the refusal for short money
-- ---------------------------------------------------------------------------
select throws_ok(
  format($$ select tests.decide(%L, 4, %L, true, null, 'd-cash') $$, tests.did('trip'), tests.rzid('ask-big')),
  '42501', null, 'the Cashier cannot raise their own approval');
select tests.director();
select throws_ok(
  format($$ select tests.decide(%L, 4, %L, true, null, 'd-dir') $$, tests.did('trip'), tests.rzid('ask-big')),
  '42501', null, 'a Director reads and does not decide');
select tests.rep();
select throws_ok(
  format($$ select tests.decide(%L, 4, %L, true, null, 'd-rep') $$, tests.did('trip'), tests.rzid('ask-big')),
  '42501', null, 'a Sales Representative cannot');
select tests.acting_as('e7000000-0000-0000-0000-000000000006'::uuid);
select throws_ok(
  format($$ select tests.decide(%L, 4, %L, true, null, 'd-gone') $$, tests.did('trip'), tests.rzid('ask-big')),
  '42501', null, 'nor can a disabled Manager');

select tests.manager();
select is(tests.decide(tests.did('trip'), 3, tests.rzid('ask-big'), true, null, 'd-stale'),
          'stale', 'a decision against an older version is refused');
select is(tests.decide(tests.did('trip'), 4, gen_random_uuid(), true, null, 'd-nosuch'),
          'no_raise_request', 'a request that does not exist is refused');
select is(tests.decide(tests.did('trip'), 4, tests.rzid('ask-big'), null, null, 'd-undecided'),
          'decision_required', 'a decision must say raise or refuse');
select is(tests.decide(tests.did('trip'), 4, tests.rzid('ask-big'), true, null, 'd-short'),
          'insufficient_imprest', 'raising above Free to approve is refused');
select is((tests.decide_context(tests.did('trip'), 4, tests.rzid('ask-big'), 'd-short-2')), '130000/500000',
          'and names what is free and what was asked');
select is(tests.figures(), '200000/200000/70000/130000/60000', 'the refusal set nothing aside');
select is(tests.decide(tests.did('trip'), 4, tests.rzid('ask-big'), false, null, 'd-noreason'),
          'reason_required', 'a refusal needs a reason');
select is(tests.decide(tests.did('trip'), 4, tests.rzid('ask-big'), false, 'no', 'd-shortreason'),
          'reason_required', 'of 3 to 500 characters');
select is(tests.keep('refuse-big', api.staff_decide_imprest_raise(
            tests.did('trip'), 4, tests.rzid('ask-big'), false, 'Too much for one trip', 'd-refuse')),
          'refused', 'the Manager refuses the request with a reason');
select results_eq(
  format($$ select status::text, refusal_reason, decided_by::text from public.imprest_approval_raises
             where id = %L $$, tests.rzid('ask-big')),
  $$ values ('refused'::text, 'Too much for one trip'::text,
             'e7000000-0000-0000-0000-000000000003'::text) $$,
  'the refusal keeps its reason and who refused it');
select is(tests.approved(tests.did('trip')), 60000::bigint, 'a refused request adds nothing');
select is(tests.decide(tests.did('trip'), 5, tests.rzid('ask-big'), true, null, 'd-late'),
          'no_raise_request', 'a request already decided cannot be decided again');

-- ---------------------------------------------------------------------------
-- The raise
-- ---------------------------------------------------------------------------
select tests.cashier();
select is(tests.keep('ask-20', api.staff_request_imprest_raise(
            tests.did('trip'), 5, 20000, 'The road toll rose', 'q-20')),
          'requested', 'after a refusal the Cashier may ask again');
select tests.manager();
select is(tests.keep('raise-20', api.staff_decide_imprest_raise(
            tests.did('trip'), 6, tests.rzid('ask-20'), true, null, 'd-raise')),
          'raised', 'the Manager raises the approval');
select is(tests.approved(tests.did('trip')), 80000::bigint,
          'criterion 3: the approved amount is the original 60,000 plus the raise of 20,000');
select is(tests.figures(), '200000/200000/90000/110000/60000',
          'criterion 2: the increase is set aside at once (90,000), and is not awaiting verification');
select is(tests.keep('raise-20-again', api.staff_decide_imprest_raise(
            tests.did('trip'), 6, tests.rzid('ask-20'), true, null, 'd-raise')),
          'replayed', 'a retry of the raise replays it');
select is(tests.figures(), '200000/200000/90000/110000/60000', 'and sets nothing aside twice');
select results_eq(
  format($$ select status::text, decided_by::text, decided_at is not null
              from public.imprest_approval_raises where id = %L $$, tests.rzid('ask-20')),
  $$ values ('raised'::text, 'e7000000-0000-0000-0000-000000000003'::text, true) $$,
  'the raise keeps who raised it and when');
select ok(exists (select 1 from public.audit_events
                   where action = 'imprest_raise_raised' and entity_id = tests.did('trip')
                     and actor_role = 'manager' and correlation_id is not null
                     and after_state ->> 'approved_tzs' = '80000'),
          'criterion 8: the raise is on the audit trail with the new approved amount');

-- ---------------------------------------------------------------------------
-- Criterion 4 · The extra is handed out and recorded before anything settles
-- ---------------------------------------------------------------------------
select tests.cashier();
select is(tests.ask(tests.did('trip'), 7, 1000, 'One more thing', 'q-while-raised'),
          'raise_open', 'no new request while the last raise is still to be handed out');
select is(api.staff_settle_imprest_disbursement(
            tests.did('trip'), 7, jsonb_build_array(tests.line(80000, 'Fare', null, 'transport_fare')),
            0, null, 's-early') ->> 'reason',
          'raise_not_handed_out', 'the disbursement cannot settle before the extra is handed out');
select tests.cashier_b();
select is(tests.give(tests.did('trip'), 7, tests.rzid('ask-20'), 'Juma', 'g-other'),
          'no_disbursement', 'another Cashier cannot hand out the extra');
select tests.cashier();
select is(tests.give(tests.did('trip'), 6, tests.rzid('ask-20'), 'Juma', 'g-stale'),
          'stale', 'a hand-out against an older version is refused');
select is(tests.give(tests.did('trip'), 7, tests.rzid('ask-20'), 'J', 'g-recipient'),
          'recipient_invalid', 'the recipient must be named');
select is(tests.give(tests.did('trip'), 7, tests.rzid('ask-big'), 'Juma', 'g-refused'),
          'no_raise_request', 'a refused request cannot be handed out');
select tests.manager();
select throws_ok(
  format($$ select tests.give(%L, 7, %L, 'Juma', 'g-mgr') $$, tests.did('trip'), tests.rzid('ask-20')),
  '42501', null, 'the Manager does not hand out cash');
select tests.cashier();
select is(tests.keep('give-20', api.staff_hand_out_imprest_raise(
            tests.did('trip'), 7, tests.rzid('ask-20'), '  Juma   Ali ', 'g-20')),
          'handed_out', 'the Cashier records handing out the extra and who received it');
select is(tests.figures(), '200000/200000/90000/110000/80000',
          'now the extra counts as awaiting verification: 80,000');
select results_eq(
  format($$ select status::text, recipient, handed_out_by::text, after_cycle
              from public.imprest_approval_raises where id = %L $$, tests.rzid('ask-20')),
  $$ values ('handed_out'::text, 'Juma Ali'::text,
             'e7000000-0000-0000-0000-000000000004'::text, 0) $$,
  'the hand-out keeps the recipient and who handed it out');
select is(tests.keep('give-20-again', api.staff_hand_out_imprest_raise(
            tests.did('trip'), 7, tests.rzid('ask-20'), 'Juma Ali', 'g-20')),
          'replayed', 'a retry of the hand-out replays it');
select is(tests.figures(), '200000/200000/90000/110000/80000', 'and counts the extra once');

-- ---------------------------------------------------------------------------
-- Criterion 5 · Settlement is checked against the raised approved amount
-- ---------------------------------------------------------------------------
select is(api.staff_settle_imprest_disbursement(
            tests.did('trip'), 8, jsonb_build_array(tests.line(78000, 'Fare', null, 'transport_fare')),
            5000, null, 's-over') ->> 'reason',
          'over_approval', 'Used plus Returned above the raised 80,000 is refused');
select is(api.staff_settle_imprest_disbursement(
            tests.did('trip'), 8, jsonb_build_array(tests.line(70000, 'Fare', null, 'transport_fare')),
            5000, null, 's-gap') ->> 'reason',
          'explanation_required', 'a remainder against 80,000 still needs its explanation');
select is(tests.keep('s-trip', api.staff_settle_imprest_disbursement(
            tests.did('trip'), 8, jsonb_build_array(tests.line(75000, 'Fare', null, 'transport_fare')),
            5000, null, 's-trip')),
          'settled', 'a settlement that explains the raised 80,000 is accepted');
select results_eq(
  format($$ select approved_tzs, used_tzs, returned_tzs, unaccounted_tzs from public.imprest_settlements
             where disbursement_id = %L and cycle = 1 $$, tests.did('trip')),
  $$ values (80000::bigint, 75000::bigint, 5000::bigint, 0::bigint) $$,
  'criterion 5: the settlement records the raised approved amount');
select is(tests.figures(), '200000/200000/90000/110000/75000',
          'Awaiting verification is the trip''s Used 75,000: the levy is only approved');

-- ---------------------------------------------------------------------------
-- Criterion 6 · Sent back, a raise, and the next cycle
-- ---------------------------------------------------------------------------
select tests.cashier();
select is(tests.ask(tests.did('trip'), 9, 1000, 'Too late', 'q-settled'),
          'not_handed_out', 'a settled disbursement cannot ask');
select tests.manager();
select is(api.staff_send_back_imprest_settlement(
            tests.did('trip'), 9, tests.sid(tests.did('trip')), 'The fare needs a receipt', 'b-trip')
            ->> 'reason',
          'sent_back', 'the Manager sends the trip back');
select tests.cashier();
select is(tests.keep('ask-10', api.staff_request_imprest_raise(
            tests.did('trip'), 10, 10000, 'A second toll on the way back', 'q-10')),
          'requested', 'a sent-back disbursement can ask');
select is(tests.figures(), '200000/200000/90000/110000/75000', 'asking again moves nothing');
select tests.manager();
select is(tests.keep('raise-10', api.staff_decide_imprest_raise(
            tests.did('trip'), 11, tests.rzid('ask-10'), true, null, 'd-raise-10')),
          'raised', 'the Manager raises it');
select is(tests.approved(tests.did('trip')), 90000::bigint, 'the approved amount is 60,000 + 20,000 + 10,000');
select is(tests.figures(), '200000/200000/100000/100000/75000',
          'the second increase is set aside, not yet awaiting verification');
select tests.cashier();
select is(api.staff_settle_imprest_disbursement(
            tests.did('trip'), 12, jsonb_build_array(tests.line(85000, 'Fare', null, 'transport_fare')),
            5000, null, 's-early-2') ->> 'reason',
          'raise_not_handed_out', 'the next cycle waits for the second extra to be handed out');
select is(tests.keep('give-10', api.staff_hand_out_imprest_raise(
            tests.did('trip'), 12, tests.rzid('ask-10'), 'Juma Ali', 'g-10')),
          'handed_out', 'the second extra is handed out while sent back');
select is(tests.figures(), '200000/200000/100000/100000/85000',
          'awaiting verification is the returned cycle''s 75,000 plus the 10,000 handed out since');
select results_eq(
  format($$ select after_cycle from public.imprest_approval_raises where id = %L $$, tests.rzid('ask-10')),
  $$ values (1) $$, 'the second hand-out remembers it came after cycle 1');
select is(api.staff_settle_imprest_disbursement(
            tests.did('trip'), 13, jsonb_build_array(tests.line(86000, 'Fare', null, 'transport_fare')),
            5000, null, 's-over-2') ->> 'reason',
          'over_approval', 'the next cycle is held to the raised 90,000');
select is(tests.keep('s-trip-2', api.staff_settle_imprest_disbursement(
            tests.did('trip'), 13, jsonb_build_array(tests.line(85000, 'Fare', null, 'transport_fare')),
            5000, null, 's-trip-2')),
          'settled', 'the Cashier settles again against the raised 90,000');
select results_eq(
  format($$ select cycle, approved_tzs, used_tzs, returned_tzs from public.imprest_settlements
             where disbursement_id = %L order by cycle $$, tests.did('trip')),
  $$ values (1, 80000::bigint, 75000::bigint, 5000::bigint),
            (2, 90000::bigint, 85000::bigint, 5000::bigint) $$,
  'cycle 1 keeps its 80,000; cycle 2 explains 90,000');
select is(tests.figures(), '200000/200000/100000/100000/85000',
          'Awaiting verification is the second cycle''s Used 85,000');

-- ---------------------------------------------------------------------------
-- Criterion 5 · Verification posts against the raised amount and frees only what came back
-- ---------------------------------------------------------------------------
select tests.manager();
select is(api.staff_verify_imprest_disbursement(
            tests.did('trip'), 14, tests.sid(tests.did('trip')), 'v-trip') ->> 'reason',
          'verified', 'the Manager verifies the second cycle');
select is(tests.figures(), '200000/115000/10000/105000/0',
          'the 85,000 is posted, the 5,000 returned is back in the fund, and only the levy is set aside');
select tests.cashier();
select is(tests.ask(tests.did('trip'), 15, 1000, 'Too late', 'q-verified'),
          'not_handed_out', 'a verified disbursement cannot ask');

-- ---------------------------------------------------------------------------
-- Criterion 3 · Nothing is ever changed or deleted
-- ---------------------------------------------------------------------------
set local role fv_definer_owner;
select throws_ok(
  format($$ update public.imprest_approval_raises set amount_tzs = 1 where id = %L $$, tests.rzid('ask-20')),
  '23001', null, 'a raise''s amount is never changed');
select throws_ok(
  format($$ update public.imprest_approval_raises set reason = 'Changed my mind' where id = %L $$,
         tests.rzid('ask-20')),
  '23001', null, 'nor its reason');
select throws_ok(
  format($$ update public.imprest_approval_raises set status = 'requested' where id = %L $$,
         tests.rzid('ask-20')),
  '23001', null, 'nor does a raise go back a step');
reset role;
select throws_ok($$ delete from public.imprest_approval_raises $$,
  '23001', null, 'and none is deleted');
select throws_ok($$ truncate public.imprest_approval_raises $$,
  '23001', null, 'or truncated');
select is((select count(*)::int from public.imprest_approval_raises), 3,
          'the trip carries its refused request and its two raises, all visible');

-- ---------------------------------------------------------------------------
-- Criterion 7 · Who reads
-- ---------------------------------------------------------------------------
set local role authenticated;
select tests.director();
select is((select count(*)::int from public.imprest_approval_raises), 3, 'a Director reads every raise');
select tests.manager();
select is((select count(*)::int from public.imprest_approval_raises), 3, 'so does the Manager');
select tests.cashier();
select is((select count(*)::int from public.imprest_approval_raises), 3, 'the proposing Cashier reads their own');
select tests.cashier_b();
select is((select count(*)::int from public.imprest_approval_raises), 0, 'another Cashier reads none');
select tests.rep();
select is((select count(*)::int from public.imprest_approval_raises), 0, 'a Sales Representative reads none');
select tests.cashier();
select is((select public.imprest_disbursement_approved_tzs(d) from public.imprest_disbursements d
            where d.id = tests.did('trip')), 90000::bigint,
          'the approved amount is a calculated column readers can select');
reset role;

select * from finish();
rollback;
