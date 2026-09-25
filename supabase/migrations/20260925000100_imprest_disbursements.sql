-- Issue #55 · Imprest spending, part 1: propose and approve payments
--
-- product.md §13.1, §13.3 points 1 and 2, §13.4, and AC-96 to AC-99, AC-101 and AC-104. A Cashier
-- proposes a payment out of the one active imprest fund; the Manager approves it as it stands or
-- rejects it. Approval sets the amount aside, so the same cash can never be approved twice. The
-- Cashier may withdraw a proposal before the decision, and the Manager may cancel an approval
-- before payment, which frees the money again.
--
-- Part 2 (payment, receipts, verification, the Awaiting verification figure) is not here. Until it
-- lands an approved disbursement stays set aside until the Manager cancels it.
--
-- Source material was the archived `feat/stage-14-imprest-application` tag. Its expense table was
-- written for the old funding model and carried payment columns this part does not own, so only
-- the category list and the per-fund approval lock are taken from it.
--
--   imprest_disbursements   one row per proposal and what became of it. Each decision fills its
--                           own columns and none is ever overwritten, so a cancelled row still
--                           names its approver.
--
-- THE ONE FIGURE THAT MATTERS. Free to approve = posted imprest funding − what is set aside, where
-- set aside is the sum of the approved rows. It is calculated in `private.imprest_spending_figures`
-- and nowhere else, and it is never stored.

begin;

create type public.imprest_category as enum (
  'fuel_and_lubricants',
  'labour_and_casual_workers',
  'transport_and_delivery',
  'meals_and_staff_welfare',
  'materials_and_supplies',
  'repairs_and_maintenance',
  'utilities',
  'fees_and_charges',
  'other'
);

comment on type public.imprest_category is
  'The nine imprest spending categories of design.md §14.4.';

create type public.imprest_disbursement_status as enum (
  'proposed',   -- the Cashier asked. Moves no money and sets nothing aside (AC-96)
  'approved',   -- the Manager approved the proposed amount. It is set aside (AC-97)
  'rejected',   -- the Manager refused it, with a reason (§4.3). Nothing was set aside
  'withdrawn',  -- the Cashier took it back before a decision. Nothing was set aside
  'cancelled'   -- the Manager cancelled an approval before payment. The money is free again
);

comment on type public.imprest_disbursement_status is
  'The disbursement workflow of product.md §13.3 up to approval. Only `approved` sets money aside.';

-- ---------------------------------------------------------------------------
-- imprest_disbursements
-- ---------------------------------------------------------------------------
create table public.imprest_disbursements (
  id                   uuid primary key default gen_random_uuid(),
  disbursement_no      text not null unique,
  fund_id              uuid not null references public.imprest_funds (id) on delete restrict,
  status               public.imprest_disbursement_status not null default 'proposed',
  -- Every transition increments it. A command states the version it was shown and is refused
  -- when the disbursement has moved on since.
  version              integer not null default 1 check (version >= 1),
  amount_tzs           bigint not null check (amount_tzs > 0 and amount_tzs <= 100000000),
  category             public.imprest_category not null,
  purpose              text not null check (length(btrim(purpose)) between 3 and 120),
  proposed_by          uuid not null references public.profiles (id),
  proposed_at          timestamptz not null default now(),
  approved_by          uuid references public.profiles (id),
  approved_at          timestamptz,
  rejected_by          uuid references public.profiles (id),
  rejected_at          timestamptz,
  rejection_reason     text check (rejection_reason is null
                                   or length(btrim(rejection_reason)) between 3 and 500),
  withdrawn_at         timestamptz,
  withdrawal_reason    text check (withdrawal_reason is null
                                   or length(btrim(withdrawal_reason)) between 3 and 500),
  cancelled_by         uuid references public.profiles (id),
  cancelled_at         timestamptz,
  cancellation_reason  text check (cancellation_reason is null
                                   or length(btrim(cancellation_reason)) between 3 and 500),
  constraint disbursement_approval_shape check (
    (status in ('approved', 'cancelled')) = (approved_by is not null)
    and (approved_by is null) = (approved_at is null)
  ),
  constraint disbursement_rejection_shape check (
    (status = 'rejected') = (rejected_by is not null)
    and (rejected_by is null) = (rejected_at is null)
    and (rejected_by is null) = (rejection_reason is null)
  ),
  constraint disbursement_withdrawal_shape check (
    (status = 'withdrawn') = (withdrawn_at is not null)
    and (withdrawn_at is null) = (withdrawal_reason is null)
  ),
  constraint disbursement_cancellation_shape check (
    (status = 'cancelled') = (cancelled_by is not null)
    and (cancelled_by is null) = (cancelled_at is null)
    and (cancelled_by is null) = (cancellation_reason is null)
  )
);

comment on table public.imprest_disbursements is
  'One proposed payment out of the imprest fund (product.md §13.3). An approved row sets its '
  'amount aside; every other status sets nothing aside.';

create index imprest_disbursements_fund_idx     on public.imprest_disbursements (fund_id, status);
create index imprest_disbursements_status_idx   on public.imprest_disbursements (status, proposed_at desc);
create index imprest_disbursements_proposed_idx on public.imprest_disbursements (proposed_by, proposed_at desc);
create index imprest_disbursements_approved_idx on public.imprest_disbursements (approved_by);
create index imprest_disbursements_rejected_idx on public.imprest_disbursements (rejected_by);
create index imprest_disbursements_cancelled_idx on public.imprest_disbursements (cancelled_by);

create or replace function private.guard_imprest_disbursement_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'imprest disbursement % cannot be deleted', old.id
      using errcode = 'restrict_violation';
  end if;

  if old.status in ('rejected', 'withdrawn', 'cancelled') then
    raise exception 'imprest disbursement % is % and final', old.id, old.status
      using errcode = 'restrict_violation';
  end if;

  if new.id is distinct from old.id
     or new.disbursement_no is distinct from old.disbursement_no
     or new.fund_id is distinct from old.fund_id
     or new.amount_tzs is distinct from old.amount_tzs
     or new.category is distinct from old.category
     or new.purpose is distinct from old.purpose
     or new.proposed_by is distinct from old.proposed_by
     or new.proposed_at is distinct from old.proposed_at
     or (old.approved_by is not null
         and (new.approved_by is distinct from old.approved_by
              or new.approved_at is distinct from old.approved_at)) then
    raise exception 'imprest disbursement % keeps what was proposed and approved', old.id
      using errcode = 'restrict_violation';
  end if;

  if new.version <> old.version + 1 then
    raise exception 'imprest disbursement % moves one version at a time', old.id
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

comment on function private.guard_imprest_disbursement_update() is
  'A disbursement moves forward one version per transition, never changes what was proposed or '
  'who approved it, and is final once rejected, withdrawn or cancelled. Refuses deletion.';

alter function private.guard_imprest_disbursement_update() owner to fv_definer_owner;
revoke execute on function private.guard_imprest_disbursement_update()
  from public, anon, authenticated, service_role;

create trigger imprest_disbursements_guard
  before update or delete on public.imprest_disbursements
  for each row execute function private.guard_imprest_disbursement_update();

-- ---------------------------------------------------------------------------
-- Grants and row-level security
--
-- A Director and the Manager read every disbursement. A Cashier reads only their own. A Sales
-- Representative reads none. Writes go through the api commands alone.
-- ---------------------------------------------------------------------------
alter table public.imprest_disbursements enable row level security;

revoke all on public.imprest_disbursements from public, anon, authenticated, service_role;
grant select on public.imprest_disbursements to authenticated;
grant select, insert, update on public.imprest_disbursements to fv_definer_owner;

create policy imprest_disbursements_select on public.imprest_disbursements
  for select to authenticated
  using ((select private.authorize(array['director', 'manager']::public.app_role[]))
         or ((select private.authorize(array['cashier']::public.app_role[]))
             and proposed_by = (select auth.uid())));

create policy imprest_disbursements_definer_owner on public.imprest_disbursements
  for all to fv_definer_owner using (true) with check (true);

-- Disbursement numbers join the daily document numbering.
do $$
declare
  v_definition text := (
    select pg_get_constraintdef(c.oid)
      from pg_constraint c
      join pg_class t     on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'document_sequences'
       and c.conname = 'document_sequences_kind_check');
  v_kind text;
begin
  if v_definition is null then
    raise exception 'public.document_sequences has no document_sequences_kind_check to extend';
  end if;
  foreach v_kind in array array['order', 'proforma', 'invoice', 'batch', 'imprest'] loop
    if position('''' || v_kind || '''' in v_definition) = 0 then
      raise exception 'the released numbering permits % and this migration would drop it: %',
        v_kind, v_definition;
    end if;
  end loop;
end
$$;

alter table public.document_sequences drop constraint document_sequences_kind_check;
alter table public.document_sequences
  add constraint document_sequences_kind_check
  check (kind in ('order', 'proforma', 'invoice', 'batch', 'imprest', 'disbursement'));

-- ---------------------------------------------------------------------------
-- The figures, calculated in one place
-- ---------------------------------------------------------------------------
create or replace function private.imprest_spending_figures(p_fund_id uuid)
returns table (posted_funding_tzs bigint, set_aside_tzs bigint, free_to_approve_tzs bigint)
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
  ), aside as (
    select coalesce(sum(d.amount_tzs), 0)::bigint as tzs
      from public.imprest_disbursements d
     where d.fund_id = p_fund_id and d.status = 'approved'
  )
  select posted.tzs, aside.tzs, posted.tzs - aside.tzs from posted, aside;
$$;

comment on function private.imprest_spending_figures(uuid) is
  'Posted imprest funding, what approved disbursements set aside, and the difference: Free to '
  'approve (AC-99). Calculated on every read, never stored.';

create or replace function api.staff_imprest_spending_position()
returns table (fund_id uuid, posted_funding_tzs bigint, set_aside_tzs bigint,
               free_to_approve_tzs bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.acting_staff(array['director', 'manager', 'cashier']::public.app_role[]);
  v_role  public.app_role := private.live_role_of(v_actor);
begin
  -- No active fund returns no row, so a screen can tell "nothing yet" from a read that failed.
  return query
    select fu.id,
           case when v_role = 'cashier' then null else s.posted_funding_tzs end,
           case when v_role = 'cashier' then null else s.set_aside_tzs end,
           s.free_to_approve_tzs
      from public.imprest_funds fu
      cross join lateral private.imprest_spending_figures(fu.id) s
     where fu.is_active;
end;
$$;

comment on function api.staff_imprest_spending_position() is
  'The spending figures of the active fund. A Director and the Manager see all three; a Cashier '
  'sees only Free to approve. A Cashier reads only their own disbursements, so the whole-fund '
  'figure has to be calculated here rather than from what they can see.';

-- ---------------------------------------------------------------------------
-- Command helpers
-- ---------------------------------------------------------------------------
create or replace function private.imprest_disbursement_result(p_reason text, p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('ok', true, 'reason', p_reason,
                            'disbursement', (select to_jsonb(d) from public.imprest_disbursements d
                                              where d.id = p_id));
$$;

create or replace function private.imprest_disbursement_audit(
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
  values (p_actor, private.live_role_of(p_actor), false, p_action, 'imprest_disbursement', p_id,
          p_before, p_after, gen_random_uuid(), p_source);
$$;

-- The shared opening of every command after the proposal: replay or conflict on the key, the row
-- locked, the version the caller was shown, and the status the command needs.
create or replace function private.imprest_disbursement_open(
  p_key text, p_operation text, p_actor uuid, p_request jsonb, p_id uuid,
  p_expected_version integer, p_needs public.imprest_disbursement_status)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_class jsonb;
  v_d     public.imprest_disbursements%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_key, ''), 0));
  v_class := private.classify_idempotency_key(p_key, p_operation, p_actor, p_request);
  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  elsif v_class ->> 'status' = 'replay' then
    return private.imprest_disbursement_result('replayed', p_id);
  end if;

  select * into v_d from public.imprest_disbursements where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_disbursement');
  elsif v_d.version is distinct from p_expected_version then
    return jsonb_build_object('ok', false, 'reason', 'stale', 'version', v_d.version,
                              'status', v_d.status::text);
  elsif v_d.status <> p_needs then
    return jsonb_build_object('ok', false,
      'reason', case when p_needs = 'proposed' then 'not_awaiting_decision' else 'not_approved' end,
      'status', v_d.status::text);
  end if;

  return null;
end;
$$;

comment on function private.imprest_disbursement_open(text, text, uuid, jsonb, uuid, integer,
                                                      public.imprest_disbursement_status) is
  'Replays or refuses a disbursement command before it acts: key conflict, replay, missing row, '
  'stale version or wrong status. Returns null when the command may go on, holding the row lock.';

-- ---------------------------------------------------------------------------
-- Propose (Cashier)
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_propose_imprest_disbursement(
  p_amount_tzs bigint, p_category text, p_purpose text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := private.acting_staff(array['cashier']::public.app_role[]);
  v_purpose text := private.normalise_label(p_purpose);
  v_id      uuid := gen_random_uuid();
  v_fund    uuid;
  v_class   jsonb;
  v_request jsonb := jsonb_build_object('amount_tzs', p_amount_tzs, 'category', p_category,
                                        'purpose', v_purpose);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));
  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'imprest.propose_disbursement', v_actor, v_request);
  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  elsif v_class ->> 'status' = 'replay' then
    return private.imprest_disbursement_result('replayed', (v_class ->> 'result_ref')::uuid);
  end if;

  if p_amount_tzs is null or p_amount_tzs <= 0 or p_amount_tzs > 100000000 then
    return jsonb_build_object('ok', false, 'reason', 'amount_invalid');
  elsif p_category is null
        or not (p_category = any (enum_range(null::public.imprest_category)::text[])) then
    return jsonb_build_object('ok', false, 'reason', 'category_invalid');
  elsif length(v_purpose) < 3 or length(v_purpose) > 120 then
    return jsonb_build_object('ok', false, 'reason', 'purpose_required');
  end if;

  select id into v_fund from public.imprest_funds where is_active;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_fund');
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'imprest.propose_disbursement', v_actor,
                               v_request, v_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  insert into public.imprest_disbursements (id, disbursement_no, fund_id, amount_tzs, category,
                                            purpose, proposed_by)
  values (v_id, private.next_document_number('disbursement', 'FV-DSB'), v_fund, p_amount_tzs,
          p_category::public.imprest_category, v_purpose, v_actor);

  perform private.imprest_disbursement_audit(v_actor, 'imprest_disbursement_proposed', v_id, null,
    jsonb_build_object('status', 'proposed', 'amount_tzs', p_amount_tzs, 'category', p_category,
                       'set_aside', false),
    'api.staff_propose_imprest_disbursement');

  return private.imprest_disbursement_result('proposed', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Approve or reject (Manager). There is no amount: the proposal is approved as it stands.
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_decide_imprest_disbursement(
  p_id uuid, p_expected_version integer, p_approve boolean, p_reason text,
  p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := private.acting_staff(array['manager']::public.app_role[]);
  v_reason  text := private.normalise_label(p_reason);
  v_d       public.imprest_disbursements%rowtype;
  v_free    bigint;
  v_stop    jsonb;
  v_request jsonb := jsonb_build_object('id', p_id, 'expected_version', p_expected_version,
                                        'approve', p_approve, 'reason', v_reason);
begin
  if p_approve is null then
    return jsonb_build_object('ok', false, 'reason', 'decision_required');
  end if;

  v_stop := private.imprest_disbursement_open(p_idempotency_key, 'imprest.decide_disbursement',
    v_actor, v_request, p_id, p_expected_version, 'proposed');
  if v_stop is not null then
    return v_stop;
  end if;

  if private.imprest_text_problem(v_reason, not p_approve) then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  select * into v_d from public.imprest_disbursements where id = p_id;

  if p_approve then
    -- Serialised per fund. This is what makes AC-104 true: a second approval waits here and then
    -- reads what the first one set aside, not the figures they both started from.
    perform pg_advisory_xact_lock(hashtextextended('imprest_fund_spend:' || v_d.fund_id::text, 0));
    select s.free_to_approve_tzs into v_free from private.imprest_spending_figures(v_d.fund_id) s;
    if v_d.amount_tzs > v_free then
      return jsonb_build_object('ok', false, 'reason', 'insufficient_imprest',
                                'free_to_approve_tzs', v_free, 'amount_tzs', v_d.amount_tzs);
    end if;
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'imprest.decide_disbursement', v_actor,
                               v_request, p_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if p_approve then
    update public.imprest_disbursements
       set status = 'approved', version = version + 1, approved_by = v_actor, approved_at = now()
     where id = p_id;
  else
    update public.imprest_disbursements
       set status = 'rejected', version = version + 1, rejected_by = v_actor, rejected_at = now(),
           rejection_reason = v_reason
     where id = p_id;
  end if;

  perform private.imprest_disbursement_audit(v_actor,
    case when p_approve then 'imprest_disbursement_approved' else 'imprest_disbursement_rejected' end,
    p_id, jsonb_build_object('status', 'proposed'),
    jsonb_build_object('status', case when p_approve then 'approved' else 'rejected' end,
                       'amount_tzs', v_d.amount_tzs, 'reason', nullif(v_reason, ''),
                       'set_aside', p_approve,
                       'free_to_approve_tzs', case when p_approve then v_free - v_d.amount_tzs end),
    'api.staff_decide_imprest_disbursement');

  return private.imprest_disbursement_result(
    case when p_approve then 'approved' else 'rejected' end, p_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Withdraw (the Cashier who proposed it)
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_withdraw_imprest_disbursement(
  p_id uuid, p_expected_version integer, p_reason text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := private.acting_staff(array['cashier']::public.app_role[]);
  v_reason  text := private.normalise_label(p_reason);
  v_stop    jsonb;
  v_request jsonb := jsonb_build_object('id', p_id, 'expected_version', p_expected_version,
                                        'reason', v_reason);
begin
  -- Another Cashier's proposal is answered exactly as a missing one, so its existence is not
  -- disclosed to somebody who may not read it.
  if not exists (select 1 from public.imprest_disbursements
                  where id = p_id and proposed_by = v_actor) then
    return jsonb_build_object('ok', false, 'reason', 'no_disbursement');
  end if;

  v_stop := private.imprest_disbursement_open(p_idempotency_key, 'imprest.withdraw_disbursement',
    v_actor, v_request, p_id, p_expected_version, 'proposed');
  if v_stop is not null then
    return v_stop;
  end if;

  if private.imprest_text_problem(v_reason, true) then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'imprest.withdraw_disbursement', v_actor,
                               v_request, p_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  update public.imprest_disbursements
     set status = 'withdrawn', version = version + 1, withdrawn_at = now(),
         withdrawal_reason = v_reason
   where id = p_id;

  perform private.imprest_disbursement_audit(v_actor, 'imprest_disbursement_withdrawn', p_id,
    jsonb_build_object('status', 'proposed'),
    jsonb_build_object('status', 'withdrawn', 'reason', v_reason, 'set_aside', false),
    'api.staff_withdraw_imprest_disbursement');

  return private.imprest_disbursement_result('withdrawn', p_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Cancel an approval before payment (Manager). Frees the money set aside.
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_cancel_imprest_disbursement(
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
  v_amount  bigint;
  v_request jsonb := jsonb_build_object('id', p_id, 'expected_version', p_expected_version,
                                        'reason', v_reason);
begin
  v_stop := private.imprest_disbursement_open(p_idempotency_key, 'imprest.cancel_disbursement',
    v_actor, v_request, p_id, p_expected_version, 'approved');
  if v_stop is not null then
    return v_stop;
  end if;

  if private.imprest_text_problem(v_reason, true) then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'imprest.cancel_disbursement', v_actor,
                               v_request, p_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  update public.imprest_disbursements
     set status = 'cancelled', version = version + 1, cancelled_by = v_actor,
         cancelled_at = now(), cancellation_reason = v_reason
   where id = p_id
  returning amount_tzs into v_amount;

  perform private.imprest_disbursement_audit(v_actor, 'imprest_disbursement_cancelled', p_id,
    jsonb_build_object('status', 'approved', 'set_aside', true),
    jsonb_build_object('status', 'cancelled', 'reason', v_reason, 'set_aside', false,
                       'freed_tzs', v_amount),
    'api.staff_cancel_imprest_disbursement');

  return private.imprest_disbursement_result('cancelled', p_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- The api surface: each wrapper commits a refusal to the audit trail
-- ---------------------------------------------------------------------------
create or replace function api.staff_propose_imprest_disbursement(
  p_amount_tzs bigint, p_category text, p_purpose text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_propose_imprest_disbursement(
  p_amount_tzs, p_category, p_purpose, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_propose_imprest_disbursement', 'imprest_disbursement', null, v);
end $$;

comment on function api.staff_propose_imprest_disbursement(bigint, text, text, text) is
  'The Cashier proposes a payment out of the imprest fund (§13.3 point 1). Sets nothing aside.';

create or replace function api.staff_decide_imprest_disbursement(
  p_id uuid, p_expected_version integer, p_approve boolean, p_reason text,
  p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_decide_imprest_disbursement(
  p_id, p_expected_version, p_approve, p_reason, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_decide_imprest_disbursement', 'imprest_disbursement', p_id, v);
end $$;

comment on function api.staff_decide_imprest_disbursement(uuid, integer, boolean, text, text) is
  'The Manager approves a proposal as it stands, which sets it aside, or rejects it with a reason. '
  'An approval above Free to approve is refused (§13.4, AC-97, AC-98).';

create or replace function api.staff_withdraw_imprest_disbursement(
  p_id uuid, p_expected_version integer, p_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_withdraw_imprest_disbursement(
  p_id, p_expected_version, p_reason, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_withdraw_imprest_disbursement', 'imprest_disbursement', p_id, v);
end $$;

comment on function api.staff_withdraw_imprest_disbursement(uuid, integer, text, text) is
  'The Cashier withdraws their own proposal before the Manager decides it, with a reason.';

create or replace function api.staff_cancel_imprest_disbursement(
  p_id uuid, p_expected_version integer, p_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_cancel_imprest_disbursement(
  p_id, p_expected_version, p_reason, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_cancel_imprest_disbursement', 'imprest_disbursement', p_id, v);
end $$;

comment on function api.staff_cancel_imprest_disbursement(uuid, integer, text, text) is
  'The Manager cancels an approval before payment, with a reason. Frees the money (AC-101).';

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
            and (p.proname like '%imprest\_disbursement' or p.proname = 'staff_imprest_spending_position'))
        or (n.nspname = 'private'
            and (p.proname like '%imprest\_disbursement%' or p.proname = 'imprest_spending_figures'))
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

commit;
