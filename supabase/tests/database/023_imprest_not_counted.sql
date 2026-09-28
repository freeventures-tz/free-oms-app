-- Issue #69 · Imprest daily count, part 2: a day nobody counted shows as Not counted
--
-- The claims under test, each traceable to issue #69's acceptance criteria:
--
--   1   Each business day of the active fund resolves to Not counted, Awaiting Manager
--       confirmation, Balanced, Shortage or Excess, from the counts alone: no job runs. Today, before
--       it closes, is due.
--   2   A day becomes Not counted when it closes in Africa/Dar_es_Salaam without a count standing,
--       or when its count is sent back after the close. The business date is never the server's.
--   3   The Cashier may count a past Not counted day late, with a required reason. It follows the
--       same confirm path, keeps the reason, and the fund still holds one waiting count.
--   4   Both Directors and the Manager read the open days, oldest first, with when each started
--       waiting; resolved alerts stay in a history. The Cashier reads the open days, not the history.
--   5   A missing count blocks nothing.
--   6   Every success and committed refusal is on the audit trail.

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

select tests.mk_user('e6900000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('e6900000-0000-0000-0000-000000000002'::uuid);  -- Director B
select tests.mk_user('e6900000-0000-0000-0000-000000000003'::uuid);  -- Manager
select tests.mk_user('e6900000-0000-0000-0000-000000000004'::uuid);  -- Cashier
select tests.mk_user('e6900000-0000-0000-0000-000000000005'::uuid);  -- Sales Representative

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('e6900000-0000-0000-0000-000000000001', 'Missed Director',   '+255700006901', true, false),
  ('e6900000-0000-0000-0000-000000000002', 'Missed Director B', '+255700006902', true, false),
  ('e6900000-0000-0000-0000-000000000003', 'Missed Manager',    '+255700006903', true, false),
  ('e6900000-0000-0000-0000-000000000004', 'Missed Cashier',    '+255700006904', true, false),
  ('e6900000-0000-0000-0000-000000000005', 'Missed Rep',        '+255700006905', true, false);

insert into public.user_roles (user_id, role) values
  ('e6900000-0000-0000-0000-000000000001', 'director'),
  ('e6900000-0000-0000-0000-000000000002', 'director'),
  ('e6900000-0000-0000-0000-000000000003', 'manager'),
  ('e6900000-0000-0000-0000-000000000004', 'cashier'),
  ('e6900000-0000-0000-0000-000000000005', 'sales_rep');

create or replace function tests.director() returns void language sql as $$
  select tests.acting_as('e6900000-0000-0000-0000-000000000001'::uuid); $$;
create or replace function tests.director_b() returns void language sql as $$
  select tests.acting_as('e6900000-0000-0000-0000-000000000002'::uuid); $$;
create or replace function tests.manager() returns void language sql as $$
  select tests.acting_as('e6900000-0000-0000-0000-000000000003'::uuid); $$;
create or replace function tests.cashier() returns void language sql as $$
  select tests.acting_as('e6900000-0000-0000-0000-000000000004'::uuid); $$;
create or replace function tests.rep() returns void language sql as $$
  select tests.acting_as('e6900000-0000-0000-0000-000000000005'::uuid); $$;

create temp table r (name text primary key, res jsonb not null);
grant all on r to public;
create or replace function tests.keep(p_name text, p_res jsonb) returns text language sql as $$
  insert into r values (p_name, p_res) returning res ->> 'reason';
$$;
create or replace function tests.cid(p_name text) returns uuid language sql as $$
  select (res -> 'count' ->> 'id')::uuid from r where name = p_name; $$;
create or replace function tests.did(p_name text) returns uuid language sql as $$
  select (res -> 'disbursement' ->> 'id')::uuid from r where name = p_name; $$;

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

create or replace function tests.count_row(p_id uuid) returns public.imprest_counts
language sql security definer as $$ select * from public.imprest_counts where id = p_id; $$;
create or replace function tests.expected() returns bigint language sql security definer as $$
  select s.posted_balance_tzs - private.imprest_awaiting_verification_tzs(f.id)
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active; $$;
-- The state of every day of the active fund, as `YYYY-MM-DD:state` joined by commas.
create or replace function tests.days() returns text language sql security definer as $$
  select string_agg(d.business_date::text || ':' || d.state, ',' order by d.business_date)
    from public.imprest_funds f cross join lateral private.imprest_count_days(f.id) d
   where f.is_active; $$;
create or replace function tests.state(p_day date) returns text language sql security definer as $$
  select d.state from public.imprest_funds f cross join lateral private.imprest_count_days(f.id) d
   where f.is_active and d.business_date = p_day; $$;
create or replace function tests.not_counted_since(p_day date) returns timestamptz
language sql security definer as $$
  select d.not_counted_since from public.imprest_funds f
   cross join lateral private.imprest_count_days(f.id) d
   where f.is_active and d.business_date = p_day; $$;
create or replace function tests.open_days() returns text language sql as $$
  select string_agg(business_date::text || ':' || state, ',' order by business_date)
    from api.staff_imprest_open_count_days(100, 0); $$;

create or replace function tests.late(p_day date, p_previous uuid, p_counted bigint, p_reason text,
                                      p_key text) returns jsonb language sql as $$
  select api.staff_enter_imprest_count(p_day, p_previous, p_counted, null, p_reason, p_key); $$;
create or replace function tests.enter(p_previous uuid, p_counted bigint, p_key text) returns jsonb
language sql as $$
  select api.staff_enter_imprest_count(tests.t(), p_previous, p_counted, null, null, p_key); $$;
create or replace function tests.confirm(p_id uuid, p_explanation text, p_key text) returns text
language sql as $$
  select api.staff_confirm_imprest_count(p_id, (tests.count_row(p_id)).version, p_explanation,
                                         null, p_key) ->> 'reason'; $$;
create or replace function tests.send_back(p_id uuid, p_key text) returns text language sql as $$
  select api.staff_send_back_imprest_count(p_id, (tests.count_row(p_id)).version,
                                           'Count the coin bag too', p_key) ->> 'reason'; $$;

-- ---------------------------------------------------------------------------
-- The shape
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     join pg_roles o on o.oid = p.proowner
    where n.nspname = 'api'
      and p.proname in ('staff_enter_imprest_count', 'staff_imprest_open_count_days',
                        'staff_imprest_count_alert_history')
      and p.prosecdef and o.rolname = 'fv_definer_owner'
      and has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('service_role', p.oid, 'execute')),
  4,
  'both forms of Enter count and the two new reads are security definer, for staff sessions only');

select ok(
  has_column_privilege('authenticated', 'public.imprest_counts', 'late_reason', 'select')
  and not has_column_privilege('authenticated', 'public.imprest_counts', 'late_reason', 'update')
  and not has_column_privilege('authenticated', 'public.imprest_counts', 'posted_balance_tzs', 'select'),
  'a session reads a count''s late reason and still not the posted balance behind it');

select is(
  (select count(*)::int from cron.job where command ilike '%count%'),
  0,
  'no scheduled job writes Not counted: it comes from the absence of a count');

-- ---------------------------------------------------------------------------
-- 2 · The business day's edges are Africa/Dar_es_Salaam's (UTC+3), never the server's
-- ---------------------------------------------------------------------------
select is(private.imprest_business_date_of('2026-09-28 20:59:59.999+00'), '2026-09-28'::date,
          'one millisecond before midnight in Dar es Salaam is still the 28th');
select is(private.imprest_business_date_of('2026-09-28 21:00:00+00'), '2026-09-29'::date,
          'midnight in Dar es Salaam is the 29th, though the server''s UTC date is still the 28th');
select is(private.imprest_business_day_close('2026-09-28'), '2026-09-28 21:00:00+00'::timestamptz,
          'the 28th closes at 21:00 UTC, midnight in Dar es Salaam');
select is(private.imprest_business_date_of(private.imprest_business_day_close('2026-12-31')),
          '2027-01-01'::date, 'a day''s close is the first instant of the next day, across a year');

-- ---------------------------------------------------------------------------
-- A fund opened four days ago, counting started three days ago. TZS 200,000 posted.
-- ---------------------------------------------------------------------------
set local role fv_definer_owner;
insert into public.imprest_funds (id, opened_by, opened_at) values
  ('e6900000-0000-0000-0000-00000000f001', 'e6900000-0000-0000-0000-000000000003',
   now() - interval '4 days');
insert into public.imprest_fundings (id, funding_no, fund_id, requested_amount_tzs, reason,
                                     requested_by)
values ('e6900000-0000-0000-0000-00000000f101', 'FV-IMP-TEST-6901',
        'e6900000-0000-0000-0000-00000000f001', 200000, 'Opening float',
        'e6900000-0000-0000-0000-000000000003');
insert into public.imprest_funding_handovers (id, funding_id, cycle, amount_tzs, provided_by)
values ('e6900000-0000-0000-0000-00000000f201', 'e6900000-0000-0000-0000-00000000f101', 1, 200000,
        'e6900000-0000-0000-0000-000000000001');
update public.imprest_fundings
   set status = 'received', version = version + 1,
       received_handover_id = 'e6900000-0000-0000-0000-00000000f201',
       received_amount_tzs = 200000, received_by = 'e6900000-0000-0000-0000-000000000003',
       received_at = now()
 where id = 'e6900000-0000-0000-0000-00000000f101';
reset role;

-- Counting started three days ago: T-3, as the business clock reads it.
set local role fv_definer_owner;
do $$ begin
  execute format($f$ create or replace function private.imprest_counting_starts_on() returns date
    language sql immutable set search_path = '' as $b$ select %L::date $b$ $f$, tests.t() - 3);
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 1 · Every day resolves from the counts alone
-- ---------------------------------------------------------------------------
select is(tests.days(),
          (tests.t() - 3) || ':not_counted,' || (tests.t() - 2) || ':not_counted,'
          || (tests.t() - 1) || ':not_counted,' || tests.t() || ':due',
          'the three closed days with no count are Not counted and today is due');
select is(tests.not_counted_since(tests.t() - 3), private.imprest_business_day_close(tests.t() - 3),
          'a day with no count is Not counted from the moment it closed');
select is(tests.not_counted_since(tests.t()), null,
          'today is not Not counted before it closes');

set local role fv_definer_owner;
do $$ begin
  execute format($f$ create or replace function private.imprest_counting_starts_on() returns date
    language sql immutable set search_path = '' as $b$ select %L::date $b$ $f$, tests.t() - 30);
end $$;
reset role;
select is(private.imprest_first_count_day('e6900000-0000-0000-0000-00000000f001'), tests.t() - 4,
          'a fund opened after counting started starts on the day it opened');
set local role fv_definer_owner;
do $$ begin
  execute format($f$ create or replace function private.imprest_counting_starts_on() returns date
    language sql immutable set search_path = '' as $b$ select %L::date $b$ $f$, tests.t() - 3);
end $$;
reset role;

select tests.manager();
select is(tests.open_days(),
          (tests.t() - 3) || ':not_counted,' || (tests.t() - 2) || ':not_counted,'
          || (tests.t() - 1) || ':not_counted',
          'the Manager reads the open days oldest first, and not today');
select is((select total from api.staff_imprest_open_count_days(1, 1)), 3::bigint,
          'a page of one says how many days are open in all');
select is((select business_date from api.staff_imprest_open_count_days(1, 2)), tests.t() - 1,
          'and the third page holds the newest open day');

-- ---------------------------------------------------------------------------
-- 3 · A late count: a past day, a required reason
-- ---------------------------------------------------------------------------
select tests.cashier();
select is(tests.keep('l-none', tests.late(tests.t() - 3, null, 150000, null, 'l-none')), 'day_changed',
          'a past day with no late reason is refused as a screen left open overnight');
select is(tests.keep('l-short', tests.late(tests.t() - 3, null, 150000, 'ab', 'l-short')),
          'late_reason_invalid', 'a late reason shorter than 3 characters is refused');
select is(tests.keep('l-today', tests.late(tests.t(), null, 150000, 'Forgot yesterday', 'l-today')),
          'late_reason_not_needed', 'today''s count takes no late reason');
select is(tests.keep('l-before', tests.late(tests.t() - 4, null, 150000, 'Before we began', 'l-before')),
          'day_not_countable', 'a day before counting started cannot be counted');
select is(tests.keep('l-future', tests.late(tests.t() + 1, null, 150000, 'Tomorrow early', 'l-future')),
          'day_changed', 'tomorrow cannot be counted');
select is((select count(*)::int from public.imprest_counts), 0, 'no refused count was stored');

select is(tests.keep('l1', tests.late(tests.t() - 3, null, 199000, 'Cashier was off sick', 'l1')),
          'counted', 'the Cashier counts a missed day late, with a reason');
select is((tests.count_row(tests.cid('l1'))).late_reason, 'Cashier was off sick',
          'the count keeps its late reason');
select is(((tests.count_row(tests.cid('l1'))).expected_tzs, (tests.count_row(tests.cid('l1'))).variance_tzs),
          (200000::bigint, -1000::bigint),
          'it is compared with the expected cash as it stands now');
select is(tests.keep('l1-replay', tests.late(tests.t() - 3, null, 199000, 'Cashier was off sick', 'l1')),
          'replayed', 'the same late count with the same key is a replay');
select is(tests.keep('l1-conflict', tests.late(tests.t() - 3, null, 199000, 'Someone else counted', 'l1')),
          'idempotency_key_conflict', 'the same key with another reason is a conflict');

select is(tests.state(tests.t() - 3), 'awaiting_confirmation',
          'the late count leaves the day Awaiting Manager confirmation');
select tests.director();
select is(
  (select (state, not_counted_since, awaiting_since, waiting_since)::text
     from api.staff_imprest_open_count_days(100, 0) where business_date = tests.t() - 3),
  ('awaiting_confirmation', private.imprest_business_day_close(tests.t() - 3),
   (tests.count_row(tests.cid('l1'))).counted_at, private.imprest_business_day_close(tests.t() - 3))::text,
  'a Director reads it still open: Not counted since the close, waiting for the Manager since the count');

-- One waiting count in the fund, late or not.
select tests.cashier();
select is(tests.keep('l-t', tests.enter(null, 150000, 'l-t')), 'earlier_count_waiting',
          'today cannot be counted while the late count waits');
select is(tests.keep('l-t2', tests.late(tests.t() - 2, null, 150000, 'Also missed that day', 'l-t2')),
          'earlier_count_waiting', 'nor another missed day');
select is((select res ->> 'business_date' from r where name = 'l-t2'), (tests.t() - 3)::text,
          'and the refusal names the day that waits');

-- The same confirm path: sent back, counted again late, confirmed as a shortage that posts.
select tests.manager();
select is(tests.send_back(tests.cid('l1'), 's-l1'), 'sent_back', 'the Manager sends the late count back');
select is(tests.state(tests.t() - 3), 'not_counted',
          'the day is Not counted again');
select is(tests.not_counted_since(tests.t() - 3), private.imprest_business_day_close(tests.t() - 3),
          'and has been since it closed, since no count stood then');
select tests.cashier();
select is(tests.keep('l1b', tests.late(tests.t() - 3, null, 199500, 'Cashier was off sick', 'l1b')),
          'stale', 'a recount that does not name the sent-back count is stale');
select is(tests.keep('l2', tests.late(tests.t() - 3, tests.cid('l1'), 199500, 'Cashier was off sick', 'l2')),
          'counted', 'the recount names the count it replaces');
select is((tests.count_row(tests.cid('l2'))).attempt, 2, 'and is the day''s second count');
select tests.manager();
select is(tests.confirm(tests.cid('l2'), 'counting_error', 'k-l2'), 'confirmed',
          'the Manager confirms the late count');
select is(tests.state(tests.t() - 3), 'shortage', 'the day is closed as a Shortage');
select is(tests.expected(), 199500::bigint, 'the shortage posted, as any confirmed count''s does');

-- ---------------------------------------------------------------------------
-- 2 · Today closes: counted but waiting, then sent back after the close
-- ---------------------------------------------------------------------------
select tests.cashier();
select is(tests.keep('t1', tests.enter(null, 199500, 't1')), 'counted', 'today is counted on time');
select is(tests.keep('t-late', tests.late(tests.t() - 2, null, 199500, 'Missed that day', 't-late')),
          'later_count_waiting', 'a missed day cannot be counted while today''s count waits');
select is((select res ->> 'business_date' from r where name = 't-late'), tests.t()::text,
          'and the refusal names today');

select tests.end_day();
select is(tests.state(tests.t() - 1), 'awaiting_confirmation',
          'a day that closed with its count waiting is Awaiting Manager confirmation, not Not counted');
select is(tests.state(tests.t()), 'due', 'the new day is due');

select tests.manager();
select is(tests.send_back(tests.cid('t1'), 's-t1'), 'sent_back',
          'the Manager sends yesterday''s count back after the close');
-- The clock above is simulated and now() is fixed for the transaction, so the count is placed an
-- hour before yesterday's close and its send-back an hour after it, as real time would have.
set local session_replication_role = replica;
update public.imprest_counts
   set counted_at = private.imprest_business_day_close(tests.t() - 1) - interval '1 hour'
 where id = tests.cid('t1');
update public.imprest_count_returns
   set returned_at = private.imprest_business_day_close(tests.t() - 1) + interval '1 hour'
 where count_id = tests.cid('t1');
set local session_replication_role = origin;
select is(tests.state(tests.t() - 1), 'not_counted', 'yesterday is now Not counted');
select is(tests.not_counted_since(tests.t() - 1),
          (select returned_at from public.imprest_count_returns where count_id = tests.cid('t1')),
          'from the moment it was sent back, not from its close');

select tests.cashier();
select is(tests.keep('t2', tests.late(tests.t() - 1, tests.cid('t1'), 199500, 'Recount the next morning', 't2')),
          'counted', 'the Cashier counts it again late');
set local session_replication_role = replica;
update public.imprest_counts
   set counted_at = private.imprest_business_day_close(tests.t() - 1) + interval '2 hours'
 where id = tests.cid('t2');
set local session_replication_role = origin;
select tests.manager();
select is(tests.confirm(tests.cid('t2'), null, 'k-t2'), 'confirmed', 'and it is confirmed Balanced');
select is(tests.state(tests.t() - 1), 'balanced', 'yesterday is Balanced');

-- ---------------------------------------------------------------------------
-- 5 · Missed days block nothing
-- ---------------------------------------------------------------------------
select tests.cashier();
select is(tests.keep('p-fuel', api.staff_propose_imprest_disbursement(
            10000, 'fuel_and_lubricants', 'Generator diesel', 'p-fuel')) is not null, true,
          'a disbursement is proposed with missed days open');
select tests.manager();
select is((api.staff_decide_imprest_disbursement(tests.did('p-fuel'), 1, true, null, 'a-fuel') ->> 'ok')::boolean,
          true, 'and approved');
select tests.cashier();
select is(tests.keep('t3', tests.enter(null, 199500, 't3')), 'counted',
          'and today is counted, though two earlier days were never counted');
select tests.manager();
select is(tests.confirm(tests.cid('t3'), null, 'k-t3'), 'confirmed', 'and confirmed');

select is(tests.days(),
          (tests.t() - 4) || ':shortage,' || (tests.t() - 3) || ':not_counted,'
          || (tests.t() - 2) || ':not_counted,' || (tests.t() - 1) || ':balanced,'
          || tests.t() || ':balanced',
          'every day resolves to exactly one state');

-- ---------------------------------------------------------------------------
-- 4 · Who reads what
-- ---------------------------------------------------------------------------
select tests.director_b();
select is(tests.open_days(),
          (tests.t() - 3) || ':not_counted,' || (tests.t() - 2) || ':not_counted',
          'the second Director reads the two days still open');
select tests.cashier();
select is(tests.open_days(),
          (tests.t() - 3) || ':not_counted,' || (tests.t() - 2) || ':not_counted',
          'the Cashier reads them too, to count them late');
select throws_ok($$ select * from api.staff_imprest_count_alert_history(10, 0) $$, '42501', null,
                 'the Cashier is not sent the alert history');
select tests.rep();
select throws_ok($$ select * from api.staff_imprest_open_count_days(10, 0) $$, '42501', null,
                 'a Sales Representative reads no open days');
select throws_ok($$ select * from api.staff_imprest_count_alert_history(10, 0) $$, '42501', null,
                 'nor the alert history');

select tests.manager();
select is(
  (select string_agg(kind || ':' || coalesce(attempt::text, '-') || ':' || resolution, ','
                     order by kind, attempt)
     from api.staff_imprest_count_alert_history(100, 0) where business_date = tests.t() - 4),
  'awaiting_confirmation:1:sent_back,awaiting_confirmation:2:confirmed,not_counted:-:counted_late',
  'the late day''s alerts stay in the history: both counts and the Not counted day');
select is(
  (select (raised_at, resolved_at)::text from api.staff_imprest_count_alert_history(100, 0)
    where business_date = tests.t() - 4 and kind = 'not_counted'),
  (private.imprest_business_day_close(tests.t() - 4),
   (select confirmed_at from public.imprest_count_confirmations where count_id = tests.cid('l2')))::text,
  'raised when the day closed, resolved when the late count was confirmed');
select is(
  (select resolution from api.staff_imprest_count_alert_history(100, 0)
    where business_date = tests.t() - 1 and kind = 'not_counted'),
  'counted_late', 'a day sent back after the close and counted late is in the history too');
select is(
  (select count(*)::int from api.staff_imprest_count_alert_history(100, 0) where kind = 'not_counted'
      and business_date in (tests.t() - 3, tests.t() - 2)),
  0, 'an alert still open is not in the history');

select is(
  (select late_reason from api.staff_imprest_counts(100, 0) where id = tests.cid('l2')),
  'Cashier was off sick', 'the counts read carries a late count''s reason');
select is(
  (select count(*)::int from api.staff_imprest_counts(100, 0) where late_reason is null),
  2, 'and none for the counts entered on their own day');
select is(
  (select string_agg(attempt::text, ',' order by attempt)
     from api.staff_imprest_counts(1, 0, tests.t() - 4)),
  '2', 'the read narrows to one day, so today''s card never loses today behind late counts');
select is(
  (select string_agg(attempt::text || ':' || total, ',' order by attempt)
     from api.staff_imprest_counts(100, 0, tests.t() - 4)),
  '1:2,2:2', 'and counts only that day''s rows in its total');

-- ---------------------------------------------------------------------------
-- 6 · The audit trail
-- ---------------------------------------------------------------------------
select ok(exists (select 1 from public.audit_events
                   where entity_type = 'imprest_count' and action = 'imprest_count_entered'
                     and entity_id = tests.cid('l1')
                     and actor_id = 'e6900000-0000-0000-0000-000000000004' and actor_role = 'cashier'
                     and correlation_id is not null
                     and source_operation = 'api.staff_enter_imprest_count'
                     and (after_state ->> 'late')::boolean
                     and after_state ->> 'late_reason' = 'Cashier was off sick'
                     and after_state ->> 'business_date' = (tests.t() - 4)::text),
          'a late count is recorded with its actor, live role, day, reason and correlation id');
select ok(exists (select 1 from public.audit_events
                   where entity_type = 'imprest_count' and action = 'command_refused'
                     and source_operation = 'api.staff_enter_imprest_count'
                     and after_state ->> 'reason' = 'day_not_countable'
                     and actor_role = 'cashier' and correlation_id is not null),
          'a refused late count is recorded with its reason');
select ok(exists (select 1 from public.audit_events
                   where entity_type = 'imprest_count' and action = 'command_refused'
                     and after_state ->> 'reason' = 'later_count_waiting'
                     and after_state ->> 'business_date' is not null),
          'and names the day that waits');

select * from finish();
rollback;
