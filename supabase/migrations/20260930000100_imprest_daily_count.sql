-- Issue #68 · Imprest daily count, part 1: the Cashier counts, the Manager confirms, the variance posts
--
-- product.md §13.7, §15.1 to §15.3, AC-57 and AC-58. Each business day the CASHIER counts the cash in
-- the tin and enters the total. Expected cash is calculated, never typed:
--
--   expected cash = posted balance − awaiting verification            (§13.4)
--
-- The count keeps expected cash, the posted balance and awaiting verification AS THEY STOOD when it
-- was entered, so its variance (counted − expected) never shifts when money moves later that day.
--
-- The MANAGER confirms the count, or sends it back with a reason for a recount. Every count is kept:
-- a recount is a new row, numbered after the one it replaces. A confirmed count ends the day in
-- exactly one state, Balanced, Shortage or Excess, with zero tolerance (§15.1). A shortage or excess
-- takes one of the seven variance reasons of design.md §14.7, and three of them need a written note.
--
-- A CONFIRMED VARIANCE POSTS (Owner decision, 28 September 2026). A shortage posts as an immutable
-- count shortage that lowers the posted balance and waits for a Director's accountability decision,
-- like an unexplained loss. An excess posts as an immutable count excess that raises it. The next
-- day's expected cash then matches the tin, and the same gap is not reported again every day. The
-- decision itself is a later ticket.
--
-- Confirming a non-zero variance raises a FLAG that both Directors read at once (§13.7, AC-58).
--
--   imprest_counts                 one row per count; only its status and version ever change.
--   imprest_count_returns          the Manager sent a count back: who, when and why. Never changed.
--   imprest_count_confirmations    the Manager confirmed a count: its outcome and explanation.
--   imprest_count_postings         the shortage or excess a confirmation posted. Never changed.
--   imprest_count_flags            the flag raised to the Directors. Never changed.
--
-- THE FIGURES, still calculated in `private.imprest_spending_figures` and never stored:
--
--   posted balance  = posted funding − verified expenses − verified unexplained losses
--                     − count shortages + count excesses
--
-- Free to approve and expected cash follow from it. Out of scope: days with no count, the Directors'
-- decisions, retirement and the daily report's imprest figures.

begin;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.imprest_count_status as enum (
  'awaiting_confirmation',  -- entered by the Cashier, waiting for the Manager
  'sent_back',              -- the Manager asked for a recount; a new count replaces it
  'confirmed'               -- the Manager confirmed it; the day is closed
);

create type public.imprest_count_outcome as enum ('balanced', 'shortage', 'excess');

-- design.md §14.7. The last three need a written note.
create type public.imprest_count_explanation as enum (
  'counting_error',
  'recording_error',
  'change_not_returned',
  'amount_correction',
  'suspected_loss_or_theft',
  'under_investigation',
  'other'
);

create type public.imprest_count_posting_kind as enum (
  'count_shortage',  -- lowers the posted balance; waits for a Director's decision
  'count_excess'     -- raises the posted balance
);

comment on type public.imprest_count_status is
  'Where a daily cash count stands (issue #68). Awaiting Manager confirmation is never a zero variance.';
comment on type public.imprest_count_explanation is
  'The variance reasons of design.md §14.7. Suspected loss or theft, Under investigation and Other '
  'need a written note.';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.imprest_counts (
  id                         uuid primary key default gen_random_uuid(),
  fund_id                    uuid not null references public.imprest_funds (id) on delete restrict,
  -- The business day (§15.3), in Africa/Dar_es_Salaam.
  business_date              date not null,
  -- 1 for the day's first count, then one more for each recount after a send-back.
  attempt                    integer not null check (attempt >= 1),
  counted_tzs                bigint not null check (counted_tzs >= 0 and counted_tzs <= 100000000),
  note                       text check (note is null or length(btrim(note)) between 3 and 500),
  -- The figures as they stood when the count was entered. Never recalculated.
  posted_balance_tzs         bigint not null,
  awaiting_verification_tzs  bigint not null check (awaiting_verification_tzs >= 0),
  expected_tzs               bigint not null,
  variance_tzs               bigint generated always as (counted_tzs - expected_tzs) stored,
  status                     public.imprest_count_status not null default 'awaiting_confirmation',
  version                    integer not null default 1 check (version >= 1),
  counted_by                 uuid not null references public.profiles (id),
  counted_at                 timestamptz not null default now(),
  unique (fund_id, business_date, attempt),
  constraint count_expected_shape
    check (expected_tzs = posted_balance_tzs - awaiting_verification_tzs)
);

comment on table public.imprest_counts is
  'The Cashier''s count of the cash in the tin for one business day (issue #68), with the expected '
  'cash it was compared with as it stood then. A recount is a new row; only status and version change.';

-- At most one count a day that has not been sent back: the one waiting, or the one confirmed.
create unique index imprest_counts_one_standing_per_day
  on public.imprest_counts (fund_id, business_date) where status <> 'sent_back';
create index imprest_counts_recent_idx on public.imprest_counts (fund_id, counted_at desc);
create index imprest_counts_by_idx on public.imprest_counts (counted_by);

create table public.imprest_count_returns (
  id           uuid primary key default gen_random_uuid(),
  count_id     uuid not null unique references public.imprest_counts (id) on delete restrict,
  reason       text not null check (length(btrim(reason)) between 3 and 500),
  returned_by  uuid not null references public.profiles (id),
  returned_at  timestamptz not null default now()
);

comment on table public.imprest_count_returns is
  'The Manager sent a count back for a recount, with a reason (issue #68). Never changed.';

create index imprest_count_returns_by_idx on public.imprest_count_returns (returned_by);

create table public.imprest_count_confirmations (
  id                uuid primary key default gen_random_uuid(),
  count_id          uuid not null unique references public.imprest_counts (id) on delete restrict,
  outcome           public.imprest_count_outcome not null,
  variance_tzs      bigint not null,
  explanation       public.imprest_count_explanation,
  explanation_note  text check (explanation_note is null
                                or length(btrim(explanation_note)) between 3 and 500),
  confirmed_by      uuid not null references public.profiles (id),
  confirmed_at      timestamptz not null default now(),
  constraint count_confirmation_shape check (
    (outcome = 'balanced') = (variance_tzs = 0)
    and (outcome = 'shortage') = (variance_tzs < 0)
    and (outcome = 'balanced') = (explanation is null)
    and (explanation is not null or explanation_note is null)
    and (explanation is null
         or explanation not in ('suspected_loss_or_theft', 'under_investigation', 'other')
         or explanation_note is not null)
  )
);

comment on table public.imprest_count_confirmations is
  'The Manager confirmed a count (issue #68): Balanced, Shortage or Excess, with a preset explanation '
  'for any variance. Never changed.';

create index imprest_count_confirmations_by_idx on public.imprest_count_confirmations (confirmed_by);

create table public.imprest_count_postings (
  id                       uuid primary key default gen_random_uuid(),
  count_id                 uuid not null unique references public.imprest_counts (id)
                             on delete restrict,
  confirmation_id          uuid not null unique references public.imprest_count_confirmations (id)
                             on delete restrict,
  fund_id                  uuid not null references public.imprest_funds (id) on delete restrict,
  kind                     public.imprest_count_posting_kind not null,
  amount_tzs               bigint not null check (amount_tzs > 0),
  -- A shortage needs a Director's accountability decision (§13.1); the decision will be its own
  -- append-only record, so this row never changes.
  needs_director_decision  boolean not null,
  posted_at                timestamptz not null default now(),
  constraint count_posting_shape check ((kind = 'count_shortage') = needs_director_decision)
);

comment on table public.imprest_count_postings is
  'What a confirmed count posted (issue #68): a shortage lowers the posted balance and waits for a '
  'Director''s decision; an excess raises it. Never changed or deleted.';

create index imprest_count_postings_fund_idx on public.imprest_count_postings (fund_id, kind);

create table public.imprest_count_flags (
  id               uuid primary key default gen_random_uuid(),
  count_id         uuid not null unique references public.imprest_counts (id) on delete restrict,
  confirmation_id  uuid not null unique references public.imprest_count_confirmations (id)
                     on delete restrict,
  fund_id          uuid not null references public.imprest_funds (id) on delete restrict,
  business_date    date not null,
  kind             public.imprest_count_posting_kind not null,
  amount_tzs       bigint not null check (amount_tzs > 0),
  raised_at        timestamptz not null default now()
);

comment on table public.imprest_count_flags is
  'The flag a confirmed shortage or excess raises to both Directors at once (§13.7, AC-58). Never '
  'changed; the Directors'' accountability decision is a later record.';

create index imprest_count_flags_recent_idx on public.imprest_count_flags (raised_at desc);
create index imprest_count_flags_fund_idx on public.imprest_count_flags (fund_id);

-- ---------------------------------------------------------------------------
-- Append-only
-- ---------------------------------------------------------------------------
-- Part 2a's refusal, which names the table it meets. TRUNCATE is refused too, since it skips the
-- row triggers.
create trigger imprest_count_returns_append_only
  before update or delete on public.imprest_count_returns
  for each row execute function private.refuse_imprest_settlement_edit();
create trigger imprest_count_confirmations_append_only
  before update or delete on public.imprest_count_confirmations
  for each row execute function private.refuse_imprest_settlement_edit();
create trigger imprest_count_postings_append_only
  before update or delete on public.imprest_count_postings
  for each row execute function private.refuse_imprest_settlement_edit();
create trigger imprest_count_flags_append_only
  before update or delete on public.imprest_count_flags
  for each row execute function private.refuse_imprest_settlement_edit();
create trigger imprest_counts_no_delete
  before delete on public.imprest_counts
  for each row execute function private.refuse_imprest_settlement_edit();

create trigger imprest_counts_no_truncate
  before truncate on public.imprest_counts
  for each statement execute function private.refuse_imprest_settlement_edit();
create trigger imprest_count_returns_no_truncate
  before truncate on public.imprest_count_returns
  for each statement execute function private.refuse_imprest_settlement_edit();
create trigger imprest_count_confirmations_no_truncate
  before truncate on public.imprest_count_confirmations
  for each statement execute function private.refuse_imprest_settlement_edit();
create trigger imprest_count_postings_no_truncate
  before truncate on public.imprest_count_postings
  for each statement execute function private.refuse_imprest_settlement_edit();
create trigger imprest_count_flags_no_truncate
  before truncate on public.imprest_count_flags
  for each statement execute function private.refuse_imprest_settlement_edit();

-- ---------------------------------------------------------------------------
-- The figures, calculated in one place: count postings move the posted balance
-- ---------------------------------------------------------------------------
create or replace function private.imprest_spending_figures(p_fund_id uuid)
returns table (posted_funding_tzs bigint, posted_balance_tzs bigint, set_aside_tzs bigint,
               free_to_approve_tzs bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with posted as (
    select coalesce(sum(f.received_amount_tzs) filter (where f.status = 'received'), 0)::bigint
             as tzs
      from public.imprest_fundings f
     where f.fund_id = p_fund_id
  ), spent as (
    -- Verified expenses and verified unexplained losses alike: both are cash gone from the tin.
    select coalesce(sum(p.amount_tzs), 0)::bigint as tzs
      from public.imprest_postings p
     where p.fund_id = p_fund_id
  ), counted as (
    -- Confirmed counts (issue #68): an excess is cash the tin holds, a shortage cash it does not.
    select coalesce(sum(case when c.kind = 'count_excess' then c.amount_tzs else -c.amount_tzs end),
                    0)::bigint as tzs
      from public.imprest_count_postings c
     where c.fund_id = p_fund_id
  ), aside as (
    -- Handed out, settled and sent back stay set aside until the Manager verifies them (AC-102).
    select coalesce(sum(d.amount_tzs), 0)::bigint as tzs
      from public.imprest_disbursements d
     where d.fund_id = p_fund_id and d.status in ('approved', 'handed_out', 'settled', 'sent_back')
  )
  select posted.tzs, posted.tzs - spent.tzs + counted.tzs, aside.tzs,
         posted.tzs - spent.tzs + counted.tzs - aside.tzs
    from posted, spent, counted, aside;
$$;

comment on function private.imprest_spending_figures(uuid) is
  'Posted imprest funding; the posted balance (funding minus verified expenses and unexplained '
  'losses, minus count shortages plus count excesses); what approved, handed-out, settled and '
  'sent-back disbursements set aside; and Free to approve, the posted balance minus set aside '
  '(AC-99, AC-102, issues #64, #65, #68). Never stored.';

-- Today, as the business counts days (§15.3).
create or replace function private.imprest_business_date()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'Africa/Dar_es_Salaam')::date;
$$;

-- ---------------------------------------------------------------------------
-- Consistent, whoever writes the rows
-- ---------------------------------------------------------------------------
-- A count is today's, waiting, in the active fund, numbered after the day's last count which must
-- have been sent back, and carrying the figures exactly as they stand now.
create or replace function private.check_imprest_count_entry()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_last    public.imprest_counts%rowtype;
  v_posted  bigint;
  v_waiting bigint;
begin
  select * into v_last from public.imprest_counts
   where fund_id = new.fund_id and business_date = new.business_date
   order by attempt desc limit 1;
  select s.posted_balance_tzs into v_posted from private.imprest_spending_figures(new.fund_id) s;
  v_waiting := private.imprest_awaiting_verification_tzs(new.fund_id);

  if new.status is distinct from 'awaiting_confirmation' or new.version is distinct from 1
     or new.business_date is distinct from private.imprest_business_date()
     or not exists (select 1 from public.imprest_funds where id = new.fund_id and is_active)
     or new.attempt is distinct from coalesce(v_last.attempt, 0) + 1
     or (v_last.id is not null and v_last.status is distinct from 'sent_back')
     or new.posted_balance_tzs is distinct from v_posted
     or new.awaiting_verification_tzs is distinct from v_waiting then
    raise exception 'imprest count % is not today''s next count at the figures as they stand',
      new.id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger imprest_counts_entry
  before insert on public.imprest_counts
  for each row execute function private.check_imprest_count_entry();

-- A count's figures never change. Its status moves forward once: to sent back with a return, or to
-- confirmed with a confirmation. Either is final.
create or replace function private.guard_imprest_count_progress()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'status' - 'version' - 'variance_tzs')
       is distinct from (to_jsonb(old) - 'status' - 'version' - 'variance_tzs')
     or old.status <> 'awaiting_confirmation'
     or new.version <> old.version + 1
     or not ((new.status = 'sent_back'
              and exists (select 1 from public.imprest_count_returns x where x.count_id = new.id))
             or (new.status = 'confirmed'
                 and exists (select 1 from public.imprest_count_confirmations c
                              where c.count_id = new.id))) then
    raise exception 'imprest count % cannot go from % to %', old.id, old.status, new.status
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger imprest_counts_progress
  before update on public.imprest_counts
  for each row execute function private.guard_imprest_count_progress();

-- A return or a confirmation is of a count that is waiting. A confirmation carries its count's
-- variance; a posting and a flag carry exactly that variance, in its own fund.
create or replace function private.check_imprest_count_decision()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_c public.imprest_counts%rowtype;
  v_k public.imprest_count_confirmations%rowtype;
begin
  select * into v_c from public.imprest_counts where id = new.count_id;

  -- Nested IFs, not one expression: PL/pgSQL resolves every field an expression names, and a return
  -- has no variance, a posting no business date.
  if tg_table_name in ('imprest_count_returns', 'imprest_count_confirmations') then
    if v_c.status is distinct from 'awaiting_confirmation' then
      raise exception 'imprest count % is not awaiting confirmation', new.count_id
        using errcode = 'check_violation';
    end if;
    if tg_table_name = 'imprest_count_confirmations' then
      if new.variance_tzs is distinct from v_c.variance_tzs then
        raise exception 'imprest count % has a variance of %, not %', new.count_id,
          v_c.variance_tzs, new.variance_tzs using errcode = 'check_violation';
      end if;
    end if;
    return new;
  end if;

  -- A posting or a flag.
  select * into v_k from public.imprest_count_confirmations where id = new.confirmation_id;
  if v_k.id is null or v_k.count_id is distinct from new.count_id
     or new.fund_id is distinct from v_c.fund_id
     or v_k.variance_tzs = 0
     or new.amount_tzs is distinct from abs(v_k.variance_tzs)
     or new.kind is distinct from (case when v_k.variance_tzs < 0 then 'count_shortage'
                                        else 'count_excess' end)::public.imprest_count_posting_kind then
    raise exception 'imprest count % of % does not match its confirmation', new.kind,
      new.amount_tzs using errcode = 'check_violation';
  end if;
  if tg_table_name = 'imprest_count_flags' then
    if new.business_date is distinct from v_c.business_date then
      raise exception 'imprest count flag % is not for the day counted', new.count_id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger imprest_count_returns_target
  before insert on public.imprest_count_returns
  for each row execute function private.check_imprest_count_decision();
create trigger imprest_count_confirmations_target
  before insert on public.imprest_count_confirmations
  for each row execute function private.check_imprest_count_decision();
create trigger imprest_count_postings_target
  before insert on public.imprest_count_postings
  for each row execute function private.check_imprest_count_decision();
create trigger imprest_count_flags_target
  before insert on public.imprest_count_flags
  for each row execute function private.check_imprest_count_decision();

-- At commit: a return leaves its count sent back; a confirmation leaves it confirmed, with a posting
-- and a flag exactly when there is a variance. The rows can be written in any order but never go
-- without each other.
--
-- SECURITY DEFINER, unlike the checks above. A deferred trigger runs at COMMIT as the session's own
-- role, after the command's definer rights have ended, and the Manager who confirms may not read the
-- flag raised to the Directors. Read as the caller, the flag would look missing and every confirmed
-- variance would be refused.
create or replace function private.check_imprest_count_complete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count uuid := new.count_id;
  v_k     public.imprest_count_confirmations%rowtype;
begin
  if tg_table_name = 'imprest_count_returns' then
    if not exists (select 1 from public.imprest_counts where id = v_count and status = 'sent_back') then
      raise exception 'imprest count return leaves count % not sent back', v_count
        using errcode = 'check_violation';
    end if;
    return null;
  end if;

  select * into v_k from public.imprest_count_confirmations where count_id = v_count;
  if v_k.id is null
     or not exists (select 1 from public.imprest_counts where id = v_count and status = 'confirmed')
     or (v_k.variance_tzs <> 0) <> exists (select 1 from public.imprest_count_postings
                                             where count_id = v_count)
     or (v_k.variance_tzs <> 0) <> exists (select 1 from public.imprest_count_flags
                                             where count_id = v_count) then
    raise exception 'imprest count % is not confirmed with its posting and flag', v_count
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

create constraint trigger imprest_count_returns_complete
  after insert on public.imprest_count_returns
  deferrable initially deferred
  for each row execute function private.check_imprest_count_complete();
create constraint trigger imprest_count_confirmations_complete
  after insert on public.imprest_count_confirmations
  deferrable initially deferred
  for each row execute function private.check_imprest_count_complete();
create constraint trigger imprest_count_postings_complete
  after insert on public.imprest_count_postings
  deferrable initially deferred
  for each row execute function private.check_imprest_count_complete();
create constraint trigger imprest_count_flags_complete
  after insert on public.imprest_count_flags
  deferrable initially deferred
  for each row execute function private.check_imprest_count_complete();

-- ---------------------------------------------------------------------------
-- Grants and row-level security
-- ---------------------------------------------------------------------------
alter table public.imprest_counts enable row level security;
alter table public.imprest_count_returns enable row level security;
alter table public.imprest_count_confirmations enable row level security;
alter table public.imprest_count_postings enable row level security;
alter table public.imprest_count_flags enable row level security;

revoke all on public.imprest_counts, public.imprest_count_returns,
              public.imprest_count_confirmations, public.imprest_count_postings,
              public.imprest_count_flags
  from public, anon, authenticated, service_role;
grant select on public.imprest_count_returns, public.imprest_count_confirmations,
                public.imprest_count_postings, public.imprest_count_flags
  to authenticated;
-- Every column of a count but the posted balance and awaiting verification behind expected cash,
-- which the Cashier is never sent. Directors and the Manager read those two through
-- `api.staff_imprest_counts`, the one read the screens use.
grant select (id, fund_id, business_date, attempt, counted_tzs, note, expected_tzs, variance_tzs,
              status, version, counted_by, counted_at)
  on public.imprest_counts to authenticated;
grant select, insert, update on public.imprest_counts to fv_definer_owner;
grant select, insert on public.imprest_count_returns, public.imprest_count_confirmations,
                        public.imprest_count_postings, public.imprest_count_flags
  to fv_definer_owner;

-- The count and its decisions: the three imprest roles. The column grant above keeps the posted
-- balance and awaiting verification out of a direct read.
create policy imprest_counts_select on public.imprest_counts
  for select to authenticated
  using ((select private.authorize(array['director', 'manager', 'cashier']::public.app_role[])));
create policy imprest_count_returns_select on public.imprest_count_returns
  for select to authenticated
  using ((select private.authorize(array['director', 'manager', 'cashier']::public.app_role[])));
create policy imprest_count_confirmations_select on public.imprest_count_confirmations
  for select to authenticated
  using ((select private.authorize(array['director', 'manager', 'cashier']::public.app_role[])));
-- A posting changes the posted balance, which the Cashier is not shown.
create policy imprest_count_postings_select on public.imprest_count_postings
  for select to authenticated
  using ((select private.authorize(array['director', 'manager']::public.app_role[])));
-- The flag is raised to the Directors.
create policy imprest_count_flags_select on public.imprest_count_flags
  for select to authenticated
  using ((select private.authorize(array['director']::public.app_role[])));

create policy imprest_counts_definer_owner on public.imprest_counts
  for all to fv_definer_owner using (true) with check (true);
create policy imprest_count_returns_definer_owner on public.imprest_count_returns
  for all to fv_definer_owner using (true) with check (true);
create policy imprest_count_confirmations_definer_owner on public.imprest_count_confirmations
  for all to fv_definer_owner using (true) with check (true);
create policy imprest_count_postings_definer_owner on public.imprest_count_postings
  for all to fv_definer_owner using (true) with check (true);
create policy imprest_count_flags_definer_owner on public.imprest_count_flags
  for all to fv_definer_owner using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Command helpers
-- ---------------------------------------------------------------------------
create or replace function private.imprest_count_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(c) - 'posted_balance_tzs' - 'awaiting_verification_tzs'
    from public.imprest_counts c where c.id = p_id;
$$;

comment on function private.imprest_count_json(uuid) is
  'A count as a command returns it, without the posted balance and awaiting verification behind '
  'expected cash, which the Cashier is not shown.';

create or replace function private.imprest_count_result(p_reason text, p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('ok', true, 'reason', p_reason, 'count', private.imprest_count_json(p_id));
$$;

create or replace function private.imprest_count_audit(
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
  values (p_actor, private.live_role_of(p_actor), false, p_action, 'imprest_count', p_id,
          p_before, p_after, gen_random_uuid(), p_source);
$$;

-- The shared opening of the Manager's two commands: replay or conflict on the key, the row locked,
-- the version the Manager was shown, and a count still waiting.
create or replace function private.imprest_count_open(
  p_key text, p_operation text, p_actor uuid, p_request jsonb, p_id uuid, p_expected_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_class jsonb;
  v_c     public.imprest_counts%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_key, ''), 0));
  v_class := private.classify_idempotency_key(p_key, p_operation, p_actor, p_request);
  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  elsif v_class ->> 'status' = 'replay' then
    return private.imprest_count_result('replayed', p_id);
  end if;

  select * into v_c from public.imprest_counts where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_count');
  elsif v_c.version is distinct from p_expected_version then
    return jsonb_build_object('ok', false, 'reason', 'stale', 'version', v_c.version,
                              'status', v_c.status::text);
  elsif v_c.status <> 'awaiting_confirmation' then
    return jsonb_build_object('ok', false, 'reason', 'not_awaiting_confirmation',
                              'status', v_c.status::text);
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Enter a count (the Cashier). The only figure typed is the cash counted.
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_enter_imprest_count(
  p_business_date date, p_previous_count_id uuid, p_counted_tzs bigint, p_note text,
  p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := private.acting_staff(array['cashier']::public.app_role[]);
  v_note    text := nullif(private.normalise_label(p_note), '');
  v_today   date := private.imprest_business_date();
  v_class   jsonb;
  v_fund    uuid;
  v_last    public.imprest_counts%rowtype;
  v_posted  bigint;
  v_waiting bigint;
  v_id      uuid := gen_random_uuid();
  v_request jsonb := jsonb_build_object('business_date', p_business_date,
                                        'previous_count_id', p_previous_count_id,
                                        'counted_tzs', p_counted_tzs, 'note', v_note);
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

  -- A screen left open past midnight would otherwise count yesterday's cash as today's.
  if p_business_date is distinct from v_today then
    return jsonb_build_object('ok', false, 'reason', 'day_changed', 'business_date', v_today::text);
  end if;

  select * into v_last from public.imprest_counts
   where fund_id = v_fund and business_date = v_today
   order by attempt desc limit 1;
  if v_last.status = 'confirmed' then
    return jsonb_build_object('ok', false, 'reason', 'already_confirmed');
  elsif v_last.status = 'awaiting_confirmation' then
    return jsonb_build_object('ok', false, 'reason', 'count_awaiting_confirmation');
  elsif v_last.id is distinct from p_previous_count_id then
    -- The day the Cashier was shown is not the day as it stands: another count came in, or a count
    -- was sent back that the screen has not yet shown.
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;

  if p_counted_tzs is null or p_counted_tzs < 0 or p_counted_tzs > 100000000 then
    return jsonb_build_object('ok', false, 'reason', 'amount_invalid');
  elsif private.imprest_text_problem(v_note, false) then
    return jsonb_build_object('ok', false, 'reason', 'note_invalid');
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'imprest.enter_count', v_actor, v_request,
                               v_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  select s.posted_balance_tzs into v_posted from private.imprest_spending_figures(v_fund) s;
  v_waiting := private.imprest_awaiting_verification_tzs(v_fund);

  insert into public.imprest_counts (id, fund_id, business_date, attempt, counted_tzs, note,
                                     posted_balance_tzs, awaiting_verification_tzs, expected_tzs,
                                     counted_by)
  values (v_id, v_fund, v_today, coalesce(v_last.attempt, 0) + 1, p_counted_tzs, v_note,
          v_posted, v_waiting, v_posted - v_waiting, v_actor);

  perform private.imprest_count_audit(v_actor, 'imprest_count_entered', v_id,
    case when v_last.id is not null then jsonb_build_object('replaces_count_id', v_last.id) end,
    jsonb_build_object('status', 'awaiting_confirmation', 'business_date', v_today,
                       'attempt', coalesce(v_last.attempt, 0) + 1, 'counted_tzs', p_counted_tzs,
                       'posted_balance_tzs', v_posted, 'awaiting_verification_tzs', v_waiting,
                       'expected_tzs', v_posted - v_waiting,
                       'variance_tzs', p_counted_tzs - (v_posted - v_waiting)),
    'api.staff_enter_imprest_count');

  return private.imprest_count_result('counted', v_id);
end;
$$;

create or replace function api.staff_enter_imprest_count(
  p_business_date date, p_previous_count_id uuid, p_counted_tzs bigint, p_note text,
  p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_enter_imprest_count(
  p_business_date, p_previous_count_id, p_counted_tzs, p_note, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_enter_imprest_count', 'imprest_count', p_previous_count_id, v);
end $$;

comment on function api.staff_enter_imprest_count(date, uuid, bigint, text, text) is
  'The Cashier enters today''s count of the cash in the tin, in whole shillings of 0 or more, with an '
  'optional note. Expected cash is calculated and kept with it (issue #68). A recount names the '
  'sent-back count it replaces.';

-- ---------------------------------------------------------------------------
-- Send back (the Manager): count again, with a reason. Nothing posts.
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_send_back_imprest_count(
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
  v_c       public.imprest_counts%rowtype;
  v_request jsonb := jsonb_build_object('id', p_id, 'expected_version', p_expected_version,
                                        'reason', v_reason);
begin
  v_stop := private.imprest_count_open(p_idempotency_key, 'imprest.send_back_count', v_actor,
                                       v_request, p_id, p_expected_version);
  if v_stop is not null then
    return v_stop;
  end if;

  if private.imprest_text_problem(v_reason, true) then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'imprest.send_back_count', v_actor, v_request,
                               p_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  select * into v_c from public.imprest_counts where id = p_id;

  insert into public.imprest_count_returns (count_id, reason, returned_by)
  values (p_id, v_reason, v_actor);

  update public.imprest_counts set status = 'sent_back', version = version + 1 where id = p_id;

  perform private.imprest_count_audit(v_actor, 'imprest_count_sent_back', p_id,
    jsonb_build_object('status', 'awaiting_confirmation'),
    jsonb_build_object('status', 'sent_back', 'business_date', v_c.business_date,
                       'attempt', v_c.attempt, 'variance_tzs', v_c.variance_tzs,
                       'reason', v_reason),
    'api.staff_send_back_imprest_count');

  return private.imprest_count_result('sent_back', p_id);
end;
$$;

create or replace function api.staff_send_back_imprest_count(
  p_id uuid, p_expected_version integer, p_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_send_back_imprest_count(
  p_id, p_expected_version, p_reason, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_send_back_imprest_count', 'imprest_count', p_id, v);
end $$;

comment on function api.staff_send_back_imprest_count(uuid, integer, text, text) is
  'The Manager sends a waiting count back for a recount, with a reason of 3 to 500 characters '
  '(issue #68). The count stays on the record; the Cashier counts again.';

-- ---------------------------------------------------------------------------
-- Confirm (the Manager). There is no figure: the count is confirmed as it stands.
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_confirm_imprest_count(
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
  v_c            public.imprest_counts%rowtype;
  v_outcome      public.imprest_count_outcome;
  v_kind         public.imprest_count_posting_kind;
  v_confirmation uuid := gen_random_uuid();
  v_figures      record;
  v_request      jsonb := jsonb_build_object('id', p_id, 'expected_version', p_expected_version,
                                             'explanation', v_explanation, 'note', v_note);
begin
  v_stop := private.imprest_count_open(p_idempotency_key, 'imprest.confirm_count', v_actor,
                                       v_request, p_id, p_expected_version);
  if v_stop is not null then
    return v_stop;
  end if;

  select * into v_c from public.imprest_counts where id = p_id;

  if v_c.variance_tzs = 0 then
    if v_explanation is not null or v_note is not null then
      return jsonb_build_object('ok', false, 'reason', 'explanation_not_needed');
    end if;
    v_outcome := 'balanced';
  else
    if v_explanation is null then
      return jsonb_build_object('ok', false, 'reason', 'explanation_required',
                                'variance_tzs', v_c.variance_tzs);
    elsif not (v_explanation = any (enum_range(null::public.imprest_count_explanation)::text[])) then
      return jsonb_build_object('ok', false, 'reason', 'explanation_invalid');
    elsif private.imprest_text_problem(v_note, v_explanation in ('suspected_loss_or_theft',
                                                                 'under_investigation', 'other')) then
      return jsonb_build_object('ok', false, 'reason', 'explanation_note_required');
    end if;
    v_outcome := (case when v_c.variance_tzs < 0 then 'shortage'
                       else 'excess' end)::public.imprest_count_outcome;
    v_kind := (case when v_c.variance_tzs < 0 then 'count_shortage'
                    else 'count_excess' end)::public.imprest_count_posting_kind;
  end if;

  -- A posting moves the posted balance, so it is serialised with every approval and verification.
  perform pg_advisory_xact_lock(hashtextextended('imprest_fund_spend:' || v_c.fund_id::text, 0));

  if private.imprest_claim_key(p_idempotency_key, 'imprest.confirm_count', v_actor, v_request,
                               p_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  insert into public.imprest_count_confirmations (id, count_id, outcome, variance_tzs, explanation,
                                                  explanation_note, confirmed_by)
  values (v_confirmation, p_id, v_outcome, v_c.variance_tzs,
          v_explanation::public.imprest_count_explanation, v_note, v_actor);

  if v_kind is not null then
    insert into public.imprest_count_postings (count_id, confirmation_id, fund_id, kind, amount_tzs,
                                               needs_director_decision)
    values (p_id, v_confirmation, v_c.fund_id, v_kind, abs(v_c.variance_tzs),
            v_kind = 'count_shortage');
    insert into public.imprest_count_flags (count_id, confirmation_id, fund_id, business_date, kind,
                                            amount_tzs)
    values (p_id, v_confirmation, v_c.fund_id, v_c.business_date, v_kind, abs(v_c.variance_tzs));
  end if;

  update public.imprest_counts set status = 'confirmed', version = version + 1 where id = p_id;

  select * into v_figures from private.imprest_spending_figures(v_c.fund_id);

  perform private.imprest_count_audit(v_actor, 'imprest_count_confirmed', p_id,
    jsonb_build_object('status', 'awaiting_confirmation'),
    jsonb_build_object('status', 'confirmed', 'business_date', v_c.business_date,
                       'attempt', v_c.attempt, 'outcome', v_outcome,
                       'counted_tzs', v_c.counted_tzs, 'expected_tzs', v_c.expected_tzs,
                       'variance_tzs', v_c.variance_tzs, 'explanation', v_explanation,
                       'explanation_note', v_note, 'posted', v_kind,
                       'needs_director_decision', v_kind = 'count_shortage',
                       'flagged_to_directors', v_kind is not null,
                       'posted_balance_tzs', v_figures.posted_balance_tzs,
                       'free_to_approve_tzs', v_figures.free_to_approve_tzs),
    'api.staff_confirm_imprest_count');

  return private.imprest_count_result('confirmed', p_id);
end;
$$;

create or replace function api.staff_confirm_imprest_count(
  p_id uuid, p_expected_version integer, p_explanation text, p_note text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_confirm_imprest_count(
  p_id, p_expected_version, p_explanation, p_note, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_confirm_imprest_count', 'imprest_count', p_id, v);
end $$;

comment on function api.staff_confirm_imprest_count(uuid, integer, text, text, text) is
  'The Manager confirms a waiting count as it stands (issue #68). Balanced posts nothing; a shortage '
  'or excess needs a preset explanation, posts append-only and raises a flag to both Directors.';

-- ---------------------------------------------------------------------------
-- Read: the counts, most recent first, each with its decision
-- ---------------------------------------------------------------------------
create or replace function api.staff_imprest_counts(p_limit integer, p_offset integer)
returns table (id uuid, business_date date, attempt integer, counted_tzs bigint, note text,
               posted_balance_tzs bigint, awaiting_verification_tzs bigint, expected_tzs bigint,
               variance_tzs bigint, status text, version integer, counted_by text,
               counted_at timestamptz, outcome text, explanation text, explanation_note text,
               confirmed_by text, confirmed_at timestamptz, return_reason text,
               returned_by text, returned_at timestamptz, needs_director_decision boolean,
               total bigint)
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
           count(*) over ()
      from public.imprest_counts c
      join public.imprest_funds f on f.id = c.fund_id and f.is_active
      join public.profiles pc on pc.id = c.counted_by
      left join public.imprest_count_confirmations k on k.count_id = c.id
      left join public.profiles pk on pk.id = k.confirmed_by
      left join public.imprest_count_returns x on x.count_id = c.id
      left join public.profiles px on px.id = x.returned_by
      left join public.imprest_count_postings p on p.count_id = c.id
     order by c.business_date desc, c.attempt desc
     limit greatest(least(coalesce(p_limit, 30), 100), 1)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

comment on function api.staff_imprest_counts(integer, integer) is
  'The active fund''s daily counts, most recent first, each with expected, counted, variance and the '
  'Manager''s confirmation or send-back (issue #68). A Cashier is not sent the posted balance or '
  'awaiting verification behind expected cash.';

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
            and p.proname in ('staff_enter_imprest_count', 'staff_send_back_imprest_count',
                              'staff_confirm_imprest_count', 'staff_imprest_counts'))
        or (n.nspname = 'private'
            and p.proname in ('imprest_spending_figures', 'imprest_business_date',
                              'check_imprest_count_entry', 'guard_imprest_count_progress',
                              'check_imprest_count_decision', 'check_imprest_count_complete',
                              'imprest_count_json', 'imprest_count_result', 'imprest_count_audit',
                              'imprest_count_open', 'impl_staff_enter_imprest_count',
                              'impl_staff_send_back_imprest_count',
                              'impl_staff_confirm_imprest_count'))
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
