-- Issue #83 · The Cashier counts the till and the Manager confirms it
--
-- product.md §15, design.md §7.19 and §14.7. The first reconciliation of Stage 15, built on the
-- model the imprest daily count uses (issues #68 and #69), which this migration does not touch.
--
-- RECONCILIATIONS ARE KEYED BY TYPE AND BUSINESS DATE. The till is the first type; stock comes
-- later on the same tables. A reconciliation holds one LINE per thing counted: for the till, one per
-- payment method. Each line keeps three figures:
--
--   expected  calculated from the day's payments, never typed, and kept as it stood at entry
--   counted   what the Cashier typed; nullable, so a figure nobody counted is never a zero
--   variance  counted − expected, derived by the database and never written by a command
--
-- None of the three ever changes. A recount after a send-back is a new reconciliation, numbered
-- after the one it replaces, and the first stays on the record.
--
-- EXPECTED. For the till, a method's expected figure is the sum of that method's payments recorded
-- on the business day (`payments.business_date`, the Africa/Dar_es_Salaam day, §15.3). A reversal
-- is a negative payment on the day it was approved, so the figure is the net money taken. Credit is
-- not a tender (§12.5) and has no line.
--
-- THE PATH. The Cashier enters and submits the count. The Manager confirms it as it stands, or sends
-- it back with a reason for a recount. The person who entered a count may never decide it, even
-- after a change of role. A confirmed day is Balanced, Shortage or Excess, with zero tolerance
-- (§15.1): any line short makes the day a Shortage, because an excess on one method never hides
-- money missing from another. A Shortage or Excess takes one of the seven reasons of design.md §14.7,
-- and Suspected loss or theft, Under investigation and Other need a written note.
--
-- THE DAY. Every business day from the day counting started reads Not counted, Awaiting Manager
-- confirmation, Balanced, Shortage or Excess, calculated on each read; today, before it closes, is
-- due. Nothing is stored for a missing day. A past Not counted day may be counted late with a reason
-- of 3 to 500 characters, under the imprest count's rule, compared with expected as it stands then.
--
-- WHAT THE TILL DOES NOT COPY FROM THE IMPREST COUNT. Nothing posts: the till's expected figure is
-- one day's takings, not a running balance, so a variance does not carry into the next day and
-- several days may wait for the Manager at once. No flag is raised to the Directors; the variance
-- investigation, accountability decisions, the missing-count alert and the daily report's till
-- section are later tickets of #10.
--
-- WHO SEES WHAT (design.md §7.19). The Cashier is not shown expected figures before counting, and
-- afterwards reads only the counts they entered: the policies and the reads refuse more. Directors
-- and the Manager read every count; Directors decide nothing here.

begin;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.reconciliation_type as enum ('till');

create type public.reconciliation_status as enum (
  'awaiting_confirmation',  -- entered, waiting for the Manager
  'sent_back',              -- the Manager asked for a recount; a new reconciliation replaces it
  'confirmed'               -- the Manager confirmed it; the day is closed
);

create type public.reconciliation_outcome as enum ('balanced', 'shortage', 'excess');

-- design.md §14.7. The last three need a written note.
create type public.variance_reason as enum (
  'counting_error',
  'recording_error',
  'change_not_returned',
  'amount_correction',
  'suspected_loss_or_theft',
  'under_investigation',
  'other'
);

comment on type public.reconciliation_type is
  'What a reconciliation counts (issue #83). The till is the first; stock comes later.';
comment on type public.variance_reason is
  'The variance reasons of design.md §14.7. Suspected loss or theft, Under investigation and Other '
  'need a written note.';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.reconciliations (
  id            uuid primary key default gen_random_uuid(),
  type          public.reconciliation_type not null,
  -- The business day (§15.3), in Africa/Dar_es_Salaam.
  business_date date not null,
  -- 1 for the day's first count, then one more for each recount after a send-back.
  attempt       integer not null check (attempt >= 1),
  note          text check (note is null or length(btrim(note)) between 3 and 500),
  -- Why a past Not counted day was counted late. Null for a count entered on its own day.
  late_reason   text check (late_reason is null or length(btrim(late_reason)) between 3 and 500),
  status        public.reconciliation_status not null default 'awaiting_confirmation',
  version       integer not null default 1 check (version >= 1),
  counted_by    uuid not null references public.profiles (id),
  counted_at    timestamptz not null default now(),
  unique (type, business_date, attempt)
);

comment on table public.reconciliations is
  'One count of one type for one business day (issue #83). A recount is a new row; only status and '
  'version ever change.';

-- At most one count of a type a day that has not been sent back: the one waiting, or the one
-- confirmed. Two Cashiers submitting at once leave one standing.
create unique index reconciliations_one_standing_per_day
  on public.reconciliations (type, business_date) where status <> 'sent_back';
create index reconciliations_recent_idx on public.reconciliations (type, counted_at desc);
create index reconciliations_by_idx on public.reconciliations (counted_by);

create table public.reconciliation_lines (
  id                uuid primary key default gen_random_uuid(),
  reconciliation_id uuid not null references public.reconciliations (id) on delete restrict,
  -- What the line counts. For the till, a payment method.
  line              text not null,
  expected_tzs      bigint not null,
  -- Null when nothing was counted for the line: missing is never zero.
  counted_tzs       bigint check (counted_tzs is null
                                  or (counted_tzs >= 0 and counted_tzs <= 1000000000000)),
  variance_tzs      bigint generated always as (counted_tzs - expected_tzs) stored,
  unique (reconciliation_id, line)
);

comment on table public.reconciliation_lines is
  'What one reconciliation counted, line by line (issue #83): the expected figure as it stood at '
  'entry, the counted figure (null if not counted) and the derived variance. Never changed.';

create table public.reconciliation_returns (
  id                uuid primary key default gen_random_uuid(),
  reconciliation_id uuid not null unique references public.reconciliations (id) on delete restrict,
  reason            text not null check (length(btrim(reason)) between 3 and 500),
  returned_by       uuid not null references public.profiles (id),
  returned_at       timestamptz not null default now()
);

comment on table public.reconciliation_returns is
  'The Manager sent a count back for a recount, with a reason (issue #83). Never changed.';

create index reconciliation_returns_by_idx on public.reconciliation_returns (returned_by);

create table public.reconciliation_confirmations (
  id                uuid primary key default gen_random_uuid(),
  reconciliation_id uuid not null unique references public.reconciliations (id) on delete restrict,
  outcome           public.reconciliation_outcome not null,
  -- The sum of the lines' variances, what they were short by and what they were over by.
  variance_tzs      bigint not null,
  short_tzs         bigint not null check (short_tzs >= 0),
  over_tzs          bigint not null check (over_tzs >= 0),
  explanation       public.variance_reason,
  explanation_note  text check (explanation_note is null
                                or length(btrim(explanation_note)) between 3 and 500),
  confirmed_by      uuid not null references public.profiles (id),
  confirmed_at      timestamptz not null default now(),
  constraint reconciliation_confirmation_shape check (
    variance_tzs = over_tzs - short_tzs
    and (outcome = 'shortage') = (short_tzs > 0)
    and (outcome = 'balanced') = (short_tzs = 0 and over_tzs = 0)
    and (outcome = 'balanced') = (explanation is null)
    and (explanation is not null or explanation_note is null)
    and (explanation is null
         or explanation not in ('suspected_loss_or_theft', 'under_investigation', 'other')
         or explanation_note is not null)
  )
);

comment on table public.reconciliation_confirmations is
  'The Manager confirmed a count (issue #83): Balanced, Shortage or Excess, with a preset reason for '
  'any variance. Never changed.';

create index reconciliation_confirmations_by_idx on public.reconciliation_confirmations (confirmed_by);

-- ---------------------------------------------------------------------------
-- Append-only
-- ---------------------------------------------------------------------------
create or replace function private.refuse_reconciliation_edit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only: % refused', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$;

comment on function private.refuse_reconciliation_edit() is
  'Refuses every UPDATE, DELETE and TRUNCATE of a reconciliation record that never changes, for '
  'every role. A correction is a new record.';

create trigger reconciliation_lines_append_only
  before update or delete on public.reconciliation_lines
  for each row execute function private.refuse_reconciliation_edit();
create trigger reconciliation_returns_append_only
  before update or delete on public.reconciliation_returns
  for each row execute function private.refuse_reconciliation_edit();
create trigger reconciliation_confirmations_append_only
  before update or delete on public.reconciliation_confirmations
  for each row execute function private.refuse_reconciliation_edit();
create trigger reconciliations_no_delete
  before delete on public.reconciliations
  for each row execute function private.refuse_reconciliation_edit();

create trigger reconciliations_no_truncate
  before truncate on public.reconciliations
  for each statement execute function private.refuse_reconciliation_edit();
create trigger reconciliation_lines_no_truncate
  before truncate on public.reconciliation_lines
  for each statement execute function private.refuse_reconciliation_edit();
create trigger reconciliation_returns_no_truncate
  before truncate on public.reconciliation_returns
  for each statement execute function private.refuse_reconciliation_edit();
create trigger reconciliation_confirmations_no_truncate
  before truncate on public.reconciliation_confirmations
  for each statement execute function private.refuse_reconciliation_edit();

-- ---------------------------------------------------------------------------
-- The business day, in Africa/Dar_es_Salaam (§15.3), never the server's zone
-- ---------------------------------------------------------------------------
create or replace function private.reconciliation_business_date()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'Africa/Dar_es_Salaam')::date;
$$;

comment on function private.reconciliation_business_date() is
  'Today, as the business counts days: 00:00:00 to 23:59:59 in Africa/Dar_es_Salaam (§15.3).';

create or replace function private.reconciliation_business_date_of(p_at timestamptz)
returns date
language sql
immutable
set search_path = ''
as $$
  select (p_at at time zone 'Africa/Dar_es_Salaam')::date;
$$;

create or replace function private.reconciliation_day_close(p_day date)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select ((p_day + 1)::timestamp at time zone 'Africa/Dar_es_Salaam');
$$;

comment on function private.reconciliation_day_close(date) is
  'The instant a business day ends: 00:00:00 of the next day in Africa/Dar_es_Salaam (§15.3).';

-- The day till counting started, fixed when this migration ran. Days before it could not be counted
-- and are not reported as missed. A function rather than a row, so nothing a session holds moves it.
do $$
begin
  execute format($f$
    create function private.till_counting_starts_on() returns date
    language sql immutable set search_path = ''
    as $b$ select %L::date $b$
  $f$, private.reconciliation_business_date());
end
$$;

comment on function private.till_counting_starts_on() is
  'The first business day the till could be counted: the day the till count was released (issue '
  '#83). Days before it are not reported as Not counted.';

-- ---------------------------------------------------------------------------
-- Expected, calculated in one place
-- ---------------------------------------------------------------------------
-- One row per payment method, in the order the methods are listed, with the day's net takings and
-- how many payment rows made them. A method nobody paid with expects 0, which is a real figure: it
-- is the counted side that may be missing, never the expected one.
create or replace function private.till_expected(p_day date)
returns table (line text, expected_tzs bigint, payments bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select m.method::text, coalesce(sum(p.amount_tzs), 0)::bigint, count(p.id)
    from unnest(enum_range(null::public.payment_method)) as m (method)
    left join public.payments p on p.method = m.method and p.business_date = p_day
   group by m.method
   order by m.method;
$$;

comment on function private.till_expected(date) is
  'What the till should hold for a business day, per payment method: the sum of that method''s '
  'payments on the day, reversals included as negative rows (issue #83). Never stored but in a '
  'count, as it stood when the count was entered.';

-- ---------------------------------------------------------------------------
-- Every business day, and where it stands
-- ---------------------------------------------------------------------------
-- One row a day, from the day counting started to today. The day's latest count decides its state;
-- with none standing, a closed day is Not counted and today is due.
create or replace function private.till_days()
returns table (business_date date, state text, not_counted_since timestamptz,
               awaiting_since timestamptz, latest_id uuid, latest_status text,
               latest_return_reason text)
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select private.till_counting_starts_on() as first_day,
           private.reconciliation_business_date() as today
  ), days as (
    select d::date as business_date, private.reconciliation_day_close(d::date) as closes_at, b.today
      from bounds b
      cross join generate_series(b.first_day, b.today, interval '1 day') d
  )
  select d.business_date,
         case when l.status = 'confirmed' then k.outcome::text
              when l.status = 'awaiting_confirmation' then 'awaiting_confirmation'
              when d.business_date < d.today then 'not_counted'
              else 'due' end,
         -- When the day became Not counted: its close, or the send-back after the close.
         case when d.business_date < d.today and (l.id is null or l.status = 'sent_back')
              then greatest(d.closes_at, lx.returned_at) end,
         case when l.status = 'awaiting_confirmation' then l.counted_at end,
         l.id, l.status::text, lx.reason
    from days d
    left join lateral (
      select c.id, c.status, c.counted_at from public.reconciliations c
       where c.type = 'till' and c.business_date = d.business_date
       order by c.attempt desc limit 1) l on true
    left join public.reconciliation_confirmations k on k.reconciliation_id = l.id
    left join public.reconciliation_returns lx on lx.reconciliation_id = l.id;
$$;

comment on function private.till_days() is
  'Each business day from the day till counting started to today, resolved to Not counted, Awaiting '
  'Manager confirmation, Balanced, Shortage or Excess, or due for today (issue #83, §15.2a). '
  'Calculated on every read; nothing is stored for a missing day.';

-- ---------------------------------------------------------------------------
-- Consistent, whoever writes the rows
-- ---------------------------------------------------------------------------
-- A count is today's, or a past countable day's with a late reason, waiting, and numbered after the
-- day's last count, which must have been sent back.
create or replace function private.check_reconciliation_entry()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_last  public.reconciliations%rowtype;
  v_today date := private.reconciliation_business_date();
begin
  select * into v_last from public.reconciliations
   where type = new.type and business_date = new.business_date
   order by attempt desc limit 1;

  if new.status is distinct from 'awaiting_confirmation' or new.version is distinct from 1
     or new.business_date is null or new.business_date > v_today
     or new.business_date < private.till_counting_starts_on()
     or (new.business_date < v_today) is distinct from (new.late_reason is not null)
     or new.attempt is distinct from coalesce(v_last.attempt, 0) + 1
     or (v_last.id is not null and v_last.status is distinct from 'sent_back') then
    raise exception 'reconciliation % is not the day''s next count', new.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger reconciliations_entry
  before insert on public.reconciliations
  for each row execute function private.check_reconciliation_entry();

-- A line belongs to a count still being entered, names a payment method, is counted, and carries the
-- expected figure exactly as it stands now.
create or replace function private.check_reconciliation_line()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_r        public.reconciliations%rowtype;
  v_expected bigint;
begin
  select * into v_r from public.reconciliations where id = new.reconciliation_id;
  select e.expected_tzs into v_expected from private.till_expected(v_r.business_date) e
   where e.line = new.line;

  if v_r.id is null or v_r.status is distinct from 'awaiting_confirmation' or v_r.version <> 1
     or v_r.type <> 'till' or v_expected is null or new.counted_tzs is null
     or new.expected_tzs is distinct from v_expected then
    raise exception 'reconciliation line % of % is not a till line at the figures as they stand',
      new.line, new.reconciliation_id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger reconciliation_lines_entry
  before insert on public.reconciliation_lines
  for each row execute function private.check_reconciliation_line();

-- A count's figures never change. Its status moves forward once: to sent back with a return, or to
-- confirmed with a confirmation. Either is final.
create or replace function private.guard_reconciliation_progress()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'status' - 'version') is distinct from (to_jsonb(old) - 'status' - 'version')
     or old.status <> 'awaiting_confirmation'
     or new.version <> old.version + 1
     or not ((new.status = 'sent_back'
              and exists (select 1 from public.reconciliation_returns x
                           where x.reconciliation_id = new.id))
             or (new.status = 'confirmed'
                 and exists (select 1 from public.reconciliation_confirmations c
                              where c.reconciliation_id = new.id))) then
    raise exception 'reconciliation % cannot go from % to %', old.id, old.status, new.status
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger reconciliations_progress
  before update on public.reconciliations
  for each row execute function private.guard_reconciliation_progress();

-- A return or a confirmation is of a waiting count, by somebody other than who counted it. A
-- confirmation carries its count's figures exactly.
create or replace function private.check_reconciliation_decision()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_r     public.reconciliations%rowtype;
  v_by    uuid;
  v_short bigint;
  v_over  bigint;
begin
  select * into v_r from public.reconciliations where id = new.reconciliation_id;
  v_by := case when tg_table_name = 'reconciliation_returns' then (to_jsonb(new) ->> 'returned_by')
               else (to_jsonb(new) ->> 'confirmed_by') end::uuid;

  if v_r.status is distinct from 'awaiting_confirmation' or v_by = v_r.counted_by then
    raise exception 'reconciliation % is not awaiting a decision by this person',
      new.reconciliation_id using errcode = 'check_violation';
  end if;

  if tg_table_name = 'reconciliation_confirmations' then
    select coalesce(sum(-l.variance_tzs) filter (where l.variance_tzs < 0), 0),
           coalesce(sum(l.variance_tzs) filter (where l.variance_tzs > 0), 0)
      into v_short, v_over
      from public.reconciliation_lines l where l.reconciliation_id = new.reconciliation_id;
    if (to_jsonb(new) ->> 'short_tzs')::bigint is distinct from v_short
       or (to_jsonb(new) ->> 'over_tzs')::bigint is distinct from v_over then
      raise exception 'reconciliation % was short by % and over by %', new.reconciliation_id,
        v_short, v_over using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger reconciliation_returns_target
  before insert on public.reconciliation_returns
  for each row execute function private.check_reconciliation_decision();
create trigger reconciliation_confirmations_target
  before insert on public.reconciliation_confirmations
  for each row execute function private.check_reconciliation_decision();

-- At commit: a till count has one counted line for each payment method; a return leaves its count
-- sent back and a confirmation leaves it confirmed. SECURITY DEFINER, since a deferred trigger runs
-- as the session's own role and the Cashier reads only their own counts.
create or replace function private.check_reconciliation_complete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'reconciliations' then
    if (select count(*) from public.reconciliation_lines l
         where l.reconciliation_id = new.id and l.counted_tzs is not null)
       <> cardinality(enum_range(null::public.payment_method)) then
      raise exception 'till count % does not count every payment method', new.id
        using errcode = 'check_violation';
    end if;
  elsif tg_table_name = 'reconciliation_returns' then
    if not exists (select 1 from public.reconciliations
                    where id = new.reconciliation_id and status = 'sent_back') then
      raise exception 'reconciliation return leaves % not sent back', new.reconciliation_id
        using errcode = 'check_violation';
    end if;
  elsif not exists (select 1 from public.reconciliations
                     where id = new.reconciliation_id and status = 'confirmed') then
    raise exception 'reconciliation confirmation leaves % not confirmed', new.reconciliation_id
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

create constraint trigger reconciliations_complete
  after insert on public.reconciliations
  deferrable initially deferred
  for each row execute function private.check_reconciliation_complete();
create constraint trigger reconciliation_returns_complete
  after insert on public.reconciliation_returns
  deferrable initially deferred
  for each row execute function private.check_reconciliation_complete();
create constraint trigger reconciliation_confirmations_complete
  after insert on public.reconciliation_confirmations
  deferrable initially deferred
  for each row execute function private.check_reconciliation_complete();

-- ---------------------------------------------------------------------------
-- Grants and row-level security
-- ---------------------------------------------------------------------------
alter table public.reconciliations enable row level security;
alter table public.reconciliation_lines enable row level security;
alter table public.reconciliation_returns enable row level security;
alter table public.reconciliation_confirmations enable row level security;

revoke all on public.reconciliations, public.reconciliation_lines, public.reconciliation_returns,
              public.reconciliation_confirmations
  from public, anon, authenticated, service_role;
grant select on public.reconciliations, public.reconciliation_lines, public.reconciliation_returns,
                public.reconciliation_confirmations
  to authenticated;
grant select, insert, update on public.reconciliations to fv_definer_owner;
grant select, insert on public.reconciliation_lines, public.reconciliation_returns,
                        public.reconciliation_confirmations
  to fv_definer_owner;

-- Directors and the Manager read every count. The Cashier reads only the counts they entered, and
-- what was decided about them.
create policy reconciliations_select on public.reconciliations
  for select to authenticated
  using ((select private.authorize(array['director', 'manager']::public.app_role[]))
         or ((select private.authorize(array['cashier']::public.app_role[]))
             and counted_by = (select auth.uid())));
create policy reconciliation_lines_select on public.reconciliation_lines
  for select to authenticated
  using (exists (select 1 from public.reconciliations r where r.id = reconciliation_id));
create policy reconciliation_returns_select on public.reconciliation_returns
  for select to authenticated
  using (exists (select 1 from public.reconciliations r where r.id = reconciliation_id));
create policy reconciliation_confirmations_select on public.reconciliation_confirmations
  for select to authenticated
  using (exists (select 1 from public.reconciliations r where r.id = reconciliation_id));

create policy reconciliations_definer_owner on public.reconciliations
  for all to fv_definer_owner using (true) with check (true);
create policy reconciliation_lines_definer_owner on public.reconciliation_lines
  for all to fv_definer_owner using (true) with check (true);
create policy reconciliation_returns_definer_owner on public.reconciliation_returns
  for all to fv_definer_owner using (true) with check (true);
create policy reconciliation_confirmations_definer_owner on public.reconciliation_confirmations
  for all to fv_definer_owner using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Command helpers
-- ---------------------------------------------------------------------------
-- A count with its lines and totals, as the commands and the read return it.
create or replace function private.till_count_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(c)
         || jsonb_build_object(
              'lines', (select jsonb_agg(jsonb_build_object(
                                 'line', l.line, 'expected_tzs', l.expected_tzs,
                                 'counted_tzs', l.counted_tzs, 'variance_tzs', l.variance_tzs)
                               order by l.line::public.payment_method)
                          from public.reconciliation_lines l where l.reconciliation_id = c.id),
              'expected_tzs', (select sum(l.expected_tzs) from public.reconciliation_lines l
                                where l.reconciliation_id = c.id),
              'counted_tzs', (select sum(l.counted_tzs) from public.reconciliation_lines l
                               where l.reconciliation_id = c.id),
              'variance_tzs', (select sum(l.variance_tzs) from public.reconciliation_lines l
                                where l.reconciliation_id = c.id))
    from public.reconciliations c where c.id = p_id;
$$;

create or replace function private.till_count_result(p_reason text, p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('ok', true, 'reason', p_reason, 'count', private.till_count_json(p_id));
$$;

create or replace function private.till_count_audit(
  p_actor uuid, p_action text, p_id uuid, p_before jsonb, p_after jsonb, p_source text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (p_actor, private.live_role_of(p_actor), false, p_action, 'reconciliation', p_id,
          p_before, p_after, gen_random_uuid(), p_source);
$$;

-- The shared opening of the Manager's two commands: replay or conflict on the key, the row locked,
-- the version the Manager was shown, a count still waiting, and somebody other than who counted it.
create or replace function private.till_count_open(
  p_key text, p_operation text, p_actor uuid, p_request jsonb, p_id uuid, p_expected_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_class jsonb;
  v_c     public.reconciliations%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_key, ''), 0));
  v_class := private.classify_idempotency_key(p_key, p_operation, p_actor, p_request);
  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  elsif v_class ->> 'status' = 'replay' then
    return private.till_count_result('replayed', p_id);
  end if;

  select * into v_c from public.reconciliations where id = p_id and type = 'till' for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_count');
  elsif v_c.version is distinct from p_expected_version then
    return jsonb_build_object('ok', false, 'reason', 'stale', 'version', v_c.version,
                              'status', v_c.status::text);
  elsif v_c.status <> 'awaiting_confirmation' then
    return jsonb_build_object('ok', false, 'reason', 'not_awaiting_confirmation',
                              'status', v_c.status::text);
  elsif v_c.counted_by = p_actor then
    -- Entering and confirming are separate people (§4.2's table names two roles), even for somebody
    -- whose role changed after they counted.
    return jsonb_build_object('ok', false, 'reason', 'same_person');
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Enter a count (the Cashier): today's, or a past Not counted day's with a late reason
-- ---------------------------------------------------------------------------
-- `p_counted` is one whole-shilling figure of 0 or more for every payment method, keyed by method:
-- {"cash": 150000, "mixx_by_yas": 0, ...}. Nothing else is typed.
create or replace function private.impl_staff_enter_till_count(
  p_business_date date, p_previous_count_id uuid, p_counted jsonb, p_note text,
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
  v_today   date := private.reconciliation_business_date();
  v_methods text[] := enum_range(null::public.payment_method)::text[];
  v_class   jsonb;
  v_last    public.reconciliations%rowtype;
  v_id      uuid := gen_random_uuid();
  v_lines   jsonb;
  v_request jsonb := jsonb_build_object('business_date', p_business_date,
                                        'previous_count_id', p_previous_count_id,
                                        'counted', p_counted, 'note', v_note,
                                        'late_reason', v_late);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));
  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'till.enter_count', v_actor, v_request);
  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  elsif v_class ->> 'status' = 'replay' then
    return private.till_count_result('replayed', (v_class ->> 'result_ref')::uuid);
  end if;

  -- Today's count carries no late reason; a past day's needs one. A screen of today's count left
  -- open past midnight sends yesterday with none, and is told the day changed.
  if p_business_date is null or p_business_date > v_today
     or (p_business_date < v_today and v_late is null) then
    return jsonb_build_object('ok', false, 'reason', 'day_changed', 'business_date', v_today::text);
  elsif p_business_date = v_today and v_late is not null then
    return jsonb_build_object('ok', false, 'reason', 'late_reason_not_needed');
  elsif p_business_date < private.till_counting_starts_on() then
    return jsonb_build_object('ok', false, 'reason', 'day_not_countable',
                              'business_date', p_business_date::text);
  end if;

  -- Two Cashiers submitting the same day queue here, so the second sees the first's count.
  perform pg_advisory_xact_lock(hashtextextended('reconciliation:till:' || p_business_date::text, 0));

  select * into v_last from public.reconciliations
   where type = 'till' and business_date = p_business_date
   order by attempt desc limit 1;
  if v_last.status = 'confirmed' then
    return jsonb_build_object('ok', false, 'reason', 'already_confirmed',
                              'business_date', p_business_date::text);
  elsif v_last.status = 'awaiting_confirmation' then
    return jsonb_build_object('ok', false, 'reason', 'count_awaiting_confirmation',
                              'business_date', p_business_date::text);
  elsif v_last.id is distinct from p_previous_count_id then
    -- The day the Cashier was shown is not the day as it stands.
    return jsonb_build_object('ok', false, 'reason', 'stale', 'business_date', p_business_date::text);
  end if;

  -- Exactly one whole number of 0 or more for each method, and nothing else.
  if p_counted is null or jsonb_typeof(p_counted) <> 'object'
     or (select array_agg(k order by k) from jsonb_object_keys(p_counted) k)
          is distinct from (select array_agg(m order by m) from unnest(v_methods) m)
     or exists (select 1 from jsonb_each(p_counted) e
                 where case when jsonb_typeof(e.value) <> 'number' then true
                            else (e.value #>> '{}')::numeric <> trunc((e.value #>> '{}')::numeric)
                              or (e.value #>> '{}')::numeric < 0
                              or (e.value #>> '{}')::numeric > 1000000000000 end) then
    return jsonb_build_object('ok', false, 'reason', 'amount_invalid');
  elsif private.imprest_text_problem(v_note, false) then
    return jsonb_build_object('ok', false, 'reason', 'note_invalid');
  elsif private.imprest_text_problem(v_late, false) then
    return jsonb_build_object('ok', false, 'reason', 'late_reason_invalid');
  end if;

  -- The key, the count and its lines go in together. The expected figures are read in the insert
  -- itself and checked again by the line trigger; a payment that commits between the two rolls back
  -- to here, key and all, and the Cashier presses again.
  begin
    if private.imprest_claim_key(p_idempotency_key, 'till.enter_count', v_actor, v_request,
                                 v_id) <> 'claimed' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;

    insert into public.reconciliations (id, type, business_date, attempt, note, late_reason,
                                        counted_by)
    values (v_id, 'till', p_business_date, coalesce(v_last.attempt, 0) + 1, v_note, v_late, v_actor);

    insert into public.reconciliation_lines (reconciliation_id, line, expected_tzs, counted_tzs)
    select v_id, e.line, e.expected_tzs, (p_counted ->> e.line)::bigint
      from private.till_expected(p_business_date) e;
  exception when check_violation then
    return jsonb_build_object('ok', false, 'reason', 'figures_moved');
  end;

  select jsonb_agg(jsonb_build_object('line', l.line, 'expected_tzs', l.expected_tzs,
                                      'counted_tzs', l.counted_tzs, 'variance_tzs', l.variance_tzs)
                   order by l.line::public.payment_method)
    into v_lines
    from public.reconciliation_lines l where l.reconciliation_id = v_id;

  perform private.till_count_audit(v_actor, 'till_count_entered', v_id,
    case when v_last.id is not null then jsonb_build_object('replaces_count_id', v_last.id) end,
    jsonb_build_object('status', 'awaiting_confirmation', 'type', 'till',
                       'business_date', p_business_date,
                       'attempt', coalesce(v_last.attempt, 0) + 1, 'lines', v_lines,
                       'late', v_late is not null, 'late_reason', v_late, 'note', v_note),
    'api.staff_enter_till_count');

  return private.till_count_result('counted', v_id);
end;
$$;

create or replace function api.staff_enter_till_count(
  p_business_date date, p_previous_count_id uuid, p_counted jsonb, p_note text,
  p_late_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_enter_till_count(
  p_business_date, p_previous_count_id, p_counted, p_note, p_late_reason, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_enter_till_count', 'reconciliation', p_previous_count_id, v);
end $$;

comment on function api.staff_enter_till_count(date, uuid, jsonb, text, text, text) is
  'The Cashier enters a till count: one whole-shilling figure of 0 or more for every payment '
  'method, with an optional note. Today''s, or a past Not counted day''s with a late reason of 3 to '
  '500 characters (issue #83). The expected figures are calculated and kept with it.';

-- ---------------------------------------------------------------------------
-- Send back (the Manager): count again, with a reason
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_send_back_till_count(
  p_id uuid, p_expected_version integer, p_reason text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := private.acting_staff(array['manager']::public.app_role[]);
  v_reason  text := private.normalise_label(p_reason);
  v_stop    jsonb;
  v_c       public.reconciliations%rowtype;
  v_request jsonb := jsonb_build_object('id', p_id, 'expected_version', p_expected_version,
                                        'reason', v_reason);
begin
  v_stop := private.till_count_open(p_idempotency_key, 'till.send_back_count', v_actor,
                                    v_request, p_id, p_expected_version);
  if v_stop is not null then
    return v_stop;
  end if;

  if private.imprest_text_problem(v_reason, true) then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'till.send_back_count', v_actor, v_request,
                               p_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  select * into v_c from public.reconciliations where id = p_id;

  insert into public.reconciliation_returns (reconciliation_id, reason, returned_by)
  values (p_id, v_reason, v_actor);

  update public.reconciliations set status = 'sent_back', version = version + 1 where id = p_id;

  perform private.till_count_audit(v_actor, 'till_count_sent_back', p_id,
    jsonb_build_object('status', 'awaiting_confirmation'),
    jsonb_build_object('status', 'sent_back', 'business_date', v_c.business_date,
                       'attempt', v_c.attempt, 'reason', v_reason),
    'api.staff_send_back_till_count');

  return private.till_count_result('sent_back', p_id);
end;
$$;

create or replace function api.staff_send_back_till_count(
  p_id uuid, p_expected_version integer, p_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_send_back_till_count(
  p_id, p_expected_version, p_reason, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_send_back_till_count', 'reconciliation', p_id, v);
end $$;

comment on function api.staff_send_back_till_count(uuid, integer, text, text) is
  'The Manager sends a waiting till count back for a recount, with a reason of 3 to 500 characters '
  '(issue #83). The count stays on the record; the Cashier counts again.';

-- ---------------------------------------------------------------------------
-- Confirm (the Manager). There is no figure: the count is confirmed as it stands.
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_confirm_till_count(
  p_id uuid, p_expected_version integer, p_explanation text, p_note text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor        uuid := private.acting_staff(array['manager']::public.app_role[]);
  v_explanation  text := nullif(btrim(coalesce(p_explanation, '')), '');
  v_note         text := nullif(private.normalise_label(p_note), '');
  v_stop         jsonb;
  v_c            public.reconciliations%rowtype;
  v_short        bigint;
  v_over         bigint;
  v_outcome      public.reconciliation_outcome;
  v_request      jsonb := jsonb_build_object('id', p_id, 'expected_version', p_expected_version,
                                             'explanation', v_explanation, 'note', v_note);
begin
  v_stop := private.till_count_open(p_idempotency_key, 'till.confirm_count', v_actor,
                                    v_request, p_id, p_expected_version);
  if v_stop is not null then
    return v_stop;
  end if;

  select * into v_c from public.reconciliations where id = p_id;
  select coalesce(sum(-l.variance_tzs) filter (where l.variance_tzs < 0), 0),
         coalesce(sum(l.variance_tzs) filter (where l.variance_tzs > 0), 0)
    into v_short, v_over
    from public.reconciliation_lines l where l.reconciliation_id = p_id;

  -- Zero tolerance (§15.1). Any line short is a Shortage: an excess on another method never hides
  -- money missing from one.
  v_outcome := (case when v_short > 0 then 'shortage' when v_over > 0 then 'excess'
                     else 'balanced' end)::public.reconciliation_outcome;

  if v_outcome = 'balanced' then
    if v_explanation is not null or v_note is not null then
      return jsonb_build_object('ok', false, 'reason', 'explanation_not_needed');
    end if;
  elsif v_explanation is null then
    return jsonb_build_object('ok', false, 'reason', 'explanation_required',
                              'variance_tzs', v_over - v_short);
  elsif not (v_explanation = any (enum_range(null::public.variance_reason)::text[])) then
    return jsonb_build_object('ok', false, 'reason', 'explanation_invalid');
  elsif private.imprest_text_problem(v_note, v_explanation in ('suspected_loss_or_theft',
                                                               'under_investigation', 'other')) then
    return jsonb_build_object('ok', false, 'reason', 'explanation_note_required');
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'till.confirm_count', v_actor, v_request,
                               p_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  insert into public.reconciliation_confirmations (reconciliation_id, outcome, variance_tzs,
                                                   short_tzs, over_tzs, explanation,
                                                   explanation_note, confirmed_by)
  values (p_id, v_outcome, v_over - v_short, v_short, v_over,
          v_explanation::public.variance_reason, v_note, v_actor);

  update public.reconciliations set status = 'confirmed', version = version + 1 where id = p_id;

  perform private.till_count_audit(v_actor, 'till_count_confirmed', p_id,
    jsonb_build_object('status', 'awaiting_confirmation'),
    jsonb_build_object('status', 'confirmed', 'business_date', v_c.business_date,
                       'attempt', v_c.attempt, 'outcome', v_outcome,
                       'short_tzs', v_short, 'over_tzs', v_over,
                       'variance_tzs', v_over - v_short, 'explanation', v_explanation,
                       'explanation_note', v_note),
    'api.staff_confirm_till_count');

  return private.till_count_result('confirmed', p_id);
end;
$$;

create or replace function api.staff_confirm_till_count(
  p_id uuid, p_expected_version integer, p_explanation text, p_note text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_confirm_till_count(
  p_id, p_expected_version, p_explanation, p_note, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_confirm_till_count', 'reconciliation', p_id, v);
end $$;

comment on function api.staff_confirm_till_count(uuid, integer, text, text, text) is
  'The Manager confirms a waiting till count as it stands (issue #83): Balanced takes no reason; a '
  'Shortage or Excess takes one of the seven, three with a written note. The person who counted '
  'may not confirm.';

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------
-- The counts, most recently entered first, each with its lines, totals and decision. A Cashier is
-- sent only the counts they entered. `p_business_date` narrows the read to one day.
create or replace function api.staff_till_counts(p_limit integer, p_offset integer,
                                                 p_business_date date default null)
returns table (id uuid, business_date date, attempt integer, note text, late_reason text,
               status text, version integer, counted_by text, counted_at timestamptz,
               lines jsonb, expected_tzs bigint, counted_tzs bigint, variance_tzs bigint,
               outcome text, short_tzs bigint, over_tzs bigint, explanation text,
               explanation_note text, confirmed_by text, confirmed_at timestamptz,
               return_reason text, returned_by text, returned_at timestamptz, total bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.acting_staff(array['director', 'manager', 'cashier']::public.app_role[]);
  v_role  public.app_role := private.live_role_of(v_actor);
begin
  return query
    select c.id, c.business_date, c.attempt, c.note, c.late_reason, c.status::text, c.version,
           pc.full_name, c.counted_at,
           s.lines, s.expected, s.counted, s.variance,
           k.outcome::text, k.short_tzs, k.over_tzs, k.explanation::text, k.explanation_note,
           pk.full_name, k.confirmed_at,
           x.reason, px.full_name, x.returned_at,
           count(*) over ()
      from public.reconciliations c
      join public.profiles pc on pc.id = c.counted_by
      cross join lateral (
        select jsonb_agg(jsonb_build_object('line', l.line, 'expected_tzs', l.expected_tzs,
                                            'counted_tzs', l.counted_tzs,
                                            'variance_tzs', l.variance_tzs)
                         order by l.line::public.payment_method) as lines,
               sum(l.expected_tzs)::bigint as expected, sum(l.counted_tzs)::bigint as counted,
               sum(l.variance_tzs)::bigint as variance
          from public.reconciliation_lines l where l.reconciliation_id = c.id) s
      left join public.reconciliation_confirmations k on k.reconciliation_id = c.id
      left join public.profiles pk on pk.id = k.confirmed_by
      left join public.reconciliation_returns x on x.reconciliation_id = c.id
      left join public.profiles px on px.id = x.returned_by
     where c.type = 'till'
       and (v_role <> 'cashier' or c.counted_by = v_actor)
       and (p_business_date is null or c.business_date = p_business_date)
     order by c.counted_at desc, c.attempt desc, c.id
     limit greatest(least(coalesce(p_limit, 30), 100), 1)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

comment on function api.staff_till_counts(integer, integer, date) is
  'Till counts, most recently entered first, each with its lines (expected, counted, variance per '
  'payment method), totals and the Manager''s decision (issue #83). A Cashier is sent only the '
  'counts they entered.';

-- What the till should hold for a day, as it stands now. Directors and the Manager only: the Cashier
-- counts without seeing it.
create or replace function api.staff_till_expected(p_business_date date)
returns table (line text, expected_tzs bigint, payments bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.acting_staff(array['director', 'manager']::public.app_role[]);
  return query select e.line, e.expected_tzs, e.payments from private.till_expected(p_business_date) e;
end;
$$;

comment on function api.staff_till_expected(date) is
  'The expected till figure per payment method for a business day, as it stands now (issue #83). '
  'Directors and the Manager; the Cashier counts without seeing it.';

-- Every day from the start of till counting, most recent first, or with `p_open_only` the days not
-- closed (Not counted, or waiting for the Manager), oldest first. States only, with no figures, so
-- every till role may read it.
create or replace function api.staff_till_days(p_limit integer, p_offset integer,
                                               p_open_only boolean default false)
returns table (business_date date, state text, not_counted_since timestamptz,
               awaiting_since timestamptz, latest_id uuid, latest_status text,
               latest_return_reason text, total bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.acting_staff(array['director', 'manager', 'cashier']::public.app_role[]);
  return query
    select d.business_date, d.state, d.not_counted_since, d.awaiting_since, d.latest_id,
           d.latest_status, d.latest_return_reason, count(*) over ()
      from private.till_days() d
     where not coalesce(p_open_only, false) or d.state in ('not_counted', 'awaiting_confirmation')
     order by case when coalesce(p_open_only, false) then d.business_date end asc,
              d.business_date desc
     limit greatest(least(coalesce(p_limit, 30), 100), 1)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

comment on function api.staff_till_days(integer, integer, boolean) is
  'Each business day of the till, resolved to Not counted, Awaiting Manager confirmation, Balanced, '
  'Shortage or Excess, or due today (issue #83, §15.2a); with p_open_only, the days not closed, '
  'oldest first. No figures; Directors, the Manager and the Cashier read.';

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
            and p.proname in ('staff_enter_till_count', 'staff_send_back_till_count',
                              'staff_confirm_till_count', 'staff_till_counts',
                              'staff_till_expected', 'staff_till_days'))
        or (n.nspname = 'private'
            and p.proname in ('refuse_reconciliation_edit', 'reconciliation_business_date',
                              'reconciliation_business_date_of', 'reconciliation_day_close',
                              'till_counting_starts_on', 'till_expected', 'till_days',
                              'check_reconciliation_entry', 'check_reconciliation_line',
                              'guard_reconciliation_progress', 'check_reconciliation_decision',
                              'check_reconciliation_complete', 'till_count_json',
                              'till_count_result', 'till_count_audit', 'till_count_open',
                              'impl_staff_enter_till_count', 'impl_staff_send_back_till_count',
                              'impl_staff_confirm_till_count'))
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
