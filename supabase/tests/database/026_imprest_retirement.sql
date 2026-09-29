-- Issue #72 · Imprest: retire the fund and carry its balance into the next one
--
-- The claims under test, each traceable to issue #72's acceptance criteria:
--
--   1   Only a live Manager submits, with a reason. Submission is refused, naming each blocker,
--       while a disbursement, funding, raised approval or reversal request is open, or a count waits.
--   2   A confirmed count for the current business day, taken after the last posting, is required.
--       Earlier Not counted days stay on the record and are listed on the submission.
--   3   Only a Director approves or rejects, with a reason on rejection. Version-checked, idempotent.
--   4   Approval closes the fund. The retired fund keeps every figure, posting, count, shortage,
--       unexplained loss and open Director decision, visible and read-only.
--   5   The closing balance is the next fund's opening balance: its own posting, linked to the
--       retired fund, counted once and never twice.
--   6   The carried balance is visible to the Manager and Directors; retired funds are listed with
--       their dates, closing balance and anything unresolved.
--   7   Every success and committed refusal is on the audit trail.

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

select tests.mk_user('e9000000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('e9000000-0000-0000-0000-000000000002'::uuid);  -- Second Director
select tests.mk_user('e9000000-0000-0000-0000-000000000003'::uuid);  -- Manager
select tests.mk_user('e9000000-0000-0000-0000-000000000004'::uuid);  -- Cashier
select tests.mk_user('e9000000-0000-0000-0000-000000000005'::uuid);  -- Sales Representative
select tests.mk_user('e9000000-0000-0000-0000-000000000006'::uuid);  -- Disabled Manager

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('e9000000-0000-0000-0000-000000000001', 'Retire Director', '+255700009001', true,  false),
  ('e9000000-0000-0000-0000-000000000002', 'Second Director', '+255700009002', true,  false),
  ('e9000000-0000-0000-0000-000000000003', 'Retire Manager',  '+255700009003', true,  false),
  ('e9000000-0000-0000-0000-000000000004', 'Retire Cashier',  '+255700009004', true,  false),
  ('e9000000-0000-0000-0000-000000000005', 'Retire Rep',      '+255700009005', true,  false),
  ('e9000000-0000-0000-0000-000000000006', 'Gone Manager',    '+255700009006', false, false);

insert into public.user_roles (user_id, role) values
  ('e9000000-0000-0000-0000-000000000001', 'director'),
  ('e9000000-0000-0000-0000-000000000002', 'director'),
  ('e9000000-0000-0000-0000-000000000003', 'manager'),
  ('e9000000-0000-0000-0000-000000000004', 'cashier'),
  ('e9000000-0000-0000-0000-000000000005', 'sales_rep'),
  ('e9000000-0000-0000-0000-000000000006', 'manager');

create or replace function tests.director() returns void language sql as $$
  select tests.acting_as('e9000000-0000-0000-0000-000000000001'::uuid); $$;
create or replace function tests.director_b() returns void language sql as $$
  select tests.acting_as('e9000000-0000-0000-0000-000000000002'::uuid); $$;
create or replace function tests.manager() returns void language sql as $$
  select tests.acting_as('e9000000-0000-0000-0000-000000000003'::uuid); $$;
create or replace function tests.cashier() returns void language sql as $$
  select tests.acting_as('e9000000-0000-0000-0000-000000000004'::uuid); $$;
create or replace function tests.rep() returns void language sql as $$
  select tests.acting_as('e9000000-0000-0000-0000-000000000005'::uuid); $$;
create or replace function tests.gone() returns void language sql as $$
  select tests.acting_as('e9000000-0000-0000-0000-000000000006'::uuid); $$;

create temp table r (name text primary key, res jsonb not null);
grant all on r to public;
-- A retry under the same key keeps the first answer and returns its own.
create or replace function tests.keep(p_name text, p_res jsonb) returns text language sql as $$
  insert into r values (p_name, p_res) on conflict (name) do nothing;
  select p_res ->> 'reason';
$$;
create or replace function tests.res(p_name text) returns jsonb language sql as $$
  select res from r where name = p_name; $$;
create or replace function tests.did(p_name text) returns uuid language sql as $$
  select (res -> 'disbursement' ->> 'id')::uuid from r where name = p_name; $$;
create or replace function tests.cid(p_name text) returns uuid language sql as $$
  select (res -> 'count' ->> 'id')::uuid from r where name = p_name; $$;
create or replace function tests.rid(p_name text) returns uuid language sql as $$
  select (res -> 'retirement' ->> 'id')::uuid from r where name = p_name; $$;
create or replace function tests.fid(p_name text) returns uuid language sql as $$
  select (res -> 'funding' ->> 'id')::uuid from r where name = p_name; $$;
create or replace function tests.dver(p_id uuid) returns integer language sql security definer as $$
  select version from public.imprest_disbursements where id = p_id; $$;
create or replace function tests.sid(p_id uuid) returns uuid language sql security definer as $$
  select id from public.imprest_settlements where disbursement_id = p_id order by cycle desc limit 1; $$;
create or replace function tests.pid(p_id uuid, p_kind text) returns uuid language sql
  security definer as $$
  select id from public.imprest_postings
   where disbursement_id = p_id and kind::text = p_kind and entry = 'original'; $$;
create or replace function tests.line(p_amount bigint, p_purpose text) returns jsonb language sql as $$
  select jsonb_build_object('amount_tzs', p_amount, 'purpose', p_purpose, 'receipt_id', null,
                            'no_receipt_reason', 'transport_fare', 'no_receipt_note', null); $$;
create or replace function tests.active() returns uuid language sql security definer as $$
  select id from public.imprest_funds where is_active; $$;
-- posted funding / posted balance / set aside / free to approve of one fund
create or replace function tests.figures(p_fund uuid) returns text language sql security definer as $$
  select s.posted_funding_tzs || '/' || s.posted_balance_tzs || '/' || s.set_aside_tzs || '/'
         || s.free_to_approve_tzs
    from private.imprest_spending_figures(p_fund) s; $$;
create or replace function tests.days(p_fund uuid) returns text language sql security definer as $$
  select string_agg(d.business_date::text || ':' || d.state, ',' order by d.business_date)
    from private.imprest_count_days(p_fund) d; $$;
create or replace function tests.submit(p_count uuid, p_reason text, p_key text) returns text
language sql as $$
  select tests.keep(p_key, api.staff_submit_imprest_retirement(p_count, p_reason, p_key)); $$;
create or replace function tests.decide(p_id uuid, p_version integer, p_approve boolean,
                                        p_reason text, p_key text) returns text language sql as $$
  select tests.keep(p_key, api.admin_decide_imprest_retirement(p_id, p_version, p_approve, p_reason,
                                                               p_key)); $$;
create or replace function tests.rver(p_id uuid) returns integer language sql security definer as $$
  select version from public.imprest_retirements where id = p_id; $$;
-- Received funding, as a Director and the Manager would record it, into the active fund.
create or replace function tests.fund(p_amount bigint, p_key text) returns void language plpgsql as $$
declare v_id uuid;
begin
  perform tests.manager();
  perform tests.keep(p_key, api.staff_request_imprest_funding(p_amount, 'Top up', p_key));
  v_id := tests.fid(p_key);
  perform tests.director();
  perform api.admin_decide_imprest_funding(v_id, 1, true, p_amount, null, p_key || '-a');
  perform api.admin_record_imprest_provided(v_id, 2, p_amount, p_key || '-p');
  perform tests.manager();
  perform api.staff_confirm_imprest_received(v_id, 3,
    (select handover_id from public.imprest_funding_summaries where id = v_id), p_key || '-r');
end $$;

-- The business clock. T is today as it reads now; `tests.end_day` moves it one day on.
create temp table clock (days integer not null);
insert into clock values (0);
grant all on clock to public;
create or replace function tests.t() returns date language plpgsql as $$
begin
  return (now() at time zone 'Africa/Dar_es_Salaam')::date + (select days from clock);
end $$;
create or replace function tests.end_day() returns void language plpgsql as $$
declare v_days integer;
begin
  update clock set days = days + 1 returning days into v_days;
  set local role fv_definer_owner;
  execute format($f$
    create or replace function private.imprest_business_date() returns date language sql stable
    set search_path = '' as $b$ select (now() at time zone 'Africa/Dar_es_Salaam')::date + %s $b$
  $f$, v_days);
  reset role;
end $$;
create or replace function tests.count(p_counted bigint, p_key text) returns text language sql as $$
  select tests.keep(p_key, api.staff_enter_imprest_count(tests.t(), null, p_counted, null, null,
                                                         p_key)); $$;

-- ---------------------------------------------------------------------------
-- The shape
-- ---------------------------------------------------------------------------
select ok(
  not has_table_privilege('authenticated', 'public.imprest_retirements', 'insert')
  and not has_table_privilege('authenticated', 'public.imprest_retirements', 'update')
  and not has_table_privilege('authenticated', 'public.imprest_retirements', 'delete')
  and has_table_privilege('authenticated', 'public.imprest_retirements', 'select')
  and not has_table_privilege('authenticated', 'public.imprest_fund_openings', 'insert')
  and has_table_privilege('authenticated', 'public.imprest_fund_openings', 'select')
  and not has_table_privilege('service_role', 'public.imprest_retirements', 'select')
  and not has_table_privilege('anon', 'public.imprest_fund_openings', 'select')
  and not has_table_privilege('fv_definer_owner', 'public.imprest_retirements', 'delete')
  and not has_table_privilege('fv_definer_owner', 'public.imprest_fund_openings', 'update')
  and not has_table_privilege('fv_definer_owner', 'public.imprest_fund_openings', 'delete'),
  'no role writes a retirement or an opening except through the commands');

select ok((select relrowsecurity from pg_class where oid = 'public.imprest_retirements'::regclass)
          and (select relrowsecurity from pg_class where oid = 'public.imprest_fund_openings'::regclass),
          'both tables have row-level security');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     join pg_roles o on o.oid = p.proowner
    where n.nspname = 'api'
      and p.proname in ('staff_submit_imprest_retirement', 'admin_decide_imprest_retirement',
                        'staff_imprest_fund_state', 'staff_imprest_retired_funds',
                        'staff_imprest_fund_record')
      and p.prosecdef and o.rolname = 'fv_definer_owner'
      and has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('service_role', p.oid, 'execute')),
  5,
  'the two commands and three reads are security definer, owned by fv_definer_owner, staff only');

-- ---------------------------------------------------------------------------
-- A fund opened three days ago, counting from then. TZS 200,000 posted.
-- ---------------------------------------------------------------------------
set local role fv_definer_owner;
insert into public.imprest_funds (id, opened_by, opened_at) values
  ('e9000000-0000-0000-0000-00000000f001', 'e9000000-0000-0000-0000-000000000003',
   now() - interval '3 days');
do $$ begin
  execute format($f$ create or replace function private.imprest_counting_starts_on() returns date
    language sql immutable set search_path = '' as $b$ select %L::date $b$ $f$, tests.t() - 3);
end $$;
reset role;
select tests.fund(200000, 'f-open');

-- The trip: 60,000, settled as Used 47,000, Returned 10,000, Not accounted for 3,000, verified.
select tests.cashier();
select tests.keep('trip', api.staff_propose_imprest_disbursement(
  60000, 'transport_and_delivery', 'Trip allowance', 'p-trip'));
select tests.manager();
select tests.keep('a-trip', api.staff_decide_imprest_disbursement(tests.did('trip'), 1, true, null, 'a-trip'));
select tests.cashier();
select tests.keep('h-trip', api.staff_hand_out_imprest_disbursement(tests.did('trip'), 2, 'Juma', 'h-trip'));
select tests.keep('s-trip', api.staff_settle_imprest_disbursement(
  tests.did('trip'), 3, jsonb_build_array(tests.line(47000, 'Fare')), 10000, 'Change lost', 's-trip'));
select tests.manager();
select is(tests.keep('v-trip', api.staff_verify_imprest_disbursement(
            tests.did('trip'), 4, tests.sid(tests.did('trip')), 'v-trip')),
          'verified', 'the trip is verified: a 47,000 expense and a 3,000 unexplained loss post');

-- Open things of every kind: a proposal, a funding request, a reversal request, a raised approval
-- request, and a count waiting for the Manager.
select tests.cashier();
select tests.keep('levy', api.staff_propose_imprest_disbursement(10000, 'fees_and_charges', 'Council levy', 'p-levy'));
select tests.keep('fuel', api.staff_propose_imprest_disbursement(20000, 'fuel_and_lubricants', 'Diesel', 'p-fuel'));
select tests.keep('rv', api.staff_request_imprest_reversal(
  tests.pid(tests.did('trip'), 'expense'), 45000, 'Receipt shows 45,000', 'q-rv'));
select tests.manager();
select tests.keep('a-fuel', api.staff_decide_imprest_disbursement(tests.did('fuel'), 1, true, null, 'a-fuel'));
select tests.keep('more', api.staff_request_imprest_funding(50000, 'Next week', 'f-more'));
select tests.cashier();
select tests.keep('h-fuel', api.staff_hand_out_imprest_disbursement(tests.did('fuel'), 2, 'Station', 'h-fuel'));
select tests.keep('rq-fuel', api.staff_request_imprest_raise(tests.did('fuel'), 3, 5000, 'Price went up', 'rq-fuel'));
select is(tests.count(129000, 'c-1'), 'counted', 'a count waits for the Manager');

-- ---------------------------------------------------------------------------
-- Criterion 1 · Who submits, and what stops it
-- ---------------------------------------------------------------------------
select tests.director();
select throws_ok($$ select api.staff_submit_imprest_retirement(null, 'Month end', 'x-dir') $$,
                 '42501', null, 'a Director does not submit');
select tests.cashier();
select throws_ok($$ select api.staff_submit_imprest_retirement(null, 'Month end', 'x-cash') $$,
                 '42501', null, 'nor does the Cashier');
select tests.rep();
select throws_ok($$ select api.staff_submit_imprest_retirement(null, 'Month end', 'x-rep') $$,
                 '42501', null, 'nor a Sales Representative');
select tests.gone();
select throws_ok($$ select api.staff_submit_imprest_retirement(null, 'Month end', 'x-gone') $$,
                 '42501', null, 'nor a Manager who is no longer active');

select tests.manager();
select is(tests.submit(null, null, 'x-noreason'), 'reason_required', 'a reason is required');
select is(tests.submit(null, 'no', 'x-short'), 'reason_required', 'of at least 3 characters');
select is(tests.submit(null, 'Month end', 'x-blocked'), 'blocked',
          'submission is refused while anything in the fund is open');
select is(
  (select string_agg((b ->> 'kind') || ':' || (b ->> 'status'), ',' order by b ->> 'kind', b ->> 'status')
     from jsonb_array_elements(tests.res('x-blocked') -> 'blockers') b),
  'count:awaiting_confirmation,disbursement:handed_out,disbursement:proposed,funding:requested,'
  || 'raise:requested,reversal:requested',
  'and the refusal names each blocker: the waiting count, both open payments, the funding, the '
  'raised approval and the reversal');
select ok(
  (select bool_and(b ->> 'number' is not null and b ->> 'id' is not null)
     from jsonb_array_elements(tests.res('x-blocked') -> 'blockers') b),
  'each blocker carries its number and id');
select ok(exists (select 1 from public.audit_events
                   where action = 'command_refused' and entity_type = 'imprest_fund'
                     and entity_id = 'e9000000-0000-0000-0000-00000000f001'
                     and source_operation = 'api.staff_submit_imprest_retirement'
                     and actor_role = 'manager' and after_state ->> 'reason' = 'blocked'
                     and jsonb_array_length(after_state -> 'blockers') = 6
                     and correlation_id is not null and occurred_at is not null),
          'criterion 7: the refusal is committed with its blockers, actor, live role and correlation id');

-- Clear them one by one.
select tests.manager();
select tests.keep('cf-1', api.staff_confirm_imprest_count(tests.cid('c-1'), 1, 'counting_error', null, 'cf-1'));
select tests.keep('rf-fuel', api.staff_decide_imprest_raise(
  tests.did('fuel'), tests.dver(tests.did('fuel')),
  (select id from public.imprest_approval_raises where disbursement_id = tests.did('fuel')),
  false, 'Use the approved amount', 'rf-fuel'));
select tests.cashier();
select tests.keep('w-levy', api.staff_withdraw_imprest_disbursement(tests.did('levy'), 1, 'Not needed', 'w-levy'));
select tests.keep('s-fuel', api.staff_settle_imprest_disbursement(
  tests.did('fuel'), tests.dver(tests.did('fuel')), jsonb_build_array(tests.line(20000, 'Diesel')), 0,
  null, 's-fuel'));
select tests.director();
select tests.keep('rj-more', api.admin_decide_imprest_funding(tests.fid('more'), 1, false, null,
                                                             'Not this week', 'rj-more'));
select tests.keep('rj-rv', api.admin_decide_imprest_reversal(
  (select id from public.imprest_posting_reversals where status = 'requested'), 1, false,
  'The receipt says 47,000', 'rj-rv'));
select tests.manager();
select is(tests.keep('v-fuel', api.staff_verify_imprest_disbursement(
            tests.did('fuel'), tests.dver(tests.did('fuel')), tests.sid(tests.did('fuel')), 'v-fuel')),
          'verified', 'the fuel payment is verified');
select is(jsonb_array_length(private.imprest_retirement_blockers(tests.active())), 0,
          'nothing is open now');

-- ---------------------------------------------------------------------------
-- Criterion 2 · A count of today, taken after the last posting
-- ---------------------------------------------------------------------------
-- Today's count was confirmed before the fuel payment was verified, so it no longer says what the
-- tin should hold.
select is(tests.submit(tests.cid('c-1'), 'Month end', 'x-stale-count'), 'count_before_last_posting',
          'a count taken before the last posting does not close the fund');
select is(tests.res('x-stale-count') ->> 'business_date', tests.t()::text, 'and the refusal names the day');

-- The next day. Nothing is counted yet.
select tests.end_day();
select is(tests.submit(null, 'Month end', 'x-nocount'), 'count_required',
          'without a confirmed count for today the fund cannot retire');
select tests.cashier();
select is(tests.count(128000, 'c-2'), 'counted', 'the Cashier counts the tin: 1,000 short');
select tests.manager();
select is(tests.submit(tests.cid('c-2'), 'Month end', 'x-waiting'), 'blocked',
          'while the count waits it is itself a blocker');
select tests.keep('cf-2', api.staff_confirm_imprest_count(tests.cid('c-2'), 1, 'counting_error', null, 'cf-2'));
select is(tests.figures(tests.active()), '200000/128000/0/128000',
          'the shortage posts: the posted balance is the cash counted, 128,000');

select is(tests.submit(gen_random_uuid(), 'Month end', 'x-othercount'), 'stale',
          'a screen that shows another count is told the day has moved on');

-- The timestamps alone: a count backdated before the last posting does not close the fund.
set local session_replication_role = replica;
update public.imprest_counts set counted_at = counted_at - interval '1 minute' where id = tests.cid('c-2');
set local session_replication_role = origin;
select is(tests.submit(tests.cid('c-2'), 'Month end', 'x-early'), 'count_before_last_posting',
          'a count entered before the last posting does not close the fund, whatever the figures');
set local session_replication_role = replica;
update public.imprest_counts set counted_at = counted_at + interval '1 minute' where id = tests.cid('c-2');
set local session_replication_role = origin;

select is(tests.submit(tests.cid('c-2'), '  Month   end  ', 'x-1'), 'submitted',
          'the Manager submits the retirement');
select results_eq(
  format($$ select status::text, reason, count_id, business_date, posted_funding_tzs,
                   closing_balance_tzs, submitted_by::text, version
              from public.imprest_retirements where id = %L $$, tests.rid('x-1')),
  format($$ values ('submitted'::text, 'Month end'::text, %L::uuid, %L::date, 200000::bigint,
                    128000::bigint, 'e9000000-0000-0000-0000-000000000003'::text, 1) $$,
         tests.cid('c-2'), tests.t()),
  'it keeps the tidied reason, the closing count, the day, posted funding and the closing balance');
select is((select not_counted_days::text from public.imprest_retirements where id = tests.rid('x-1')),
          '{' || (tests.t() - 4) || ',' || (tests.t() - 3) || ',' || (tests.t() - 2) || '}',
          'the earlier Not counted days are listed on the submission, oldest first');
select is(tests.days(tests.active()),
          (tests.t() - 4) || ':not_counted,' || (tests.t() - 3) || ':not_counted,'
          || (tests.t() - 2) || ':not_counted,' || (tests.t() - 1) || ':shortage,'
          || tests.t() || ':shortage',
          'and they stay Not counted on the record');
select is(tests.submit(tests.cid('c-2'), 'Month end', 'x-1'), 'replayed', 'a retry replays');
select is(tests.rid('x-1'), (select id from public.imprest_retirements where status = 'submitted'),
          'with the same submission');
select is(tests.submit(tests.cid('c-2'), 'Year end', 'x-1'), 'idempotency_key_conflict',
          'the same key with another reason is a conflict');
select is(tests.submit(tests.cid('c-2'), 'Month end again', 'x-again'), 'retirement_open',
          'one submission waits at a time');
select is((select is_active from public.imprest_funds where id = 'e9000000-0000-0000-0000-00000000f001'),
          true, 'a submission alone leaves the fund active');
select ok(exists (select 1 from public.audit_events
                   where action = 'imprest_retirement_submitted' and entity_type = 'imprest_retirement'
                     and entity_id = tests.rid('x-1') and actor_role = 'manager'
                     and after_state ->> 'closing_balance_tzs' = '128000'
                     and jsonb_array_length(after_state -> 'not_counted_days') = 3
                     and correlation_id is not null),
          'criterion 7: the submission is on the audit trail');

-- ---------------------------------------------------------------------------
-- Criterion 3 · Only a Director decides
-- ---------------------------------------------------------------------------
select tests.manager();
select throws_ok(format($$ select api.admin_decide_imprest_retirement(%L, 1, true, null, 'd-mgr') $$,
                        tests.rid('x-1')), '42501', null, 'the Manager does not approve');
select tests.cashier();
select throws_ok(format($$ select api.admin_decide_imprest_retirement(%L, 1, true, null, 'd-cash') $$,
                        tests.rid('x-1')), '42501', null, 'nor does the Cashier');

select tests.director();
select is(tests.decide(tests.rid('x-1'), 1, null, null, 'd-null'), 'decision_required',
          'a decision is approve or reject');
select is(tests.decide(tests.rid('x-1'), 1, false, null, 'd-noreason'), 'reason_required',
          'a rejection needs a reason');
select is(tests.decide(tests.rid('x-1'), 7, true, null, 'd-stale'), 'stale',
          'a decision on a version not shown is refused');
select is(tests.decide(gen_random_uuid(), 1, true, null, 'd-none'), 'no_retirement',
          'a missing retirement is refused');
select is(tests.decide(tests.rid('x-1'), 1, false, 'Count again with me there', 'd-reject'), 'rejected',
          'a Director rejects it with a reason');
select results_eq(
  format($$ select status::text, rejection_reason, decided_by::text, version, next_fund_id
              from public.imprest_retirements where id = %L $$, tests.rid('x-1')),
  $$ values ('rejected'::text, 'Count again with me there'::text,
             'e9000000-0000-0000-0000-000000000001'::text, 2, null::uuid) $$,
  'the rejection keeps its reason and who decided');
select is((select is_active from public.imprest_funds where id = 'e9000000-0000-0000-0000-00000000f001'),
          true, 'a rejected retirement leaves the fund active');
select is(tests.decide(tests.rid('x-1'), 2, true, null, 'd-late'), 'not_awaiting_decision',
          'a decided retirement is not decided again');

select tests.manager();
select is(tests.submit(tests.cid('c-2'), 'Month end, counted together', 'x-2'), 'submitted',
          'the Manager submits again');

-- Something opens after the submission: the approval finds it.
select tests.cashier();
select tests.keep('late', api.staff_propose_imprest_disbursement(5000, 'other', 'Padlock', 'p-late'));
select tests.director();
select is(tests.decide(tests.rid('x-2'), 1, true, null, 'd-blocked'), 'blocked',
          'what opened since the submission stops the approval');
select is(tests.res('d-blocked') -> 'blockers' -> 0 ->> 'number',
          (select disbursement_no from public.imprest_disbursements where id = tests.did('late')),
          'naming it');
select tests.cashier();
select tests.keep('w-late', api.staff_withdraw_imprest_disbursement(tests.did('late'), 1, 'Found one', 'w-late'));

select tests.director();
select is(tests.decide(tests.rid('x-2'), 1, true, null, 'd-approve'), 'approved',
          'a Director approves the retirement');
select is(tests.decide(tests.rid('x-2'), 1, true, null, 'd-approve'), 'replayed', 'a retry replays');
select tests.director_b();
select is(tests.decide(tests.rid('x-2'), 1, true, null, 'd-approve-b'), 'stale',
          'the second Director is told it has moved on');

-- ---------------------------------------------------------------------------
-- Criterion 4 · The retired fund keeps everything, read-only
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select is_active, retired_at is not null from public.imprest_funds
      where id = 'e9000000-0000-0000-0000-00000000f001' $$,
  $$ values (false, true) $$,
  'approval closes the fund');
select is(tests.figures('e9000000-0000-0000-0000-00000000f001'), '200000/128000/0/128000',
          'the retired fund keeps every figure');
select is((select count(*)::int from public.imprest_postings
            where fund_id = 'e9000000-0000-0000-0000-00000000f001'), 3,
          'and every posting: two expenses and the unexplained loss');
select is((private.imprest_fund_unresolved('e9000000-0000-0000-0000-00000000f001') -> 'losses' -> 0
            ->> 'amount_tzs'), '3000', 'the unexplained loss still waits for a Director');
select is((select string_agg(x ->> 'amount_tzs', ',' order by x ->> 'business_date')
             from jsonb_array_elements(private.imprest_fund_unresolved(
                    'e9000000-0000-0000-0000-00000000f001') -> 'shortages') x),
          '1000,1000', 'so do both count shortages');
select is(tests.days('e9000000-0000-0000-0000-00000000f001'),
          (tests.t() - 4) || ':not_counted,' || (tests.t() - 3) || ':not_counted,'
          || (tests.t() - 2) || ':not_counted,' || (tests.t() - 1) || ':shortage,'
          || tests.t() || ':shortage',
          'its days end on the closing count''s day, the Not counted ones still Not counted');

set local role fv_definer_owner;
select throws_ok(
  $$ insert into public.imprest_disbursements (disbursement_no, fund_id, amount_tzs, category,
                                              purpose, proposed_by)
     values ('FV-DSB-TEST-9999', 'e9000000-0000-0000-0000-00000000f001', 1000, 'other', 'Sneaked in',
             'e9000000-0000-0000-0000-000000000004') $$,
  '23001', null, 'nothing joins a retired fund, whoever writes it');
select throws_ok(
  $$ update public.imprest_funds set is_active = true, retired_at = null
      where id = 'e9000000-0000-0000-0000-00000000f001' $$,
  null, null, 'a retired fund is never reopened');
select throws_ok(
  $$ update public.imprest_retirements set closing_balance_tzs = 1 where status = 'approved' $$,
  '23001', null, 'an approved retirement is never rewritten');
reset role;
select throws_ok(
  $$ delete from public.imprest_fund_openings $$, '23001', null,
  'an opening balance is never removed, not even by the database owner');
select throws_ok(
  $$ delete from public.imprest_funds where id = 'e9000000-0000-0000-0000-00000000f001' $$, '23001', null,
  'nor is a retired fund');

-- ---------------------------------------------------------------------------
-- Criterion 5 · The closing balance carried once
-- ---------------------------------------------------------------------------
select isnt(tests.active(), 'e9000000-0000-0000-0000-00000000f001'::uuid, 'a new fund is active');
select results_eq(
  format($$ select fund_id, from_fund_id, retirement_id, amount_tzs from public.imprest_fund_openings $$),
  format($$ values (%L::uuid, 'e9000000-0000-0000-0000-00000000f001'::uuid, %L::uuid, 128000::bigint) $$,
         tests.active(), tests.rid('x-2')),
  'its opening balance is its own posting of the closing balance, linked to the retired fund');
select is((select next_fund_id from public.imprest_retirements where id = tests.rid('x-2')), tests.active(),
          'the retirement names the fund it carried into');
select is((select opened_by::text from public.imprest_funds where id = tests.active()),
          'e9000000-0000-0000-0000-000000000001', 'the new fund was opened by the approving Director');
select is(tests.figures(tests.active()), '0/128000/0/128000',
          'the new fund''s posted balance is the carried 128,000, with no funding counted');
select ok(exists (select 1 from public.audit_events
                   where action = 'imprest_retirement_approved' and entity_id = tests.rid('x-2')
                     and actor_role = 'director' and after_state ->> 'closing_balance_tzs' = '128000'
                     and after_state ->> 'next_fund_id' = tests.active()::text
                     and correlation_id is not null),
          'criterion 7: the approval is on the audit trail');

set local role fv_definer_owner;
select throws_ok(
  format($$ insert into public.imprest_fund_openings (fund_id, from_fund_id, retirement_id, amount_tzs)
            values (%L, 'e9000000-0000-0000-0000-00000000f001', %L, 128000) $$,
         tests.active(), tests.rid('x-2')),
  '23505', null, 'a closing balance cannot be carried twice');
reset role;

-- Today was counted before the fund retired, so the new fund's counting starts tomorrow.
select is(tests.days(tests.active()), null, 'the new fund has no day to count today');
select tests.cashier();
select is(tests.count(128000, 'c-new'), 'day_not_countable', 'and today cannot be counted again');
select is((api.staff_imprest_fund_state() ->> 'counting_starts_on'), (tests.t() + 1)::text,
          'the Cashier is told when counting starts');
select is((api.staff_imprest_fund_state() -> 'opening'), null,
          'and not the carried balance, a posted figure');
select tests.cashier();
select throws_ok($$ select api.staff_imprest_retired_funds(10, 0) $$, '42501', null,
                 'the Cashier does not read retired funds');

-- ---------------------------------------------------------------------------
-- Criterion 6 · The carried balance and the retired funds, as the Manager and Directors read them
-- ---------------------------------------------------------------------------
select tests.manager();
select is((api.staff_imprest_fund_state() -> 'opening' ->> 'amount_tzs'), '128000',
          'the Manager sees the carried balance');
select is((api.staff_imprest_fund_state() -> 'opening' ->> 'from_fund_id'),
          'e9000000-0000-0000-0000-00000000f001', 'and the fund it came from');
select tests.director();
select results_eq(
  $$ select fund_id::text, closing_balance_tzs, submitted_by, approved_by, losses_waiting,
            losses_waiting_tzs, shortages_waiting, shortages_waiting_tzs, not_counted_days, total
       from api.staff_imprest_retired_funds(10, 0) $$,
  $$ values ('e9000000-0000-0000-0000-00000000f001'::text, 128000::bigint, 'Retire Manager'::text,
             'Retire Director'::text, 1, 3000::bigint, 2, 2000::bigint, 3, 1::bigint) $$,
  'retired funds are listed with their closing balance and everything unresolved');
select is((api.staff_imprest_fund_record('e9000000-0000-0000-0000-00000000f001') -> 'figures'
            ->> 'posted_balance_tzs'), '128000', 'the retired fund''s record reads whole');
select is(jsonb_array_length(api.staff_imprest_fund_record('e9000000-0000-0000-0000-00000000f001')
            -> 'retirements'), 2, 'with both submissions, the rejected one too');
select is((api.staff_imprest_fund_record('e9000000-0000-0000-0000-00000000f001') -> 'carried_into'
            ->> 'amount_tzs'), '128000', 'and where its balance went');
select tests.rep();
select throws_ok($$ select api.staff_imprest_fund_record('e9000000-0000-0000-0000-00000000f001') $$,
                 '42501', null, 'a Sales Representative reads no fund record');

-- ---------------------------------------------------------------------------
-- The next funding adds to the carried balance, and a second retirement carries only its own
-- ---------------------------------------------------------------------------
select tests.fund(40000, 'f-next');
select is(tests.figures(tests.active()), '40000/168000/0/168000',
          'the next funding adds to the carried balance');
select tests.end_day();
select is(tests.days(tests.active()), tests.t() || ':due', 'the new fund''s first day is due');
select tests.cashier();
select is(tests.count(168000, 'c-3'), 'counted', 'the Cashier counts the new fund');
select tests.manager();
select tests.keep('cf-3', api.staff_confirm_imprest_count(tests.cid('c-3'), 1, null, null, 'cf-3'));
select is(tests.submit(tests.cid('c-3'), 'Quarter end', 'x-3'), 'submitted', 'the new fund can retire too');
select tests.director();
select is(tests.decide(tests.rid('x-3'), 1, true, null, 'd-3'), 'approved', 'and is approved');
select is(tests.figures(tests.active()), '0/168000/0/168000',
          'the third fund opens with the second''s 168,000 alone: the first''s balance is not carried twice');
select is((select count(*)::int from public.imprest_fund_openings), 2, 'one opening per retirement');

select * from finish();
rollback;
