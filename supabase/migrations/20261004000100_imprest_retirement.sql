-- Issue #72 · Imprest: retire the fund and carry its balance into the next one
--
-- product.md §13.8, design.md §7B.12 and AC-59. The MANAGER submits the fund's retirement with a
-- reason, and a DIRECTOR approves or rejects it, with a reason on rejection. No cash is handed back
-- (Owner decision, 28 September 2026): retirement closes the fund as a RECORD, and the cash stays in
-- the tin. The fund's closing posted balance becomes the next fund's OPENING BALANCE, and the next
-- funding adds to it.
--
--   imprest_retirements      one row per submission and what became of it. A decision fills its
--                            own columns; nothing is ever changed or deleted.
--   imprest_fund_openings    the opening balance of a fund carried from a retired one: its own
--                            posting, linked to the retirement and the fund it came from. Never
--                            changed. One per retired fund and one per new fund, so a closing
--                            balance is carried once and never twice.
--   imprest_funds            gains `retired_at`. A fund changes once, from active to retired, and
--                            only with an approved retirement.
--
-- NOTHING UNRESOLVED IS HIDDEN. A submission is refused, naming each blocker, while any disbursement
-- is open (not verified, rejected, withdrawn or cancelled), a funding, raised approval or reversal
-- request is open, or a count waits for the Manager. It needs a confirmed count for the current
-- business day taken after the last posting, so the closing balance is the cash counted in the tin.
-- Earlier Not counted days stay on the record and are listed on the submission. The retired fund
-- keeps every figure, posting, count, shortage, unexplained loss and open Director decision, and
-- rows can no longer be added to it.
--
-- THE DAYS. The retired fund's business days end on its closing count's day, or the day before
-- approval if that is later. The next fund's start the day after, or on the day it opened if that is
-- later. So the day the closing count covered is not due twice, and no day falls between the two.
--
-- FIVE RELEASED OBJECTS ARE REPLACED, signatures unchanged: the spending figures (the opening
-- balance is part of the posted balance), the fund's first count day, the count days, and the
-- wrappers of the proposal and the count, which now wait for a retirement being approved.

begin;

-- ---------------------------------------------------------------------------
-- A fund is retired once
-- ---------------------------------------------------------------------------
alter table public.imprest_funds add column retired_at timestamptz;
alter table public.imprest_funds
  add constraint fund_retired_shape check (is_active = (retired_at is null));

comment on column public.imprest_funds.retired_at is
  'When a Director approved the fund''s retirement (issue #72). Null while the fund is active.';

create type public.imprest_retirement_status as enum (
  'submitted',  -- the Manager submitted it. The fund is still active
  'approved',   -- a Director approved it. The fund is retired and its balance carried
  'rejected'    -- a Director rejected it, with a reason. The fund stays active
);

comment on type public.imprest_retirement_status is
  'The steps of a fund retirement (issue #72). Only an approved one closes the fund.';

create table public.imprest_retirements (
  id                   uuid primary key default gen_random_uuid(),
  fund_id              uuid not null references public.imprest_funds (id) on delete restrict,
  status               public.imprest_retirement_status not null default 'submitted',
  version              integer not null default 1 check (version >= 1),
  reason               text not null check (length(btrim(reason)) between 3 and 500),
  -- The closing count: today's confirmed count, taken after the last posting.
  count_id             uuid not null references public.imprest_counts (id) on delete restrict,
  business_date        date not null,
  -- The figures as they stood at submission. The closing balance is the cash counted.
  posted_funding_tzs   bigint not null,
  closing_balance_tzs  bigint not null check (closing_balance_tzs >= 0),
  -- The fund's Not counted days at submission, oldest first. They stay on the record.
  not_counted_days     date[] not null default '{}',
  submitted_by         uuid not null references public.profiles (id),
  submitted_at         timestamptz not null default now(),
  decided_by           uuid references public.profiles (id),
  decided_at           timestamptz,
  rejection_reason     text check (rejection_reason is null
                                   or length(btrim(rejection_reason)) between 3 and 500),
  -- The fund the closing balance was carried into. Checked at commit: the approval names it before
  -- it opens, because the fund it retires may only close once an approved retirement exists.
  next_fund_id         uuid references public.imprest_funds (id) on delete restrict
                         deferrable initially deferred,
  constraint retirement_decision_shape check (
    (status <> 'submitted') = (decided_by is not null)
    and (decided_by is null) = (decided_at is null)
    and (status = 'rejected') = (rejection_reason is not null)
    and (status = 'approved') = (next_fund_id is not null)
  )
);

comment on table public.imprest_retirements is
  'The Manager''s submission to retire the imprest fund and a Director''s decision (issue #72, '
  'product.md §13.8). Written by the commands alone; a decision fills its own columns and nothing '
  'is ever changed or deleted.';

create unique index imprest_retirements_one_open_idx
  on public.imprest_retirements (fund_id) where status = 'submitted';
create unique index imprest_retirements_one_approved_idx
  on public.imprest_retirements (fund_id) where status = 'approved';
create index imprest_retirements_fund_idx on public.imprest_retirements (fund_id, submitted_at desc);
create index imprest_retirements_count_idx on public.imprest_retirements (count_id);
create index imprest_retirements_submitted_by_idx on public.imprest_retirements (submitted_by);
create index imprest_retirements_decided_by_idx on public.imprest_retirements (decided_by);
create index imprest_retirements_next_fund_idx on public.imprest_retirements (next_fund_id);

create table public.imprest_fund_openings (
  id             uuid primary key default gen_random_uuid(),
  fund_id        uuid not null unique references public.imprest_funds (id) on delete restrict,
  from_fund_id   uuid not null unique references public.imprest_funds (id) on delete restrict,
  retirement_id  uuid not null unique references public.imprest_retirements (id) on delete restrict,
  amount_tzs     bigint not null check (amount_tzs >= 0),
  posted_at      timestamptz not null default now(),
  constraint opening_is_another_fund check (fund_id <> from_fund_id)
);

comment on table public.imprest_fund_openings is
  'A fund''s opening balance, carried from the fund whose retirement was approved (issue #72): its '
  'own posting, counted in this fund''s posted balance and nowhere else. Never changed or deleted.';

create trigger imprest_fund_openings_append_only
  before update or delete on public.imprest_fund_openings
  for each row execute function private.refuse_imprest_settlement_edit();
create trigger imprest_fund_openings_no_truncate
  before truncate on public.imprest_fund_openings
  for each statement execute function private.refuse_imprest_settlement_edit();
create trigger imprest_retirements_no_truncate
  before truncate on public.imprest_retirements
  for each statement execute function private.refuse_imprest_settlement_edit();
create trigger imprest_funds_no_truncate
  before truncate on public.imprest_funds
  for each statement execute function private.refuse_imprest_settlement_edit();

-- ---------------------------------------------------------------------------
-- Consistent, whoever writes the rows
-- ---------------------------------------------------------------------------
-- A fund is born active, never deleted, and changes once: retired, with an approved retirement.
create or replace function private.guard_imprest_fund()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'imprest fund % cannot be deleted', old.id using errcode = 'restrict_violation';
  elsif tg_op = 'INSERT' then
    if not new.is_active or new.retired_at is not null then
      raise exception 'an imprest fund is opened active' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- Only retirement is guarded here. What a fund was opened with is not this slice's to police, and
  -- the test suites move `opened_at` back to make past days.
  if new.is_active is not distinct from old.is_active
     and new.retired_at is not distinct from old.retired_at then
    return new;
  end if;

  if new.id is distinct from old.id or new.opened_by is distinct from old.opened_by
     or not old.is_active or new.is_active
     or not exists (select 1 from public.imprest_retirements r
                     where r.fund_id = old.id and r.status = 'approved') then
    raise exception 'imprest fund % changes only once, retired by an approved retirement', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

comment on function private.guard_imprest_fund() is
  'An imprest fund is opened active, never deleted, and retired once, by an approved retirement '
  '(issue #72).';

create trigger imprest_funds_guard
  before insert or update or delete on public.imprest_funds
  for each row execute function private.guard_imprest_fund();

-- A retirement is born submitted against the active fund and a confirmed count of it. It moves once,
-- to approved or rejected, keeping what was submitted.
create or replace function private.guard_imprest_retirement()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'imprest retirement % cannot be deleted', old.id
      using errcode = 'restrict_violation';
  elsif tg_op = 'INSERT' then
    if new.status <> 'submitted' or new.version <> 1
       or not exists (select 1 from public.imprest_funds where id = new.fund_id and is_active)
       or not exists (select 1 from public.imprest_counts c
                       where c.id = new.count_id and c.fund_id = new.fund_id
                         and c.status = 'confirmed' and c.business_date = new.business_date) then
      raise exception 'imprest retirement % is not a submission of the active fund at its count', new.id
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if (to_jsonb(new) - 'status' - 'version' - 'decided_by' - 'decided_at' - 'rejection_reason'
                    - 'next_fund_id')
       is distinct from
     (to_jsonb(old) - 'status' - 'version' - 'decided_by' - 'decided_at' - 'rejection_reason'
                    - 'next_fund_id')
     or old.status <> 'submitted'
     or new.status not in ('approved', 'rejected')
     or new.version is distinct from old.version + 1 then
    raise exception 'imprest retirement % keeps what was submitted and moves forward once', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

comment on function private.guard_imprest_retirement() is
  'A retirement is born submitted against the active fund and its confirmed count, goes to approved '
  'or rejected once, one version on, never changes what was submitted, and is never deleted '
  '(issue #72).';

create trigger imprest_retirements_guard
  before insert or update or delete on public.imprest_retirements
  for each row execute function private.guard_imprest_retirement();

-- An opening carries exactly the closing balance of an approved retirement into the fund it names.
create or replace function private.check_imprest_fund_opening()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_r public.imprest_retirements%rowtype;
begin
  select * into v_r from public.imprest_retirements where id = new.retirement_id;
  if v_r.id is null or v_r.status is distinct from 'approved'
     or new.from_fund_id is distinct from v_r.fund_id
     or new.fund_id is distinct from v_r.next_fund_id
     or new.amount_tzs is distinct from v_r.closing_balance_tzs then
    raise exception 'imprest opening of % does not match an approved retirement', new.amount_tzs
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger imprest_fund_openings_target
  before insert on public.imprest_fund_openings
  for each row execute function private.check_imprest_fund_opening();

-- At commit: an approved retirement has retired its fund and carried its balance into an active
-- fund, exactly once.
create or replace function private.check_imprest_retirement_complete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'approved'
     and (not exists (select 1 from public.imprest_funds where id = new.fund_id and not is_active)
          or not exists (select 1 from public.imprest_fund_openings o
                          where o.retirement_id = new.id and o.fund_id = new.next_fund_id
                            and o.amount_tzs = new.closing_balance_tzs)) then
    raise exception 'imprest retirement % is approved without retiring its fund and carrying its '
      'balance', new.id using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

create constraint trigger imprest_retirement_complete
  after update on public.imprest_retirements
  deferrable initially deferred
  for each row execute function private.check_imprest_retirement_complete();

-- A retired fund is read-only: no row joins it. The fund row is locked FOR SHARE, so a write racing
-- the approval either commits first, and the approval then finds it and refuses, or waits for the
-- approval and is refused here.
--
-- SECURITY DEFINER: the commands that write these rows run as fv_definer_owner already; a direct
-- write by anybody else is refused by grants before it gets here.
create or replace function private.refuse_retired_imprest_fund()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.imprest_funds where id = new.fund_id and is_active for share;
  if not found then
    raise exception '% cannot be added to imprest fund %, which is retired', tg_table_name,
      new.fund_id using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

comment on function private.refuse_retired_imprest_fund() is
  'Refuses a row added to a retired imprest fund (issue #72), holding the fund row so the check '
  'cannot race the retirement''s approval.';

do $$
declare t text;
begin
  foreach t in array array['imprest_fundings', 'imprest_disbursements', 'imprest_verifications',
                           'imprest_postings', 'imprest_counts', 'imprest_count_postings',
                           'imprest_count_flags', 'imprest_posting_reversals'] loop
    execute format('create trigger %I before insert on public.%I for each row '
                   'execute function private.refuse_retired_imprest_fund()',
                   t || '_fund_active', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Grants and row-level security: Directors and the Manager
-- ---------------------------------------------------------------------------
alter table public.imprest_retirements enable row level security;
alter table public.imprest_fund_openings enable row level security;

revoke all on public.imprest_retirements, public.imprest_fund_openings
  from public, anon, authenticated, service_role;
grant select on public.imprest_retirements, public.imprest_fund_openings to authenticated;
grant select, insert, update on public.imprest_retirements to fv_definer_owner;
grant select, insert on public.imprest_fund_openings to fv_definer_owner;

-- The closing and opening balances are posted figures, which the Cashier is not shown.
create policy imprest_retirements_select on public.imprest_retirements
  for select to authenticated
  using ((select private.authorize(array['director', 'manager']::public.app_role[])));
create policy imprest_fund_openings_select on public.imprest_fund_openings
  for select to authenticated
  using ((select private.authorize(array['director', 'manager']::public.app_role[])));
create policy imprest_retirements_definer_owner on public.imprest_retirements
  for all to fv_definer_owner using (true) with check (true);
create policy imprest_fund_openings_definer_owner on public.imprest_fund_openings
  for all to fv_definer_owner using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Replaced · the figures: an opening balance is part of the posted balance
-- ---------------------------------------------------------------------------
create or replace function private.imprest_spending_figures(p_fund_id uuid)
returns table (posted_funding_tzs bigint, posted_balance_tzs bigint, set_aside_tzs bigint,
               free_to_approve_tzs bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with opening as (
    -- The balance carried from the retired fund before it (issue #72). Posted funding stays what
    -- was received into this fund, so the carried balance is never counted as funding too.
    select coalesce(sum(o.amount_tzs), 0)::bigint as tzs
      from public.imprest_fund_openings o
     where o.fund_id = p_fund_id
  ), posted as (
    select coalesce(sum(f.received_amount_tzs) filter (where f.status = 'received'), 0)::bigint
             as tzs
      from public.imprest_fundings f
     where f.fund_id = p_fund_id
  ), spent as (
    -- Verified expenses and verified unexplained losses alike: both are cash gone from the tin. A
    -- reversal cancels one of them, and its replacement is spent in its place (issue #71).
    select coalesce(sum(case when p.entry = 'reversal' then -p.amount_tzs else p.amount_tzs end),
                    0)::bigint as tzs
      from public.imprest_postings p
     where p.fund_id = p_fund_id
  ), counted as (
    -- Confirmed counts (issue #68): an excess is cash the tin holds, a shortage cash it does not.
    select coalesce(sum(case when c.kind = 'count_excess' then c.amount_tzs else -c.amount_tzs end),
                    0)::bigint as tzs
      from public.imprest_count_postings c
     where c.fund_id = p_fund_id
  ), aside as (
    -- Handed out, settled and sent back stay set aside until the Manager verifies them (AC-102),
    -- and so does every raise that was raised, handed out or not (issue #70).
    select coalesce(sum(d.amount_tzs + coalesce(x.tzs, 0)), 0)::bigint as tzs
      from public.imprest_disbursements d
      left join lateral (select sum(r.amount_tzs) as tzs from public.imprest_approval_raises r
                          where r.disbursement_id = d.id
                            and r.status in ('raised', 'handed_out')) x on true
     where d.fund_id = p_fund_id and d.status in ('approved', 'handed_out', 'settled', 'sent_back')
  )
  select posted.tzs, opening.tzs + posted.tzs - spent.tzs + counted.tzs, aside.tzs,
         opening.tzs + posted.tzs - spent.tzs + counted.tzs - aside.tzs
    from opening, posted, spent, counted, aside;
$$;

comment on function private.imprest_spending_figures(uuid) is
  'Posted imprest funding; the posted balance (the opening balance carried from a retired fund, '
  'plus funding, minus verified expenses and unexplained losses as corrected by reversals and '
  'replacements, minus count shortages plus count excesses); what approved, handed-out, settled and '
  'sent-back disbursements set aside, raised approvals included; and Free to approve, the posted '
  'balance minus set aside (AC-99, AC-102, issues #64, #65, #68, #70, #71, #72). Never stored.';

-- ---------------------------------------------------------------------------
-- Replaced · where a fund's days start and end
-- ---------------------------------------------------------------------------
-- The later of the day it opened and the day counting started, and for a fund carried from a
-- retired one, the day after that fund's closing count: that day was counted before it retired.
create or replace function private.imprest_first_count_day(p_fund_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(private.imprest_business_date_of(f.opened_at), private.imprest_counting_starts_on(),
                  (select r.business_date + 1
                     from public.imprest_fund_openings o
                     join public.imprest_retirements r on r.id = o.retirement_id
                    where o.fund_id = f.id))
    from public.imprest_funds f where f.id = p_fund_id;
$$;

comment on function private.imprest_first_count_day(uuid) is
  'A fund''s first business day to count: the later of the day it opened and the day counting '
  'started (issue #69), and for a fund carried from a retired one, the day after the closing count '
  '(issue #72).';

-- A fund's last business day: today while it is active; once retired, its closing count's day, or
-- the day before approval if that is later. The next fund's days start the day after.
create or replace function private.imprest_last_count_day(p_fund_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select case when f.is_active then private.imprest_business_date()
              else greatest((select r.business_date from public.imprest_retirements r
                              where r.fund_id = f.id and r.status = 'approved'),
                            private.imprest_business_date_of(f.retired_at) - 1) end
    from public.imprest_funds f where f.id = p_fund_id;
$$;

comment on function private.imprest_last_count_day(uuid) is
  'A fund''s last business day to count: today while active, and once retired the later of its '
  'closing count''s day and the day before approval (issue #72).';

-- As issue #69's, bounded by the fund's last day, so a retired fund's days stop where the next
-- fund's begin. Every past day is still Not counted unless a count was confirmed for it.
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
           private.imprest_last_count_day(p_fund_id) as last_day,
           private.imprest_business_date() as today
  ), days as (
    select d::date as business_date, private.imprest_business_day_close(d::date) as closes_at,
           b.today
      from bounds b
      cross join generate_series(b.first_day, b.last_day, interval '1 day') d
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
  'Each business day of a fund from its first to its last (today while active), resolved to Not '
  'counted, Awaiting Manager confirmation, Balanced, Shortage or Excess, or due for today (issues '
  '#69 and #72, §15.2a). Calculated on every read; nothing is stored for a missing day.';

-- ---------------------------------------------------------------------------
-- What stands in the way, what is unresolved, and whether the closing count still holds
-- ---------------------------------------------------------------------------
-- Everything still open in the fund, oldest first, each named by its number.
create or replace function private.imprest_retirement_blockers(p_fund_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(b.item order by b.at, b.item ->> 'number'), '[]'::jsonb)
    from (
      select d.proposed_at as at,
             jsonb_build_object('kind', 'disbursement', 'id', d.id, 'number', d.disbursement_no,
                                'status', d.status::text) as item
        from public.imprest_disbursements d
       where d.fund_id = p_fund_id
         and d.status not in ('verified', 'rejected', 'withdrawn', 'cancelled')
      union all
      select f.requested_at,
             jsonb_build_object('kind', 'funding', 'id', f.id, 'number', f.funding_no,
                                'status', f.status::text)
        from public.imprest_fundings f
       where f.fund_id = p_fund_id and f.status not in ('received', 'rejected')
      union all
      select r.requested_at,
             jsonb_build_object('kind', 'raise', 'id', d.id, 'number', d.disbursement_no,
                                'status', r.status::text)
        from public.imprest_approval_raises r
        join public.imprest_disbursements d on d.id = r.disbursement_id
       where d.fund_id = p_fund_id and r.status = 'requested'
      union all
      select r.requested_at,
             jsonb_build_object('kind', 'reversal', 'id', d.id, 'number', d.disbursement_no,
                                'status', r.status::text)
        from public.imprest_posting_reversals r
        join public.imprest_disbursements d on d.id = r.disbursement_id
       where r.fund_id = p_fund_id and r.status = 'requested'
      union all
      select c.counted_at,
             jsonb_build_object('kind', 'count', 'id', c.id, 'number', c.business_date::text,
                                'status', c.status::text)
        from public.imprest_counts c
       where c.fund_id = p_fund_id and c.status = 'awaiting_confirmation'
    ) b;
$$;

comment on function private.imprest_retirement_blockers(uuid) is
  'What stops a fund retiring (issue #72): open disbursements, open funding, raised approval and '
  'reversal requests, and a count waiting for the Manager, oldest first, each by its number.';

-- When money last posted to the fund, leaving out one count's own variance.
create or replace function private.imprest_last_posting_at(p_fund_id uuid, p_except_count uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select max(t) from (
    select max(f.received_at) as t from public.imprest_fundings f
     where f.fund_id = p_fund_id and f.status = 'received'
    union all
    select max(p.posted_at) from public.imprest_postings p where p.fund_id = p_fund_id
    union all
    select max(c.posted_at) from public.imprest_count_postings c
     where c.fund_id = p_fund_id and c.count_id is distinct from p_except_count
    union all
    select max(o.posted_at) from public.imprest_fund_openings o where o.fund_id = p_fund_id
  ) x;
$$;

comment on function private.imprest_last_posting_at(uuid, uuid) is
  'When money last posted to an imprest fund: funding received, a verified or corrected posting, '
  'a count''s variance other than the one named, or the opening balance (issue #72).';

-- The closing count holds when nothing has posted since it and the posted balance is exactly the
-- cash it counted, with nothing out of the tin when it was taken. The timestamps alone would miss a
-- posting whose transaction began before the count and committed after it; the figures alone would
-- miss postings that cancel out.
create or replace function private.imprest_count_closes_fund(p_count_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select c.status = 'confirmed'
         and c.awaiting_verification_tzs = 0
         and s.posted_balance_tzs = c.counted_tzs
         and c.counted_at >= coalesce(private.imprest_last_posting_at(c.fund_id, c.id), '-infinity')
    from public.imprest_counts c
    cross join lateral private.imprest_spending_figures(c.fund_id) s
   where c.id = p_count_id;
$$;

comment on function private.imprest_count_closes_fund(uuid) is
  'True when a confirmed count was taken after the fund''s last posting: nothing out of the tin '
  'then, nothing posted since, and the posted balance equal to the cash counted (issue #72).';

-- What a retired fund still carries unresolved: unexplained losses and count shortages that wait
-- for a Director's decision, and its Not counted days. A reversed loss is no longer waiting; its
-- replacement is.
create or replace function private.imprest_fund_unresolved(p_fund_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'losses', coalesce((
      select jsonb_agg(jsonb_build_object('posting_id', p.id, 'disbursement_id', d.id,
                                          'disbursement_no', d.disbursement_no,
                                          'amount_tzs', p.amount_tzs, 'posted_at', p.posted_at)
                       order by p.posted_at, d.disbursement_no)
        from public.imprest_postings p
        join public.imprest_disbursements d on d.id = p.disbursement_id
       where p.fund_id = p_fund_id and p.needs_director_decision
         and not exists (select 1 from public.imprest_postings x
                          where x.corrects_posting_id = p.id and x.entry = 'reversal')), '[]'),
    'shortages', coalesce((
      select jsonb_agg(jsonb_build_object('count_id', cp.count_id, 'business_date', c.business_date,
                                          'amount_tzs', cp.amount_tzs)
                       order by c.business_date)
        from public.imprest_count_postings cp
        join public.imprest_counts c on c.id = cp.count_id
       where cp.fund_id = p_fund_id and cp.needs_director_decision), '[]'),
    'excesses_tzs', (select coalesce(sum(cp.amount_tzs), 0) from public.imprest_count_postings cp
                      where cp.fund_id = p_fund_id and cp.kind = 'count_excess'),
    'not_counted_days', coalesce((
      select jsonb_agg(d.business_date order by d.business_date)
        from private.imprest_count_days(p_fund_id) d where d.state = 'not_counted'), '[]'));
$$;

comment on function private.imprest_fund_unresolved(uuid) is
  'A fund''s unexplained losses and count shortages waiting for a Director''s decision, its count '
  'excesses, and its Not counted days (issue #72). Retirement resolves none of them.';

-- ---------------------------------------------------------------------------
-- Command helpers
-- ---------------------------------------------------------------------------
create or replace function private.imprest_retirement_result(p_reason text, p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('ok', true, 'reason', p_reason,
                            'retirement', (select to_jsonb(r) from public.imprest_retirements r
                                            where r.id = p_id));
$$;

create or replace function private.imprest_retirement_audit(
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
  values (p_actor, private.live_role_of(p_actor), false, p_action, 'imprest_retirement', p_id,
          p_before, p_after, gen_random_uuid(), p_source);
$$;

-- ---------------------------------------------------------------------------
-- Submit (the Manager)
-- ---------------------------------------------------------------------------
-- `p_count_id` is the closing count the Manager was shown: a screen that shows an older count is
-- told the day has moved on.
create or replace function private.impl_staff_submit_imprest_retirement(
  p_count_id uuid, p_reason text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := private.acting_staff(array['manager']::public.app_role[]);
  v_reason   text := private.normalise_label(p_reason);
  v_today    date := private.imprest_business_date();
  v_id       uuid := gen_random_uuid();
  v_class    jsonb;
  v_fund     uuid;
  v_blockers jsonb;
  v_count    public.imprest_counts%rowtype;
  v_figures  record;
  v_missed   date[];
  v_request  jsonb := jsonb_build_object('count_id', p_count_id, 'reason', v_reason);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));
  v_class := private.classify_idempotency_key(p_idempotency_key, 'imprest.submit_retirement',
                                              v_actor, v_request);
  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  elsif v_class ->> 'status' = 'replay' then
    return private.imprest_retirement_result('replayed', (v_class ->> 'result_ref')::uuid);
  end if;

  if private.imprest_text_problem(v_reason, true) then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  select id into v_fund from public.imprest_funds where is_active;
  if v_fund is null then
    return jsonb_build_object('ok', false, 'reason', 'no_fund');
  end if;

  -- Serialised with every approval, verification and count of the fund, so what is checked here is
  -- what stands when the submission is written.
  perform pg_advisory_xact_lock(hashtextextended('imprest_fund_spend:' || v_fund::text, 0));

  if exists (select 1 from public.imprest_retirements where fund_id = v_fund and status = 'submitted') then
    return jsonb_build_object('ok', false, 'reason', 'retirement_open');
  end if;

  v_blockers := private.imprest_retirement_blockers(v_fund);
  if jsonb_array_length(v_blockers) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'blocked', 'blockers', v_blockers);
  end if;

  select * into v_count from public.imprest_counts
   where fund_id = v_fund and business_date = v_today
   order by attempt desc limit 1;
  if v_count.id is null or v_count.status <> 'confirmed' then
    return jsonb_build_object('ok', false, 'reason', 'count_required', 'business_date', v_today::text);
  elsif v_count.id is distinct from p_count_id then
    return jsonb_build_object('ok', false, 'reason', 'stale', 'business_date', v_today::text);
  elsif not private.imprest_count_closes_fund(v_count.id) then
    return jsonb_build_object('ok', false, 'reason', 'count_before_last_posting',
                              'business_date', v_today::text);
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'imprest.submit_retirement', v_actor, v_request,
                               v_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  select * into v_figures from private.imprest_spending_figures(v_fund);
  select coalesce(array_agg(d.business_date order by d.business_date), '{}') into v_missed
    from private.imprest_count_days(v_fund) d where d.state = 'not_counted';

  insert into public.imprest_retirements (id, fund_id, reason, count_id, business_date,
                                          posted_funding_tzs, closing_balance_tzs, not_counted_days,
                                          submitted_by)
  values (v_id, v_fund, v_reason, v_count.id, v_today, v_figures.posted_funding_tzs,
          v_figures.posted_balance_tzs, v_missed, v_actor);

  perform private.imprest_retirement_audit(v_actor, 'imprest_retirement_submitted', v_id, null,
    jsonb_build_object('status', 'submitted', 'fund_id', v_fund, 'reason', v_reason,
                       'count_id', v_count.id, 'business_date', v_today,
                       'posted_funding_tzs', v_figures.posted_funding_tzs,
                       'closing_balance_tzs', v_figures.posted_balance_tzs,
                       'not_counted_days', to_jsonb(v_missed),
                       'unresolved', private.imprest_fund_unresolved(v_fund)),
    'api.staff_submit_imprest_retirement');

  return private.imprest_retirement_result('submitted', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Approve or reject (a Director). Approval is final: the fund closes and its balance is carried.
-- ---------------------------------------------------------------------------
create or replace function private.impl_admin_decide_imprest_retirement(
  p_retirement_id uuid, p_expected_version integer, p_approve boolean, p_reason text,
  p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := private.acting_director();
  v_reason   text := private.normalise_label(p_reason);
  v_class    jsonb;
  v_r        public.imprest_retirements%rowtype;
  v_blockers jsonb;
  v_balance  bigint;
  v_next     uuid := gen_random_uuid();
  v_request  jsonb := jsonb_build_object('retirement_id', p_retirement_id,
                                         'expected_version', p_expected_version,
                                         'approve', p_approve, 'reason', v_reason);
begin
  if p_approve is null then
    return jsonb_build_object('ok', false, 'reason', 'decision_required');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));
  v_class := private.classify_idempotency_key(p_idempotency_key, 'imprest.decide_retirement',
                                              v_actor, v_request);
  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  elsif v_class ->> 'status' = 'replay' then
    return private.imprest_retirement_result('replayed', p_retirement_id);
  end if;

  select * into v_r from public.imprest_retirements where id = p_retirement_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_retirement');
  end if;

  -- The locks in the order every other writer takes them: the active fund's lock, which a proposal,
  -- a count and a first funding request take before they choose the fund, then the fund's spending
  -- lock, then the rows. A command that chose this fund has committed before the blockers are read;
  -- one that has not yet chosen waits, and then chooses the next fund. Anything else writing into the
  -- fund holds the fund row, and is refused once the fund is retired.
  perform pg_advisory_xact_lock(hashtextextended('imprest:active_fund', 0));
  perform pg_advisory_xact_lock(hashtextextended('imprest_fund_spend:' || v_r.fund_id::text, 0));
  perform 1 from public.imprest_funds where id = v_r.fund_id for update;

  select * into v_r from public.imprest_retirements where id = p_retirement_id for update;
  if v_r.version is distinct from p_expected_version then
    return jsonb_build_object('ok', false, 'reason', 'stale', 'version', v_r.version,
                              'status', v_r.status::text);
  elsif v_r.status <> 'submitted' then
    return jsonb_build_object('ok', false, 'reason', 'not_awaiting_decision',
                              'status', v_r.status::text);
  elsif not p_approve and private.imprest_text_problem(v_reason, true) then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  if p_approve then
    -- Whatever opened or posted since the submission stops it. The Director rejects it, and the
    -- Manager submits again once the fund is closed out again.
    v_blockers := private.imprest_retirement_blockers(v_r.fund_id);
    if jsonb_array_length(v_blockers) > 0 then
      return jsonb_build_object('ok', false, 'reason', 'blocked', 'blockers', v_blockers);
    end if;
    select s.posted_balance_tzs into v_balance from private.imprest_spending_figures(v_r.fund_id) s;
    if not private.imprest_count_closes_fund(v_r.count_id) or v_balance <> v_r.closing_balance_tzs then
      return jsonb_build_object('ok', false, 'reason', 'count_before_last_posting',
                                'business_date', v_r.business_date::text);
    end if;
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'imprest.decide_retirement', v_actor, v_request,
                               p_retirement_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if not p_approve then
    update public.imprest_retirements
       set status = 'rejected', decided_by = v_actor, decided_at = now(),
           rejection_reason = v_reason, version = version + 1
     where id = p_retirement_id;

    perform private.imprest_retirement_audit(v_actor, 'imprest_retirement_rejected', p_retirement_id,
      jsonb_build_object('status', 'submitted', 'version', v_r.version),
      jsonb_build_object('status', 'rejected', 'fund_id', v_r.fund_id, 'reason', v_reason,
                         'version', v_r.version + 1),
      'api.admin_decide_imprest_retirement');
    return private.imprest_retirement_result('rejected', p_retirement_id);
  end if;

  update public.imprest_retirements
     set status = 'approved', decided_by = v_actor, decided_at = now(), next_fund_id = v_next,
         version = version + 1
   where id = p_retirement_id;

  update public.imprest_funds set is_active = false, retired_at = now() where id = v_r.fund_id;

  -- The next fund, and its opening balance: the closing balance, posted once, here.
  insert into public.imprest_funds (id, opened_by) values (v_next, v_actor);
  insert into public.imprest_fund_openings (fund_id, from_fund_id, retirement_id, amount_tzs)
  values (v_next, v_r.fund_id, p_retirement_id, v_r.closing_balance_tzs);

  perform private.imprest_retirement_audit(v_actor, 'imprest_retirement_approved', p_retirement_id,
    jsonb_build_object('status', 'submitted', 'version', v_r.version, 'fund_active', true),
    jsonb_build_object('status', 'approved', 'fund_id', v_r.fund_id, 'fund_active', false,
                       'closing_balance_tzs', v_r.closing_balance_tzs, 'next_fund_id', v_next,
                       'opening_balance_tzs', v_r.closing_balance_tzs,
                       'unresolved', private.imprest_fund_unresolved(v_r.fund_id),
                       'version', v_r.version + 1),
    'api.admin_decide_imprest_retirement');

  return private.imprest_retirement_result('approved', p_retirement_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- The api surface: each wrapper commits a refusal to the audit trail
-- ---------------------------------------------------------------------------
create or replace function api.staff_submit_imprest_retirement(
  p_count_id uuid, p_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_submit_imprest_retirement(p_count_id, p_reason,
                                                                 p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_submit_imprest_retirement', 'imprest_fund',
                        (select id from public.imprest_funds where is_active), v);
end $$;

comment on function api.staff_submit_imprest_retirement(uuid, text, text) is
  'The Manager submits the active fund''s retirement with a reason of 3 to 500 characters, naming '
  'today''s confirmed closing count (issue #72). Refused, naming each blocker, while anything in the '
  'fund is open, and without a count taken after the last posting.';

create or replace function api.admin_decide_imprest_retirement(
  p_retirement_id uuid, p_expected_version integer, p_approve boolean, p_reason text,
  p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_admin_decide_imprest_retirement(
  p_retirement_id, p_expected_version, p_approve, p_reason, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.admin_decide_imprest_retirement', 'imprest_retirement',
                        p_retirement_id, v);
end $$;

comment on function api.admin_decide_imprest_retirement(uuid, integer, boolean, text, text) is
  'A Director approves a submitted retirement, which retires the fund and carries its closing '
  'balance into the next fund as its opening balance, or rejects it with a reason (issue #72).';

-- ---------------------------------------------------------------------------
-- Replaced · the two commands that choose the active fund wait for a retirement being approved
--
-- A proposal and a count read which fund is active, then write into it. Taken during an approval,
-- that read could find the fund being retired, and the write be refused by the fund's guard as an
-- error. Each now shares the active fund's lock, which the approval holds exclusively, so it chooses
-- the next fund once the approval commits. Their bodies are unchanged; only the wrappers are
-- replaced, signatures included.
-- ---------------------------------------------------------------------------
create or replace function api.staff_propose_imprest_disbursement(
  p_amount_tzs bigint, p_category text, p_purpose text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  perform pg_advisory_xact_lock_shared(hashtextextended('imprest:active_fund', 0));
  v := private.impl_staff_propose_imprest_disbursement(p_amount_tzs, p_category, p_purpose,
                                                        p_idempotency_key);
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_propose_imprest_disbursement', 'imprest_disbursement', null, v);
end $$;

comment on function api.staff_propose_imprest_disbursement(bigint, text, text, text) is
  'The Cashier proposes a payment out of the imprest fund (§13.3 point 1). Sets nothing aside. Waits '
  'for a retirement being approved, and then joins the next fund (issue #72).';

create or replace function api.staff_enter_imprest_count(
  p_business_date date, p_previous_count_id uuid, p_counted_tzs bigint, p_note text,
  p_late_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  perform pg_advisory_xact_lock_shared(hashtextextended('imprest:active_fund', 0));
  v := private.impl_staff_enter_imprest_count(p_business_date, p_previous_count_id, p_counted_tzs,
                                               p_note, p_late_reason, p_idempotency_key);
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_enter_imprest_count', 'imprest_count', p_previous_count_id, v);
end $$;

comment on function api.staff_enter_imprest_count(date, uuid, bigint, text, text, text) is
  'The Cashier enters a count of the cash in the tin, in whole shillings of 0 or more, with an '
  'optional note: today''s, or a past Not counted day''s with a late reason of 3 to 500 characters '
  '(issues #68 and #69). Expected cash is calculated as it stands and kept with it. Waits for a '
  'retirement being approved, and then counts the next fund (issue #72).';

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------
-- The active fund as the imprest screen needs it: when counting starts, the balance carried into it,
-- and for Directors and the Manager the retirement waiting, the last one rejected, and what a
-- submission would meet now. A Cashier is sent when counting starts and nothing else.
create or replace function api.staff_imprest_fund_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.acting_staff(array['director', 'manager', 'cashier']::public.app_role[]);
  v_role  public.app_role := private.live_role_of(v_actor);
  v_today date := private.imprest_business_date();
  v_fund  public.imprest_funds%rowtype;
  v_count public.imprest_counts%rowtype;
  v_open  jsonb;
  v_last  jsonb;
begin
  select * into v_fund from public.imprest_funds where is_active;
  if v_fund.id is null then
    return null;
  end if;
  if v_role = 'cashier' then
    return jsonb_build_object('fund_id', v_fund.id,
                              'counting_starts_on', private.imprest_first_count_day(v_fund.id));
  end if;

  select * into v_count from public.imprest_counts
   where fund_id = v_fund.id and business_date = v_today order by attempt desc limit 1;

  select jsonb_build_object('id', r.id, 'version', r.version, 'reason', r.reason,
                            'submitted_by', p.full_name, 'submitted_at', r.submitted_at,
                            'business_date', r.business_date,
                            'posted_funding_tzs', r.posted_funding_tzs,
                            'closing_balance_tzs', r.closing_balance_tzs,
                            'not_counted_days', to_jsonb(r.not_counted_days),
                            'count', jsonb_build_object('id', c.id, 'counted_tzs', c.counted_tzs,
                                                        'expected_tzs', c.expected_tzs,
                                                        'variance_tzs', c.variance_tzs,
                                                        'counted_at', c.counted_at))
    into v_open
    from public.imprest_retirements r
    join public.profiles p on p.id = r.submitted_by
    join public.imprest_counts c on c.id = r.count_id
   where r.fund_id = v_fund.id and r.status = 'submitted';

  select jsonb_build_object('reason', r.rejection_reason, 'decided_by', p.full_name,
                            'decided_at', r.decided_at)
    into v_last
    from public.imprest_retirements r
    join public.profiles p on p.id = r.decided_by
   where r.fund_id = v_fund.id and r.status = 'rejected'
   order by r.decided_at desc limit 1;

  return jsonb_build_object(
    'fund_id', v_fund.id,
    'opened_at', v_fund.opened_at,
    'counting_starts_on', private.imprest_first_count_day(v_fund.id),
    'opening', (select jsonb_build_object('amount_tzs', o.amount_tzs, 'from_fund_id', o.from_fund_id,
                                          'retired_at', f.retired_at, 'posted_at', o.posted_at)
                  from public.imprest_fund_openings o
                  join public.imprest_funds f on f.id = o.from_fund_id
                 where o.fund_id = v_fund.id),
    'retirement', v_open,
    'last_rejected', v_last,
    'readiness', jsonb_build_object(
      'business_date', v_today,
      'blockers', private.imprest_retirement_blockers(v_fund.id),
      'count', case when v_count.id is null then null
                    else jsonb_build_object('id', v_count.id, 'status', v_count.status::text,
                                            'counted_tzs', v_count.counted_tzs,
                                            'counted_at', v_count.counted_at,
                                            'closes_fund',
                                            coalesce(private.imprest_count_closes_fund(v_count.id),
                                                     false)) end,
      'posted_balance_tzs', (select s.posted_balance_tzs
                               from private.imprest_spending_figures(v_fund.id) s),
      'unresolved', private.imprest_fund_unresolved(v_fund.id)));
end;
$$;

comment on function api.staff_imprest_fund_state() is
  'The active imprest fund for the imprest screen (issue #72): when counting starts, the opening '
  'balance carried from a retired fund, the retirement waiting for a Director, the last one '
  'rejected, and what a submission would meet now. A Cashier is sent only when counting starts.';

-- Retired funds, most recently retired first, with their dates, closing balance and what they
-- still carry unresolved.
create or replace function api.staff_imprest_retired_funds(p_limit integer, p_offset integer)
returns table (fund_id uuid, opened_at timestamptz, retired_at timestamptz, retirement_id uuid,
               closing_balance_tzs bigint, submitted_by text, approved_by text,
               losses_waiting integer, losses_waiting_tzs bigint, shortages_waiting integer,
               shortages_waiting_tzs bigint, not_counted_days integer, total bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.acting_staff(array['director', 'manager']::public.app_role[]);
  return query
    select f.id, f.opened_at, f.retired_at, r.id, r.closing_balance_tzs, ps.full_name, pd.full_name,
           jsonb_array_length(u.v -> 'losses'),
           (select coalesce(sum((x ->> 'amount_tzs')::bigint), 0)::bigint
              from jsonb_array_elements(u.v -> 'losses') x),
           jsonb_array_length(u.v -> 'shortages'),
           (select coalesce(sum((x ->> 'amount_tzs')::bigint), 0)::bigint
              from jsonb_array_elements(u.v -> 'shortages') x),
           jsonb_array_length(u.v -> 'not_counted_days'),
           count(*) over ()
      from public.imprest_funds f
      join public.imprest_retirements r on r.fund_id = f.id and r.status = 'approved'
      join public.profiles ps on ps.id = r.submitted_by
      join public.profiles pd on pd.id = r.decided_by
      cross join lateral (select private.imprest_fund_unresolved(f.id) as v) u
     where not f.is_active
     order by f.retired_at desc, f.id
     limit greatest(least(coalesce(p_limit, 30), 100), 1)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

comment on function api.staff_imprest_retired_funds(integer, integer) is
  'Retired imprest funds, most recently retired first, with their dates, closing balance, and the '
  'losses, shortages and Not counted days they still carry (issue #72). Directors and the Manager.';

-- One fund's whole record, read-only: its figures, every retirement, what is unresolved, its counts,
-- fundings and postings, and where its balance was carried.
create or replace function api.staff_imprest_fund_record(p_fund_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_fund public.imprest_funds%rowtype;
begin
  perform private.acting_staff(array['director', 'manager']::public.app_role[]);
  select * into v_fund from public.imprest_funds where id = p_fund_id;
  if v_fund.id is null then
    return null;
  end if;

  return jsonb_build_object(
    'fund_id', v_fund.id,
    'is_active', v_fund.is_active,
    'opened_at', v_fund.opened_at,
    'retired_at', v_fund.retired_at,
    'figures', (select jsonb_build_object(
                  'opening_tzs', (select coalesce(sum(o.amount_tzs), 0) from public.imprest_fund_openings o
                                   where o.fund_id = v_fund.id),
                  'posted_funding_tzs', s.posted_funding_tzs,
                  'expenses_tzs', (select coalesce(sum(case when p.entry = 'reversal' then -p.amount_tzs
                                                            else p.amount_tzs end), 0)
                                     from public.imprest_postings p
                                    where p.fund_id = v_fund.id and p.kind = 'expense'),
                  'losses_tzs', (select coalesce(sum(case when p.entry = 'reversal' then -p.amount_tzs
                                                          else p.amount_tzs end), 0)
                                   from public.imprest_postings p
                                  where p.fund_id = v_fund.id and p.kind = 'unexplained_loss'),
                  'shortages_tzs', (select coalesce(sum(c.amount_tzs), 0) from public.imprest_count_postings c
                                     where c.fund_id = v_fund.id and c.kind = 'count_shortage'),
                  'excesses_tzs', (select coalesce(sum(c.amount_tzs), 0) from public.imprest_count_postings c
                                    where c.fund_id = v_fund.id and c.kind = 'count_excess'),
                  'posted_balance_tzs', s.posted_balance_tzs)
                  from private.imprest_spending_figures(v_fund.id) s),
    'carried_from', (select jsonb_build_object('fund_id', o.from_fund_id, 'amount_tzs', o.amount_tzs)
                       from public.imprest_fund_openings o where o.fund_id = v_fund.id),
    'carried_into', (select jsonb_build_object('fund_id', o.fund_id, 'amount_tzs', o.amount_tzs,
                                               'posted_at', o.posted_at)
                       from public.imprest_fund_openings o where o.from_fund_id = v_fund.id),
    'retirements', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status::text, 'reason', r.reason,
                                          'business_date', r.business_date,
                                          'closing_balance_tzs', r.closing_balance_tzs,
                                          'not_counted_days', to_jsonb(r.not_counted_days),
                                          'submitted_by', ps.full_name, 'submitted_at', r.submitted_at,
                                          'decided_by', pd.full_name, 'decided_at', r.decided_at,
                                          'rejection_reason', r.rejection_reason)
                       order by r.submitted_at)
        from public.imprest_retirements r
        join public.profiles ps on ps.id = r.submitted_by
        left join public.profiles pd on pd.id = r.decided_by
       where r.fund_id = v_fund.id), '[]'),
    'unresolved', private.imprest_fund_unresolved(v_fund.id),
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('business_date', d.business_date, 'state', d.state)
                       order by d.business_date desc)
        from private.imprest_count_days(v_fund.id) d), '[]'),
    'counts', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'business_date', c.business_date,
                                          'attempt', c.attempt, 'status', c.status::text,
                                          'counted_tzs', c.counted_tzs, 'expected_tzs', c.expected_tzs,
                                          'variance_tzs', c.variance_tzs, 'outcome', k.outcome::text,
                                          'counted_by', pc.full_name, 'counted_at', c.counted_at,
                                          'late_reason', c.late_reason)
                       order by c.business_date desc, c.attempt desc)
        from public.imprest_counts c
        join public.profiles pc on pc.id = c.counted_by
        left join public.imprest_count_confirmations k on k.count_id = c.id
       where c.fund_id = v_fund.id), '[]'),
    'fundings', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'funding_no', f.funding_no,
                                          'status', f.status::text,
                                          'requested_amount_tzs', f.requested_amount_tzs,
                                          'received_amount_tzs', f.received_amount_tzs,
                                          'requested_at', f.requested_at, 'received_at', f.received_at)
                       order by f.requested_at)
        from public.imprest_fundings f where f.fund_id = v_fund.id), '[]'),
    'postings', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'disbursement_id', d.id,
                                          'disbursement_no', d.disbursement_no,
                                          'kind', p.kind::text, 'entry', p.entry::text,
                                          'amount_tzs', p.amount_tzs, 'posted_at', p.posted_at,
                                          'needs_director_decision', p.needs_director_decision)
                       order by p.posted_at, d.disbursement_no, p.entry)
        from public.imprest_postings p
        join public.imprest_disbursements d on d.id = p.disbursement_id
       where p.fund_id = v_fund.id), '[]'));
end;
$$;

comment on function api.staff_imprest_fund_record(uuid) is
  'One imprest fund''s whole record, read-only (issue #72): figures, retirements, unresolved losses, '
  'shortages and Not counted days, counts, fundings, postings, and the balance carried in and out. '
  'Directors and the Manager.';

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
            and p.proname in ('staff_submit_imprest_retirement', 'admin_decide_imprest_retirement',
                              'staff_propose_imprest_disbursement', 'staff_enter_imprest_count',
                              'staff_imprest_fund_state', 'staff_imprest_retired_funds',
                              'staff_imprest_fund_record'))
        or (n.nspname = 'private'
            and p.proname in ('guard_imprest_fund', 'guard_imprest_retirement',
                              'check_imprest_fund_opening', 'check_imprest_retirement_complete',
                              'refuse_retired_imprest_fund', 'imprest_spending_figures',
                              'imprest_first_count_day', 'imprest_last_count_day',
                              'imprest_count_days', 'imprest_retirement_blockers',
                              'imprest_last_posting_at', 'imprest_count_closes_fund',
                              'imprest_fund_unresolved', 'imprest_retirement_result',
                              'imprest_retirement_audit', 'impl_staff_submit_imprest_retirement',
                              'impl_admin_decide_imprest_retirement'))
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
