-- Issue #71 · Imprest: a Director approves the reversal and repost of a verified expense or loss
--
-- product.md §13.6 and AC-56. A verified posting is never changed. To correct one, a Cashier (on
-- their own payment) or the Manager REQUESTS A REVERSAL of one verified imprest expense or
-- unexplained loss, giving the correct amount and a reason. A DIRECTOR approves or rejects it (Owner
-- decision, 28 September 2026, matching §4.1). Approval posts two append-only records beside the
-- original:
--
--   a REVERSAL, which cancels the corrected posting in full, and
--   a REPLACEMENT posting at the correct amount. A correct amount of 0 is a pure undo: the reversal
--   alone is posted.
--
-- The posted balance moves by the difference. A replacement unexplained loss still needs a
-- Director’s accountability decision, like the loss it replaces.
--
--   imprest_posting_reversals   one row per request and what became of it. Written by the
--                               commands alone; a decision fills its own columns and nothing is
--                               ever changed or deleted.
--   imprest_postings            gains `entry` (original, reversal or replacement), `reversal_id`
--                               (the request that posted it) and `corrects_posting_id` (the posting
--                               it cancels or replaces). Still insert-only.
--
-- ONE LEDGER. Reversals and replacements are rows of `imprest_postings`, in the verification of the
-- posting they correct, so every reader of the balance sums one table. A reversal counts against
-- what was spent, so it raises the balance by what it cancels.
--
-- A POSTING IS REVERSED ONCE. A reversal row is never itself reversed; an original or a replacement
-- is reversed at most once (a unique index), so its replacement is what is corrected next.
--
-- THE FLOOR. An approval that would take the posted balance below what is set aside (Free to
-- approve below zero) is refused, under the fund’s spending lock, so it cannot race an approval for
-- the same shillings. The request is checked the same way, as advice before the Director sees it.
--
-- THREE RELEASED OBJECTS ARE REPLACED, each named where it is replaced: the posting checks, the
-- verification completeness check, and the spending figures. Signatures do not change.

begin;

-- ---------------------------------------------------------------------------
-- The requests
-- ---------------------------------------------------------------------------
create type public.imprest_reversal_status as enum (
  'requested',  -- a Cashier or the Manager asked. Nothing is posted
  'approved',   -- a Director approved. The reversal and any replacement are posted
  'rejected'    -- a Director rejected it, with a reason. Nothing is posted
);

comment on type public.imprest_reversal_status is
  'The steps of a reversal request (issue #71). Only an approved request posts.';

create type public.imprest_posting_entry as enum (
  'original',     -- what the Manager's verification posted
  'reversal',     -- cancels one original or replacement in full
  'replacement'   -- the correct amount, posted with its reversal
);

comment on type public.imprest_posting_entry is
  'What an imprest posting is (issue #71): an original from verification, a reversal that cancels '
  'one posting in full, or the replacement posted at the correct amount.';

create table public.imprest_posting_reversals (
  id                uuid primary key default gen_random_uuid(),
  -- The posting to correct: an original or a replacement, never a reversal.
  posting_id        uuid not null references public.imprest_postings (id) on delete restrict,
  disbursement_id   uuid not null references public.imprest_disbursements (id) on delete restrict,
  fund_id           uuid not null references public.imprest_funds (id) on delete restrict,
  -- What the posting holds, kept so the request reads whole without the posting.
  original_tzs      bigint not null check (original_tzs >= 0),
  -- The amount the posting should have been. 0 undoes it.
  correct_tzs       bigint not null check (correct_tzs >= 0 and correct_tzs <= 100000000),
  reason            text not null check (length(btrim(reason)) between 3 and 500),
  status            public.imprest_reversal_status not null default 'requested',
  version           integer not null default 1 check (version >= 1),
  requested_by      uuid not null references public.profiles (id),
  requested_role    public.app_role not null check (requested_role in ('cashier', 'manager')),
  requested_at      timestamptz not null default now(),
  decided_by        uuid references public.profiles (id),
  decided_at        timestamptz,
  rejection_reason  text check (rejection_reason is null
                                or length(btrim(rejection_reason)) between 3 and 500),
  constraint reversal_changes_amount check (correct_tzs <> original_tzs),
  constraint reversal_decision_shape check (
    (status <> 'requested') = (decided_by is not null)
    and (decided_by is null) = (decided_at is null)
    and (status = 'rejected') = (rejection_reason is not null)
  )
);

comment on table public.imprest_posting_reversals is
  'A request to reverse one verified imprest posting and post it again at the correct amount, and '
  'the Director''s decision (issue #71, product.md §13.6). Written by the commands alone; a decision '
  'fills its own columns and nothing is ever changed or deleted.';

-- One open request per posting, whoever writes the row.
create unique index imprest_posting_reversals_one_open_idx
  on public.imprest_posting_reversals (posting_id) where status = 'requested';
create index imprest_posting_reversals_status_idx
  on public.imprest_posting_reversals (status, requested_at);
create index imprest_posting_reversals_disbursement_idx
  on public.imprest_posting_reversals (disbursement_id);
create index imprest_posting_reversals_fund_idx on public.imprest_posting_reversals (fund_id);
create index imprest_posting_reversals_requested_by_idx
  on public.imprest_posting_reversals (requested_by);
create index imprest_posting_reversals_decided_by_idx
  on public.imprest_posting_reversals (decided_by);

-- ---------------------------------------------------------------------------
-- The ledger learns reversals and replacements
-- ---------------------------------------------------------------------------
-- Adding columns rewrites no row and fires no row trigger, so the released postings stay as they
-- were: every one of them is an original.
alter table public.imprest_postings
  add column entry public.imprest_posting_entry not null default 'original',
  add column reversal_id uuid references public.imprest_posting_reversals (id) on delete restrict,
  add column corrects_posting_id uuid references public.imprest_postings (id) on delete restrict;

alter table public.imprest_postings
  add constraint posting_entry_shape check (
    (entry = 'original') = (reversal_id is null)
    and (entry = 'original') = (corrects_posting_id is null)
  );

-- A verification still posts one expense and at most one loss; corrections join it beside them.
alter table public.imprest_postings drop constraint imprest_postings_verification_id_kind_key;
create unique index imprest_postings_original_idx
  on public.imprest_postings (verification_id, kind) where entry = 'original';

-- A posting is reversed at most once, and a request posts each entry at most once.
create unique index imprest_postings_reversed_once_idx
  on public.imprest_postings (corrects_posting_id) where entry = 'reversal';
create unique index imprest_postings_request_entry_idx
  on public.imprest_postings (reversal_id, entry) where reversal_id is not null;

-- A loss waits for a Director’s decision, and so does its replacement. A reversal cancels; it waits
-- for nothing.
alter table public.imprest_postings drop constraint posting_loss_shape;
alter table public.imprest_postings
  add constraint posting_loss_shape
    check ((kind = 'unexplained_loss' and entry <> 'reversal') = needs_director_decision
           and (kind = 'expense' or amount_tzs > 0));

comment on table public.imprest_postings is
  'What a verification posted (issue #64), and every correction of it (issue #71): reversals that '
  'cancel a posting in full and replacements at the correct amount. A reversal raises the posted '
  'balance; every other row lowers it. Never changed or deleted.';

-- ---------------------------------------------------------------------------
-- Replaced · the posting checks: an original is exactly its settlement’s figure; a correction is
-- exactly what an approved request asked for
-- ---------------------------------------------------------------------------
create or replace function private.check_imprest_verification_target()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_d      public.imprest_disbursements%rowtype;
  v_s      public.imprest_settlements%rowtype;
  v_v      public.imprest_verifications%rowtype;
  v_p      public.imprest_postings%rowtype;
  v_rv     public.imprest_posting_reversals%rowtype;
  v_figure bigint;
begin
  if tg_table_name = 'imprest_verifications' then
    select * into v_d from public.imprest_disbursements where id = new.disbursement_id;
    select * into v_s from public.imprest_settlements
     where disbursement_id = new.disbursement_id order by cycle desc limit 1;
    if v_d.status is distinct from 'settled' or v_d.fund_id is distinct from new.fund_id
       or v_s.id is distinct from new.settlement_id then
      raise exception 'imprest disbursement % is not settled at settlement %', new.disbursement_id,
        new.settlement_id using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.entry <> 'original' then
    -- A correction belongs to an approved request, sits in the verification of the posting it
    -- corrects, keeps its kind, and carries exactly the amount the request settles on.
    select * into v_rv from public.imprest_posting_reversals where id = new.reversal_id;
    select * into v_p from public.imprest_postings where id = new.corrects_posting_id;
    if v_rv.id is null or v_rv.status is distinct from 'approved'
       or v_rv.posting_id is distinct from new.corrects_posting_id
       or v_p.id is null or v_p.entry = 'reversal'
       or new.verification_id is distinct from v_p.verification_id
       or new.disbursement_id is distinct from v_p.disbursement_id
       or new.settlement_id is distinct from v_p.settlement_id
       or new.fund_id is distinct from v_p.fund_id
       or new.kind is distinct from v_p.kind
       or new.amount_tzs is distinct from
            (case when new.entry = 'reversal' then v_p.amount_tzs else v_rv.correct_tzs end)
       or (new.entry = 'replacement' and v_rv.correct_tzs = 0) then
      raise exception 'imprest % of % does not match an approved reversal of posting %', new.entry,
        new.amount_tzs, new.corrects_posting_id using errcode = 'check_violation';
    end if;
    return new;
  end if;

  select * into v_v from public.imprest_verifications where id = new.verification_id;
  select * into v_s from public.imprest_settlements where id = v_v.settlement_id;
  if new.kind = 'expense' then
    v_figure := v_s.used_tzs;
  else
    v_figure := v_s.unaccounted_tzs;
  end if;
  if v_v.id is null
     or new.disbursement_id is distinct from v_v.disbursement_id
     or new.settlement_id is distinct from v_v.settlement_id
     or new.fund_id is distinct from v_v.fund_id
     or new.amount_tzs is distinct from v_figure then
    raise exception 'imprest posting % of % does not match its settlement', new.kind, new.amount_tzs
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function private.check_imprest_verification_target() is
  'A verification names a settled disbursement''s latest settlement in its own fund; an original '
  'posting is exactly that settlement''s Used or Not accounted for (issue #64); a reversal cancels '
  'the posting an approved request names, in full, and a replacement posts its correct amount '
  '(issue #71).';

-- ---------------------------------------------------------------------------
-- Replaced · a verification’s completeness counts its originals only
-- ---------------------------------------------------------------------------
create or replace function private.check_imprest_verification_complete()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_id      uuid;
  v_v       public.imprest_verifications%rowtype;
  v_s       public.imprest_settlements%rowtype;
  v_expense integer;
  v_loss    integer;
begin
  if tg_table_name = 'imprest_verifications' then
    v_id := new.id;
  else
    v_id := new.verification_id;
  end if;

  select * into v_v from public.imprest_verifications where id = v_id;
  select * into v_s from public.imprest_settlements where id = v_v.settlement_id;
  select count(*) filter (where kind = 'expense'), count(*) filter (where kind = 'unexplained_loss')
    into v_expense, v_loss
    from public.imprest_postings where verification_id = v_id and entry = 'original';

  if v_expense <> 1 or (v_loss = 1) <> (v_s.unaccounted_tzs > 0) or v_loss > 1
     or not exists (select 1 from public.imprest_disbursements
                     where id = v_v.disbursement_id and status = 'verified') then
    raise exception 'imprest verification % has % expense and % loss postings for a remainder of %',
      v_id, v_expense, v_loss, v_s.unaccounted_tzs using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- A request moves forward once, keeps what was asked, and is never deleted
-- ---------------------------------------------------------------------------
create or replace function private.guard_imprest_posting_reversal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'imprest reversal % cannot be deleted', old.id using errcode = 'restrict_violation';
  end if;

  if new.id is distinct from old.id
     or new.posting_id is distinct from old.posting_id
     or new.disbursement_id is distinct from old.disbursement_id
     or new.fund_id is distinct from old.fund_id
     or new.original_tzs is distinct from old.original_tzs
     or new.correct_tzs is distinct from old.correct_tzs
     or new.reason is distinct from old.reason
     or new.requested_by is distinct from old.requested_by
     or new.requested_role is distinct from old.requested_role
     or new.requested_at is distinct from old.requested_at
     or old.status <> 'requested'
     or new.status not in ('approved', 'rejected')
     or new.version is distinct from old.version + 1 then
    raise exception 'imprest reversal % keeps what was asked and moves forward once', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

comment on function private.guard_imprest_posting_reversal() is
  'A reversal request goes from requested to approved or rejected once, one version on, never '
  'changes what was asked, and is never deleted (issue #71).';

create trigger imprest_posting_reversals_guard
  before update or delete on public.imprest_posting_reversals
  for each row execute function private.guard_imprest_posting_reversal();
create trigger imprest_posting_reversals_no_truncate
  before truncate on public.imprest_posting_reversals
  for each statement execute function private.refuse_imprest_settlement_edit();

-- A request is born open, against a posting that is an original or a replacement, not yet
-- reversed, at the amount it holds, whoever writes the row.
create or replace function private.check_imprest_posting_reversal_target()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_p public.imprest_postings%rowtype;
begin
  select * into v_p from public.imprest_postings where id = new.posting_id;
  if new.status <> 'requested' or new.version <> 1 or v_p.id is null or v_p.entry = 'reversal'
     or new.disbursement_id is distinct from v_p.disbursement_id
     or new.fund_id is distinct from v_p.fund_id
     or new.original_tzs is distinct from v_p.amount_tzs
     or exists (select 1 from public.imprest_postings x
                 where x.corrects_posting_id = new.posting_id and x.entry = 'reversal') then
    raise exception 'imprest posting % is not open to a reversal request', new.posting_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function private.check_imprest_posting_reversal_target() is
  'A reversal request is born open against an original or replacement posting that has not been '
  'reversed, at the amount it holds (issue #71).';

create trigger imprest_posting_reversals_target
  before insert on public.imprest_posting_reversals
  for each row execute function private.check_imprest_posting_reversal_target();

-- At commit, an approved request carries its reversal, and a replacement exactly when the correct
-- amount is above zero. A rejected one carries neither.
create or replace function private.check_imprest_posting_reversal_complete()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_reversals    integer;
  v_replacements integer;
begin
  select count(*) filter (where entry = 'reversal'), count(*) filter (where entry = 'replacement')
    into v_reversals, v_replacements
    from public.imprest_postings where reversal_id = new.id;
  if (new.status = 'approved' and (v_reversals <> 1 or v_replacements <> (new.correct_tzs > 0)::int))
     or (new.status <> 'approved' and v_reversals + v_replacements > 0) then
    raise exception 'imprest reversal % (%) has % reversal and % replacement postings', new.id,
      new.status, v_reversals, v_replacements using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

create constraint trigger imprest_posting_reversal_complete
  after update on public.imprest_posting_reversals
  deferrable initially deferred
  for each row execute function private.check_imprest_posting_reversal_complete();

-- ---------------------------------------------------------------------------
-- Grants and row-level security: the readers of the disbursement itself
-- ---------------------------------------------------------------------------
alter table public.imprest_posting_reversals enable row level security;

revoke all on public.imprest_posting_reversals from public, anon, authenticated, service_role;
grant select on public.imprest_posting_reversals to authenticated;
grant select, insert, update on public.imprest_posting_reversals to fv_definer_owner;

create policy imprest_posting_reversals_select on public.imprest_posting_reversals
  for select to authenticated
  using ((select private.authorize(array['director', 'manager']::public.app_role[]))
         or ((select private.authorize(array['cashier']::public.app_role[]))
             and exists (select 1 from public.imprest_disbursements d
                          where d.id = disbursement_id and d.proposed_by = (select auth.uid()))));

create policy imprest_posting_reversals_definer_owner on public.imprest_posting_reversals
  for all to fv_definer_owner using (true) with check (true);

-- When the payment’s oldest open request was made, as a column PostgREST can sort and filter the
-- Directors’ "Reversals waiting for approval" list by. Invoker’s rights, like its raise twin.
create or replace function public.imprest_disbursement_reversal_requested_at(d public.imprest_disbursements)
returns timestamptz
language sql
stable
security invoker
set search_path = ''
as $$
  select min(r.requested_at) from public.imprest_posting_reversals r
   where r.disbursement_id = d.id and r.status = 'requested';
$$;

comment on function public.imprest_disbursement_reversal_requested_at(public.imprest_disbursements) is
  'When the payment''s oldest open reversal request was made, or null when none is open (issue #71).';

revoke execute on function public.imprest_disbursement_reversal_requested_at(public.imprest_disbursements)
  from public, anon, service_role;
grant execute on function public.imprest_disbursement_reversal_requested_at(public.imprest_disbursements)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Replaced · the figures: a reversal gives back what it cancels
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
  select posted.tzs, posted.tzs - spent.tzs + counted.tzs, aside.tzs,
         posted.tzs - spent.tzs + counted.tzs - aside.tzs
    from posted, spent, counted, aside;
$$;

comment on function private.imprest_spending_figures(uuid) is
  'Posted imprest funding; the posted balance (funding minus verified expenses and unexplained '
  'losses as corrected by reversals and replacements, minus count shortages plus count excesses); '
  'what approved, handed-out, settled and sent-back disbursements set aside, raised approvals '
  'included; and Free to approve, the posted balance minus set aside (AC-99, AC-102, issues #64, '
  '#65, #68, #70, #71). Never stored.';

-- ---------------------------------------------------------------------------
-- Command helpers
-- ---------------------------------------------------------------------------
create or replace function private.imprest_reversal_result(p_reason text, p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('ok', true, 'reason', p_reason,
                            'reversal', (select to_jsonb(r) from public.imprest_posting_reversals r
                                          where r.id = p_id));
$$;

create or replace function private.imprest_reversal_audit(
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
  values (p_actor, private.live_role_of(p_actor), false, p_action, 'imprest_posting_reversal', p_id,
          p_before, p_after, gen_random_uuid(), p_source);
$$;

-- ---------------------------------------------------------------------------
-- Request (a Cashier on their own payment, or the Manager)
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_request_imprest_reversal(
  p_posting_id uuid, p_correct_tzs bigint, p_reason text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := private.acting_staff(array['cashier', 'manager']::public.app_role[]);
  v_role    public.app_role := private.live_role_of(v_actor);
  v_reason  text := private.normalise_label(p_reason);
  v_id      uuid := gen_random_uuid();
  v_class   jsonb;
  v_p       public.imprest_postings%rowtype;
  v_free    bigint;
  v_request jsonb := jsonb_build_object('posting_id', p_posting_id, 'correct_tzs', p_correct_tzs,
                                        'reason', v_reason);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));
  v_class := private.classify_idempotency_key(p_idempotency_key, 'imprest.request_reversal',
                                              v_actor, v_request);
  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  elsif v_class ->> 'status' = 'replay' then
    return private.imprest_reversal_result('replayed', (v_class ->> 'result_ref')::uuid);
  end if;

  -- Another Cashier’s posting is answered exactly as a missing one.
  select * into v_p from public.imprest_postings where id = p_posting_id;
  if not found
     or (v_role = 'cashier'
         and not exists (select 1 from public.imprest_disbursements
                          where id = v_p.disbursement_id and proposed_by = v_actor)) then
    return jsonb_build_object('ok', false, 'reason', 'no_posting');
  elsif v_p.entry = 'reversal' then
    return jsonb_build_object('ok', false, 'reason', 'not_reversible');
  end if;

  -- Two requests for one posting serialise here; the second finds the first open.
  perform pg_advisory_xact_lock(hashtextextended('imprest_posting_reversal:' || p_posting_id::text, 0));
  if exists (select 1 from public.imprest_postings
              where corrects_posting_id = p_posting_id and entry = 'reversal') then
    return jsonb_build_object('ok', false, 'reason', 'already_reversed');
  elsif exists (select 1 from public.imprest_posting_reversals
                 where posting_id = p_posting_id and status = 'requested') then
    return jsonb_build_object('ok', false, 'reason', 'reversal_open');
  end if;

  if p_correct_tzs is null or p_correct_tzs < 0 or p_correct_tzs > 100000000 then
    return jsonb_build_object('ok', false, 'reason', 'amount_invalid');
  elsif p_correct_tzs = v_p.amount_tzs then
    return jsonb_build_object('ok', false, 'reason', 'amount_unchanged', 'amount_tzs', v_p.amount_tzs);
  elsif private.imprest_text_problem(v_reason, true) then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  -- Advice before the Director sees it: a correction the fund cannot carry now is refused now. The
  -- approval checks again under the fund’s lock, which is the control.
  select s.free_to_approve_tzs into v_free from private.imprest_spending_figures(v_p.fund_id) s;
  if p_correct_tzs - v_p.amount_tzs > v_free then
    return jsonb_build_object('ok', false, 'reason', 'below_set_aside',
                              'free_to_approve_tzs', v_free,
                              'amount_tzs', p_correct_tzs - v_p.amount_tzs);
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'imprest.request_reversal', v_actor, v_request,
                               v_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  insert into public.imprest_posting_reversals (id, posting_id, disbursement_id, fund_id,
                                                original_tzs, correct_tzs, reason, requested_by,
                                                requested_role)
  values (v_id, p_posting_id, v_p.disbursement_id, v_p.fund_id, v_p.amount_tzs, p_correct_tzs,
          v_reason, v_actor, v_role);

  perform private.imprest_reversal_audit(v_actor, 'imprest_reversal_requested', v_id, null,
    jsonb_build_object('status', 'requested', 'posting_id', p_posting_id,
                       'disbursement_id', v_p.disbursement_id, 'kind', v_p.kind,
                       'entry', v_p.entry, 'original_tzs', v_p.amount_tzs,
                       'correct_tzs', p_correct_tzs, 'reason', v_reason,
                       'requested_role', v_role),
    'api.staff_request_imprest_reversal');

  return private.imprest_reversal_result('requested', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Approve or reject (a Director). There is no amount: the correct amount is the one asked for.
-- ---------------------------------------------------------------------------
create or replace function private.impl_admin_decide_imprest_reversal(
  p_reversal_id uuid, p_expected_version integer, p_approve boolean, p_reason text,
  p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor       uuid := private.acting_director();
  v_reason      text := private.normalise_label(p_reason);
  v_class       jsonb;
  v_rv          public.imprest_posting_reversals%rowtype;
  v_p           public.imprest_postings%rowtype;
  v_before      bigint;
  v_free        bigint;
  v_reversal    uuid;
  v_replacement uuid;
  v_figures     record;
  v_request     jsonb := jsonb_build_object('reversal_id', p_reversal_id,
                                            'expected_version', p_expected_version,
                                            'approve', p_approve, 'reason', v_reason);
begin
  if p_approve is null then
    return jsonb_build_object('ok', false, 'reason', 'decision_required');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));
  v_class := private.classify_idempotency_key(p_idempotency_key, 'imprest.decide_reversal',
                                              v_actor, v_request);
  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  elsif v_class ->> 'status' = 'replay' then
    return private.imprest_reversal_result('replayed', p_reversal_id);
  end if;

  select * into v_rv from public.imprest_posting_reversals where id = p_reversal_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_reversal');
  elsif v_rv.version is distinct from p_expected_version then
    return jsonb_build_object('ok', false, 'reason', 'stale', 'version', v_rv.version,
                              'status', v_rv.status::text);
  elsif v_rv.status <> 'requested' then
    return jsonb_build_object('ok', false, 'reason', 'not_awaiting_decision',
                              'status', v_rv.status::text);
  elsif not p_approve and private.imprest_text_problem(v_reason, true) then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  select * into v_p from public.imprest_postings where id = v_rv.posting_id;

  -- Serialised per fund with approvals, raises and verifications, so a correction and an approval
  -- that both read the same Free to approve cannot both spend it.
  perform pg_advisory_xact_lock(hashtextextended('imprest_fund_spend:' || v_rv.fund_id::text, 0));
  select s.posted_balance_tzs, s.free_to_approve_tzs into v_before, v_free
    from private.imprest_spending_figures(v_rv.fund_id) s;
  if p_approve and v_rv.correct_tzs - v_rv.original_tzs > v_free then
    return jsonb_build_object('ok', false, 'reason', 'below_set_aside',
                              'free_to_approve_tzs', v_free,
                              'amount_tzs', v_rv.correct_tzs - v_rv.original_tzs);
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'imprest.decide_reversal', v_actor, v_request,
                               p_reversal_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if not p_approve then
    update public.imprest_posting_reversals
       set status = 'rejected', decided_by = v_actor, decided_at = now(),
           rejection_reason = v_reason, version = version + 1
     where id = p_reversal_id;

    perform private.imprest_reversal_audit(v_actor, 'imprest_reversal_rejected', p_reversal_id,
      jsonb_build_object('status', 'requested', 'version', v_rv.version),
      jsonb_build_object('status', 'rejected', 'posting_id', v_rv.posting_id,
                         'disbursement_id', v_rv.disbursement_id, 'reason', v_reason,
                         'version', v_rv.version + 1),
      'api.admin_decide_imprest_reversal');
    return private.imprest_reversal_result('rejected', p_reversal_id);
  end if;

  update public.imprest_posting_reversals
     set status = 'approved', decided_by = v_actor, decided_at = now(), version = version + 1
   where id = p_reversal_id;

  -- The reversal cancels the posting in full; the replacement posts the correct amount beside it,
  -- unless the correct amount is nothing. Both sit in the posting’s own verification.
  v_reversal := gen_random_uuid();
  insert into public.imprest_postings (id, verification_id, disbursement_id, settlement_id, fund_id,
                                       kind, amount_tzs, needs_director_decision, entry,
                                       reversal_id, corrects_posting_id)
  values (v_reversal, v_p.verification_id, v_p.disbursement_id, v_p.settlement_id, v_p.fund_id,
          v_p.kind, v_p.amount_tzs, false, 'reversal', p_reversal_id, v_p.id);

  if v_rv.correct_tzs > 0 then
    v_replacement := gen_random_uuid();
    insert into public.imprest_postings (id, verification_id, disbursement_id, settlement_id,
                                         fund_id, kind, amount_tzs, needs_director_decision, entry,
                                         reversal_id, corrects_posting_id)
    values (v_replacement, v_p.verification_id, v_p.disbursement_id, v_p.settlement_id, v_p.fund_id,
            v_p.kind, v_rv.correct_tzs, v_p.kind = 'unexplained_loss', 'replacement',
            p_reversal_id, v_p.id);
  end if;

  select s.posted_balance_tzs, s.free_to_approve_tzs into v_figures
    from private.imprest_spending_figures(v_rv.fund_id) s;

  perform private.imprest_reversal_audit(v_actor, 'imprest_reversal_approved', p_reversal_id,
    jsonb_build_object('status', 'requested', 'version', v_rv.version,
                       'posted_balance_tzs', v_before),
    jsonb_build_object('status', 'approved', 'posting_id', v_rv.posting_id,
                       'disbursement_id', v_rv.disbursement_id, 'kind', v_p.kind,
                       'original_tzs', v_rv.original_tzs, 'correct_tzs', v_rv.correct_tzs,
                       'reversal_posting_id', v_reversal, 'replacement_posting_id', v_replacement,
                       'posted_balance_tzs', v_figures.posted_balance_tzs,
                       'free_to_approve_tzs', v_figures.free_to_approve_tzs,
                       'version', v_rv.version + 1),
    'api.admin_decide_imprest_reversal');

  return private.imprest_reversal_result('approved', p_reversal_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- The api surface: each wrapper commits a refusal to the audit trail
-- ---------------------------------------------------------------------------
create or replace function api.staff_request_imprest_reversal(
  p_posting_id uuid, p_correct_tzs bigint, p_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_request_imprest_reversal(
  p_posting_id, p_correct_tzs, p_reason, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_request_imprest_reversal', 'imprest_posting', p_posting_id, v);
end $$;

comment on function api.staff_request_imprest_reversal(uuid, bigint, text, text) is
  'A Cashier (on their own payment) or the Manager asks a Director to reverse one verified imprest '
  'expense or unexplained loss and post it again at the correct amount, 0 or more, with a reason of '
  '3 to 500 characters. One open request per posting (issue #71).';

create or replace function api.admin_decide_imprest_reversal(
  p_reversal_id uuid, p_expected_version integer, p_approve boolean, p_reason text,
  p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_admin_decide_imprest_reversal(
  p_reversal_id, p_expected_version, p_approve, p_reason, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.admin_decide_imprest_reversal', 'imprest_posting_reversal',
                        p_reversal_id, v);
end $$;

comment on function api.admin_decide_imprest_reversal(uuid, integer, boolean, text, text) is
  'A Director approves a reversal request, which posts the reversal and the replacement together '
  'and is refused when it would leave the posted balance below what is set aside, or rejects it '
  'with a reason (issue #71).';

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
            and p.proname in ('staff_request_imprest_reversal', 'admin_decide_imprest_reversal'))
        or (n.nspname = 'private'
            and p.proname in ('check_imprest_verification_target',
                              'check_imprest_verification_complete',
                              'guard_imprest_posting_reversal',
                              'check_imprest_posting_reversal_target',
                              'check_imprest_posting_reversal_complete',
                              'imprest_spending_figures', 'imprest_reversal_result',
                              'imprest_reversal_audit', 'impl_staff_request_imprest_reversal',
                              'impl_admin_decide_imprest_reversal'))
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
