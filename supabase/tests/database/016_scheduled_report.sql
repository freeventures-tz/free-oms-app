-- Issue #18 · The scheduled pilot report: one visible reporting success path
-- Integrated on the released schema by issue #51; section 3a is that integration's funding mapping.
--
-- What this file exists to hold in place, stated once:
--
--   1. THE DAY IS THE DATABASE'S TO DECIDE. `private.run_scheduled_report(attempt)` takes its
--      slot ordinal and nothing else -- no business date, no actor, no correlation id -- derives
--      the previous Africa/Dar_es_Salaam calendar date itself, and the 21:01 UTC cron slot the
--      migration registered really is 00:01 the next day in Dar es Salaam. The retry slots, and
--      the failure path they exist for, are issue #19's and are proved in 017.
--
--   2. ONCE PER BUSINESS DATE. A second invocation for the same date creates no second run, no
--      second snapshot and no second delivery. A replayed cron slot must be a no-op, not a
--      duplicate report.
--
--   3. THE SNAPSHOT CANNOT BE CHANGED, AND ITS DIGEST DESCRIBES IT. Update and delete are refused
--      for everybody, the stored SHA-256 is stamped from the content rather than supplied, and
--      `public.daily_reports` recomputes it independently at read time.
--
--   4. MISSING IS NOT ZERO. A day nobody counted is `not_counted` with a NULL amount and a NULL
--      variance. A count the Manager has not confirmed is `awaiting_manager_confirmation`, which is
--      a THIRD answer and is kept apart from both of the others.
--
--   5. A FIGURE IS AS AT THE CUTOFF, NOT AS AT NOW. An invoice cancelled after the report's date
--      was money owed on the night the report describes, so it is still outstanding on it. This is
--      the assertion that would fail if the credit section ever went back to asking whether an
--      invoice stands TODAY.
--
--   6. TWO ROLES READ IT AND TWO DO NOT. product.md §18.1 names both Directors and the Manager. A
--      Cashier and a Sales Representative are refused by the database itself, not by a hidden menu
--      entry, and no Data API role can execute the generator at all.
create extension if not exists pgtap with schema extensions;

begin;
select plan(75);

create schema if not exists tests;

create or replace function tests.mk_user(p_id uuid) returns void language plpgsql as $$
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          created_at, updated_at)
  values (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          p_id::text || '@test.local', extensions.crypt('x', extensions.gen_salt('bf')),
          now(), now());
end $$;

-- Acting as one person, the way every read in this application does: a verified JWT subject and
-- nothing else. `authenticated` needs EXECUTE on it because the session really does become
-- `authenticated` further down — the helper has to survive the role change it is there to test.
create or replace function tests.claim(p_id uuid) returns text language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_id::text, 'role', 'authenticated')::text, true);
$$;
grant usage on schema tests to authenticated;
grant execute on function tests.claim(uuid) to authenticated;
-- THE TWO HALVES OF AN ATTEMPT, composed here because the real entry point cannot be called from a
-- pgTAP file at all. `private.run_scheduled_report` is a PROCEDURE that COMMITS between the claim
-- and the work — that is the whole point of it — and transaction control is illegal inside the
-- transaction this file runs in. So this file proves the two halves and every rule they enforce;
-- that the entry point really commits between them, that a worker which dies mid-report leaves a
-- reclaimable claim, and that a worker which hangs blocks no later slot are proved against the real
-- procedure with two live sessions, in `tests/integration/report-claim-concurrency.test.ts`.
--
-- IT CANNOT DRIFT FROM THE PROCEDURE'S ANSWER. The refusal shape belongs to
-- `private.claim_report_attempt`, which hands it back ready-made, so there is no second opinion
-- here about what a refused slot returns.
create or replace function tests.fire(p_attempt integer) returns jsonb language plpgsql as $$
declare
  v_claim record;
begin
  select c.* into v_claim
    from private.claim_report_attempt('daily_pilot_report', p_attempt) c;

  if v_claim.outcome <> 'claimed' then
    return v_claim.claim_refusal;
  end if;

  return private.run_report_attempt(v_claim.claimed_run_id, v_claim.claimed_token,
                                    v_claim.claimed_date, v_claim.claim_correlation, p_attempt);
end $$;


select tests.mk_user('c1000000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('c1000000-0000-0000-0000-000000000002'::uuid);  -- Second Director
select tests.mk_user('c1000000-0000-0000-0000-000000000003'::uuid);  -- Manager
select tests.mk_user('c1000000-0000-0000-0000-000000000004'::uuid);  -- Cashier
select tests.mk_user('c1000000-0000-0000-0000-000000000005'::uuid);  -- Sales Representative
select tests.mk_user('c1000000-0000-0000-0000-000000000006'::uuid);  -- A deactivated Manager

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('c1000000-0000-0000-0000-000000000001', 'Report Director One', '+255700000181', true,  false),
  ('c1000000-0000-0000-0000-000000000002', 'Report Director Two', '+255700000182', true,  false),
  ('c1000000-0000-0000-0000-000000000003', 'Report Manager',      '+255700000183', true,  false),
  ('c1000000-0000-0000-0000-000000000004', 'Report Cashier',      '+255700000184', true,  false),
  ('c1000000-0000-0000-0000-000000000005', 'Report Rep',          '+255700000185', true,  false),
  ('c1000000-0000-0000-0000-000000000006', 'Former Manager',      '+255700000186', false, false);

insert into public.user_roles (user_id, role) values
  ('c1000000-0000-0000-0000-000000000001', 'director'),
  ('c1000000-0000-0000-0000-000000000002', 'director'),
  ('c1000000-0000-0000-0000-000000000003', 'manager'),
  ('c1000000-0000-0000-0000-000000000004', 'cashier'),
  ('c1000000-0000-0000-0000-000000000005', 'sales_rep'),
  ('c1000000-0000-0000-0000-000000000006', 'manager');

-- ---------------------------------------------------------------------------
-- 1. THE SCHEDULE, AND THE MINUTE IT REALLY MEANS
-- ---------------------------------------------------------------------------
select is(
  (select local_run_time from public.report_schedules where code = 'daily_pilot_report'),
  time '00:01',
  'the schedule is 00:01 in the yard''s own time (product.md 18.2)');

select is(
  (select cron_expression from public.report_schedules where code = 'daily_pilot_report'),
  '1 21 * * *',
  'and it is registered as 21:01 UTC');

-- The correspondence itself, checked against the database's own timezone table rather than against
-- the arithmetic in somebody's head.
select is(
  (timestamptz '2026-08-24 21:01:00+00' at time zone 'Africa/Dar_es_Salaam')::time,
  time '00:01',
  '21:01 UTC is one minute past midnight in Dar es Salaam');

select is(
  (timestamptz '2026-08-24 21:01:00+00' at time zone 'Africa/Dar_es_Salaam')::date,
  date '2026-08-25',
  'and it is already the NEXT day there, which is why the report is for the day before');

select is(
  (select count(*)::int from cron.job where jobname = 'fv-daily-pilot-report'),
  1,
  'exactly one cron job is registered, not one per migration run');

select is(
  (select schedule from cron.job where jobname = 'fv-daily-pilot-report'),
  '1 21 * * *',
  'the registered job fires at the UTC minute the schedule row records');

select ok(
  (select command = 'call private.run_scheduled_report(1);'
     from cron.job where jobname = 'fv-daily-pilot-report'),
  'and it calls the private entry point directly -- no HTTP hop, no edge function, no secret');

select is(
  private.business_date(),
  (now() at time zone 'Africa/Dar_es_Salaam')::date,
  'the business date is the local calendar date, whatever zone the server runs in');

-- ---------------------------------------------------------------------------
-- 2. ONE SUCCESSFUL GENERATION
-- ---------------------------------------------------------------------------
-- Stated rather than assumed: every count below is a count of what THIS test created, and a
-- database still carrying last run's report would otherwise fail four assertions and explain none
-- of them.
select is(
  (select count(*)::int from public.report_runs),
  0,
  'the suite starts against a database with no report in it');

select set_config('tests.first', tests.fire(1)::text, true);

select is(
  (current_setting('tests.first')::jsonb ->> 'created')::boolean,
  true,
  'the first invocation of the night writes the report');

select is(
  (current_setting('tests.first')::jsonb ->> 'business_date')::date,
  (now() at time zone 'Africa/Dar_es_Salaam')::date - 1,
  'and it reports YESTERDAY in Dar es Salaam -- the day that closed at 23:59');

select is(
  (select count(*)::int from public.report_runs),
  1,
  'one run');

select is(
  (select count(*)::int from public.report_snapshots),
  1,
  'one snapshot');

select is(
  (select business_date from public.report_snapshots),
  (now() at time zone 'Africa/Dar_es_Salaam')::date - 1,
  'and the snapshot carries the same business date as the run');

-- ---------------------------------------------------------------------------
-- 3. THE APPROVED CONTENT, INCLUDING THE ABSENCES
-- ---------------------------------------------------------------------------
create or replace function tests.snapshot() returns jsonb language sql stable as $$
  select content from public.report_snapshots limit 1;
$$;

select is(
  (select count(*)::int
     from jsonb_object_keys(tests.snapshot() -> 'sections')),
  14,
  'every approved pilot section is present, not only the ones with figures in them');

select ok(
  (tests.snapshot() -> 'sections') ?& array[
    'sales', 'invoices', 'payments_by_method', 'outstanding_credit', 'discounts_and_approvals',
    'paid_but_unreleased', 'released_stock', 'inventory_variances', 'supplier_shortages',
    'production_batches', 'production_output', 'cashier_reconciliation', 'pending_approvals',
    'imprest'],
  'and they are the sections product.md 18.3 lists');

select is(
  tests.snapshot() -> 'sections' -> 'cashier_reconciliation' ->> 'state',
  'not_counted',
  'a till nobody counted is NOT COUNTED');

select ok(
  (tests.snapshot() -> 'sections' -> 'cashier_reconciliation' -> 'counted_tzs') = 'null'::jsonb
  and (tests.snapshot() -> 'sections' -> 'cashier_reconciliation' -> 'variance_tzs') = 'null'::jsonb,
  'with a null amount and a null variance -- never a zero, which would read as a balanced day');

select is(
  tests.snapshot() -> 'sections' -> 'imprest' -> 'reconciliation' ->> 'missing_reason',
  'no_imprest_fund',
  'and a missing imprest count says WHY it is missing rather than leaving a blank');

select is(
  tests.snapshot() ->> 'time_zone',
  'Africa/Dar_es_Salaam',
  'the snapshot names the clock it was built against');

-- ---------------------------------------------------------------------------
-- 3a. IMPREST, AS THE RELEASED FUNDING SCHEMA CAN HONESTLY STATE IT (issue #51)
--
-- The Owner-approved presentation: requests and CONFIRMED RECEIPTS are reported; approval and
-- provision are withheld as unavailable, never zeroed; expenses, the position and the count do not
-- exist on main and say so. Everything below is driven through the released funding commands, so
-- the fund, the version history, the append-only approvals, handovers and mismatch are the real
-- ones — the report is asked about data the application can actually produce.
--
--   A  request 100,000 -> approve 80,000 -> increase to 90,000 -> provide 70,000
--      -> Manager counts 60,000 (mismatch) -> corrected handover 65,000 -> received 65,000
--   B  request 50,000, never decided                       (a request with no receipt)
--   C  request 30,000 -> approve -> provide 30,000 -> received 30,000
--
-- So the day's received money is 95,000: two receipts, summed. Approved 80,000, the increase to
-- 90,000, the 70,000 handover and the 60,000 count all post nothing, and none of them may appear.
-- ---------------------------------------------------------------------------
create or replace function tests.acting_as(p_id uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_id::text, 'role', 'authenticated')::text, true);
$$;
create or replace function tests.manager() returns void language sql as $$
  select tests.acting_as('c1000000-0000-0000-0000-000000000003'::uuid); $$;
create or replace function tests.director() returns void language sql as $$
  select tests.acting_as('c1000000-0000-0000-0000-000000000001'::uuid); $$;

create temp table imp (name text primary key, res jsonb not null);
create or replace function tests.keep(p_name text, p_res jsonb) returns text language sql as $$
  insert into imp values (p_name, p_res) returning res ->> 'reason';
$$;
create or replace function tests.fid(p_name text) returns uuid language sql as $$
  select (res -> 'funding' ->> 'id')::uuid from imp where name = p_name; $$;
create or replace function tests.hid(p_name text) returns uuid language sql as $$
  select (res -> 'funding' ->> 'handover_id')::uuid from imp where name = p_name; $$;
create or replace function tests.imprest(p_date date) returns jsonb language sql as $$
  select private.report_content(p_date) -> 'sections' -> 'imprest'; $$;

select tests.manager();
select tests.keep('a.req', api.staff_request_imprest_funding(100000, 'Report fixture A', 'rpt-a-req'));
select tests.keep('b.req', api.staff_request_imprest_funding(50000,  'Report fixture B', 'rpt-b-req'));
select tests.keep('c.req', api.staff_request_imprest_funding(30000,  'Report fixture C', 'rpt-c-req'));

select tests.director();
select tests.keep('a.app', api.admin_decide_imprest_funding(tests.fid('a.req'), 1, true, 80000, null, 'rpt-a-app'));
select tests.keep('a.inc', api.admin_increase_imprest_approval(tests.fid('a.req'), 2, 90000, 'More sand needed', 'rpt-a-inc'));
select tests.keep('a.prov', api.admin_record_imprest_provided(tests.fid('a.req'), 3, 70000, 'rpt-a-prov'));
select tests.keep('c.app', api.admin_decide_imprest_funding(tests.fid('c.req'), 1, true, 30000, null, 'rpt-c-app'));
select tests.keep('c.prov', api.admin_record_imprest_provided(tests.fid('c.req'), 2, 30000, 'rpt-c-prov'));

select tests.manager();
select tests.keep('a.mis', api.staff_report_imprest_mismatch(tests.fid('a.req'), 4, tests.hid('a.prov'), 60000, 'Counted less', 'rpt-a-mis'));

select tests.director();
select tests.keep('a.fix', api.admin_resolve_imprest_mismatch(tests.fid('a.req'), 5, 65000, 'Corrected handover', 'rpt-a-fix'));

select tests.manager();
select tests.keep('a.rec', api.staff_confirm_imprest_received(tests.fid('a.req'), 6, tests.hid('a.fix'), 'rpt-a-rec'));
select tests.keep('c.rec', api.staff_confirm_imprest_received(tests.fid('c.req'), 3, tests.hid('c.prov'), 'rpt-c-rec'));

select is(
  (select string_agg(name || '=' || (res ->> 'reason'), ',' order by name) from imp),
  'a.app=approved,a.fix=handover_corrected,a.inc=approval_increased,a.mis=mismatch_reported,a.prov=provided,a.rec=received,'
  'a.req=requested,b.req=requested,c.app=approved,c.prov=provided,c.rec=received,c.req=requested',
  'the fixture went through every released funding command, and each one was accepted');

select is(
  tests.imprest(private.business_date()) ->> 'state',
  'active',
  'once a fund exists the section reports it as active');

select is(
  tests.imprest(private.business_date()) ->> 'fund_id',
  (select id::text from public.imprest_funds where is_active),
  'and names it by its real identity');

select ok(
  (tests.imprest(private.business_date()) -> 'fund_no') = 'null'::jsonb,
  'without inventing a fund number the released schema does not have');

select is(
  (tests.imprest(private.business_date()) -> 'funding' ->> 'requested_count')::int,
  3,
  'three requests were made on the day, including the one never decided');

select is(
  (tests.imprest(private.business_date()) -> 'funding' ->> 'requested_tzs')::bigint,
  180000::bigint,
  'and what they asked for is summed as it was asked');

select is(
  (tests.imprest(private.business_date()) -> 'funding' ->> 'received_tzs')::bigint,
  95000::bigint,
  'received money is the two confirmed receipts, 65,000 + 30,000 -- no approval, increase, '
  'handover or mismatch count is added to it');

select ok(
  (tests.imprest(private.business_date()) -> 'funding' -> 'approved_tzs') = 'null'::jsonb
  and (tests.imprest(private.business_date()) -> 'funding' -> 'provided_tzs') = 'null'::jsonb,
  'approved and provided are NULL, not a zero and not a sum of the history rows');

select is(
  tests.imprest(private.business_date()) -> 'funding' -> 'unavailable',
  '{"approved_tzs": "funding_aggregation_deferred", "provided_tzs": "funding_aggregation_deferred"}'::jsonb,
  'and the snapshot says why they are withheld, so the screen can say it too');

select ok(
  (tests.imprest(private.business_date()) -> 'approved_expenses') = 'null'::jsonb
  and (tests.imprest(private.business_date()) -> 'position') = 'null'::jsonb
  and tests.imprest(private.business_date()) -> 'unavailable'
      = '{"approved_expenses": "imprest_spending_not_built", "position": "imprest_spending_not_built"}'::jsonb,
  'expenses and the position are withheld because their workflow does not exist -- cumulative '
  'funding is not offered as a balance in their place');

select ok(
  tests.imprest(private.business_date()) -> 'reconciliation' ->> 'state' = 'not_counted'
  and (tests.imprest(private.business_date()) -> 'reconciliation' -> 'counted_tzs') = 'null'::jsonb
  and (tests.imprest(private.business_date()) -> 'reconciliation' -> 'variance_tzs') = 'null'::jsonb
  and tests.imprest(private.business_date()) -> 'reconciliation' ->> 'missing_reason'
      = 'no_reconciliation_record',
  'with a fund but no count, the count is NOT COUNTED with null amounts and a stated reason');

-- LOCAL-DAY BOUNDARIES, both sides of local midnight and both sides of UTC midnight. The rows are
-- written with the times that matter, on the same live fund, because a command can only stamp the
-- transaction's own clock. A receipt row is written as the commands leave one: provided, then its
-- handover, then received one version later, so every shape constraint and guard still applies.
select tests.acting_as(null);

insert into public.imprest_fundings (funding_no, fund_id, status, requested_amount_tzs, reason,
                                     requested_by, requested_at)
select v.no, f.id, 'requested', v.amount, 'Boundary fixture', 'c1000000-0000-0000-0000-000000000003',
       v.at
  from public.imprest_funds f,
       (values ('FV-IMP-EDGE-1', 1000, timestamptz '2026-01-10 23:59:59.999999+03'),
               ('FV-IMP-EDGE-2', 2000, timestamptz '2026-01-11 00:00:00+03'),
               ('FV-IMP-EDGE-3', 4000, timestamptz '2026-01-09 23:30:00+00'),
               ('FV-IMP-EDGE-4', 8000, timestamptz '2026-01-10 00:30:00+00')) v(no, amount, at)
 where f.is_active;

insert into public.imprest_fundings (funding_no, fund_id, status, requested_amount_tzs, reason,
                                     requested_by, requested_at)
select v.no, f.id, 'provided', v.amount, 'Boundary receipt', 'c1000000-0000-0000-0000-000000000003',
       v.at
  from public.imprest_funds f,
       (values ('FV-IMP-EDGE-5', 16000, timestamptz '2026-01-10 10:00:00+03'),
               ('FV-IMP-EDGE-6', 32000, timestamptz '2026-01-10 11:00:00+03')) v(no, amount, at)
 where f.is_active;

insert into public.imprest_funding_handovers (funding_id, cycle, amount_tzs, provided_by, provided_at)
select f.id, 1, v.amount, 'c1000000-0000-0000-0000-000000000001', timestamptz '2026-01-10 12:00+03'
  from public.imprest_fundings f
  join (values ('FV-IMP-EDGE-5', 16000::bigint), ('FV-IMP-EDGE-6', 30000::bigint)) v(no, amount)
    on v.no = f.funding_no;

update public.imprest_fundings f
   set status = 'received', version = f.version + 1,
       received_handover_id = h.id, received_amount_tzs = h.amount_tzs,
       received_by = 'c1000000-0000-0000-0000-000000000003',
       received_at = case f.funding_no
                       when 'FV-IMP-EDGE-5' then timestamptz '2026-01-11 00:00:00+03'
                       else timestamptz '2026-01-10 23:59:59+03' end
  from public.imprest_funding_handovers h
 where h.funding_id = f.id and f.funding_no in ('FV-IMP-EDGE-5', 'FV-IMP-EDGE-6');

select is(
  (tests.imprest(date '2026-01-10') -> 'funding' ->> 'requested_count')::int,
  5,
  '10 January keeps the request at 23:59:59.999999 local and both requests made before 03:00 local '
  '-- one of them on 9 January in UTC');

select is(
  (tests.imprest(date '2026-01-10') -> 'funding' ->> 'requested_tzs')::bigint,
  61000::bigint,
  'and sums exactly those five: 1,000 + 4,000 + 8,000 + 16,000 + 32,000');

select is(
  (tests.imprest(date '2026-01-10') -> 'funding' ->> 'received_tzs')::bigint,
  30000::bigint,
  'a receipt at 23:59:59 local is the 10th''s, at the amount received rather than requested');

select is(
  (tests.imprest(date '2026-01-11') -> 'funding' ->> 'received_tzs')::bigint,
  16000::bigint,
  'a receipt at exactly 00:00 local belongs to the NEXT day, even though it was requested on the 10th');

select is(
  (tests.imprest(date '2026-01-11') -> 'funding' ->> 'requested_count')::int,
  1,
  'and so does a request at 00:00 local');

select is(
  (tests.imprest(date '2026-01-09') -> 'funding' ->> 'requested_count')::int,
  0,
  '23:30 UTC on 9 January is 02:30 on the 10th in Dar es Salaam, so the 9th has no request');

-- THE STORED SNAPSHOT DID NOT MOVE. It was written above, before any fund existed, and everything
-- since — a fund, receipts, a correction — happened after it.
select ok(
  tests.snapshot() -> 'sections' -> 'imprest' ->> 'state' = 'no_fund'
  and (tests.snapshot() -> 'sections' -> 'imprest' -> 'fund_id') = 'null'::jsonb
  and (tests.snapshot() -> 'sections' -> 'imprest' -> 'funding') = 'null'::jsonb,
  'the report written before the fund existed still says there was no fund -- later funding and '
  'receipts cannot reach a snapshot already written');

select ok(
  (select integrity_ok from public.daily_reports),
  'and its digest still matches the content it was written with');


-- ---------------------------------------------------------------------------
-- 3b. OUTSTANDING CREDIT IS AS AT THE CUTOFF, AND A LATER CANCELLATION DOES NOT REWRITE IT
--
-- Four invoices issued on one day, 20 January 2026, differing only in WHEN they were cancelled.
-- Nothing is paid against any of them, so the credit total is arithmetic anybody can check by
-- reading the four amounts.
--
--   A  TZS 500,000  cancelled five days LATER      -> owed on the 20th, and on the 21st
--   B  TZS 300,000  cancelled the same afternoon   -> never owed at any cutoff after it
--   C  TZS 200,000  never cancelled                -> owed at every cutoff
--   D  TZS 100,000  cancelled at 00:00 on the 21st -> owed on the 20th, the boundary case
--
-- D IS THE ONE THAT PINS THE BOUNDARY DOWN. Local midnight opens the 21st, so the cancellation is
-- the 21st's event and the 20th closed with the money still owed. A closed upper bound, or a
-- comparison one microsecond out, moves D into the 20th and nothing else in this file would notice.
-- ---------------------------------------------------------------------------
insert into public.customers (id, name)
values ('c3000000-0000-0000-0000-000000000001', 'Credit Cutoff Customer');

insert into public.orders (id, order_no, customer_id, status, is_cash_sale,
                           created_by, created_role, created_at, confirmed_at)
select ('c4000000-0000-0000-0000-00000000000' || n)::uuid,
       'ORD-CUTOFF-' || n,
       'c3000000-0000-0000-0000-000000000001',
       'confirmed', false,
       'c1000000-0000-0000-0000-000000000001', 'sales_rep',
       timestamptz '2026-01-20 09:00+03', timestamptz '2026-01-20 10:00+03'
  from generate_series(1, 4) as n;

insert into public.invoices (invoice_no, order_id, customer_id, subtotal_tzs, discount_tzs,
                             total_tzs, business_date, issued_at, cancelled_at, cancel_reason)
values
  ('INV-CUTOFF-A', 'c4000000-0000-0000-0000-000000000001',
   'c3000000-0000-0000-0000-000000000001', 500000, 0, 500000, date '2026-01-20',
   timestamptz '2026-01-20 11:00+03', timestamptz '2026-01-25 09:00+03', 'cancelled days later'),
  ('INV-CUTOFF-B', 'c4000000-0000-0000-0000-000000000002',
   'c3000000-0000-0000-0000-000000000001', 300000, 0, 300000, date '2026-01-20',
   timestamptz '2026-01-20 11:00+03', timestamptz '2026-01-20 15:00+03', 'cancelled the same day'),
  ('INV-CUTOFF-C', 'c4000000-0000-0000-0000-000000000003',
   'c3000000-0000-0000-0000-000000000001', 200000, 0, 200000, date '2026-01-20',
   timestamptz '2026-01-20 11:00+03', null, null),
  ('INV-CUTOFF-D', 'c4000000-0000-0000-0000-000000000004',
   'c3000000-0000-0000-0000-000000000001', 100000, 0, 100000, date '2026-01-20',
   timestamptz '2026-01-20 11:00+03', timestamptz '2026-01-21 00:00+03', 'cancelled at midnight');

select is(
  (private.report_content(date '2026-01-20') -> 'sections' -> 'outstanding_credit'
     ->> 'outstanding_tzs')::bigint,
  800000::bigint,
  'an invoice cancelled after the cutoff is still outstanding at it -- A, C and D, not B');

select is(
  (private.report_content(date '2026-01-20') -> 'sections' -> 'outstanding_credit'
     ->> 'invoice_count')::bigint,
  3::bigint,
  'and it is counted as one of the invoices still owing, not merely added to the total');

select is(
  (private.report_content(date '2026-01-20') -> 'sections' -> 'invoices'
     ->> 'cancelled_count')::bigint,
  1::bigint,
  'the invoices section agrees with it: only the same-day cancellation is the 20th''s');

select is(
  (private.report_content(date '2026-01-21') -> 'sections' -> 'outstanding_credit'
     ->> 'outstanding_tzs')::bigint,
  700000::bigint,
  'by the next night D has been cancelled and A has not -- the day decides, not the row''s state now');

select is(
  (private.report_content(date '2026-01-26') -> 'sections' -> 'outstanding_credit'
     ->> 'outstanding_tzs')::bigint,
  200000::bigint,
  'and once A is cancelled too, only the invoice that was never cancelled is still owed');

-- ---------------------------------------------------------------------------
-- 3c. A DECISION IS COUNTED ON THE DAY IT WAS MADE, NOT ON THE DAY IT WAS ASKED FOR
--
-- The same trap as 3b, in the two sections that report a decision. Every request and batch below
-- was entered on 10 February 2026; what differs is WHEN it was decided. `status` on both tables is
-- where the row stands NOW, so a report built from it after midnight would carry a decision the
-- 10th never saw -- and that report is an immutable snapshot, so the error would be permanent.
--
--   Approval requests (all discounts, all asked for on the 10th):
--     R1  23:55, approved at 00:02 on the 11th     -> pending at the cutoff
--     R2  23:55, rejected at 00:02 on the 11th     -> pending at the cutoff
--     R3  10:00, approved at 11:00                 -> approved
--     R4  10:00, rejected at 11:00                 -> rejected
--     R5  23:00, approved at exactly 00:00 on 11th -> pending: midnight opens the 11th
--     R6  23:00, approved at 23:59:59.999999       -> approved: the last instant of the 10th
--     R7  10:00, approved at 11:00, superseded at 01:00 on the 11th -> approved at the cutoff
--
--   Production batches (all entered on the 10th):
--     B1  approved at 00:03 on the 11th -> draft     B4  rejected at 15:00       -> rejected
--     B2  rejected at 00:03 on the 11th -> draft     B5  approved at 00:00, 11th -> draft
--     B3  approved at 15:00             -> approved  B6  never decided           -> draft
--
-- R7 is the append-only history read properly: the answer at the cutoff is the LAST decision
-- before it, not "no later decision, so pending".
-- ---------------------------------------------------------------------------
insert into public.approval_requests (id, entity_type, entity_id, approval_type, requested_by,
                                      requested_role, required_role, requested_at, status,
                                      approved_by, approved_role, approved_at)
select ('c5000000-0000-0000-0000-00000000000' || v.n)::uuid, 'order',
       ('c6000000-0000-0000-0000-00000000000' || v.n)::uuid, 'discount',
       'c1000000-0000-0000-0000-000000000005', 'sales_rep', 'director', v.asked, v.now_status,
       case when v.now_status = 'approved' then 'c1000000-0000-0000-0000-000000000001'::uuid end,
       case when v.now_status = 'approved' then 'director'::public.app_role end,
       case when v.now_status = 'approved' then v.decided end
  from (values
    (1, timestamptz '2026-02-10 23:55+03', 'approved'::public.approval_status, timestamptz '2026-02-11 00:02+03'),
    (2, timestamptz '2026-02-10 23:55+03', 'rejected',   timestamptz '2026-02-11 00:02+03'),
    (3, timestamptz '2026-02-10 10:00+03', 'approved',   timestamptz '2026-02-10 11:00+03'),
    (4, timestamptz '2026-02-10 10:00+03', 'rejected',   timestamptz '2026-02-10 11:00+03'),
    (5, timestamptz '2026-02-10 23:00+03', 'approved',   timestamptz '2026-02-11 00:00+03'),
    (6, timestamptz '2026-02-10 23:00+03', 'approved',   timestamptz '2026-02-10 23:59:59.999999+03'),
    (7, timestamptz '2026-02-10 10:00+03', 'superseded', timestamptz '2026-02-11 01:00+03')
  ) v(n, asked, now_status, decided);

-- The append-only history the projection above was written from.
insert into public.approval_decisions (request_id, outcome, decided_by, decided_role, decided_at)
select ('c5000000-0000-0000-0000-00000000000' || v.n)::uuid, v.outcome,
       'c1000000-0000-0000-0000-000000000001', 'director', v.decided
  from (values
    (1, 'approved'::public.decision_outcome, timestamptz '2026-02-11 00:02+03'),
    (2, 'rejected',   timestamptz '2026-02-11 00:02+03'),
    (3, 'approved',   timestamptz '2026-02-10 11:00+03'),
    (4, 'rejected',   timestamptz '2026-02-10 11:00+03'),
    (5, 'approved',   timestamptz '2026-02-11 00:00+03'),
    (6, 'approved',   timestamptz '2026-02-10 23:59:59.999999+03'),
    (7, 'approved',   timestamptz '2026-02-10 11:00+03'),
    (7, 'superseded', timestamptz '2026-02-11 01:00+03')
  ) v(n, outcome, decided);

insert into public.production_batches (batch_no, location_code, status, moulded_at, entered_by,
                                       entered_role, entered_at, decided_by, decided_role,
                                       decided_at, decision_reason)
select 'PB-CUTOFF-' || v.n, 'yard', v.now_status, v.entered, 'c1000000-0000-0000-0000-000000000003',
       'manager', v.entered,
       case when v.decided is not null then 'c1000000-0000-0000-0000-000000000003'::uuid end,
       case when v.decided is not null then 'manager'::public.app_role end,
       v.decided,
       case when v.now_status = 'rejected' then 'Mix too wet' end
  from (values
    (1, timestamptz '2026-02-10 23:50+03', 'approved'::public.production_batch_status, timestamptz '2026-02-11 00:03+03'),
    (2, timestamptz '2026-02-10 23:50+03', 'rejected', timestamptz '2026-02-11 00:03+03'),
    (3, timestamptz '2026-02-10 09:00+03', 'approved', timestamptz '2026-02-10 15:00+03'),
    (4, timestamptz '2026-02-10 09:00+03', 'rejected', timestamptz '2026-02-10 15:00+03'),
    (5, timestamptz '2026-02-10 20:00+03', 'approved', timestamptz '2026-02-11 00:00+03'),
    (6, timestamptz '2026-02-10 20:00+03', 'draft',    null::timestamptz)
  ) v(n, entered, now_status, decided);

create or replace function tests.discounts_on(p_date date) returns jsonb language sql stable as $$
  select e
    from jsonb_array_elements(private.report_content(p_date) -> 'sections'
                                -> 'discounts_and_approvals' -> 'by_type') e
   where e ->> 'approval_type' = 'discount';
$$;

select is(
  (tests.discounts_on(date '2026-02-10') ->> 'requested')::int,
  7,
  'every discount asked for on the 10th is counted as requested on the 10th, whenever it was decided');

select is(
  (tests.discounts_on(date '2026-02-10') ->> 'approved')::int,
  3,
  'approved at the cutoff: R3, R6 at 23:59:59.999999, and R7 whose supersession came later -- '
  'not R1 or R5, approved at or after midnight');

select is(
  (tests.discounts_on(date '2026-02-10') ->> 'rejected')::int,
  1,
  'rejected at the cutoff: R4 only -- R2 was still waiting when the 10th closed');

select is(
  (private.report_content(date '2026-02-10') -> 'sections' -> 'production_batches' ->> 'entered')::int,
  6,
  'six batches entered on the 10th');

select is(
  (private.report_content(date '2026-02-10') -> 'sections' -> 'production_batches' ->> 'draft')::int,
  4,
  'four were still drafts at midnight: B1, B2, B5 decided at or after it, and B6 never decided');

select is(
  (private.report_content(date '2026-02-10') -> 'sections' -> 'production_batches' ->> 'approved')::int,
  1,
  'one was approved on the day -- B3, not the batches approved after midnight');

select is(
  (private.report_content(date '2026-02-10') -> 'sections' -> 'production_batches' ->> 'rejected')::int,
  1,
  'one was rejected on the day -- B4, not B2 rejected after midnight');

-- The generation-time POSITION is deliberately NOT reconstructed. It says what is waiting as the
-- report is written, so it follows the requests as they stand now and says so.
select ok(
  private.report_content(date '2026-02-10') -> 'sections' -> 'pending_approvals' ->> 'as_at'
      = 'generation'
  and (private.report_content(date '2026-02-10') -> 'sections' -> 'pending_approvals' ->> 'count')::int
      = (select count(*)::int from public.approval_requests where status = 'pending'),
  'pending approvals stay a generation-time position: none of R1-R7 is waiting now, so none is counted');

-- ---------------------------------------------------------------------------
-- 4. THE DIGEST
-- ---------------------------------------------------------------------------
select is(
  (select content_sha256 from public.report_snapshots),
  (select encode(sha256(convert_to(content::text, 'UTF8')), 'hex') from public.report_snapshots),
  'the stored digest is the digest of the stored content');

select ok(
  (select integrity_ok from public.daily_reports),
  'and the view recomputes it on read rather than repeating the stored claim');

select ok(
  (select content_sha256 ~ '^[0-9a-f]{64}$' from public.report_snapshots),
  'it is a full SHA-256, in the one form a person can compare by eye');

-- A caller cannot store a digest that describes something else: the trigger overwrites whatever
-- was offered.
-- A run written by hand states its own state, because issue #19 gave the table one and took the
-- default away: a row here is a report that was generated, and it has to say so.
insert into public.report_runs (schedule_id, business_date, correlation_id, status,
                                generated_at, claim_token, claimed_at, lease_expires_at,
                                completed_at)
values ((select id from public.report_schedules where code = 'daily_pilot_report'),
        date '2026-01-15', gen_random_uuid(), 'succeeded',
        now(), gen_random_uuid(), now(), now(), now());

-- The attempt is named as well, because issue #19 keyed a snapshot on `(run_id, attempt_ordinal)`
-- so that a stalled attempt cannot hold the index entry the attempt replacing it needs.
insert into public.report_snapshots (run_id, business_date, attempt_ordinal, schema_version,
                                     content, content_sha256)
values ((select id from public.report_runs where business_date = date '2026-01-15'),
        date '2026-01-15', 1, 1, '{"a": 1}'::jsonb,
        '0000000000000000000000000000000000000000000000000000000000000000');

select is(
  (select content_sha256 from public.report_snapshots where business_date = date '2026-01-15'),
  encode(sha256(convert_to('{"a": 1}'::jsonb::text, 'UTF8')), 'hex'),
  'a digest offered by the caller is replaced by the one the content actually has');

-- ---------------------------------------------------------------------------
-- 5. IMMUTABILITY
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ update public.report_snapshots set business_date = date '2020-01-01' $$,
  '23001',
  null,
  'a snapshot cannot be edited, by anybody, including the role that wrote it');

select throws_ok(
  $$ delete from public.report_snapshots $$,
  '23001',
  null,
  'and it cannot be deleted either -- reports are kept, not tidied away');

-- ---------------------------------------------------------------------------
-- 6. DUPLICATE INVOCATION
-- ---------------------------------------------------------------------------
select set_config('tests.second', tests.fire(1)::text, true);

select is(
  (current_setting('tests.second')::jsonb ->> 'created')::boolean,
  false,
  'a replayed cron slot writes nothing');

select is(
  current_setting('tests.second')::jsonb ->> 'reason',
  'already_generated',
  'and says why, rather than pretending it did the work');

select is(
  (select count(*)::int from public.report_runs
    where business_date = (now() at time zone 'Africa/Dar_es_Salaam')::date - 1),
  1,
  'still one run for that business date');

select is(
  (select count(*)::int from public.report_snapshots
    where business_date = (now() at time zone 'Africa/Dar_es_Salaam')::date - 1),
  1,
  'still one snapshot');

-- ---------------------------------------------------------------------------
-- 7. RECIPIENTS
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from public.report_deliveries d
     join public.report_snapshots s on s.id = d.snapshot_id
    where s.business_date = (now() at time zone 'Africa/Dar_es_Salaam')::date - 1),
  3,
  'both Directors and the Manager get a delivery; the deactivated Manager does not');

select is(
  (select count(*)::int from public.report_deliveries
    where recipient_role in ('cashier', 'sales_rep')),
  0,
  'no Cashier and no Sales Representative receives a report (product.md 18.1)');

select throws_ok(
  format($$ insert into public.report_deliveries (snapshot_id, recipient_id, recipient_role)
            values (%L, %L, 'cashier') $$,
         (select id from public.report_snapshots
           where business_date = (now() at time zone 'Africa/Dar_es_Salaam')::date - 1),
         'c1000000-0000-0000-0000-000000000004'),
  '23514',
  null,
  'and the schema refuses one, so no later code path can hand a Cashier a report');

-- ---------------------------------------------------------------------------
-- 8. WHO MAY READ, AND WHO MAY RUN
-- ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('authenticated', 'private.run_scheduled_report(integer, jsonb)', 'execute')
  and not has_function_privilege('anon', 'private.run_scheduled_report(integer, jsonb)', 'execute')
  and not has_function_privilege('service_role', 'private.run_scheduled_report(integer, jsonb)', 'execute'),
  'no Data API role can run the generator -- not a session, not the secret key');

select ok(
  not has_function_privilege('authenticated', 'private.report_content(date)', 'execute')
  and not has_function_privilege('service_role', 'private.report_content(date)', 'execute'),
  'nor build report content for a date of its own choosing');

select ok(
  has_function_privilege('postgres', 'private.run_scheduled_report(integer, jsonb)', 'execute'),
  'the role that owns the cron job can, which is the only caller there is');

select ok(
  not has_table_privilege('authenticated', 'public.report_snapshots', 'insert')
  and not has_table_privilege('authenticated', 'public.report_snapshots', 'update')
  and not has_table_privilege('authenticated', 'public.report_snapshots', 'delete')
  and not has_table_privilege('authenticated', 'public.report_runs', 'insert'),
  'a signed-in session may read a report and may not write one');

select ok(
  not has_table_privilege('service_role', 'public.report_snapshots', 'select')
  and not has_table_privilege('service_role', 'public.daily_reports', 'select'),
  'and a leaked secret key is not a way to read one');

set local role authenticated;

select tests.claim('c1000000-0000-0000-0000-000000000001'::uuid);
select is(
  (select count(*)::int from public.daily_reports),
  2,
  'a Director reads the reports');

select tests.claim('c1000000-0000-0000-0000-000000000003'::uuid);
select is(
  (select count(*)::int from public.daily_reports),
  2,
  'so does the Manager');

select tests.claim('c1000000-0000-0000-0000-000000000004'::uuid);
select is(
  (select count(*)::int from public.daily_reports),
  0,
  'a Cashier is handed nothing, whatever route they reached for');

select tests.claim('c1000000-0000-0000-0000-000000000005'::uuid);
select is(
  (select count(*)::int from public.report_snapshots),
  0,
  'and a Sales Representative cannot read the snapshots underneath the view either');

select tests.claim('c1000000-0000-0000-0000-000000000006'::uuid);
select is(
  (select count(*)::int from public.daily_reports),
  0,
  'a deactivated Manager is refused, because the policy checks the account and not the role alone');

reset role;

select finish();
rollback;
