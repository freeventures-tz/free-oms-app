-- Issue #69 · Imprest daily count, part 2: a day nobody counted shows as Not counted
--
-- product.md §13.7, §15.2a and §15.3, AC-112 and AC-113. A reconciliation that never happened is
-- unknown, not balanced. Every business day of the active fund resolves to exactly one state:
--
--   Not counted                     the day closed with no count standing
--   Awaiting Manager confirmation   a count waits for the Manager
--   Balanced, Shortage, Excess      the day's count is confirmed (issue #68)
--
-- Today, before it closes, is due rather than Not counted.
--
-- NOTHING IS STORED FOR A MISSING DAY. The states come from the counts and the business clock on
-- every read, so no job has to run for a day to become Not counted: `private.imprest_count_days`
-- decides it the moment the day closes in Africa/Dar_es_Salaam.
--
-- THE ALERTS ARE DERIVED THE SAME WAY. Both Directors and the Manager read every open day, oldest
-- first, with when it started waiting. A Not counted alert opens when the day closes with no count
-- standing, or when the Manager sends back a count after the close, and stays open until the day
-- has a confirmed count. An Awaiting Manager confirmation alert opens when a count is entered and
-- closes when the Manager confirms it or sends it back. Resolved alerts stay in a history.
--
-- A LATE COUNT. The Cashier may count a past Not counted day, with a required reason of 3 to 500
-- characters. It is compared with the expected cash as it stands when entered, like any count, goes
-- through the same confirm path, and keeps its reason, so the record says it was late. The fund
-- still holds one waiting count, so one gap can never post twice.
--
-- WHERE THE DAYS START. A day is a business day of the fund from the later of the day the fund
-- opened and the day counting started. Counting started with the daily count release: this
-- migration fixes that date as today, or the first count's day if one is earlier. Days before it
-- could not be counted, and are not reported as missed.
--
-- A missing count blocks nothing (§15.2a, §18.4): no command reads these states.
--
-- Released objects this replaces, pinned in the migration-chain phase: the entry check
-- `private.check_imprest_count_entry`, the command `api.staff_enter_imprest_count` (its five-argument
-- form now enters today's count through the new command) and the read `api.staff_imprest_counts`,
-- which now returns a count's late reason and lists counts most recently entered first, so the one
-- waiting count always leads. `private.impl_staff_enter_imprest_count` takes the late
-- reason; its five-argument form is dropped.

begin;

-- ---------------------------------------------------------------------------
-- A late count keeps its reason. Only status and version still change.
-- ---------------------------------------------------------------------------
alter table public.imprest_counts
  add column late_reason text
    constraint count_late_reason_shape
      check (late_reason is null or length(btrim(late_reason)) between 3 and 500);

comment on column public.imprest_counts.late_reason is
  'Why a past Not counted day was counted late (issue #69). Null for a count entered on its own day.';

grant select (late_reason) on public.imprest_counts to authenticated;

-- ---------------------------------------------------------------------------
-- The business day's edges, in Africa/Dar_es_Salaam (§15.3), never the server's zone
-- ---------------------------------------------------------------------------
create or replace function private.imprest_business_date_of(p_at timestamptz)
returns date
language sql
immutable
set search_path = ''
as $$
  select (p_at at time zone 'Africa/Dar_es_Salaam')::date;
$$;

comment on function private.imprest_business_date_of(timestamptz) is
  'The business day an instant falls on, in Africa/Dar_es_Salaam (§15.3).';

-- The instant a business day closes: midnight at its end, in Africa/Dar_es_Salaam.
create or replace function private.imprest_business_day_close(p_day date)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select ((p_day + 1)::timestamp at time zone 'Africa/Dar_es_Salaam');
$$;

comment on function private.imprest_business_day_close(date) is
  'The instant a business day ends: 00:00:00 of the next day in Africa/Dar_es_Salaam (§15.3).';

-- The day counting started, fixed when this migration ran: today, or the first count's day if one
-- is earlier. A function rather than a row, so nothing a session holds can move it.
do $$
declare
  v_today date := private.imprest_business_date();
  v_start date := least(v_today, coalesce((select min(business_date) from public.imprest_counts),
                                          v_today));
begin
  execute format($f$
    create function private.imprest_counting_starts_on() returns date
    language sql immutable set search_path = ''
    as $b$ select %L::date $b$
  $f$, v_start);
end
$$;

comment on function private.imprest_counting_starts_on() is
  'The first business day that could be counted: the day the daily count was released (issue #69). '
  'Days before it are not reported as Not counted.';

-- The fund's first business day to count: the later of the day it opened and the day counting started.
create or replace function private.imprest_first_count_day(p_fund_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(private.imprest_business_date_of(f.opened_at), private.imprest_counting_starts_on())
    from public.imprest_funds f where f.id = p_fund_id;
$$;

-- ---------------------------------------------------------------------------
-- Every business day of a fund, and where it stands
-- ---------------------------------------------------------------------------
-- One row a day, from the fund's first business day to today. The day's latest count decides its
-- state; with none standing, a closed day is Not counted and today is due.
--
-- `not_counted_since` is when the Not counted alert opened: the close, if no count stood then, or
-- the send-back after the close that left the day with none. It stays set once the day is counted
-- late, with `resolved_at` the confirmation that closed it.
create or replace function private.imprest_count_days(p_fund_id uuid)
returns table (business_date date, state text, not_counted_since timestamptz,
               awaiting_since timestamptz, resolved_at timestamptz, latest_count_id uuid,
               latest_status text, latest_return_reason text)
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select private.imprest_first_count_day(p_fund_id) as first_day,
           private.imprest_business_date() as today
  ), days as (
    select d::date as business_date, private.imprest_business_day_close(d::date) as closes_at,
           b.today
      from bounds b
      cross join generate_series(b.first_day, b.today, interval '1 day') d
  )
  select d.business_date,
         case when l.status = 'confirmed' then k.outcome::text
              when l.status = 'awaiting_confirmation' then 'awaiting_confirmation'
              when d.business_date < d.today then 'not_counted'
              else 'due' end,
         -- `greatest` ignores a null, so with no count at the close this is the close itself.
         case when d.business_date < d.today and (s.id is null or s.status = 'sent_back')
              then greatest(d.closes_at, sx.returned_at) end,
         case when l.status = 'awaiting_confirmation' then l.counted_at end,
         k.confirmed_at,
         l.id, l.status::text, lx.reason
    from days d
    -- The day's latest count.
    left join lateral (
      select c.id, c.status, c.counted_at from public.imprest_counts c
       where c.fund_id = p_fund_id and c.business_date = d.business_date
       order by c.attempt desc limit 1) l on true
    left join public.imprest_count_confirmations k on k.count_id = l.id
    left join public.imprest_count_returns lx on lx.count_id = l.id
    -- The count that stood when the day closed, if any, and its send-back.
    left join lateral (
      select c.id, c.status from public.imprest_counts c
       where c.fund_id = p_fund_id and c.business_date = d.business_date
         and c.counted_at < d.closes_at
       order by c.attempt desc limit 1) s on true
    left join public.imprest_count_returns sx on sx.count_id = s.id;
$$;

comment on function private.imprest_count_days(uuid) is
  'Each business day of a fund from its first to today, resolved to Not counted, Awaiting Manager '
  'confirmation, Balanced, Shortage or Excess, or due for today (issue #69, §15.2a). Calculated on '
  'every read; nothing is stored for a missing day.';

-- ---------------------------------------------------------------------------
-- A count is for today, or late for a past day of the fund with a reason
-- ---------------------------------------------------------------------------
-- As issue #68's check, except the day: today with no late reason, or a past day of the fund with
-- one. The figures are still exactly those standing now.
create or replace function private.check_imprest_count_entry()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_last    public.imprest_counts%rowtype;
  v_posted  bigint;
  v_waiting bigint;
  v_today   date := private.imprest_business_date();
begin
  select * into v_last from public.imprest_counts
   where fund_id = new.fund_id and business_date = new.business_date
   order by attempt desc limit 1;
  select s.posted_balance_tzs into v_posted from private.imprest_spending_figures(new.fund_id) s;
  v_waiting := private.imprest_awaiting_verification_tzs(new.fund_id);

  if new.status is distinct from 'awaiting_confirmation' or new.version is distinct from 1
     or new.business_date is null or new.business_date > v_today
     or new.business_date < private.imprest_first_count_day(new.fund_id)
     or (new.business_date < v_today) is distinct from (new.late_reason is not null)
     or not exists (select 1 from public.imprest_funds where id = new.fund_id and is_active)
     or new.attempt is distinct from coalesce(v_last.attempt, 0) + 1
     or (v_last.id is not null and v_last.status is distinct from 'sent_back')
     or new.posted_balance_tzs is distinct from v_posted
     or new.awaiting_verification_tzs is distinct from v_waiting then
    raise exception 'imprest count % is not the day''s next count at the figures as they stand',
      new.id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Enter a count (the Cashier): today's, or a past Not counted day's with a late reason
-- ---------------------------------------------------------------------------
drop function private.impl_staff_enter_imprest_count(date, uuid, bigint, text, text);

create or replace function private.impl_staff_enter_imprest_count(
  p_business_date date, p_previous_count_id uuid, p_counted_tzs bigint, p_note text,
  p_late_reason text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := private.acting_staff(array['cashier']::public.app_role[]);
  v_note    text := nullif(private.normalise_label(p_note), '');
  v_late    text := nullif(private.normalise_label(p_late_reason), '');
  v_today   date := private.imprest_business_date();
  v_class   jsonb;
  v_fund    uuid;
  v_last    public.imprest_counts%rowtype;
  v_posted  bigint;
  v_waiting bigint;
  v_waiting_day date;
  v_id      uuid := gen_random_uuid();
  v_request jsonb := jsonb_build_object('business_date', p_business_date,
                                        'previous_count_id', p_previous_count_id,
                                        'counted_tzs', p_counted_tzs, 'note', v_note,
                                        'late_reason', v_late);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));
  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'imprest.enter_count', v_actor, v_request);
  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  elsif v_class ->> 'status' = 'replay' then
    return private.imprest_count_result('replayed', (v_class ->> 'result_ref')::uuid);
  end if;

  select id into v_fund from public.imprest_funds where is_active;
  if v_fund is null then
    return jsonb_build_object('ok', false, 'reason', 'no_fund');
  end if;

  -- Serialised per fund with every approval and verification, so the figures kept with the count
  -- are the ones standing, and two counts cannot race for the same day.
  perform pg_advisory_xact_lock(hashtextextended('imprest_fund_spend:' || v_fund::text, 0));

  -- Today's count carries no late reason; a past day's needs one. A screen of today's count left
  -- open past midnight sends yesterday with none, and is told the day changed.
  if p_business_date is null or p_business_date > v_today
     or (p_business_date < v_today and v_late is null) then
    return jsonb_build_object('ok', false, 'reason', 'day_changed', 'business_date', v_today::text);
  elsif p_business_date = v_today and v_late is not null then
    return jsonb_build_object('ok', false, 'reason', 'late_reason_not_needed');
  elsif p_business_date < private.imprest_first_count_day(v_fund) then
    return jsonb_build_object('ok', false, 'reason', 'day_not_countable',
                              'business_date', p_business_date::text);
  end if;

  -- Another day's count still waiting blocks this one: it kept the balance before this gap, so
  -- confirming both would post the same missing cash twice. The Manager decides it first.
  select business_date into v_waiting_day from public.imprest_counts
   where fund_id = v_fund and status = 'awaiting_confirmation' and business_date <> p_business_date;
  if v_waiting_day is not null then
    return jsonb_build_object('ok', false,
                              'reason', case when v_waiting_day < p_business_date
                                             then 'earlier_count_waiting'
                                             else 'later_count_waiting' end,
                              'business_date', v_waiting_day::text);
  end if;

  select * into v_last from public.imprest_counts
   where fund_id = v_fund and business_date = p_business_date
   order by attempt desc limit 1;
  if v_last.status = 'confirmed' then
    return jsonb_build_object('ok', false, 'reason', 'already_confirmed',
                              'business_date', p_business_date::text);
  elsif v_last.status = 'awaiting_confirmation' then
    return jsonb_build_object('ok', false, 'reason', 'count_awaiting_confirmation',
                              'business_date', p_business_date::text);
  elsif v_last.id is distinct from p_previous_count_id then
    -- The day the Cashier was shown is not the day as it stands: another count came in, or a count
    -- was sent back that the screen has not yet shown.
    return jsonb_build_object('ok', false, 'reason', 'stale', 'business_date', p_business_date::text);
  end if;

  if p_counted_tzs is null or p_counted_tzs < 0 or p_counted_tzs > 100000000 then
    return jsonb_build_object('ok', false, 'reason', 'amount_invalid');
  elsif private.imprest_text_problem(v_note, false) then
    return jsonb_build_object('ok', false, 'reason', 'note_invalid');
  elsif private.imprest_text_problem(v_late, false) then
    return jsonb_build_object('ok', false, 'reason', 'late_reason_invalid');
  end if;

  -- The key, the figures and the count go in together, as in issue #68: a figure that moves between
  -- this read and the entry trigger's re-check rolls back to here, and the Cashier presses again.
  begin
    if private.imprest_claim_key(p_idempotency_key, 'imprest.enter_count', v_actor, v_request,
                                 v_id) <> 'claimed' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;

    select s.posted_balance_tzs into v_posted from private.imprest_spending_figures(v_fund) s;
    v_waiting := private.imprest_awaiting_verification_tzs(v_fund);

    insert into public.imprest_counts (id, fund_id, business_date, attempt, counted_tzs, note,
                                       posted_balance_tzs, awaiting_verification_tzs, expected_tzs,
                                       counted_by, late_reason)
    values (v_id, v_fund, p_business_date, coalesce(v_last.attempt, 0) + 1, p_counted_tzs, v_note,
            v_posted, v_waiting, v_posted - v_waiting, v_actor, v_late);
  exception when check_violation then
    return jsonb_build_object('ok', false, 'reason', 'figures_moved');
  end;

  perform private.imprest_count_audit(v_actor, 'imprest_count_entered', v_id,
    case when v_last.id is not null then jsonb_build_object('replaces_count_id', v_last.id) end,
    jsonb_build_object('status', 'awaiting_confirmation', 'business_date', p_business_date,
                       'attempt', coalesce(v_last.attempt, 0) + 1, 'counted_tzs', p_counted_tzs,
                       'posted_balance_tzs', v_posted, 'awaiting_verification_tzs', v_waiting,
                       'expected_tzs', v_posted - v_waiting,
                       'variance_tzs', p_counted_tzs - (v_posted - v_waiting),
                       'late', v_late is not null, 'late_reason', v_late),
    'api.staff_enter_imprest_count');

  return private.imprest_count_result('counted', v_id);
end;
$$;

create or replace function api.staff_enter_imprest_count(
  p_business_date date, p_previous_count_id uuid, p_counted_tzs bigint, p_note text,
  p_late_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_enter_imprest_count(
  p_business_date, p_previous_count_id, p_counted_tzs, p_note, p_late_reason, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_enter_imprest_count', 'imprest_count', p_previous_count_id, v);
end $$;

comment on function api.staff_enter_imprest_count(date, uuid, bigint, text, text, text) is
  'The Cashier enters a count of the cash in the tin, in whole shillings of 0 or more, with an '
  'optional note: today''s, or a past Not counted day''s with a late reason of 3 to 500 characters '
  '(issues #68 and #69). Expected cash is calculated as it stands and kept with it.';

-- Issue #68's form, kept so a screen loaded before this release can still count today.
create or replace function api.staff_enter_imprest_count(
  p_business_date date, p_previous_count_id uuid, p_counted_tzs bigint, p_note text,
  p_idempotency_key text)
returns jsonb language sql security definer set search_path = '' as $$
  select api.staff_enter_imprest_count(p_business_date, p_previous_count_id, p_counted_tzs, p_note,
                                       null, p_idempotency_key);
$$;

comment on function api.staff_enter_imprest_count(date, uuid, bigint, text, text) is
  'Today''s count, as issue #68 entered it: the six-argument form with no late reason.';

-- ---------------------------------------------------------------------------
-- Read: the counts, most recent first, now with a late count's reason
-- ---------------------------------------------------------------------------
drop function api.staff_imprest_counts(integer, integer);

-- `p_business_date` narrows the read to one day, so today's card reads today's counts however many
-- late counts were entered after them. Left out, it reads every day, as issue #68's form did.
create function api.staff_imprest_counts(p_limit integer, p_offset integer,
                                         p_business_date date default null)
returns table (id uuid, business_date date, attempt integer, counted_tzs bigint, note text,
               posted_balance_tzs bigint, awaiting_verification_tzs bigint, expected_tzs bigint,
               variance_tzs bigint, status text, version integer, counted_by text,
               counted_at timestamptz, outcome text, explanation text, explanation_note text,
               confirmed_by text, confirmed_at timestamptz, return_reason text,
               returned_by text, returned_at timestamptz, needs_director_decision boolean,
               late_reason text, total bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.acting_staff(array['director', 'manager', 'cashier']::public.app_role[]);
  v_role  public.app_role := private.live_role_of(v_actor);
begin
  -- The Cashier sees what they counted, the expected cash and the variance, and not the posted
  -- balance or awaiting verification behind it: the spending read withholds both from them too.
  return query
    select c.id, c.business_date, c.attempt, c.counted_tzs, c.note,
           case when v_role = 'cashier' then null else c.posted_balance_tzs end,
           case when v_role = 'cashier' then null else c.awaiting_verification_tzs end,
           c.expected_tzs, c.variance_tzs, c.status::text, c.version,
           pc.full_name, c.counted_at,
           k.outcome::text, k.explanation::text, k.explanation_note, pk.full_name, k.confirmed_at,
           x.reason, px.full_name, x.returned_at,
           p.needs_director_decision,
           c.late_reason,
           count(*) over ()
      from public.imprest_counts c
      join public.imprest_funds f on f.id = c.fund_id and f.is_active
      join public.profiles pc on pc.id = c.counted_by
      left join public.imprest_count_confirmations k on k.count_id = c.id
      left join public.profiles pk on pk.id = k.confirmed_by
      left join public.imprest_count_returns x on x.count_id = c.id
      left join public.profiles px on px.id = x.returned_by
      left join public.imprest_count_postings p on p.count_id = c.id
     where p_business_date is null or c.business_date = p_business_date
     -- Most recently entered first, where issue #68 ordered by day. A late count is for an old day,
     -- and the fund's one waiting count must lead the first page: nothing is entered while it
     -- waits, so it is always the latest entered.
     order by c.counted_at desc, c.attempt desc, c.id
     limit greatest(least(coalesce(p_limit, 30), 100), 1)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

comment on function api.staff_imprest_counts(integer, integer, date) is
  'The active fund''s daily counts, most recently entered first, each with expected, counted, variance, the '
  'Manager''s confirmation or send-back, and a late count''s reason (issues #68 and #69). A Cashier '
  'is not sent the posted balance or awaiting verification behind expected cash.';

-- ---------------------------------------------------------------------------
-- Read: the open days, oldest first
-- ---------------------------------------------------------------------------
-- Every day of the active fund that is Not counted or Awaiting Manager confirmation, oldest first,
-- with when it started waiting. For Directors and the Manager these are the open alerts; the Cashier
-- reads the same days to count a missed one late. No page is capped short of the whole list.
create or replace function api.staff_imprest_open_count_days(p_limit integer, p_offset integer)
returns table (business_date date, state text, waiting_since timestamptz,
               not_counted_since timestamptz, awaiting_since timestamptz, latest_count_id uuid,
               latest_status text, latest_return_reason text, total bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.acting_staff(array['director', 'manager', 'cashier']::public.app_role[]);
  return query
    select d.business_date, d.state, least(d.not_counted_since, d.awaiting_since),
           d.not_counted_since, d.awaiting_since, d.latest_count_id, d.latest_status,
           d.latest_return_reason, count(*) over ()
      from public.imprest_funds f
      cross join lateral private.imprest_count_days(f.id) d
     where f.is_active and d.state in ('not_counted', 'awaiting_confirmation')
     order by d.business_date asc
     limit greatest(least(coalesce(p_limit, 30), 100), 1)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

comment on function api.staff_imprest_open_count_days(integer, integer) is
  'The active fund''s Not counted and Awaiting Manager confirmation days, oldest first, with when each '
  'started waiting (issue #69, §15.2a, AC-112, AC-113). Directors, the Manager and the Cashier read.';

-- ---------------------------------------------------------------------------
-- Read: the alerts that have been resolved, most recently resolved first
-- ---------------------------------------------------------------------------
-- A Not counted alert resolved when a late count was confirmed; an Awaiting Manager confirmation
-- alert, one a count, resolved when the Manager confirmed it or sent it back. Directors and the
-- Manager, to whom the alerts are raised.
create or replace function api.staff_imprest_count_alert_history(p_limit integer, p_offset integer)
returns table (kind text, business_date date, count_id uuid, attempt integer,
               raised_at timestamptz, resolved_at timestamptz, resolution text, total bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.acting_staff(array['director', 'manager']::public.app_role[]);
  return query
    with alerts as (
      select 'not_counted'::text as kind, d.business_date, null::uuid as count_id,
             null::integer as attempt, d.not_counted_since as raised_at, d.resolved_at,
             'counted_late'::text as resolution
        from public.imprest_funds f
        cross join lateral private.imprest_count_days(f.id) d
       where f.is_active and d.not_counted_since is not null and d.resolved_at is not null
      union all
      select 'awaiting_confirmation', c.business_date, c.id, c.attempt, c.counted_at,
             coalesce(k.confirmed_at, x.returned_at),
             case when k.id is not null then 'confirmed' else 'sent_back' end
        from public.imprest_counts c
        join public.imprest_funds f on f.id = c.fund_id and f.is_active
        left join public.imprest_count_confirmations k on k.count_id = c.id
        left join public.imprest_count_returns x on x.count_id = c.id
       where c.status <> 'awaiting_confirmation'
    )
    select a.kind, a.business_date, a.count_id, a.attempt, a.raised_at, a.resolved_at,
           a.resolution, count(*) over ()
      from alerts a
     order by a.resolved_at desc, a.business_date desc, a.kind, a.attempt desc nulls last
     limit greatest(least(coalesce(p_limit, 30), 100), 1)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

comment on function api.staff_imprest_count_alert_history(integer, integer) is
  'Resolved daily count alerts, most recently resolved first: Not counted days counted late, and '
  'counts that waited for the Manager (issue #69, §15.2a). Directors and the Manager read.';

-- ---------------------------------------------------------------------------
-- Ownership and grants
-- ---------------------------------------------------------------------------
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure::text as signature, n.nspname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'api'
            and p.proname in ('staff_enter_imprest_count', 'staff_imprest_counts',
                              'staff_imprest_open_count_days', 'staff_imprest_count_alert_history'))
        or (n.nspname = 'private'
            and p.proname in ('imprest_business_date_of', 'imprest_business_day_close',
                              'imprest_counting_starts_on', 'imprest_first_count_day',
                              'imprest_count_days', 'check_imprest_count_entry',
                              'impl_staff_enter_imprest_count'))
  loop
    execute format('alter function %s owner to fv_definer_owner', fn.signature);
    execute format('revoke execute on function %s from public, anon, authenticated, service_role',
                   fn.signature);
    if fn.nspname = 'api' then
      execute format('grant execute on function %s to authenticated', fn.signature);
    end if;
  end loop;
end
$$;

notify pgrst, 'reload schema';

commit;
