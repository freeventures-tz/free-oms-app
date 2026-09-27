-- Issue #64 · Imprest spending, part 2b-1: the Manager verifies a settled payment, which posts it
--
-- The claims under test, each traceable to issue #64's acceptance criteria:
--
--   1   Only a live Manager verifies, only a settled disbursement, only its latest settlement, at
--       the version they were shown, under an idempotency key that covers every input.
--   2   There is no amount to verify with: the command takes none.
--   3   Verifying posts Used as one immutable imprest expense and, when above zero, Not accounted
--       for as one immutable unexplained loss awaiting a Director's decision. Nobody changes either.
--   4   Posted balance = posted funding − verified expenses − verified losses. Set aside and
--       Awaiting verification no longer count a verified disbursement. The worked example holds.
--   5   Verification takes the per-fund lock, and a later approval reads what it freed.
--   6   The verified disbursement leaves the settled queue and reads as verified.
--   7   Every verification and every committed refusal is on the audit trail.
--   8   A Cashier is still sent Free to approve alone.

create extension if not exists pgtap with schema extensions;

begin;
select plan(71);

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

select tests.mk_user('e6400000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('e6400000-0000-0000-0000-000000000003'::uuid);  -- Manager
select tests.mk_user('e6400000-0000-0000-0000-000000000004'::uuid);  -- Cashier A
select tests.mk_user('e6400000-0000-0000-0000-000000000005'::uuid);  -- Sales Representative
select tests.mk_user('e6400000-0000-0000-0000-000000000006'::uuid);  -- Disabled Manager
select tests.mk_user('e6400000-0000-0000-0000-000000000007'::uuid);  -- Cashier B

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('e6400000-0000-0000-0000-000000000001', 'Verify Director',  '+255700006401', true,  false),
  ('e6400000-0000-0000-0000-000000000003', 'Verify Manager',   '+255700006403', true,  false),
  ('e6400000-0000-0000-0000-000000000004', 'Verify Cashier A', '+255700006404', true,  false),
  ('e6400000-0000-0000-0000-000000000005', 'Verify Rep',       '+255700006405', true,  false),
  ('e6400000-0000-0000-0000-000000000006', 'Gone Manager',     '+255700006406', false, false),
  ('e6400000-0000-0000-0000-000000000007', 'Verify Cashier B', '+255700006407', true,  false);

insert into public.user_roles (user_id, role) values
  ('e6400000-0000-0000-0000-000000000001', 'director'),
  ('e6400000-0000-0000-0000-000000000003', 'manager'),
  ('e6400000-0000-0000-0000-000000000004', 'cashier'),
  ('e6400000-0000-0000-0000-000000000005', 'sales_rep'),
  ('e6400000-0000-0000-0000-000000000006', 'manager'),
  ('e6400000-0000-0000-0000-000000000007', 'cashier');

create or replace function tests.director() returns void language sql as $$
  select tests.acting_as('e6400000-0000-0000-0000-000000000001'::uuid); $$;
create or replace function tests.manager() returns void language sql as $$
  select tests.acting_as('e6400000-0000-0000-0000-000000000003'::uuid); $$;
create or replace function tests.cashier() returns void language sql as $$
  select tests.acting_as('e6400000-0000-0000-0000-000000000004'::uuid); $$;
create or replace function tests.rep() returns void language sql as $$
  select tests.acting_as('e6400000-0000-0000-0000-000000000005'::uuid); $$;
create or replace function tests.cashier_b() returns void language sql as $$
  select tests.acting_as('e6400000-0000-0000-0000-000000000007'::uuid); $$;

create temp table r (name text primary key, res jsonb not null);
grant all on r to public;
create or replace function tests.keep(p_name text, p_res jsonb) returns text language sql as $$
  insert into r values (p_name, p_res) returning res ->> 'reason';
$$;
create or replace function tests.did(p_name text) returns uuid language sql as $$
  select (res -> 'disbursement' ->> 'id')::uuid from r where name = p_name; $$;
create or replace function tests.ver(p_id uuid) returns integer language sql
  security definer as $$ select version from public.imprest_disbursements where id = p_id; $$;
create or replace function tests.status(p_id uuid) returns text language sql
  security definer as $$ select status::text from public.imprest_disbursements where id = p_id; $$;
create or replace function tests.sid(p_id uuid) returns uuid language sql security definer as $$
  select id from public.imprest_settlements where disbursement_id = p_id
   order by cycle desc limit 1; $$;
-- posted funding / posted balance / set aside / free to approve / awaiting verification
create or replace function tests.figures() returns text language sql security definer as $$
  select s.posted_funding_tzs || '/' || s.posted_balance_tzs || '/' || s.set_aside_tzs || '/'
         || s.free_to_approve_tzs || '/' || private.imprest_awaiting_verification_tzs(f.id)
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active; $$;
create or replace function tests.postings(p_id uuid) returns text language sql security definer as $$
  select coalesce(string_agg(kind::text || ':' || amount_tzs || ':' || needs_director_decision,
                             ',' order by kind), '-')
    from public.imprest_postings where disbursement_id = p_id; $$;
create or replace function tests.line(p_amount bigint, p_purpose text, p_reason text)
returns jsonb language sql as $$
  select jsonb_build_object('amount_tzs', p_amount, 'purpose', p_purpose, 'receipt_id', null,
                            'no_receipt_reason', p_reason, 'no_receipt_note', null); $$;

-- ---------------------------------------------------------------------------
-- The shape: two append-only tables no client writes, and one command
-- ---------------------------------------------------------------------------
select ok(
  (select bool_and(not has_table_privilege('authenticated', 'public.' || t, 'insert')
                   and not has_table_privilege('authenticated', 'public.' || t, 'update')
                   and not has_table_privilege('authenticated', 'public.' || t, 'delete')
                   and has_table_privilege('authenticated', 'public.' || t, 'select')
                   and not has_table_privilege('service_role', 'public.' || t, 'select')
                   and not has_table_privilege('service_role', 'public.' || t, 'insert')
                   and not has_table_privilege('anon', 'public.' || t, 'select')
                   and not has_table_privilege('fv_definer_owner', 'public.' || t, 'update')
                   and not has_table_privilege('fv_definer_owner', 'public.' || t, 'delete'))
     from unnest(array['imprest_verifications', 'imprest_postings']) t),
  'no role writes a verification or a posting except by insert through the command, and anon and '
  'the service role read neither');

select ok(
  (select bool_and(c.relrowsecurity) from pg_class c
    where c.oid in ('public.imprest_verifications'::regclass, 'public.imprest_postings'::regclass)),
  'both tables have row-level security');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     join pg_roles o on o.oid = p.proowner
    where n.nspname = 'api' and p.proname = 'staff_verify_imprest_disbursement'
      and p.prosecdef and o.rolname = 'fv_definer_owner'
      and has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('service_role', p.oid, 'execute')),
  1,
  'the verify command is security definer, owned by fv_definer_owner, callable by staff sessions only');

select ok(
  not exists (select 1 from information_schema.parameters
               where specific_schema = 'api'
                 and specific_name like 'staff_verify_imprest_disbursement%'
                 and (parameter_name like '%amount%' or parameter_name like '%tzs%')),
  'criterion 2: the command has no amount parameter, so no other figure can be verified');

select is(
  (select string_agg(enumlabel, ',' order by enumsortorder) from pg_enum
    where enumtypid = 'public.imprest_disbursement_status'::regtype),
  'proposed,approved,handed_out,settled,verified,rejected,withdrawn,cancelled',
  'verified comes after settled');

-- ---------------------------------------------------------------------------
-- The worked example: TZS 200,000 posted, built directly as its owner would
-- ---------------------------------------------------------------------------
set local role fv_definer_owner;
insert into public.imprest_funds (id, opened_by) values
  ('e6400000-0000-0000-0000-00000000f001', 'e6400000-0000-0000-0000-000000000003');
insert into public.imprest_fundings (id, funding_no, fund_id, requested_amount_tzs, reason,
                                     requested_by)
values ('e6400000-0000-0000-0000-00000000f101', 'FV-IMP-TEST-6401',
        'e6400000-0000-0000-0000-00000000f001', 200000, 'Opening float',
        'e6400000-0000-0000-0000-000000000003');
insert into public.imprest_funding_handovers (id, funding_id, cycle, amount_tzs, provided_by)
values ('e6400000-0000-0000-0000-00000000f201', 'e6400000-0000-0000-0000-00000000f101', 1, 200000,
        'e6400000-0000-0000-0000-000000000001');
update public.imprest_fundings
   set status = 'received', version = version + 1,
       received_handover_id = 'e6400000-0000-0000-0000-00000000f201',
       received_amount_tzs = 200000, received_by = 'e6400000-0000-0000-0000-000000000003',
       received_at = now()
 where id = 'e6400000-0000-0000-0000-00000000f101';
reset role;

-- The trip: 60,000 approved, handed out, settled as Used 47,000, Returned 10,000, Not accounted
-- for 3,000. The fuel: 20,000 approved, handed out and settled exactly. The levy: Cashier B's,
-- handed out and not settled.
select tests.cashier();
select tests.keep('trip', api.staff_propose_imprest_disbursement(
  60000, 'transport_and_delivery', 'Trip allowance, Dar to Kibaha', 'p-trip'));
select tests.keep('fuel', api.staff_propose_imprest_disbursement(
  20000, 'fuel_and_lubricants', 'Generator diesel', 'p-fuel'));
select tests.cashier_b();
select tests.keep('levy', api.staff_propose_imprest_disbursement(
  10000, 'fees_and_charges', 'Council levy', 'p-levy'));
select tests.manager();
select tests.keep('a-trip', api.staff_decide_imprest_disbursement(tests.did('trip'), 1, true, null, 'a-trip'));
select tests.keep('a-fuel', api.staff_decide_imprest_disbursement(tests.did('fuel'), 1, true, null, 'a-fuel'));
select tests.keep('a-levy', api.staff_decide_imprest_disbursement(tests.did('levy'), 1, true, null, 'a-levy'));
select tests.cashier();
select tests.keep('h-trip', api.staff_hand_out_imprest_disbursement(tests.did('trip'), 2, 'Juma', 'h-trip'));
select tests.keep('h-fuel', api.staff_hand_out_imprest_disbursement(tests.did('fuel'), 2, 'Puma', 'h-fuel'));
select tests.cashier_b();
select tests.keep('h-levy', api.staff_hand_out_imprest_disbursement(tests.did('levy'), 2, 'Council', 'h-levy'));
select tests.cashier();
select is(tests.keep('s-trip', api.staff_settle_imprest_disbursement(
            tests.did('trip'), 3,
            jsonb_build_array(tests.line(40000, 'Fuel', 'vendor_did_not_issue'),
                              tests.line(7000, 'Tolls', 'transport_fare')),
            10000, 'Driver cannot say where three thousand went', 's-trip')),
          'settled', 'the trip is settled as Used 47,000, Returned 10,000, Not accounted for 3,000');
select is(tests.keep('s-fuel', api.staff_settle_imprest_disbursement(
            tests.did('fuel'), 3, jsonb_build_array(tests.line(20000, 'Diesel', 'vendor_did_not_issue')),
            0, null, 's-fuel')),
          'settled', 'the fuel is settled exactly');

-- Before verifying, only the trip in the fund's figures: the fuel and the levy add 30,000 to set
-- aside and 30,000 to Awaiting verification.
select is(tests.figures(), '200000/200000/90000/110000/80000',
          'criterion 4: before verifying, nothing is posted, set aside is 90,000 and Awaiting verification 80,000');

-- ---------------------------------------------------------------------------
-- Criterion 1 · Who may verify, and what
-- ---------------------------------------------------------------------------
select tests.director();
select throws_ok(
  format($$ select api.staff_verify_imprest_disbursement(%L, 4, %L, 'v-dir') $$,
         tests.did('trip'), tests.sid(tests.did('trip'))),
  '42501', null, 'a Director reads and does not verify');
select tests.cashier();
select throws_ok(
  format($$ select api.staff_verify_imprest_disbursement(%L, 4, %L, 'v-cash') $$,
         tests.did('trip'), tests.sid(tests.did('trip'))),
  '42501', null, 'the Cashier cannot verify their own settlement');
select tests.rep();
select throws_ok(
  format($$ select api.staff_verify_imprest_disbursement(%L, 4, %L, 'v-rep') $$,
         tests.did('trip'), tests.sid(tests.did('trip'))),
  '42501', null, 'a Sales Representative cannot verify');
select tests.acting_as('e6400000-0000-0000-0000-000000000006'::uuid);
select throws_ok(
  format($$ select api.staff_verify_imprest_disbursement(%L, 4, %L, 'v-gone') $$,
         tests.did('trip'), tests.sid(tests.did('trip'))),
  '42501', null, 'nor can a disabled Manager');
select is(tests.status(tests.did('trip')), 'settled', 'and the trip is still settled');

select tests.manager();
select is(api.staff_verify_imprest_disbursement(gen_random_uuid(), 1, gen_random_uuid(), 'v-none')
            ->> 'reason', 'no_disbursement', 'a disbursement that does not exist is refused');
select is(api.staff_verify_imprest_disbursement(tests.did('trip'), 3, tests.sid(tests.did('trip')),
                                                'v-stale') ->> 'reason',
          'stale', 'a verification against an older version is refused');
select ok(exists (select 1 from public.audit_events
                   where action = 'command_refused' and entity_id = tests.did('trip')
                     and entity_type = 'imprest_disbursement'
                     and source_operation = 'api.staff_verify_imprest_disbursement'
                     and actor_id = 'e6400000-0000-0000-0000-000000000003'
                     and actor_role = 'manager'
                     and after_state ->> 'reason' = 'stale'
                     and correlation_id is not null and occurred_at is not null),
          'criterion 7: the stale refusal is committed with actor, live role, operation, reason, '
          'entity, time and correlation id');
select is(api.staff_verify_imprest_disbursement(tests.did('levy'), 3, tests.sid(tests.did('trip')),
                                                'v-out') ->> 'reason',
          'not_settled', 'a handed-out disbursement cannot be verified');
select is(api.staff_verify_imprest_disbursement(tests.did('trip'), 4, tests.sid(tests.did('fuel')),
                                                'v-other') ->> 'reason',
          'settlement_not_latest', 'only the disbursement''s own latest settlement can be verified');
select is(api.staff_verify_imprest_disbursement(tests.did('trip'), 4, null, 'v-nosettle')
            ->> 'reason', 'settlement_not_latest', 'a verification must name the settlement it was shown');
select is(tests.figures(), '200000/200000/90000/110000/80000', 'no refusal moved a figure');
select is(tests.postings(tests.did('trip')), '-', 'and none posted anything');

-- ---------------------------------------------------------------------------
-- Criteria 3 and 4 · The worked example, verified
-- ---------------------------------------------------------------------------
select is(tests.keep('v-trip', api.staff_verify_imprest_disbursement(
            tests.did('trip'), 4, tests.sid(tests.did('trip')), 'v-trip')),
          'verified', 'the Manager verifies the trip exactly as the Cashier settled it');
select is(tests.status(tests.did('trip')), 'verified', 'the trip is verified');
select is(tests.ver(tests.did('trip')), 5, 'at the next version');
select is(tests.postings(tests.did('trip')), 'expense:47000:false,unexplained_loss:3000:true',
          'Used posts as a 47,000 imprest expense, and Not accounted for as a 3,000 unexplained loss '
          'awaiting a Director''s decision');
select results_eq(
  format($$ select v.settlement_id, v.verified_by::text, v.fund_id
              from public.imprest_verifications v where v.disbursement_id = %L $$, tests.did('trip')),
  format($$ values (%L::uuid, 'e6400000-0000-0000-0000-000000000003'::text,
                    'e6400000-0000-0000-0000-00000000f001'::uuid) $$, tests.sid(tests.did('trip'))),
  'the verification names the settlement it verified, the Manager and the fund');
select ok((select bool_and(p.settlement_id = tests.sid(tests.did('trip'))
                           and p.fund_id = 'e6400000-0000-0000-0000-00000000f001')
             from public.imprest_postings p where p.disbursement_id = tests.did('trip')),
          'both postings belong to that settlement and fund');

-- The fuel and the levy are still set aside; take them out and the worked example reads exactly:
-- posted balance 150,000, set aside 0, Free to approve 150,000, Awaiting verification 0.
select is(tests.figures(), '200000/150000/30000/120000/30000',
          'criterion 4: posted balance = 200,000 − 47,000 − 3,000; the trip is no longer set aside or awaiting');
-- The tin: 200,000 in, 60,000 out on the trip and 10,000 back, 20,000 out on the fuel and 10,000
-- on the levy.
select is(
  (select s.posted_balance_tzs - private.imprest_awaiting_verification_tzs(f.id)
     from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
    where f.is_active),
  (200000 - 60000 + 10000 - 20000 - 10000)::bigint,
  'expected cash (posted balance − Awaiting verification) matches the cash in the tin');

select ok(exists (select 1 from public.audit_events
                   where action = 'imprest_disbursement_verified' and entity_id = tests.did('trip')
                     and entity_type = 'imprest_disbursement'
                     and actor_id = 'e6400000-0000-0000-0000-000000000003'
                     and actor_role = 'manager'
                     and source_operation = 'api.staff_verify_imprest_disbursement'
                     and correlation_id is not null
                     and before_state ->> 'status' = 'settled'
                     and after_state ->> 'status' = 'verified'
                     and (after_state ->> 'expense_tzs')::bigint = 47000
                     and (after_state ->> 'unexplained_loss_tzs')::bigint = 3000
                     and (after_state ->> 'released_to_free_tzs')::bigint = 10000),
          'criterion 7: the verification is on the audit trail with the Manager and what it posted and freed');

-- Replay and retry.
select is(api.staff_verify_imprest_disbursement(tests.did('trip'), 4, tests.sid(tests.did('trip')),
                                                'v-trip') ->> 'reason',
          'replayed', 'the same request replays');
select is(api.staff_verify_imprest_disbursement(tests.did('trip'), 5, tests.sid(tests.did('trip')),
                                                'v-trip') ->> 'reason',
          'idempotency_key_conflict', 'a changed retry on the same key is a conflict');
select is(api.staff_verify_imprest_disbursement(tests.did('trip'), 4, tests.sid(tests.did('fuel')),
                                                'v-trip') ->> 'reason',
          'idempotency_key_conflict', 'so is a retry naming another settlement');
select is(api.staff_verify_imprest_disbursement(tests.did('trip'), 5, tests.sid(tests.did('trip')),
                                                'v-trip-again') ->> 'reason',
          'not_settled', 'a second verification is refused');
select is(api.staff_verify_imprest_disbursement(tests.did('trip'), 4, tests.sid(tests.did('trip')),
                                                'v-trip-stale') ->> 'reason',
          'stale', 'and one against the version before it is stale');
select is((select count(*)::int from public.imprest_postings where disbursement_id = tests.did('trip')),
          2, 'there are still exactly two postings');
select is(tests.figures(), '200000/150000/30000/120000/30000', 'and the figures did not move');

-- ---------------------------------------------------------------------------
-- A settlement with no remainder posts the expense alone
-- ---------------------------------------------------------------------------
select is(tests.keep('v-fuel', api.staff_verify_imprest_disbursement(
            tests.did('fuel'), 4, tests.sid(tests.did('fuel')), 'v-fuel')),
          'verified', 'the fuel, settled exactly, is verified');
select is(tests.postings(tests.did('fuel')), 'expense:20000:false',
          'it posts a 20,000 imprest expense and no loss');
select is(tests.figures(), '200000/130000/10000/120000/10000',
          'the fuel leaves set aside and Awaiting, and posts: Free to approve does not move');

-- ---------------------------------------------------------------------------
-- A settlement that used nothing posts a zero expense and frees the whole amount
-- ---------------------------------------------------------------------------
select tests.cashier();
select tests.keep('spare', api.staff_propose_imprest_disbursement(
  5000, 'other', 'Padlock, not needed in the end', 'p-spare'));
select tests.manager();
select tests.keep('a-spare', api.staff_decide_imprest_disbursement(tests.did('spare'), 1, true, null, 'a-spare'));
select tests.cashier();
select tests.keep('h-spare', api.staff_hand_out_imprest_disbursement(tests.did('spare'), 2, 'Shop', 'h-spare'));
select tests.keep('s-spare', api.staff_settle_imprest_disbursement(
  tests.did('spare'), 3, '[]'::jsonb, 5000, null, 's-spare'));
select tests.manager();
select is(tests.keep('v-spare', api.staff_verify_imprest_disbursement(
            tests.did('spare'), 4, tests.sid(tests.did('spare')), 'v-spare')),
          'verified', 'a settlement with every shilling returned is verified');
select is(tests.postings(tests.did('spare')), 'expense:0:false',
          'it posts an imprest expense of nothing, so every verification has its expense');
select is(tests.figures(), '200000/130000/10000/120000/10000', 'and the figures are where they were');

-- An envelope, settled and left waiting, for the deferred check at the end.
select tests.cashier();
select tests.keep('bare', api.staff_propose_imprest_disbursement(1000, 'other', 'Envelope', 'p-bare'));
select tests.manager();
select tests.keep('a-bare', api.staff_decide_imprest_disbursement(tests.did('bare'), 1, true, null, 'a-bare'));
select tests.cashier();
select tests.keep('h-bare', api.staff_hand_out_imprest_disbursement(tests.did('bare'), 2, 'Shop', 'h-bare'));
select is(tests.keep('s-bare', api.staff_settle_imprest_disbursement(
            tests.did('bare'), 3, jsonb_build_array(tests.line(1000, 'Envelope', 'vendor_did_not_issue')),
            0, null, 's-bare')),
          'settled', 'the envelope is settled and waits for the Manager');

-- ---------------------------------------------------------------------------
-- Criterion 5 · A later approval reads what verification freed, and the loss stays spent
-- ---------------------------------------------------------------------------
select tests.cashier();
select tests.keep('big', api.staff_propose_imprest_disbursement(
  119001, 'materials_and_supplies', 'Cement, one shilling too many', 'p-big'));
select tests.keep('fits', api.staff_propose_imprest_disbursement(
  119000, 'materials_and_supplies', 'Cement', 'p-fits'));
select tests.manager();
select is(api.staff_decide_imprest_disbursement(tests.did('big'), 1, true, null, 'a-big') ->> 'reason',
          'insufficient_imprest',
          'an approval one shilling above Free to approve is refused: the 3,000 loss did not come back');
select is(api.staff_decide_imprest_disbursement(tests.did('fits'), 1, true, null, 'a-fits') ->> 'reason',
          'approved', 'an approval of exactly Free to approve passes');
select is(tests.figures(), '200000/130000/130000/0/11000', 'and nothing is left to approve');

select ok(
  (select prosrc like '%imprest_fund_spend:%'
     from pg_proc where oid = 'private.impl_staff_verify_imprest_disbursement(uuid, integer, uuid, text)'::regprocedure),
  'criterion 5: verification takes the same per-fund lock as approval');

-- ---------------------------------------------------------------------------
-- Criterion 3 · Nobody changes or removes a posting or a verification
-- ---------------------------------------------------------------------------
set local role fv_definer_owner;
select throws_ok($$ update public.imprest_postings set amount_tzs = amount_tzs + 1 $$,
                 '42501', null, 'the commands'' own role cannot update a posting');
select throws_ok($$ delete from public.imprest_postings $$,
                 '42501', null, 'nor delete one');
select throws_ok($$ update public.imprest_verifications set verified_at = now() $$,
                 '42501', null, 'nor change a verification');
select throws_ok(
  format($$ update public.imprest_disbursements set status = 'settled', version = version + 1
             where id = %L $$, tests.did('trip')),
  '23001', null, 'a verified disbursement cannot go back to settled');
select throws_ok(
  format($$ update public.imprest_disbursements set status = 'cancelled', version = version + 1,
                  cancelled_by = approved_by, cancelled_at = now(), cancellation_reason = 'late'
             where id = %L $$, tests.did('trip')),
  '23001', null, 'nor be cancelled');
select throws_ok(
  format($$ insert into public.imprest_postings (verification_id, disbursement_id, settlement_id,
                                                 fund_id, kind, amount_tzs, needs_director_decision)
            select v.id, v.disbursement_id, v.settlement_id, v.fund_id, 'unexplained_loss', 1, true
              from public.imprest_verifications v where v.disbursement_id = %L $$, tests.did('fuel')),
  '23514', null, 'a posting that is not the settlement''s own figure cannot be written');
select throws_ok(
  format($$ insert into public.imprest_verifications (disbursement_id, settlement_id, fund_id,
                                                      verified_by)
            select %L, %L, 'e6400000-0000-0000-0000-00000000f001',
                   'e6400000-0000-0000-0000-000000000003' $$,
         tests.did('levy'), tests.sid(tests.did('trip'))),
  '23514', null, 'a verification cannot be written for a disbursement that is not settled');
reset role;
-- Even the table owner, which bypasses grants, meets the trigger.
select throws_ok($$ update public.imprest_postings set amount_tzs = amount_tzs + 1 $$,
                 '23001', null, 'even the owner cannot update a posting');
select throws_ok($$ delete from public.imprest_verifications $$,
                 '23001', null, 'or delete a verification');

-- ---------------------------------------------------------------------------
-- Criteria 6 and 8 · Who reads what
-- ---------------------------------------------------------------------------
set local role authenticated;
select tests.manager();
select is((select string_agg(id::text, ',') from public.imprest_disbursements where status = 'settled'),
          tests.did('bare')::text,
          'criterion 6: the Manager''s settled queue holds only the envelope once the others are verified');
select is((select count(*)::int from public.imprest_postings where disbursement_id = tests.did('trip')),
          2, 'the Manager reads the trip''s postings');
select tests.director();
select is((select count(*)::int from public.imprest_postings), 4, 'a Director reads every posting');
select is((select count(*)::int from public.imprest_verifications), 3, 'and every verification');
select tests.cashier();
select is((select count(*)::int from public.imprest_postings where disbursement_id = tests.did('trip')),
          2, 'the Cashier reads the postings of their own disbursement');
select is((select status::text from public.imprest_disbursements where id = tests.did('trip')),
          'verified', 'and sees it as verified');
select tests.cashier_b();
select is((select count(*)::int from public.imprest_postings), 0,
          'another Cashier reads none of them');
select is((select count(*)::int from public.imprest_verifications), 0, 'nor any verification');
select tests.rep();
select is((select count(*)::int from public.imprest_postings), 0, 'a Sales Representative reads none');
reset role;

select tests.cashier();
select results_eq(
  $$ select posted_funding_tzs, posted_balance_tzs, set_aside_tzs, free_to_approve_tzs,
            awaiting_verification_tzs from api.staff_imprest_spending_position() $$,
  $$ values (null::bigint, null::bigint, null::bigint, 0::bigint, null::bigint) $$,
  'criterion 8: a Cashier is still sent Free to approve alone');
select tests.manager();
select results_eq(
  $$ select posted_funding_tzs, posted_balance_tzs, set_aside_tzs, free_to_approve_tzs,
            awaiting_verification_tzs from api.staff_imprest_spending_position() $$,
  $$ values (200000::bigint, 130000::bigint, 130000::bigint, 0::bigint, 11000::bigint) $$,
  'the Manager is sent posted funding, the posted balance and the other three');
select tests.director();
select is((select posted_balance_tzs from api.staff_imprest_spending_position()), 130000::bigint,
          'and so is a Director');

-- ---------------------------------------------------------------------------
-- The daily report's imprest figures stay withheld
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select i -> 'position', i -> 'approved_expenses', i -> 'unavailable' ->> 'position',
            i -> 'unavailable' ->> 'approved_expenses'
       from jsonb_path_query_first(private.report_content(current_date), '$.**.imprest') i $$,
  $$ values ('null'::jsonb, 'null'::jsonb, 'imprest_spending_not_built'::text,
             'imprest_spending_not_built'::text) $$,
  'the daily report still withholds the imprest position and approved expenses');

-- ---------------------------------------------------------------------------
-- The deferred check: a verification carries its expense posting at commit
-- ---------------------------------------------------------------------------
set local role fv_definer_owner;
set constraints all immediate;
select throws_ok(
  format($$ insert into public.imprest_verifications (disbursement_id, settlement_id, fund_id,
                                                      verified_by)
            values (%L, %L, 'e6400000-0000-0000-0000-00000000f001',
                    'e6400000-0000-0000-0000-000000000003') $$,
         tests.did('bare'), tests.sid(tests.did('bare'))),
  '23514', null, 'a verification with no expense posting behind it is refused');
set constraints all deferred;
reset role;

select * from finish();
rollback;
