-- Issue #84 · A Director decides who is accountable for an imprest loss or count shortage
--
-- The claims under test, each traceable to issue #84's acceptance criteria:
--
--   1   Only a live Director records a decision. The Manager, the Cashier and the Sales
--       Representative are refused by the database, and each refusal is committed to the audit trail
--       with the actor's live role. An account that is not live is refused before anything is written.
--   2   The decision is written and required. Responsible staff are optional: a decision names one to
--       ten of them, or states that nobody has been identified, never both and never neither.
--   3   A subject gets at most one decision, and it is never changed or deleted by any role.
--   4   A decision posts nothing: no posting, no balance change, no stock movement. It closes the
--       subject's place in the Directors' undecided list and in what a fund still waits on.
--   5   A reversed loss is no longer waiting and cannot be decided.
--   6   Success is on the audit trail with actor, live role, operation, entity and correlation id,
--       and a lost answer is replayed by its key.

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

select tests.mk_user('e8400000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('e8400000-0000-0000-0000-000000000002'::uuid);  -- Second Director
select tests.mk_user('e8400000-0000-0000-0000-000000000003'::uuid);  -- Manager
select tests.mk_user('e8400000-0000-0000-0000-000000000004'::uuid);  -- Cashier
select tests.mk_user('e8400000-0000-0000-0000-000000000005'::uuid);  -- Sales Representative
select tests.mk_user('e8400000-0000-0000-0000-000000000006'::uuid);  -- Disabled Director

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('e8400000-0000-0000-0000-000000000001', 'Decision Director', '+255700084001', true,  false),
  ('e8400000-0000-0000-0000-000000000002', 'Second Director',   '+255700084002', true,  false),
  ('e8400000-0000-0000-0000-000000000003', 'Decision Manager',  '+255700084003', true,  false),
  ('e8400000-0000-0000-0000-000000000004', 'Decision Cashier',  '+255700084004', true,  false),
  ('e8400000-0000-0000-0000-000000000005', 'Decision Rep',      '+255700084005', true,  false),
  ('e8400000-0000-0000-0000-000000000006', 'Gone Director',     '+255700084006', false, false);

insert into public.user_roles (user_id, role) values
  ('e8400000-0000-0000-0000-000000000001', 'director'),
  ('e8400000-0000-0000-0000-000000000002', 'director'),
  ('e8400000-0000-0000-0000-000000000003', 'manager'),
  ('e8400000-0000-0000-0000-000000000004', 'cashier'),
  ('e8400000-0000-0000-0000-000000000005', 'sales_rep'),
  ('e8400000-0000-0000-0000-000000000006', 'director');

create or replace function tests.director() returns void language sql as $$
  select tests.acting_as('e8400000-0000-0000-0000-000000000001'::uuid); $$;
create or replace function tests.director_b() returns void language sql as $$
  select tests.acting_as('e8400000-0000-0000-0000-000000000002'::uuid); $$;
create or replace function tests.manager() returns void language sql as $$
  select tests.acting_as('e8400000-0000-0000-0000-000000000003'::uuid); $$;
create or replace function tests.cashier() returns void language sql as $$
  select tests.acting_as('e8400000-0000-0000-0000-000000000004'::uuid); $$;
create or replace function tests.rep() returns void language sql as $$
  select tests.acting_as('e8400000-0000-0000-0000-000000000005'::uuid); $$;

create temp table r (name text primary key, res jsonb not null);
grant all on r to public;
create or replace function tests.keep(p_name text, p_res jsonb) returns text language sql as $$
  insert into r values (p_name, p_res) returning res ->> 'reason';
$$;
create or replace function tests.did(p_name text) returns uuid language sql as $$
  select (res -> 'disbursement' ->> 'id')::uuid from r where name = p_name; $$;
create or replace function tests.cid(p_name text) returns uuid language sql as $$
  select (res -> 'count' ->> 'id')::uuid from r where name = p_name; $$;
create or replace function tests.sid(p_id uuid) returns uuid language sql security definer as $$
  select id from public.imprest_settlements where disbursement_id = p_id order by cycle desc limit 1; $$;
create or replace function tests.pid(p_id uuid, p_kind text) returns uuid language sql
  security definer as $$
  select id from public.imprest_postings
   where disbursement_id = p_id and kind::text = p_kind and entry = 'original'; $$;
create or replace function tests.shortage() returns uuid language sql security definer as $$
  select id from public.imprest_count_postings where kind = 'count_shortage'
   and fund_id = 'e8400000-0000-0000-0000-00000000f001'; $$;
create or replace function tests.line(p_amount bigint, p_purpose text) returns jsonb language sql as $$
  select jsonb_build_object('amount_tzs', p_amount, 'purpose', p_purpose, 'receipt_id', null,
                            'no_receipt_reason', 'transport_fare', 'no_receipt_note', null); $$;
-- posted balance / set aside / free to approve, and every posting and stock row there is.
create or replace function tests.money() returns text language sql security definer as $$
  select s.posted_balance_tzs || '/' || s.set_aside_tzs || '/' || s.free_to_approve_tzs || '|'
         || (select count(*) from public.imprest_postings) || '/'
         || (select count(*) from public.imprest_count_postings) || '/'
         || (select count(*) from public.inventory_ledger)
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active; $$;
create or replace function tests.decide(p_type text, p_subject uuid, p_decision text,
                                        p_nobody boolean, p_staff uuid[], p_key text)
returns jsonb language sql as $$
  select api.admin_record_accountability_decision(p_type, p_subject, p_decision, p_nobody, p_staff,
                                                  p_key); $$;
create or replace function tests.waiting() returns text language sql as $$
  select coalesce(string_agg(u ->> 'subject_type', ',' order by u ->> 'subject_type'), '')
    from jsonb_array_elements(api.admin_accountability_queue() -> 'undecided') u
   where (u ->> 'fund_id')::uuid = 'e8400000-0000-0000-0000-00000000f001'; $$;
create or replace function tests.refusals(p_actor uuid) returns bigint language sql
  security definer as $$
  select count(*) from public.audit_events
   where action = 'command_refused' and actor_id = p_actor
     and source_operation = 'api.admin_record_accountability_decision'; $$;

-- ---------------------------------------------------------------------------
-- The shape: two tables no client writes, and no role that may change a decision
-- ---------------------------------------------------------------------------
select ok(
  not has_table_privilege('authenticated', 'public.accountability_decisions', 'insert')
  and not has_table_privilege('authenticated', 'public.accountability_decisions', 'update')
  and not has_table_privilege('authenticated', 'public.accountability_decisions', 'delete')
  and has_table_privilege('authenticated', 'public.accountability_decisions', 'select')
  and not has_table_privilege('authenticated', 'public.accountability_decision_staff', 'insert')
  and not has_table_privilege('anon', 'public.accountability_decisions', 'select')
  and not has_table_privilege('service_role', 'public.accountability_decisions', 'select')
  and not has_table_privilege('fv_definer_owner', 'public.accountability_decisions', 'update')
  and not has_table_privilege('fv_definer_owner', 'public.accountability_decisions', 'delete')
  and not has_table_privilege('fv_definer_owner', 'public.accountability_decision_staff', 'delete'),
  'no role writes a decision except through the command, and nobody may update or delete one');

select ok((select relrowsecurity from pg_class where oid = 'public.accountability_decisions'::regclass)
          and (select relrowsecurity from pg_class
                where oid = 'public.accountability_decision_staff'::regclass),
          'both tables have row-level security');

select ok(
  has_function_privilege('authenticated',
    'api.admin_record_accountability_decision(text,uuid,text,boolean,uuid[],text)', 'execute')
  and not has_function_privilege('anon',
    'api.admin_record_accountability_decision(text,uuid,text,boolean,uuid[],text)', 'execute')
  and not has_function_privilege('authenticated',
    'private.impl_admin_record_accountability_decision(text,uuid,text,boolean,uuid[],text)', 'execute'),
  'the command is reached only through its api wrapper, by a signed-in caller');

select ok(not exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = 'accountability_decisions'
                         and (column_name like '%amount%' or column_name like '%outcome%'
                              or column_name like '%recover%' or column_name like '%payroll%')),
          'a decision has no amount, no outcome list, no recovery and nothing payroll');

-- ---------------------------------------------------------------------------
-- The ground: 100,000 posted; a trip settled 500 short and verified; a fuel run settled 1,000 short
-- and verified; and today's count short, confirmed as a suspected loss.
-- ---------------------------------------------------------------------------
set local role fv_definer_owner;
insert into public.imprest_funds (id, opened_by) values
  ('e8400000-0000-0000-0000-00000000f001', 'e8400000-0000-0000-0000-000000000003');
insert into public.imprest_fundings (id, funding_no, fund_id, requested_amount_tzs, reason,
                                     requested_by)
values ('e8400000-0000-0000-0000-00000000f101', 'FV-IMP-TEST-8401',
        'e8400000-0000-0000-0000-00000000f001', 100000, 'Opening float',
        'e8400000-0000-0000-0000-000000000003');
insert into public.imprest_funding_handovers (id, funding_id, cycle, amount_tzs, provided_by)
values ('e8400000-0000-0000-0000-00000000f201', 'e8400000-0000-0000-0000-00000000f101', 1, 100000,
        'e8400000-0000-0000-0000-000000000001');
update public.imprest_fundings
   set status = 'received', version = version + 1,
       received_handover_id = 'e8400000-0000-0000-0000-00000000f201',
       received_amount_tzs = 100000, received_by = 'e8400000-0000-0000-0000-000000000003',
       received_at = now()
 where id = 'e8400000-0000-0000-0000-00000000f101';
reset role;

select tests.cashier();
select tests.keep('trip', api.staff_propose_imprest_disbursement(
  10000, 'transport_and_delivery', 'Trip allowance', 'a84-p-trip'));
select tests.keep('fuel', api.staff_propose_imprest_disbursement(
  4000, 'transport_and_delivery', 'Fuel run', 'a84-p-fuel'));
select tests.manager();
select tests.keep('a-trip', api.staff_decide_imprest_disbursement(tests.did('trip'), 1, true, null, 'a84-a-trip'));
select tests.keep('a-fuel', api.staff_decide_imprest_disbursement(tests.did('fuel'), 1, true, null, 'a84-a-fuel'));
select tests.cashier();
select tests.keep('h-trip', api.staff_hand_out_imprest_disbursement(tests.did('trip'), 2, 'Juma', 'a84-h-trip'));
select tests.keep('h-fuel', api.staff_hand_out_imprest_disbursement(tests.did('fuel'), 2, 'Asha', 'a84-h-fuel'));
select tests.keep('s-trip', api.staff_settle_imprest_disbursement(
  tests.did('trip'), 3, jsonb_build_array(tests.line(8000, 'Fare')), 1500,
  'Change lost on the road', 'a84-s-trip'));
select tests.keep('s-fuel', api.staff_settle_imprest_disbursement(
  tests.did('fuel'), 3, jsonb_build_array(tests.line(3000, 'Diesel')), 0,
  'Receipt blew away', 'a84-s-fuel'));
select tests.manager();
select is(tests.keep('v-trip', api.staff_verify_imprest_disbursement(
            tests.did('trip'), 4, tests.sid(tests.did('trip')), 'a84-v-trip')),
          'verified', 'the trip is verified: a 500 unexplained loss posts');
select is(tests.keep('v-fuel', api.staff_verify_imprest_disbursement(
            tests.did('fuel'), 4, tests.sid(tests.did('fuel')), 'a84-v-fuel')),
          'verified', 'the fuel run is verified: a 1,000 unexplained loss posts');

select tests.cashier();
select is(tests.keep('c1', api.staff_enter_imprest_count(private.imprest_business_date(), null, 1000,
                                                         null, null, 'a84-c1')),
          'counted', 'the Cashier counts the tin short');
select tests.manager();
select is(api.staff_confirm_imprest_count(tests.cid('c1'), 1, 'counting_error', null,
                                          'a84-k1') ->> 'reason',
          'confirmed', 'and the Manager confirms the shortage');
select isnt(tests.shortage(), null, 'the confirmed count posted a shortage');

-- ---------------------------------------------------------------------------
-- 4 · Everything waits, and a Director sees it all
-- ---------------------------------------------------------------------------
select tests.director();
select is(tests.waiting(), 'imprest_count_shortage,imprest_unexplained_loss,imprest_unexplained_loss',
          'the Directors'' list shows both losses and the shortage, undecided');
select ok(
  (select bool_and(u ? 'amount_tzs' and u ? 'posted_at' and u ? 'fund_retired')
     from jsonb_array_elements(api.admin_accountability_queue() -> 'undecided') u),
  'each undecided subject comes with its amount, when it posted and whether its fund is retired');
select ok(
  exists (select 1 from jsonb_array_elements(api.admin_accountability_queue() -> 'staff') s
           where s ->> 'id' = 'e8400000-0000-0000-0000-000000000004' and s ->> 'role' = 'cashier'),
  'and the staff a decision may name');

-- 1 · Only a Director reads the list.
select tests.manager();
select throws_ok($$ select api.admin_accountability_queue() $$, '42501', null,
                 'the Manager is refused the Directors'' list');
select tests.cashier();
select throws_ok($$ select api.admin_accountability_queue() $$, '42501', null,
                 'and so is the Cashier');

-- ---------------------------------------------------------------------------
-- 1 · Every other role is refused, on the record
-- ---------------------------------------------------------------------------
create temp table before_refusals as select tests.money() as money;
grant all on before_refusals to public;

select tests.manager();
select is(tests.decide('imprest_unexplained_loss', tests.pid(tests.did('trip'), 'unexplained_loss'),
                       'The Manager decides', true, null, 'a84-m') ->> 'reason',
          'director_only', 'the Manager is refused');
select tests.cashier();
select is(tests.decide('imprest_count_shortage', tests.shortage(), 'The Cashier decides', true, null,
                       'a84-c') ->> 'reason',
          'director_only', 'the Cashier is refused');
select tests.rep();
select is(tests.decide('imprest_unexplained_loss', tests.pid(tests.did('trip'), 'unexplained_loss'),
                       'The rep decides', true, null, 'a84-r') ->> 'reason',
          'director_only', 'the Sales Representative is refused');

select ok(
  (select count(*) = 3 from public.audit_events
    where action = 'command_refused'
      and source_operation = 'api.admin_record_accountability_decision'
      and after_state ->> 'reason' = 'director_only'
      and correlation_id is not null and occurred_at is not null
      and ((actor_id = 'e8400000-0000-0000-0000-000000000003' and actor_role = 'manager'
            and entity_type = 'imprest_posting')
        or (actor_id = 'e8400000-0000-0000-0000-000000000004' and actor_role = 'cashier'
            and entity_type = 'imprest_count_posting')
        or (actor_id = 'e8400000-0000-0000-0000-000000000005' and actor_role = 'sales_rep'
            and entity_type = 'imprest_posting'))),
  'each refusal is committed with the actor, their live role, the operation, entity and correlation id');

select tests.acting_as('e8400000-0000-0000-0000-000000000006'::uuid);
select throws_ok(
  $$ select tests.decide('imprest_count_shortage', tests.shortage(), 'Gone', true, null, 'a84-g') $$,
  '42501', null, 'a Director whose account is not live is refused before anything is written');
select set_config('request.jwt.claims', '', true);
select throws_ok(
  $$ select tests.decide('imprest_count_shortage', tests.shortage(), 'Nobody', true, null, 'a84-n') $$,
  '42501', null, 'and so is a request with no session');

select is((select count(*) from public.accountability_decisions), 0::bigint,
          'no refused attempt wrote a decision');

-- ---------------------------------------------------------------------------
-- 2 · The written record is required, and so is an answer on who is responsible
-- ---------------------------------------------------------------------------
select tests.director();
select is(tests.decide('imprest_unexplained_loss', tests.pid(tests.did('trip'), 'unexplained_loss'),
                       '   ', true, null, 'a84-e1') ->> 'reason',
          'decision_required', 'a blank decision is refused');
select is(tests.decide('imprest_unexplained_loss', tests.pid(tests.did('trip'), 'unexplained_loss'),
                       E'
	 
', true, null, 'a84-e2b') ->> 'reason',
          'decision_required', 'and so is one of only tabs and line breaks');
select is(tests.decide('imprest_unexplained_loss', tests.pid(tests.did('trip'), 'unexplained_loss'),
                       null, true, null, 'a84-e2') ->> 'reason',
          'decision_required', 'and so is a missing one');
select is(tests.decide('imprest_unexplained_loss', tests.pid(tests.did('trip'), 'unexplained_loss'),
                       repeat('x', 2001), true, null, 'a84-e3') ->> 'reason',
          'decision_required', 'and one over 2,000 characters');
select is(tests.decide('imprest_unexplained_loss', tests.pid(tests.did('trip'), 'unexplained_loss'),
                       'Driver to repay', null, null, 'a84-e4') ->> 'reason',
          'responsible_required', 'a decision must say whether anyone is responsible');
select is(tests.decide('imprest_unexplained_loss', tests.pid(tests.did('trip'), 'unexplained_loss'),
                       'Driver to repay', false, '{}', 'a84-e5') ->> 'reason',
          'responsible_required', 'naming somebody needs at least one name');
select is(tests.decide('imprest_unexplained_loss', tests.pid(tests.did('trip'), 'unexplained_loss'),
                       'Driver to repay', true,
                       array['e8400000-0000-0000-0000-000000000004'::uuid], 'a84-e6') ->> 'reason',
          'responsible_conflict', 'and nobody identified names nobody');
select is(tests.decide('imprest_unexplained_loss', tests.pid(tests.did('trip'), 'unexplained_loss'),
                       'Driver to repay', false, array[gen_random_uuid()], 'a84-e7') ->> 'reason',
          'unknown_staff', 'a responsible person must be a member of staff');
select is(tests.decide('imprest_unexplained_loss', tests.pid(tests.did('trip'), 'expense'),
                       'Not a loss', true, null, 'a84-e8') ->> 'reason',
          'no_subject', 'an expense is not a subject');
select is(tests.decide('imprest_count_shortage', tests.pid(tests.did('trip'), 'unexplained_loss'),
                       'Wrong kind', true, null, 'a84-e9') ->> 'reason',
          'no_subject', 'a loss named as a shortage is not found');
select is(tests.decide('till_variance', tests.shortage(), 'Not yet', true, null, 'a84-e10') ->> 'reason',
          'no_subject', 'a subject type that does not exist yet is refused');
select ok(
  (select count(*) = 11 from public.audit_events
    where action = 'command_refused' and actor_id = 'e8400000-0000-0000-0000-000000000001'
      and actor_role = 'director'
      and source_operation = 'api.admin_record_accountability_decision'),
  'a Director''s refusals are on the trail too');

select is(tests.money(), (select money from before_refusals), 'no refusal moved anything');

-- ---------------------------------------------------------------------------
-- 3, 4 and 6 · A Director decides; it posts nothing and closes the subject
-- ---------------------------------------------------------------------------
select is(tests.keep('d-trip', tests.decide(
            'imprest_unexplained_loss', tests.pid(tests.did('trip'), 'unexplained_loss'),
            '  The driver lost the change; he repays it from his own pocket.  ', false,
            array['e8400000-0000-0000-0000-000000000004'::uuid,
                  'e8400000-0000-0000-0000-000000000004'::uuid,
                  'e8400000-0000-0000-0000-000000000003'::uuid], 'a84-d-trip')),
          'recorded', 'a Director records a decision naming two people');
select ok(
  (select d ->> 'decision' = 'The driver lost the change; he repays it from his own pocket.'
          and (d ->> 'nobody_identified')::boolean = false
          and d ->> 'decided_by' = 'e8400000-0000-0000-0000-000000000001'
          and d ->> 'decided_at' is not null
          and jsonb_array_length(d -> 'responsible') = 2
     from (select res -> 'decision' as d from r where name = 'd-trip') x),
  'it stores the written decision, the Director, the time and each person named once');

select is(tests.keep('d-short', tests.decide(
            'imprest_count_shortage', tests.shortage(), 'Nobody could explain the shortage.', true,
            null, 'a84-d-short')),
          'recorded', 'a decision may state that nobody has been identified');

select is(tests.money(), (select money from before_refusals),
          'no decision posted anything, changed a balance or moved stock');

select ok(
  (select count(*) = 2 from public.audit_events e
     join public.accountability_decisions a on a.id = e.entity_id
    where e.action = 'accountability_decision_recorded'
      and e.entity_type = 'accountability_decision'
      and e.actor_id = 'e8400000-0000-0000-0000-000000000001' and e.actor_role = 'director'
      and e.source_operation = 'api.admin_record_accountability_decision'
      and e.correlation_id = a.correlation_id and e.occurred_at is not null),
  'each success is audited with actor, live role, operation, entity, timestamp and correlation id');

select is(tests.waiting(), 'imprest_unexplained_loss',
          'the decided loss and shortage leave the list; the fuel run''s loss still waits');
select ok(
  jsonb_array_length(private.imprest_fund_unresolved('e8400000-0000-0000-0000-00000000f001') -> 'losses') = 1
  and jsonb_array_length(private.imprest_fund_unresolved('e8400000-0000-0000-0000-00000000f001') -> 'shortages') = 0,
  'and what the fund still waits on no longer lists them');
select ok(
  exists (select 1 from jsonb_array_elements(api.admin_accountability_queue() -> 'decided') d
           where d ->> 'subject_type' = 'imprest_count_shortage'
             and (d ->> 'nobody_identified')::boolean),
  'the decided list shows the latest decisions');

-- 6 · A lost answer is replayed; a reused key with different words is not.
select is(tests.decide('imprest_count_shortage', tests.shortage(), 'Nobody could explain the shortage.',
                       true, null, 'a84-d-short') ->> 'reason',
          'replayed', 'the same request under the same key is replayed');
select is(tests.decide('imprest_count_shortage', tests.shortage(), 'Something else.', true, null,
                       'a84-d-short') ->> 'reason',
          'idempotency_key_conflict', 'and the same key with other words is a conflict');

-- 3 · One decision per subject, by any Director, and no way to change it.
select tests.director_b();
select is(tests.decide('imprest_count_shortage', tests.shortage(), 'A second view.', true, null,
                       'a84-d-short-2') ->> 'reason',
          'already_decided', 'a second Director cannot decide it again');
select is((select count(*) from public.accountability_decisions), 2::bigint, 'still two decisions');

set local role fv_definer_owner;
select throws_ok(
  $$ update public.accountability_decisions set decision = 'Rewritten' $$,
  '42501', null, 'not even the command owner may rewrite a decision');
select throws_ok(
  $$ delete from public.accountability_decisions $$, '42501', null, 'or delete one');
select throws_ok(
  $$ delete from public.accountability_decision_staff $$, '42501', null, 'or remove who it names');
select throws_ok(
  format($$ insert into public.accountability_decisions (subject_type, imprest_count_posting_id,
              fund_id, decision, nobody_identified, decided_by, correlation_id)
            values ('imprest_count_shortage', %L, 'e8400000-0000-0000-0000-00000000f001',
                    'A replacement', true, 'e8400000-0000-0000-0000-000000000001', gen_random_uuid()) $$,
         tests.shortage()),
  '23505', null, 'and a second row for the same subject breaks the unique constraint');
select throws_ok(
  format($$ insert into public.accountability_decisions (subject_type, imprest_posting_id,
              fund_id, decision, nobody_identified, decided_by, correlation_id)
            values ('imprest_unexplained_loss', %L, 'e8400000-0000-0000-0000-00000000f001',
                    E'
	
', true, 'e8400000-0000-0000-0000-000000000001', gen_random_uuid()) $$,
         tests.pid(tests.did('fuel'), 'unexplained_loss')),
  '23514', null, 'and the table itself refuses a decision of only whitespace');
reset role;

-- ---------------------------------------------------------------------------
-- 5 · A reversed loss is no longer waiting, and cannot be decided
-- ---------------------------------------------------------------------------
select tests.cashier();
select is(api.staff_request_imprest_reversal(tests.pid(tests.did('fuel'), 'unexplained_loss'), 0,
                                             'The receipt was found', 'a84-rq') ->> 'reason',
          'requested', 'the Cashier asks for the fuel run''s loss to be reversed');
select tests.director();
select is(api.admin_decide_imprest_reversal(
            (select id from public.imprest_posting_reversals
              where posting_id = tests.pid(tests.did('fuel'), 'unexplained_loss')),
            1, true, null, 'a84-rv') ->> 'reason',
          'approved', 'and a Director approves it');
select is(tests.waiting(), '', 'the reversed loss leaves the list');
select is(tests.decide('imprest_unexplained_loss', tests.pid(tests.did('fuel'), 'unexplained_loss'),
                       'Too late', true, null, 'a84-d-fuel') ->> 'reason',
          'subject_reversed', 'and a decision on it is refused');

select * from finish();
rollback;
