-- Issue #70 · Imprest: raise a disbursement's approval before paying more
--
-- product.md §13.3 point 4 and AC-100. The Cashier may not pay more than the approved amount. When
-- the need grows, a RAISED APPROVAL comes first. While a disbursement is handed out, or sent back
-- after settlement, the Cashier ASKS for more with a reason. The Manager RAISES the approval, which
-- sets the extra aside at once and is refused when Free to approve is short, or refuses the request
-- with a reason. The Cashier then HANDS OUT the extra and records who received it. Settlement, and
-- every later cycle, is checked against the raised approved amount.
--
--   imprest_approval_raises   one row per request and what became of it: requested, then raised or
--                             refused, then handed out. Each step fills its own columns and none is
--                             ever changed, so the original approval and every raise stay visible.
--
-- THE APPROVED AMOUNT IS CALCULATED, NEVER TYPED. It is the original approval (`amount_tzs`, which
-- never changes) plus every raise that was raised or handed out. It is calculated in
-- `public.imprest_disbursement_approved_tzs` and nowhere else; `private.imprest_approved_tzs` reads
-- it for the commands.
--
-- THE MONEY. A raise sets its increase aside the moment it is raised, so Free to approve falls at
-- once. Awaiting verification counts the extra only when the Cashier records handing it out: until
-- then the cash has not left the tin. A raise handed out while sent back is counted beside the
-- latest submitted cycle until the next cycle explains it (`after_cycle` remembers which cycle it
-- followed).
--
-- ONE OPEN REQUEST AT A TIME, and none while an earlier raise is still to be handed out. The
-- disbursement cannot settle while a request or an un-handed-out raise is open, in the settle
-- command and again in the trigger on the settlement row.
--
-- Every command moves the disbursement one version, so a screen that showed the old approved amount
-- is refused as stale instead of settling against it.
--
-- FIVE RELEASED OBJECTS ARE REPLACED, each named where it is replaced: the settlement target check,
-- the spending figures, Awaiting verification, and the settle command. Signatures do not change.

begin;

-- ---------------------------------------------------------------------------
-- The raises
-- ---------------------------------------------------------------------------
create type public.imprest_raise_status as enum (
  'requested',   -- the Cashier asked. Sets nothing aside
  'raised',      -- the Manager raised the approval. The increase is set aside
  'refused',     -- the Manager refused, with a reason. Nothing was set aside
  'handed_out'   -- the Cashier handed out the extra and recorded who received it
);

comment on type public.imprest_raise_status is
  'The steps of a raised approval (issue #70). Only raised and handed out set money aside.';

create table public.imprest_approval_raises (
  id               uuid primary key default gen_random_uuid(),
  disbursement_id  uuid not null references public.imprest_disbursements (id) on delete restrict,
  raise_no         integer not null check (raise_no >= 1),
  status           public.imprest_raise_status not null default 'requested',
  -- The increase asked for, in whole shillings. It is the raise; the approved amount is calculated.
  amount_tzs       bigint not null check (amount_tzs > 0 and amount_tzs <= 100000000),
  reason           text not null check (length(btrim(reason)) between 3 and 500),
  requested_by     uuid not null references public.profiles (id),
  requested_at     timestamptz not null default now(),
  decided_by       uuid references public.profiles (id),
  decided_at       timestamptz,
  refusal_reason   text check (refusal_reason is null
                               or length(btrim(refusal_reason)) between 3 and 500),
  handed_out_by    uuid references public.profiles (id),
  handed_out_at    timestamptz,
  recipient        text check (recipient is null or length(btrim(recipient)) between 2 and 120),
  -- How many settlement cycles the disbursement had when the extra went out.
  after_cycle      integer check (after_cycle is null or after_cycle >= 0),
  unique (disbursement_id, raise_no),
  constraint raise_decision_shape check (
    (status <> 'requested') = (decided_by is not null)
    and (decided_by is null) = (decided_at is null)
    and (status = 'refused') = (refusal_reason is not null)
  ),
  constraint raise_handout_shape check (
    (status = 'handed_out') = (handed_out_by is not null)
    and (handed_out_by is null) = (handed_out_at is null)
    and (handed_out_by is null) = (recipient is null)
    and (handed_out_by is null) = (after_cycle is null)
  )
);

comment on table public.imprest_approval_raises is
  'A Cashier''s request for more than a disbursement was approved for, and what became of it (issue '
  '#70, product.md §13.3). Written by the commands alone; a step fills its own columns and nothing '
  'is ever changed or deleted.';

-- One open request at a time, whoever writes the row.
create unique index imprest_approval_raises_one_open_idx
  on public.imprest_approval_raises (disbursement_id) where status = 'requested';
create index imprest_approval_raises_status_idx
  on public.imprest_approval_raises (status, requested_at);
create index imprest_approval_raises_requested_by_idx on public.imprest_approval_raises (requested_by);
create index imprest_approval_raises_decided_by_idx   on public.imprest_approval_raises (decided_by);
create index imprest_approval_raises_handed_out_by_idx on public.imprest_approval_raises (handed_out_by);

create or replace function private.guard_imprest_approval_raise()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'imprest raise % cannot be deleted', old.id using errcode = 'restrict_violation';
  end if;

  if new.id is distinct from old.id
     or new.disbursement_id is distinct from old.disbursement_id
     or new.raise_no is distinct from old.raise_no
     or new.amount_tzs is distinct from old.amount_tzs
     or new.reason is distinct from old.reason
     or new.requested_by is distinct from old.requested_by
     or new.requested_at is distinct from old.requested_at
     or (old.decided_by is not null
         and (new.decided_by is distinct from old.decided_by
              or new.decided_at is distinct from old.decided_at
              or new.refusal_reason is distinct from old.refusal_reason))
     or (old.handed_out_by is not null
         and (new.handed_out_by is distinct from old.handed_out_by
              or new.handed_out_at is distinct from old.handed_out_at
              or new.recipient is distinct from old.recipient
              or new.after_cycle is distinct from old.after_cycle)) then
    raise exception 'imprest raise % keeps what was asked, decided and handed out', old.id
      using errcode = 'restrict_violation';
  end if;

  if not ((old.status = 'requested' and new.status in ('raised', 'refused'))
          or (old.status = 'raised' and new.status = 'handed_out')) then
    raise exception 'imprest raise % cannot go from % to %', old.id, old.status, new.status
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

comment on function private.guard_imprest_approval_raise() is
  'A raise only moves forward (requested to raised or refused, raised to handed out), never changes '
  'what was asked or decided, and is never deleted (issue #70).';

create trigger imprest_approval_raises_guard
  before update or delete on public.imprest_approval_raises
  for each row execute function private.guard_imprest_approval_raise();
create trigger imprest_approval_raises_no_truncate
  before truncate on public.imprest_approval_raises
  for each statement execute function private.refuse_imprest_settlement_edit();

-- A request is made while the disbursement is handed out or sent back, whoever writes the row.
create or replace function private.check_imprest_approval_raise_target()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status public.imprest_disbursement_status;
begin
  select status into v_status from public.imprest_disbursements where id = new.disbursement_id;
  if new.status <> 'requested' or v_status is null or v_status not in ('handed_out', 'sent_back') then
    raise exception 'imprest disbursement % is not open to a raised approval', new.disbursement_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function private.check_imprest_approval_raise_target() is
  'A raise is born as a request against a handed-out or sent-back disbursement (issue #70).';

create trigger imprest_approval_raises_target
  before insert on public.imprest_approval_raises
  for each row execute function private.check_imprest_approval_raise_target();

-- ---------------------------------------------------------------------------
-- Grants and row-level security: the readers of the disbursement itself
-- ---------------------------------------------------------------------------
alter table public.imprest_approval_raises enable row level security;

revoke all on public.imprest_approval_raises from public, anon, authenticated, service_role;
grant select on public.imprest_approval_raises to authenticated;
grant select, insert, update on public.imprest_approval_raises to fv_definer_owner;

create policy imprest_approval_raises_select on public.imprest_approval_raises
  for select to authenticated
  using ((select private.authorize(array['director', 'manager']::public.app_role[]))
         or ((select private.authorize(array['cashier']::public.app_role[]))
             and exists (select 1 from public.imprest_disbursements d
                          where d.id = disbursement_id and d.proposed_by = (select auth.uid()))));

create policy imprest_approval_raises_definer_owner on public.imprest_approval_raises
  for all to fv_definer_owner using (true) with check (true);

-- ---------------------------------------------------------------------------
-- The approved amount, calculated in one place
-- ---------------------------------------------------------------------------
-- Invoker's rights, so it adds up only the raises the caller may read, and a column PostgREST can
-- select. The private form is what the commands and the figures call.
create or replace function public.imprest_disbursement_approved_tzs(d public.imprest_disbursements)
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  select d.amount_tzs + coalesce((select sum(r.amount_tzs) from public.imprest_approval_raises r
                                   where r.disbursement_id = d.id
                                     and r.status in ('raised', 'handed_out')), 0)::bigint;
$$;

comment on function public.imprest_disbursement_approved_tzs(public.imprest_disbursements) is
  'The approved amount: the original approval plus every raise that was raised or handed out. '
  'Calculated on every read, never stored or typed (issue #70).';

revoke execute on function public.imprest_disbursement_approved_tzs(public.imprest_disbursements)
  from public, anon, service_role;
grant execute on function public.imprest_disbursement_approved_tzs(public.imprest_disbursements)
  to authenticated;

-- When the open request was made, as a column PostgREST can sort and filter the Manager's "Waiting
-- for a raised approval" list by. Invoker's rights, like `imprest_disbursement_sent_back_at`.
create or replace function public.imprest_disbursement_raise_requested_at(d public.imprest_disbursements)
returns timestamptz
language sql
stable
security invoker
set search_path = ''
as $$
  select min(r.requested_at) from public.imprest_approval_raises r
   where r.disbursement_id = d.id and r.status = 'requested';
$$;

comment on function public.imprest_disbursement_raise_requested_at(public.imprest_disbursements) is
  'When the disbursement''s open request for a raised approval was made, or null when none is open '
  '(issue #70).';

revoke execute on function public.imprest_disbursement_raise_requested_at(public.imprest_disbursements)
  from public, anon, service_role;
grant execute on function public.imprest_disbursement_raise_requested_at(public.imprest_disbursements)
  to authenticated;

create or replace function private.imprest_approved_tzs(p_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select d.amount_tzs + coalesce((select sum(r.amount_tzs) from public.imprest_approval_raises r
                                   where r.disbursement_id = d.id
                                     and r.status in ('raised', 'handed_out')), 0)::bigint
    from public.imprest_disbursements d where d.id = p_id;
$$;

comment on function private.imprest_approved_tzs(uuid) is
  'The approved amount of one disbursement for the commands: original plus raises (issue #70). The '
  'same sum as public.imprest_disbursement_approved_tzs, read with the owner''s rights.';

-- ---------------------------------------------------------------------------
-- Replaced · a settlement is checked against the raised approved amount, and never with a raise open
-- ---------------------------------------------------------------------------
create or replace function private.check_imprest_settlement_target()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_d        public.imprest_disbursements%rowtype;
  v_last     integer;
  v_returned boolean;
begin
  if tg_table_name = 'imprest_settlements' then
    select * into v_d from public.imprest_disbursements where id = new.disbursement_id;
    select s.cycle, exists (select 1 from public.imprest_settlement_returns x
                             where x.settlement_id = s.id)
      into v_last, v_returned
      from public.imprest_settlements s
     where s.disbursement_id = new.disbursement_id
     order by s.cycle desc limit 1;
    if new.approved_tzs is distinct from private.imprest_approved_tzs(new.disbursement_id)
       or exists (select 1 from public.imprest_approval_raises r
                   where r.disbursement_id = new.disbursement_id
                     and r.status in ('requested', 'raised'))
       or not ((v_d.status = 'handed_out' and v_last is null and new.cycle = 1)
               or (v_d.status = 'sent_back' and v_returned and new.cycle = v_last + 1)) then
      raise exception 'imprest disbursement % is not open to settlement cycle % at %',
        new.disbursement_id, new.cycle, new.approved_tzs using errcode = 'check_violation';
    end if;
  elsif new.receipt_id is not null and not exists (
          select 1 from public.imprest_receipts rc
            join public.imprest_settlements s on s.disbursement_id = rc.disbursement_id
           where rc.id = new.receipt_id and s.id = new.settlement_id) then
    raise exception 'receipt % belongs to another disbursement', new.receipt_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Replaced · the figures: a raise is set aside the moment it is raised
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
  'losses, minus count shortages plus count excesses); what approved, handed-out, settled and '
  'sent-back disbursements set aside, raised approvals included; and Free to approve, the posted '
  'balance minus set aside (AC-99, AC-102, issues #64, #65, #68, #70). Never stored.';

-- ---------------------------------------------------------------------------
-- Replaced · Awaiting verification counts an extra once it is handed out
-- ---------------------------------------------------------------------------
create or replace function private.imprest_awaiting_verification_tzs(p_fund_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  -- Cash that has left the fund and is not verified: the original amount while it is out, then the
  -- latest submitted cycle's Used plus Not accounted for, whether that cycle waits for the Manager
  -- or was sent back. Returned cash is back in the fund. An extra counts once it is handed out; a
  -- later cycle covers every extra handed out before it, so only extras handed out after the latest
  -- cycle are added to it.
  select coalesce(sum(case when d.status = 'handed_out' then d.amount_tzs
                           else s.used_tzs + s.unaccounted_tzs end
                      + coalesce(x.tzs, 0)), 0)::bigint
    from public.imprest_disbursements d
    left join lateral (select st.cycle, st.used_tzs, st.unaccounted_tzs
                         from public.imprest_settlements st
                        where st.disbursement_id = d.id
                        order by st.cycle desc limit 1) s on true
    left join lateral (select sum(r.amount_tzs) as tzs from public.imprest_approval_raises r
                        where r.disbursement_id = d.id and r.status = 'handed_out'
                          and r.after_cycle = coalesce(s.cycle, 0)) x on true
   where d.fund_id = p_fund_id and d.status in ('handed_out', 'settled', 'sent_back');
$$;

comment on function private.imprest_awaiting_verification_tzs(uuid) is
  'Awaiting verification (product.md §13.4): cash that has left the fund and has not been checked '
  'by the Manager, counting a sent-back disbursement at its latest submitted cycle and an extra '
  'from the moment it is handed out (issues #65, #70). Never stored.';

-- ---------------------------------------------------------------------------
-- Replaced · settle against the raised approved amount, and never with a raise open
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_settle_imprest_disbursement(
  p_id uuid, p_expected_version integer, p_lines jsonb, p_returned_tzs bigint,
  p_explanation text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor       uuid := private.acting_staff(array['cashier']::public.app_role[]);
  v_explanation text := nullif(private.normalise_label(p_explanation), '');
  v_stop        jsonb;
  v_d           public.imprest_disbursements%rowtype;
  v_needs       public.imprest_disbursement_status;
  v_cycle       integer;
  v_lines       jsonb := '[]'::jsonb;
  v_line        jsonb;
  v_i           integer := 0;
  v_amount      bigint;
  v_purpose     text;
  v_receipt     uuid;
  v_given       boolean;
  v_reason      text;
  v_note        text;
  v_rc          public.imprest_receipts%rowtype;
  v_owner       text;
  v_seen        uuid[] := '{}'::uuid[];
  v_used        bigint := 0;
  v_none        integer := 0;
  v_remainder   bigint;
  v_approved    bigint;
  v_settlement  uuid := gen_random_uuid();
  v_request     jsonb;
begin
  -- The lines are compared as the Cashier sent them, tidied the way they are stored, so a retry
  -- with any line, file, amount or explanation changed is a conflict and never a replay.
  if p_lines is not null and jsonb_typeof(p_lines) = 'array' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'amount_tzs', e -> 'amount_tzs',
             'purpose', private.normalise_label(e ->> 'purpose'),
             'receipt_id', e -> 'receipt_id',
             'no_receipt_reason', e -> 'no_receipt_reason',
             'no_receipt_note', nullif(private.normalise_label(e ->> 'no_receipt_note'), ''))
             order by n), '[]'::jsonb)
      into v_lines
      from jsonb_array_elements(p_lines) with ordinality as t(e, n);
  end if;
  v_request := jsonb_build_object('id', p_id, 'expected_version', p_expected_version,
                                  'lines', v_lines, 'returned_tzs', p_returned_tzs,
                                  'explanation', v_explanation);

  -- A first settlement needs the cash handed out; a later one needs the last cycle sent back. The
  -- status read here only picks which; the shared opening locks the row and checks the version, so
  -- a status that moved in between has moved the version too and is refused as stale.
  select case when status = 'sent_back' then 'sent_back' else 'handed_out' end::public.imprest_disbursement_status
    into v_needs
    from public.imprest_disbursements where id = p_id and proposed_by = v_actor;
  v_stop := private.imprest_own_disbursement_open(p_idempotency_key,
    'imprest.settle_disbursement', v_actor, v_request, p_id, p_expected_version,
    coalesce(v_needs, 'handed_out'));
  if v_stop is not null then
    if v_stop ->> 'reason' = 'not_approved' then
      v_stop := jsonb_set(v_stop, '{reason}', '"not_handed_out"');
    end if;
    return v_stop;
  end if;

  select * into v_d from public.imprest_disbursements where id = p_id;
  select coalesce(max(cycle), 0) + 1 into v_cycle
    from public.imprest_settlements where disbursement_id = p_id;

  -- The approved amount is the original approval plus every raise (issue #70). Settling waits for a
  -- request to be decided and for a raise to be handed out, so the cash the lines explain is cash
  -- that left the tin.
  v_approved := private.imprest_approved_tzs(p_id);
  if exists (select 1 from public.imprest_approval_raises
              where disbursement_id = p_id and status in ('requested', 'raised')) then
    return jsonb_build_object('ok', false, 'reason', 'raise_not_handed_out');
  end if;

  if p_returned_tzs is null or p_returned_tzs < 0 or p_returned_tzs > v_approved then
    return jsonb_build_object('ok', false, 'reason',
      case when p_returned_tzs > v_approved then 'over_approval' else 'returned_invalid' end,
      'amount_tzs', v_approved, 'returned_tzs', p_returned_tzs);
  elsif p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    return jsonb_build_object('ok', false, 'reason', 'lines_invalid');
  elsif jsonb_array_length(p_lines) > 20 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_lines');
  end if;

  for v_line in select value from jsonb_array_elements(v_lines) loop
    v_i := v_i + 1;

    -- A missing key is null, and null slips past every comparison, so its type is required first.
    if coalesce(jsonb_typeof(v_line -> 'amount_tzs'), 'missing') <> 'number'
       or (v_line ->> 'amount_tzs')::numeric <> trunc((v_line ->> 'amount_tzs')::numeric)
       or (v_line ->> 'amount_tzs')::numeric <= 0
       or (v_line ->> 'amount_tzs')::numeric > 100000000 then
      return jsonb_build_object('ok', false, 'reason', 'line_amount_invalid', 'line', v_i);
    end if;
    v_amount := (v_line ->> 'amount_tzs')::bigint;

    v_purpose := coalesce(v_line ->> 'purpose', '');
    if length(v_purpose) < 2 or length(v_purpose) > 120 then
      return jsonb_build_object('ok', false, 'reason', 'line_purpose_invalid', 'line', v_i);
    end if;

    v_reason := nullif(v_line ->> 'no_receipt_reason', '');
    v_note := v_line ->> 'no_receipt_note';
    -- A receipt is GIVEN when the key holds anything but null, whatever its type, so a number
    -- cannot slip past the receipt-or-reason rule and then fail a cast at insert.
    v_given := coalesce(jsonb_typeof(v_line -> 'receipt_id'), 'null') <> 'null';

    if not v_given and v_reason is null then
      return jsonb_build_object('ok', false, 'reason', 'line_evidence_required', 'line', v_i);
    elsif v_given and (v_reason is not null or v_note is not null) then
      return jsonb_build_object('ok', false, 'reason', 'line_evidence_both', 'line', v_i);
    end if;

    v_receipt := null;
    if v_given then
      if jsonb_typeof(v_line -> 'receipt_id') <> 'string' then
        return jsonb_build_object('ok', false, 'reason', 'receipt_not_found', 'line', v_i);
      end if;
      begin
        v_receipt := (v_line ->> 'receipt_id')::uuid;
      exception when invalid_text_representation then
        return jsonb_build_object('ok', false, 'reason', 'receipt_not_found', 'line', v_i);
      end;
    end if;

    if v_reason is not null then
      if not (v_reason = any (enum_range(null::public.imprest_no_receipt_reason)::text[])) then
        return jsonb_build_object('ok', false, 'reason', 'no_receipt_reason_invalid', 'line', v_i);
      elsif private.imprest_text_problem(v_note,
              v_reason in ('receipt_lost_or_damaged', 'other')) then
        return jsonb_build_object('ok', false, 'reason', 'no_receipt_note_required', 'line', v_i);
      end if;
      v_none := v_none + 1;
    else
      -- THE PATH IS CHECKED, NEVER TRUSTED (issue #62 criterion 10). A receipt an earlier cycle of
      -- this disbursement cited may be cited again; only twice in the one cycle is refused.
      select * into v_rc from public.imprest_receipts where id = v_receipt;
      if not found then
        return jsonb_build_object('ok', false, 'reason', 'receipt_not_found', 'line', v_i);
      elsif v_rc.disbursement_id <> p_id
            or v_rc.object_path not like 'imprest/' || p_id::text || '/%' then
        return jsonb_build_object('ok', false, 'reason', 'receipt_wrong_disbursement', 'line', v_i);
      elsif v_rc.uploaded_by <> v_actor then
        return jsonb_build_object('ok', false, 'reason', 'receipt_not_yours', 'line', v_i);
      elsif v_receipt = any (v_seen) then
        return jsonb_build_object('ok', false, 'reason', 'receipt_cited_twice', 'line', v_i);
      end if;

      select o.owner_id into v_owner from storage.objects o
       where o.bucket_id = 'imprest-evidence' and o.name = v_rc.object_path;
      if not found then
        return jsonb_build_object('ok', false, 'reason', 'receipt_not_uploaded', 'line', v_i);
      elsif v_owner is distinct from v_actor::text then
        return jsonb_build_object('ok', false, 'reason', 'receipt_not_yours', 'line', v_i);
      end if;
      v_seen := v_seen || v_receipt;
    end if;

    v_used := v_used + v_amount;
  end loop;

  -- AC-100: the lines and the returned cash may not claim more than was approved.
  if v_used + p_returned_tzs > v_approved then
    return jsonb_build_object('ok', false, 'reason', 'over_approval', 'amount_tzs', v_approved,
                              'used_tzs', v_used, 'returned_tzs', p_returned_tzs);
  end if;

  v_remainder := v_approved - v_used - p_returned_tzs;
  if v_remainder > 0 and private.imprest_text_problem(v_explanation, true) then
    return jsonb_build_object('ok', false, 'reason', 'explanation_required',
                              'unaccounted_tzs', v_remainder);
  elsif v_remainder = 0 and v_explanation is not null then
    return jsonb_build_object('ok', false, 'reason', 'explanation_not_needed');
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'imprest.settle_disbursement', v_actor,
                               v_request, p_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  insert into public.imprest_settlements (id, disbursement_id, cycle, approved_tzs, used_tzs,
                                          returned_tzs, unaccounted_tzs, unaccounted_explanation,
                                          line_count, no_receipt_lines, settled_by)
  values (v_settlement, p_id, v_cycle, v_approved, v_used, p_returned_tzs, v_remainder,
          case when v_remainder > 0 then v_explanation end, v_i, v_none, v_actor);

  insert into public.imprest_settlement_lines (settlement_id, line_no, amount_tzs, purpose,
                                               receipt_id, no_receipt_reason, no_receipt_note)
  select v_settlement, n::integer, (e ->> 'amount_tzs')::bigint, e ->> 'purpose',
         (e ->> 'receipt_id')::uuid,
         (nullif(e ->> 'no_receipt_reason', ''))::public.imprest_no_receipt_reason,
         e ->> 'no_receipt_note'
    from jsonb_array_elements(v_lines) with ordinality as t(e, n);

  update public.imprest_disbursements
     set status = 'settled', version = version + 1
   where id = p_id;

  perform private.imprest_disbursement_audit(v_actor, 'imprest_disbursement_settled', p_id,
    jsonb_build_object('status', v_d.status),
    jsonb_build_object('status', 'settled', 'cycle', v_cycle, 'approved_tzs', v_approved,
                       'used_tzs', v_used, 'returned_tzs', p_returned_tzs,
                       'unaccounted_tzs', v_remainder, 'lines', v_i, 'no_receipt_lines', v_none,
                       'set_aside', true),
    'api.staff_settle_imprest_disbursement');

  return private.imprest_disbursement_result('settled', p_id);
end;
$$;

comment on function api.staff_settle_imprest_disbursement(uuid, integer, jsonb, bigint, text, text) is
  'The Cashier settles a handed-out disbursement, or settles again one sent back, as the next cycle: '
  'its lines, the cash returned, and an explanation for any remainder. Approved, raised approvals '
  'included, = Used + Returned + Not accounted for (issues #62, #65, #70). Refused while a raise is '
  'open.';

-- ---------------------------------------------------------------------------
-- Command helpers
-- ---------------------------------------------------------------------------
create or replace function private.imprest_raise_result(p_reason text, p_id uuid, p_raise uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.imprest_disbursement_result(p_reason, p_id)
         || jsonb_build_object('raise', (select to_jsonb(r) from public.imprest_approval_raises r
                                          where r.id = p_raise));
$$;

-- The shared opening of the three commands: the caller's own disbursement when it is the Cashier's
-- command, then replay or conflict on the key, the row locked, the version the caller was shown, and
-- a disbursement that is handed out or sent back.
create or replace function private.imprest_raise_open(
  p_key text, p_operation text, p_actor uuid, p_request jsonb, p_id uuid,
  p_expected_version integer, p_own boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.imprest_disbursement_status;
  v_stop   jsonb;
begin
  -- Another Cashier's disbursement is answered exactly as a missing one.
  if p_own and not exists (select 1 from public.imprest_disbursements
                            where id = p_id and proposed_by = p_actor) then
    return jsonb_build_object('ok', false, 'reason', 'no_disbursement');
  end if;

  -- The status read here only picks which of the two the shared opening demands; it locks the row
  -- and checks the version, so a status that moved in between has moved the version too.
  select status into v_status from public.imprest_disbursements where id = p_id;
  v_stop := private.imprest_disbursement_open(p_key, p_operation, p_actor, p_request, p_id,
    p_expected_version,
    (case when v_status = 'sent_back' then 'sent_back' else 'handed_out' end)::public.imprest_disbursement_status);
  if v_stop ->> 'reason' = 'not_approved' then
    v_stop := jsonb_set(v_stop, '{reason}', '"not_handed_out"');
  end if;
  return v_stop;
end;
$$;

comment on function private.imprest_raise_open(text, text, uuid, jsonb, uuid, integer, boolean) is
  'Replays or refuses a raised-approval command before it acts: not the caller''s own, key '
  'conflict, replay, missing row, stale version, or a disbursement that is not handed out or sent '
  'back. Returns null when the command may go on, holding the row lock.';

-- ---------------------------------------------------------------------------
-- Ask for more (the Cashier who proposed it)
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_request_imprest_raise(
  p_id uuid, p_expected_version integer, p_amount_tzs bigint, p_reason text,
  p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := private.acting_staff(array['cashier']::public.app_role[]);
  v_reason  text := private.normalise_label(p_reason);
  v_stop    jsonb;
  v_raise   uuid := gen_random_uuid();
  v_request jsonb := jsonb_build_object('id', p_id, 'expected_version', p_expected_version,
                                        'amount_tzs', p_amount_tzs, 'reason', v_reason);
begin
  v_stop := private.imprest_raise_open(p_idempotency_key, 'imprest.request_raise', v_actor,
    v_request, p_id, p_expected_version, true);
  if v_stop is not null then
    return v_stop;
  end if;

  if p_amount_tzs is null or p_amount_tzs <= 0 or p_amount_tzs > 100000000 then
    return jsonb_build_object('ok', false, 'reason', 'amount_invalid');
  elsif private.imprest_text_problem(v_reason, true) then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  elsif exists (select 1 from public.imprest_approval_raises
                 where disbursement_id = p_id and status in ('requested', 'raised')) then
    return jsonb_build_object('ok', false, 'reason', 'raise_open');
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'imprest.request_raise', v_actor, v_request,
                               p_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  insert into public.imprest_approval_raises (id, disbursement_id, raise_no, amount_tzs, reason,
                                              requested_by)
  select v_raise, p_id, coalesce(max(raise_no), 0) + 1, p_amount_tzs, v_reason, v_actor
    from public.imprest_approval_raises where disbursement_id = p_id;

  update public.imprest_disbursements set version = version + 1 where id = p_id;

  perform private.imprest_disbursement_audit(v_actor, 'imprest_raise_requested', p_id,
    jsonb_build_object('approved_tzs', private.imprest_approved_tzs(p_id)),
    jsonb_build_object('raise_id', v_raise, 'amount_tzs', p_amount_tzs, 'reason', v_reason,
                       'approved_tzs', private.imprest_approved_tzs(p_id), 'set_aside', false),
    'api.staff_request_imprest_raise');

  return private.imprest_raise_result('requested', p_id, v_raise);
end;
$$;

-- ---------------------------------------------------------------------------
-- Raise or refuse (the Manager). There is no amount: the increase is the one that was asked for.
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_decide_imprest_raise(
  p_id uuid, p_expected_version integer, p_raise_id uuid, p_raise boolean, p_reason text,
  p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := private.acting_staff(array['manager']::public.app_role[]);
  v_reason  text := private.normalise_label(p_reason);
  v_stop    jsonb;
  v_r       public.imprest_approval_raises%rowtype;
  v_fund    uuid;
  v_free    bigint;
  v_before  bigint;
  v_request jsonb := jsonb_build_object('id', p_id, 'expected_version', p_expected_version,
                                        'raise_id', p_raise_id, 'raise', p_raise,
                                        'reason', v_reason);
begin
  if p_raise is null then
    return jsonb_build_object('ok', false, 'reason', 'decision_required');
  end if;

  v_stop := private.imprest_raise_open(p_idempotency_key, 'imprest.decide_raise', v_actor,
    v_request, p_id, p_expected_version, false);
  if v_stop is not null then
    return v_stop;
  end if;

  select * into v_r from public.imprest_approval_raises
   where id = p_raise_id and disbursement_id = p_id and status = 'requested' for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_raise_request');
  elsif not p_raise and private.imprest_text_problem(v_reason, true) then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  v_before := private.imprest_approved_tzs(p_id);

  if p_raise then
    -- Serialised per fund with approvals, so a raise and an approval that both read the same Free
    -- to approve cannot both spend it.
    select fund_id into v_fund from public.imprest_disbursements where id = p_id;
    perform pg_advisory_xact_lock(hashtextextended('imprest_fund_spend:' || v_fund::text, 0));
    select s.free_to_approve_tzs into v_free from private.imprest_spending_figures(v_fund) s;
    if v_r.amount_tzs > v_free then
      return jsonb_build_object('ok', false, 'reason', 'insufficient_imprest',
                                'free_to_approve_tzs', v_free, 'amount_tzs', v_r.amount_tzs);
    end if;
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'imprest.decide_raise', v_actor, v_request,
                               p_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if p_raise then
    update public.imprest_approval_raises
       set status = 'raised', decided_by = v_actor, decided_at = now()
     where id = p_raise_id;
  else
    update public.imprest_approval_raises
       set status = 'refused', decided_by = v_actor, decided_at = now(), refusal_reason = v_reason
     where id = p_raise_id;
  end if;

  update public.imprest_disbursements set version = version + 1 where id = p_id;

  perform private.imprest_disbursement_audit(v_actor,
    case when p_raise then 'imprest_raise_raised' else 'imprest_raise_refused' end, p_id,
    jsonb_build_object('approved_tzs', v_before),
    jsonb_build_object('raise_id', p_raise_id, 'amount_tzs', v_r.amount_tzs,
                       'approved_tzs', private.imprest_approved_tzs(p_id),
                       'reason', nullif(v_reason, ''), 'set_aside', p_raise,
                       'free_to_approve_tzs', case when p_raise then v_free - v_r.amount_tzs end),
    'api.staff_decide_imprest_raise');

  return private.imprest_raise_result(case when p_raise then 'raised' else 'refused' end, p_id,
                                      p_raise_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Hand out the extra (the Cashier who proposed it). There is no amount: the raise goes out.
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_hand_out_imprest_raise(
  p_id uuid, p_expected_version integer, p_raise_id uuid, p_recipient text,
  p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor     uuid := private.acting_staff(array['cashier']::public.app_role[]);
  v_recipient text := private.normalise_label(p_recipient);
  v_stop      jsonb;
  v_r         public.imprest_approval_raises%rowtype;
  v_cycles    integer;
  v_request   jsonb := jsonb_build_object('id', p_id, 'expected_version', p_expected_version,
                                          'raise_id', p_raise_id, 'recipient', v_recipient);
begin
  v_stop := private.imprest_raise_open(p_idempotency_key, 'imprest.hand_out_raise', v_actor,
    v_request, p_id, p_expected_version, true);
  if v_stop is not null then
    return v_stop;
  end if;

  if length(v_recipient) < 2 or length(v_recipient) > 120 then
    return jsonb_build_object('ok', false, 'reason', 'recipient_invalid');
  end if;

  select * into v_r from public.imprest_approval_raises
   where id = p_raise_id and disbursement_id = p_id and status = 'raised' for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_raise_request');
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'imprest.hand_out_raise', v_actor, v_request,
                               p_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  select count(*)::integer into v_cycles from public.imprest_settlements where disbursement_id = p_id;

  update public.imprest_approval_raises
     set status = 'handed_out', handed_out_by = v_actor, handed_out_at = now(),
         recipient = v_recipient, after_cycle = v_cycles
   where id = p_raise_id;

  update public.imprest_disbursements set version = version + 1 where id = p_id;

  perform private.imprest_disbursement_audit(v_actor, 'imprest_raise_handed_out', p_id,
    jsonb_build_object('raise_id', p_raise_id, 'status', 'raised'),
    jsonb_build_object('raise_id', p_raise_id, 'status', 'handed_out', 'recipient', v_recipient,
                       'amount_tzs', v_r.amount_tzs, 'after_cycle', v_cycles, 'set_aside', true),
    'api.staff_hand_out_imprest_raise');

  return private.imprest_raise_result('handed_out', p_id, p_raise_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- The api surface: each wrapper commits a refusal to the audit trail
-- ---------------------------------------------------------------------------
create or replace function api.staff_request_imprest_raise(
  p_id uuid, p_expected_version integer, p_amount_tzs bigint, p_reason text,
  p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_request_imprest_raise(
  p_id, p_expected_version, p_amount_tzs, p_reason, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_request_imprest_raise', 'imprest_disbursement', p_id, v);
end $$;

comment on function api.staff_request_imprest_raise(uuid, integer, bigint, text, text) is
  'The Cashier asks for a raised approval on a handed-out or sent-back disbursement: a whole-shilling '
  'increase and a reason of 3 to 500 characters. One request is open at a time (issue #70).';

create or replace function api.staff_decide_imprest_raise(
  p_id uuid, p_expected_version integer, p_raise_id uuid, p_raise boolean, p_reason text,
  p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_decide_imprest_raise(
  p_id, p_expected_version, p_raise_id, p_raise, p_reason, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_decide_imprest_raise', 'imprest_disbursement', p_id, v);
end $$;

comment on function api.staff_decide_imprest_raise(uuid, integer, uuid, boolean, text, text) is
  'The Manager raises the approval by the amount asked, which sets it aside at once and is refused '
  'when Free to approve is short, or refuses the request with a reason (issue #70).';

create or replace function api.staff_hand_out_imprest_raise(
  p_id uuid, p_expected_version integer, p_raise_id uuid, p_recipient text,
  p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_hand_out_imprest_raise(
  p_id, p_expected_version, p_raise_id, p_recipient, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_hand_out_imprest_raise', 'imprest_disbursement', p_id, v);
end $$;

comment on function api.staff_hand_out_imprest_raise(uuid, integer, uuid, text, text) is
  'The Cashier records handing out a raised amount and who received it. Until then the extra is set '
  'aside but not awaiting verification (issue #70).';

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
            and p.proname in ('staff_request_imprest_raise', 'staff_decide_imprest_raise',
                              'staff_hand_out_imprest_raise'))
        or (n.nspname = 'private'
            and p.proname in ('guard_imprest_approval_raise', 'check_imprest_approval_raise_target',
                              'imprest_approved_tzs', 'check_imprest_settlement_target',
                              'imprest_spending_figures', 'imprest_awaiting_verification_tzs',
                              'impl_staff_settle_imprest_disbursement', 'imprest_raise_result',
                              'imprest_raise_open', 'impl_staff_request_imprest_raise',
                              'impl_staff_decide_imprest_raise', 'impl_staff_hand_out_imprest_raise'))
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
