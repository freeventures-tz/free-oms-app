-- Issue #55 · Imprest spending, part 1: propose, approve, reject, withdraw and cancel
--
-- The claims under test, each traceable to product.md §13.3 and §13.4:
--
--   AC-96  A Cashier proposes. A proposal moves no money and sets nothing aside.
--   AC-97  Approval sets the approved amount aside and lowers Free to approve at once.
--   AC-98  An approval above Free to approve is refused and nothing changes.
--   AC-99  Posted funding, Set aside and Free to approve are calculated, never typed.
--   AC-101 Rejection and cancellation free the money; the history keeps both steps.
--   AC-104 Approvals serialise per fund (the race itself runs over HTTP in the integration suite).
--   §14.2  Only the api commands write; a committed refusal leaves an audit row.

create extension if not exists pgtap with schema extensions;

begin;
select plan(67);

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

select tests.mk_user('e5500000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('e5500000-0000-0000-0000-000000000003'::uuid);  -- Manager
select tests.mk_user('e5500000-0000-0000-0000-000000000004'::uuid);  -- Cashier A
select tests.mk_user('e5500000-0000-0000-0000-000000000005'::uuid);  -- Sales Representative
select tests.mk_user('e5500000-0000-0000-0000-000000000006'::uuid);  -- Disabled Cashier
select tests.mk_user('e5500000-0000-0000-0000-000000000007'::uuid);  -- Cashier B

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('e5500000-0000-0000-0000-000000000001', 'Spend Director',  '+255700005501', true,  false),
  ('e5500000-0000-0000-0000-000000000003', 'Spend Manager',   '+255700005503', true,  false),
  ('e5500000-0000-0000-0000-000000000004', 'Spend Cashier A', '+255700005504', true,  false),
  ('e5500000-0000-0000-0000-000000000005', 'Spend Rep',       '+255700005505', true,  false),
  ('e5500000-0000-0000-0000-000000000006', 'Gone Cashier',    '+255700005506', false, false),
  ('e5500000-0000-0000-0000-000000000007', 'Spend Cashier B', '+255700005507', true,  false);

insert into public.user_roles (user_id, role) values
  ('e5500000-0000-0000-0000-000000000001', 'director'),
  ('e5500000-0000-0000-0000-000000000003', 'manager'),
  ('e5500000-0000-0000-0000-000000000004', 'cashier'),
  ('e5500000-0000-0000-0000-000000000005', 'sales_rep'),
  ('e5500000-0000-0000-0000-000000000006', 'cashier'),
  ('e5500000-0000-0000-0000-000000000007', 'cashier');

create or replace function tests.director() returns void language sql as $$
  select tests.acting_as('e5500000-0000-0000-0000-000000000001'::uuid); $$;
create or replace function tests.manager() returns void language sql as $$
  select tests.acting_as('e5500000-0000-0000-0000-000000000003'::uuid); $$;
create or replace function tests.cashier() returns void language sql as $$
  select tests.acting_as('e5500000-0000-0000-0000-000000000004'::uuid); $$;
create or replace function tests.cashier_b() returns void language sql as $$
  select tests.acting_as('e5500000-0000-0000-0000-000000000007'::uuid); $$;

create temp table r (name text primary key, res jsonb not null);
grant all on r to public;
create or replace function tests.keep(p_name text, p_res jsonb) returns text language sql as $$
  insert into r values (p_name, p_res) returning res ->> 'reason';
$$;
create or replace function tests.did(p_name text) returns uuid language sql as $$
  select (res -> 'disbursement' ->> 'id')::uuid from r where name = p_name; $$;
create or replace function tests.ver(p_name text) returns integer language sql as $$
  select version from public.imprest_disbursements where id = tests.did(p_name); $$;
create or replace function tests.pos() returns jsonb language sql as $$
  select to_jsonb(p) from api.staff_imprest_spending_position() p; $$;
-- The calculation itself, whoever is acting. What each role is SHOWN is tested separately.
create or replace function tests.figures() returns text language sql as $$
  select s.posted_funding_tzs || '/' || s.set_aside_tzs || '/' || s.free_to_approve_tzs
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active; $$;

-- ---------------------------------------------------------------------------
-- The table cannot be written by a client, and the service role holds nothing on it
-- ---------------------------------------------------------------------------
select ok(
  not has_table_privilege('authenticated', 'public.imprest_disbursements', 'insert')
  and not has_table_privilege('authenticated', 'public.imprest_disbursements', 'update')
  and not has_table_privilege('authenticated', 'public.imprest_disbursements', 'delete')
  and not has_table_privilege('service_role', 'public.imprest_disbursements', 'select')
  and not has_table_privilege('service_role', 'public.imprest_disbursements', 'insert')
  and not has_table_privilege('anon', 'public.imprest_disbursements', 'select'),
  'authenticated may only read disbursements, and anon and the service role hold nothing');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     join pg_roles o on o.oid = p.proowner
    where n.nspname = 'api' and p.proname like '%imprest_disbursement%'
      and p.prosecdef and o.rolname = 'fv_definer_owner'),
  4,
  'four disbursement commands, each security definer and owned by fv_definer_owner');

select ok(
  not has_function_privilege('service_role',
    'api.staff_decide_imprest_disbursement(uuid, integer, boolean, text, text)', 'execute')
  and not has_function_privilege('anon',
    'api.staff_decide_imprest_disbursement(uuid, integer, boolean, text, text)', 'execute')
  and not has_function_privilege('authenticated',
    'private.impl_staff_decide_imprest_disbursement(uuid, integer, boolean, text, text)',
    'execute'),
  'neither anon, the service role nor a client may reach the approval outside the api wrapper');

select ok(
  not exists (select 1 from information_schema.parameters
               where specific_schema = 'api'
                 and specific_name like 'staff_decide_imprest_disbursement%'
                 and parameter_name like '%amount%'),
  'the approval has no amount parameter: the Manager approves the proposal as it stands');

-- ---------------------------------------------------------------------------
-- A fund with TZS 200,000 posted, built directly as its owner would
-- ---------------------------------------------------------------------------
set local role fv_definer_owner;
insert into public.imprest_funds (id, opened_by) values
  ('e5500000-0000-0000-0000-00000000f001', 'e5500000-0000-0000-0000-000000000003');
insert into public.imprest_fundings (id, funding_no, fund_id, requested_amount_tzs, reason,
                                     requested_by)
values ('e5500000-0000-0000-0000-00000000f101', 'FV-IMP-TEST-0001',
        'e5500000-0000-0000-0000-00000000f001', 200000, 'Opening float',
        'e5500000-0000-0000-0000-000000000003');
insert into public.imprest_funding_handovers (id, funding_id, cycle, amount_tzs, provided_by)
values ('e5500000-0000-0000-0000-00000000f201', 'e5500000-0000-0000-0000-00000000f101', 1, 200000,
        'e5500000-0000-0000-0000-000000000001');
update public.imprest_fundings
   set status = 'received', version = version + 1,
       received_handover_id = 'e5500000-0000-0000-0000-00000000f201',
       received_amount_tzs = 200000, received_by = 'e5500000-0000-0000-0000-000000000003',
       received_at = now()
 where id = 'e5500000-0000-0000-0000-00000000f101';
reset role;

-- ---------------------------------------------------------------------------
-- AC-96 · Only a live Cashier proposes, and a proposal sets nothing aside
-- ---------------------------------------------------------------------------
select tests.manager();
select throws_ok(
  $$ select api.staff_propose_imprest_disbursement(1000, 'fuel_and_lubricants', 'Diesel', 'd-mgr') $$,
  '42501', null, 'a Manager cannot propose a disbursement');
select tests.director();
select throws_ok(
  $$ select api.staff_propose_imprest_disbursement(1000, 'fuel_and_lubricants', 'Diesel', 'd-dir') $$,
  '42501', null, 'nor can a Director');
select tests.acting_as('e5500000-0000-0000-0000-000000000006'::uuid);
select throws_ok(
  $$ select api.staff_propose_imprest_disbursement(1000, 'fuel_and_lubricants', 'Diesel', 'd-gone') $$,
  '42501', null, 'nor a Cashier whose account is disabled');

select tests.cashier();
select is(api.staff_propose_imprest_disbursement(0, 'fuel_and_lubricants', 'Diesel', 'd-zero')
            ->> 'reason', 'amount_invalid', 'a zero amount is refused');
select is(api.staff_propose_imprest_disbursement(1000, 'petrol', 'Diesel', 'd-cat') ->> 'reason',
          'category_invalid', 'a category outside the nine is refused');
select is(api.staff_propose_imprest_disbursement(1000, 'utilities', ' x ', 'd-purpose')
            ->> 'reason', 'purpose_required', 'a purpose under three characters is refused');

select is(tests.keep('fuel',
  api.staff_propose_imprest_disbursement(120000, 'fuel_and_lubricants', 'Generator diesel',
                                         'd-fuel')),
  'proposed', 'the Cashier proposes TZS 120,000 for fuel');
select is(tests.figures(), '200000/0/200000', 'a proposal sets nothing aside (AC-96)');
select is(api.staff_propose_imprest_disbursement(120000, 'fuel_and_lubricants',
                                                 'Generator diesel', 'd-fuel') ->> 'reason',
          'replayed', 'a retry with the same key replays');
select is((select count(*)::int from public.imprest_disbursements), 1,
          'and creates no second disbursement');
select is(api.staff_propose_imprest_disbursement(120001, 'fuel_and_lubricants',
                                                 'Generator diesel', 'd-fuel') ->> 'reason',
          'idempotency_key_conflict', 'a changed retry is a conflict, not a replay');
select ok((select disbursement_no like 'FV-DSB-%' from public.imprest_disbursements
            where id = tests.did('fuel')), 'the disbursement carries a document number');

select is(tests.keep('repairs',
  api.staff_propose_imprest_disbursement(90000, 'repairs_and_maintenance', 'Gate hinge', 'd-rep')),
  'proposed', 'a second proposal, TZS 90,000 for repairs');
select is(tests.keep('meals',
  api.staff_propose_imprest_disbursement(30000, 'meals_and_staff_welfare', 'Lunch', 'd-meal')),
  'proposed', 'a third proposal, TZS 30,000 for meals');

-- ---------------------------------------------------------------------------
-- Reads: Cashiers see only their own; a Sales Representative sees nothing
-- ---------------------------------------------------------------------------
select tests.cashier_b();
set local role authenticated;
select is((select count(*)::int from public.imprest_disbursements), 0,
          'another Cashier cannot read these disbursements');
select is(tests.pos() ->> 'posted_funding_tzs', null,
          'a Cashier is not given posted funding');
select is(tests.pos() ->> 'free_to_approve_tzs', '200000',
          'but sees Free to approve for the whole fund');
select tests.cashier();
select is((select count(*)::int from public.imprest_disbursements), 3,
          'the proposing Cashier reads their own three');
select tests.acting_as('e5500000-0000-0000-0000-000000000005'::uuid);
select is((select count(*)::int from public.imprest_disbursements), 0,
          'a Sales Representative reads no disbursement');
select throws_ok($$ select * from api.staff_imprest_spending_position() $$, '42501', null,
                 'nor the spending position');
select tests.director();
select is((select count(*)::int from public.imprest_disbursements), 3, 'a Director reads them all');
select is(tests.pos() ->> 'set_aside_tzs', '0', 'and is given every figure');
reset role;

-- ---------------------------------------------------------------------------
-- AC-97, AC-98 · Approval sets money aside; above Free to approve it is refused
-- ---------------------------------------------------------------------------
select throws_ok(
  format($$ select api.staff_decide_imprest_disbursement(%L, 1, true, null, 'd-dir-ok') $$,
         tests.did('fuel')),
  '42501', null, 'a Director cannot approve');
select tests.cashier();
select throws_ok(
  format($$ select api.staff_decide_imprest_disbursement(%L, 1, true, null, 'd-cash-ok') $$,
         tests.did('fuel')),
  '42501', null, 'nor can the Cashier who proposed it');

select tests.manager();
select is(api.staff_decide_imprest_disbursement(tests.did('fuel'), 9, true, null, 'd-stale')
            ->> 'reason', 'stale', 'a command naming an old version is refused');
select is(tests.keep('fuel.ok',
  api.staff_decide_imprest_disbursement(tests.did('fuel'), 1, true, null, 'd-fuel-ok')),
  'approved', 'the Manager approves TZS 120,000 for fuel');
select is(tests.figures(), '200000/120000/80000',
          'set aside becomes 120,000 and Free to approve 80,000 (AC-97)');
select is(api.staff_decide_imprest_disbursement(tests.did('fuel'), 1, true, null, 'd-fuel-ok')
            ->> 'reason', 'replayed', 'a retried approval replays');
select is(tests.figures(), '200000/120000/80000', 'and sets nothing aside twice');

select is(tests.keep('repairs.ok',
  api.staff_decide_imprest_disbursement(tests.did('repairs'), 1, true, null, 'd-rep-ok')),
  'insufficient_imprest', 'approving TZS 90,000 with 80,000 free is refused (AC-98)');
select is((select res ->> 'free_to_approve_tzs' from r where name = 'repairs.ok'), '80000',
          'the refusal states what was free');
select is(tests.figures(), '200000/120000/80000', 'and every figure stays the same');
select is((select status::text from public.imprest_disbursements where id = tests.did('repairs')),
          'proposed', 'the refused proposal is still awaiting a decision');
select ok(exists (select 1 from public.audit_events
                   where action = 'command_refused'
                     and source_operation = 'api.staff_decide_imprest_disbursement'
                     and entity_id = tests.did('repairs')
                     and after_state ->> 'reason' = 'insufficient_imprest'
                     and actor_role = 'manager'),
          'the refusal is committed to the audit trail with actor and live role');
select ok(exists (select 1 from public.audit_events
                   where action = 'imprest_disbursement_approved'
                     and entity_id = tests.did('fuel')
                     and actor_role = 'manager' and correlation_id is not null),
          'the approval is audited');

-- ---------------------------------------------------------------------------
-- §4.3 · Rejection needs a reason and names no approver
-- ---------------------------------------------------------------------------
select is(api.staff_decide_imprest_disbursement(tests.did('repairs'), 1, false, 'no', 'd-rep-no1')
            ->> 'reason', 'reason_required', 'a rejection needs 3 to 500 characters of reason');
select is(api.staff_decide_imprest_disbursement(tests.did('repairs'), 1, false,
                                                'Quote is too high', 'd-rep-no') ->> 'reason',
          'rejected', 'the Manager rejects with a reason');
select is((select approved_by::text || '|' || rejected_by::text || '|' || rejection_reason
             from public.imprest_disbursements where id = tests.did('repairs')),
          null, 'a rejected disbursement names no approver');
select is((select rejected_by::text || '|' || rejection_reason
             from public.imprest_disbursements where id = tests.did('repairs')),
          'e5500000-0000-0000-0000-000000000003|Quote is too high',
          'and names who decided it and why');
select is(api.staff_decide_imprest_disbursement(tests.did('repairs'), 2, true, null, 'd-rep-late')
            ->> 'reason', 'not_awaiting_decision', 'a rejected disbursement cannot be approved');
select is(api.staff_decide_imprest_disbursement(tests.did('repairs'), 1, false,
                                                'A different reason', 'd-rep-no') ->> 'reason',
          'idempotency_key_conflict', 'a retry with a changed reason is a conflict');

-- ---------------------------------------------------------------------------
-- Withdraw: the proposing Cashier only, before a decision
-- ---------------------------------------------------------------------------
select tests.cashier_b();
select is(api.staff_withdraw_imprest_disbursement(tests.did('meals'), 1, 'Not needed', 'd-w-b')
            ->> 'reason', 'no_disbursement', 'another Cashier cannot withdraw it');
select tests.manager();
select throws_ok(
  format($$ select api.staff_withdraw_imprest_disbursement(%L, 1, 'Not needed', 'd-w-m') $$,
         tests.did('meals')),
  '42501', null, 'nor can the Manager');
select tests.cashier();
select is(api.staff_withdraw_imprest_disbursement(tests.did('meals'), 1, 'no', 'd-w-short')
            ->> 'reason', 'reason_required', 'a withdrawal needs a reason');
select is(api.staff_withdraw_imprest_disbursement(tests.did('meals'), 1, 'Lunch was provided',
                                                  'd-w') ->> 'reason',
          'withdrawn', 'the Cashier withdraws their own proposal');
select is(tests.figures(), '200000/120000/80000',
          'nothing was set aside, so no figure moves');
select is(api.staff_withdraw_imprest_disbursement(tests.did('fuel'), 2, 'Changed mind', 'd-w-fuel')
            ->> 'reason', 'not_awaiting_decision', 'an approved disbursement cannot be withdrawn');

-- ---------------------------------------------------------------------------
-- AC-101 · Cancelling an approval frees the money and keeps the history
-- ---------------------------------------------------------------------------
select tests.director();
select throws_ok(
  format($$ select api.staff_cancel_imprest_disbursement(%L, 2, 'Stop it', 'd-c-dir') $$,
         tests.did('fuel')),
  '42501', null, 'a Director cannot cancel');
select tests.manager();
select is(api.staff_cancel_imprest_disbursement(tests.did('meals'), 2, 'Stop it', 'd-c-meal')
            ->> 'reason', 'not_approved', 'only an approved disbursement can be cancelled');
select is(api.staff_cancel_imprest_disbursement(tests.did('fuel'), 2, 'Generator repaired instead',
                                                'd-c') ->> 'reason',
          'cancelled', 'the Manager cancels the TZS 120,000 approval');
select is(tests.figures(), '200000/0/200000', 'Free to approve returns to TZS 200,000');
select is((select (approved_by is not null and cancelled_by is not null)::text || '|'
                  || cancellation_reason
             from public.imprest_disbursements where id = tests.did('fuel')),
          'true|Generator repaired instead', 'the approval and the cancellation both stay');
select is((select count(*)::int from public.audit_events
            where entity_id = tests.did('fuel')
              and action in ('imprest_disbursement_approved', 'imprest_disbursement_cancelled')),
          2, 'and both are in the audit trail');

-- ---------------------------------------------------------------------------
-- History cannot be rewritten, even by a superuser
-- ---------------------------------------------------------------------------
select throws_ok(
  format($$ update public.imprest_disbursements set status = 'approved', version = version + 1
             where id = %L $$, tests.did('fuel')),
  '23001', null, 'a cancelled disbursement is final');
select throws_ok(
  format($$ delete from public.imprest_disbursements where id = %L $$, tests.did('repairs')),
  '23001', null, 'and no disbursement can be deleted');

select tests.cashier();
set local role authenticated;
select throws_ok(
  $$ insert into public.imprest_disbursements (fund_id, disbursement_no, amount_tzs, category,
                                               purpose, proposed_by)
     values ('e5500000-0000-0000-0000-00000000f001', 'x', 1, 'other', 'Direct write',
             'e5500000-0000-0000-0000-000000000004') $$,
  '42501', null, 'a client cannot insert a disbursement directly');
select throws_ok(
  format($$ update public.imprest_disbursements set purpose = 'Rewritten' where id = %L $$,
         tests.did('meals')),
  '42501', null, 'nor update one');
reset role;
select is((select count(*)::int from (
             select 1 from public.imprest_disbursements
              where status = 'proposed') s), 0, 'nothing is left awaiting a decision');

-- Approval limit is the whole Free to approve: exactly 200,000 is allowed.
select is(tests.keep('big',
  api.staff_propose_imprest_disbursement(200000, 'other', 'Whole float', 'd-big')), 'proposed',
  'a proposal for the whole fund');
select tests.manager();
select is(api.staff_decide_imprest_disbursement(tests.did('big'), 1, true, null, 'd-big-ok')
            ->> 'reason', 'approved', 'an approval equal to Free to approve is allowed');
select is(tests.figures(), '200000/200000/0', 'and nothing is left free');

-- The report stays withheld: no report function mentions a disbursement.
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('api', 'private') and p.proname like '%report%'
              and pg_get_functiondef(p.oid) like '%imprest_disbursement%'), 0,
          'the daily report reads no disbursement');

-- A failed read is a failure: with no active fund the position is empty, never zero.
set local role fv_definer_owner;
update public.imprest_funds set is_active = false;
reset role;
select is((select count(*)::int from api.staff_imprest_spending_position()), 0,
          'with no active fund there is no position row rather than a zero');

select * from finish();
rollback;
