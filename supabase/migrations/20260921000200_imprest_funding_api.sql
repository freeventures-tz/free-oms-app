-- Issue #48 · Imprest funding commands
--
-- Seven commands, and the authority on each is product.md §4.1 and §13.2:
--
--   staff_request_imprest_funding     Manager   asks for cash
--   admin_decide_imprest_funding      Director  approves an amount, or rejects with a reason
--   admin_increase_imprest_approval   Director  raises the approval before a larger handover
--   admin_record_imprest_provided     Director  Imprest Provided: the amount actually handed over
--   staff_confirm_imprest_received    Manager   Cash Received: confirms the DISPLAYED handover
--   staff_report_imprest_mismatch     Manager   Report mismatch: what was actually counted
--   admin_resolve_imprest_mismatch    Director  a corrected handover, with its explanation
--
-- THREE RULES EVERY COMMAND FOLLOWS.
--
-- 1. Authority first. `acting_staff` and `acting_director` RAISE for a missing, disabled, changed
--    or unconfirmed-password caller, so nothing is written and nothing claims to have been audited.
--    No command takes an actor parameter.
--
-- 2. The version the caller was shown. Every command after the request states the funding version
--    it acted on and is refused as `stale` when the funding has moved since. Confirmation and
--    mismatch also name the handover on screen. All writers take the funding row FOR UPDATE, so
--    two Directors deciding at once, or a confirmation racing a correction, serialise: the second
--    finds a new version and loses its authority.
--
-- 3. Idempotency covers every material input. The stored request includes the version, amounts,
--    reasons, notes and explanations, so a retry replays and a changed retry is a conflict.
--
-- Each command lives in `private` under an `impl_` name behind a thin `api` wrapper that commits
-- any `ok: false` result to the audit trail through `private.refuse`, the helper the stock and
-- production commands use (migration 20260823000100).

begin;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function private.active_imprest_fund(p_opened_by uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  -- Two first requests at once would each find no fund. The lock makes the second wait until the
  -- first commits, and its next statement then sees the fund the first one opened.
  perform pg_advisory_xact_lock(hashtextextended('imprest:active_fund', 0));
  select id into v_id from public.imprest_funds where is_active;
  if found then
    return v_id;
  end if;
  insert into public.imprest_funds (opened_by) values (p_opened_by) returning id into v_id;
  return v_id;
end;
$$;

comment on function private.active_imprest_fund(uuid) is
  'The single active imprest fund, opened by the first funding request under an advisory lock so '
  'that concurrent first requests share one fund.';

create or replace function private.imprest_funding_result(p_reason text, p_funding_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('ok', true, 'reason', p_reason,
                            'funding', (select to_jsonb(s) from public.imprest_funding_summaries s
                                         where s.id = p_funding_id));
$$;

comment on function private.imprest_funding_result(text, uuid) is
  'A successful imprest funding result: the reason and the funding as the summary view shows it.';

-- Claims the key, or reports what an earlier holder of it did: 'claimed', 'replay' or 'conflict'.
create or replace function private.imprest_claim_key(
  p_key text, p_operation text, p_actor uuid, p_request jsonb, p_ref uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claimed integer;
begin
  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_key, p_operation, p_ref, p_actor, p_request)
  on conflict (key) do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 1 then
    return 'claimed';
  end if;
  return private.classify_idempotency_key(p_key, p_operation, p_actor, p_request) ->> 'status';
end;
$$;

comment on function private.imprest_claim_key(text, text, uuid, jsonb, uuid) is
  'Claims an idempotency key for an imprest funding command, or classifies the earlier claim.';

create or replace function private.imprest_text_problem(p_value text, p_required boolean)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null or p_value = '' then p_required
    else length(p_value) < 3 or length(p_value) > 500
  end;
$$;

comment on function private.imprest_text_problem(text, boolean) is
  'True when a normalised reason, note or explanation is missing (and required) or outside the '
  '3 to 500 characters the tables accept.';

create or replace function private.imprest_audit(
  p_actor uuid, p_action text, p_funding_id uuid, p_before jsonb, p_after jsonb, p_source text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (p_actor, private.live_role_of(p_actor), false, p_action, 'imprest_funding', p_funding_id,
          p_before, p_after, gen_random_uuid(), p_source);
$$;

comment on function private.imprest_audit(uuid, text, uuid, jsonb, jsonb, text) is
  'Writes the success audit row of an imprest funding transition.';

-- ---------------------------------------------------------------------------
-- Request
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_request_imprest_funding(
  p_amount_tzs bigint, p_reason text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := private.acting_staff(array['manager']::public.app_role[]);
  v_reason  text := private.normalise_label(p_reason);
  v_id      uuid := gen_random_uuid();
  v_class   jsonb;
  v_request jsonb := jsonb_build_object('amount_tzs', p_amount_tzs, 'reason', v_reason);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));
  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'imprest.request_funding', v_actor, v_request);
  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  elsif v_class ->> 'status' = 'replay' then
    return private.imprest_funding_result('replayed', (v_class ->> 'result_ref')::uuid);
  end if;

  if p_amount_tzs is null or p_amount_tzs <= 0 or p_amount_tzs > 100000000 then
    return jsonb_build_object('ok', false, 'reason', 'amount_invalid');
  end if;
  if private.imprest_text_problem(v_reason, true) then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  case private.imprest_claim_key(p_idempotency_key, 'imprest.request_funding', v_actor, v_request, v_id)
    when 'claimed' then null;
    when 'replay' then
      return private.imprest_funding_result('replayed',
        (private.classify_idempotency_key(p_idempotency_key, 'imprest.request_funding', v_actor,
                                          v_request) ->> 'result_ref')::uuid);
    else
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end case;

  insert into public.imprest_fundings (id, funding_no, fund_id, requested_amount_tzs, reason,
                                       requested_by)
  values (v_id, private.next_document_number('imprest', 'FV-IMP'),
          private.active_imprest_fund(v_actor), p_amount_tzs, v_reason, v_actor);

  perform private.imprest_audit(v_actor, 'imprest_funding_requested', v_id, null,
    jsonb_build_object('status', 'requested', 'requested_amount_tzs', p_amount_tzs,
                       'posted', false),
    'api.staff_request_imprest_funding');

  return private.imprest_funding_result('requested', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Approve or reject
-- ---------------------------------------------------------------------------
create or replace function private.impl_admin_decide_imprest_funding(
  p_funding_id uuid, p_expected_version integer, p_approve boolean, p_amount_tzs bigint,
  p_reason text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := private.acting_director();
  v_reason  text := private.normalise_label(p_reason);
  v_f       public.imprest_fundings%rowtype;
  v_class   jsonb;
  v_request jsonb := jsonb_build_object(
    'funding_id', p_funding_id, 'expected_version', p_expected_version, 'approve', p_approve,
    'amount_tzs', p_amount_tzs, 'reason', v_reason);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));
  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'imprest.decide_funding', v_actor, v_request);
  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  elsif v_class ->> 'status' = 'replay' then
    return private.imprest_funding_result('replayed', p_funding_id);
  end if;

  if p_approve is null then
    return jsonb_build_object('ok', false, 'reason', 'decision_required');
  elsif p_approve and (p_amount_tzs is null or p_amount_tzs <= 0 or p_amount_tzs > 100000000) then
    return jsonb_build_object('ok', false, 'reason', 'amount_invalid');
  elsif private.imprest_text_problem(v_reason, not p_approve) then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  select * into v_f from public.imprest_fundings where id = p_funding_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_funding');
  elsif v_f.version is distinct from p_expected_version then
    return jsonb_build_object('ok', false, 'reason', 'stale', 'version', v_f.version,
                              'status', v_f.status::text);
  elsif v_f.status <> 'requested' then
    return jsonb_build_object('ok', false, 'reason', 'not_awaiting_decision',
                              'status', v_f.status::text);
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'imprest.decide_funding', v_actor, v_request,
                               p_funding_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if p_approve then
    insert into public.imprest_funding_approvals (funding_id, sequence, amount_tzs, note, approved_by)
    values (p_funding_id, 1, p_amount_tzs, nullif(v_reason, ''), v_actor);
    update public.imprest_fundings
       set status = 'approved', version = version + 1
     where id = p_funding_id;
  else
    update public.imprest_fundings
       set status = 'rejected', version = version + 1, rejected_by = v_actor, rejected_at = now(),
           rejection_reason = v_reason
     where id = p_funding_id;
  end if;

  perform private.imprest_audit(v_actor,
    case when p_approve then 'imprest_funding_approved' else 'imprest_funding_rejected' end,
    p_funding_id, jsonb_build_object('status', 'requested'),
    jsonb_build_object('status', case when p_approve then 'approved' else 'rejected' end,
                       'approved_amount_tzs', case when p_approve then p_amount_tzs end,
                       'reason', nullif(v_reason, ''), 'posted', false),
    'api.admin_decide_imprest_funding');

  return private.imprest_funding_result(
    case when p_approve then 'approved' else 'rejected' end, p_funding_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Approval increase
-- ---------------------------------------------------------------------------
create or replace function private.impl_admin_increase_imprest_approval(
  p_funding_id uuid, p_expected_version integer, p_amount_tzs bigint, p_note text,
  p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := private.acting_director();
  v_note    text := private.normalise_label(p_note);
  v_f       public.imprest_fundings%rowtype;
  v_current public.imprest_funding_approvals%rowtype;
  v_class   jsonb;
  v_request jsonb := jsonb_build_object(
    'funding_id', p_funding_id, 'expected_version', p_expected_version,
    'amount_tzs', p_amount_tzs, 'note', v_note);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));
  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'imprest.increase_approval', v_actor, v_request);
  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  elsif v_class ->> 'status' = 'replay' then
    return private.imprest_funding_result('replayed', p_funding_id);
  end if;

  if p_amount_tzs is null or p_amount_tzs <= 0 or p_amount_tzs > 100000000 then
    return jsonb_build_object('ok', false, 'reason', 'amount_invalid');
  elsif private.imprest_text_problem(v_note, false) then
    return jsonb_build_object('ok', false, 'reason', 'note_invalid');
  end if;

  select * into v_f from public.imprest_fundings where id = p_funding_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_funding');
  elsif v_f.version is distinct from p_expected_version then
    return jsonb_build_object('ok', false, 'reason', 'stale', 'version', v_f.version,
                              'status', v_f.status::text);
  elsif v_f.status not in ('approved', 'disputed') then
    -- Before a handover, or while a correction is being worked out. Not while a handover awaits
    -- the Manager, and never after receipt.
    return jsonb_build_object('ok', false, 'reason', 'not_open_for_approval_change',
                              'status', v_f.status::text);
  end if;

  select * into v_current from public.imprest_funding_approvals
   where funding_id = p_funding_id order by sequence desc limit 1;
  if p_amount_tzs <= v_current.amount_tzs then
    return jsonb_build_object('ok', false, 'reason', 'increase_not_higher',
                              'approved_amount_tzs', v_current.amount_tzs);
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'imprest.increase_approval', v_actor, v_request,
                               p_funding_id) <> 'claimed' then
    -- Under the key lock a second claim can only find this same request, already committed.
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  insert into public.imprest_funding_approvals (funding_id, sequence, amount_tzs, note, approved_by)
  values (p_funding_id, v_current.sequence + 1, p_amount_tzs, nullif(v_note, ''), v_actor);
  update public.imprest_fundings set version = version + 1 where id = p_funding_id;

  perform private.imprest_audit(v_actor, 'imprest_funding_approval_increased', p_funding_id,
    jsonb_build_object('approved_amount_tzs', v_current.amount_tzs),
    jsonb_build_object('approved_amount_tzs', p_amount_tzs, 'sequence', v_current.sequence + 1,
                       'note', nullif(v_note, ''), 'posted', false),
    'api.admin_increase_imprest_approval');

  return private.imprest_funding_result('approval_increased', p_funding_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Imprest Provided, and the corrected handover after a mismatch
--
-- One body for both, because they are the same fact — a Director recording cash handed to the
-- Manager, inside the current approval — and differ only in the state they start from and in
-- whether an explanation is owed.
-- ---------------------------------------------------------------------------
create or replace function private.imprest_record_handover(
  p_funding_id uuid, p_expected_version integer, p_amount_tzs bigint, p_explanation text,
  p_idempotency_key text, p_correction boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := private.acting_director();
  v_expl    text := private.normalise_label(p_explanation);
  v_op      text := case when p_correction then 'imprest.correct_handover'
                         else 'imprest.record_provided' end;
  v_f       public.imprest_fundings%rowtype;
  v_limit   bigint;
  v_cycle   integer;
  v_class   jsonb;
  v_request jsonb := jsonb_build_object(
    'funding_id', p_funding_id, 'expected_version', p_expected_version,
    'amount_tzs', p_amount_tzs, 'explanation', v_expl);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));
  v_class := private.classify_idempotency_key(p_idempotency_key, v_op, v_actor, v_request);
  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  elsif v_class ->> 'status' = 'replay' then
    return private.imprest_funding_result('replayed', p_funding_id);
  end if;

  if p_amount_tzs is null or p_amount_tzs <= 0 or p_amount_tzs > 100000000 then
    return jsonb_build_object('ok', false, 'reason', 'amount_invalid');
  elsif p_correction and private.imprest_text_problem(v_expl, true) then
    return jsonb_build_object('ok', false, 'reason', 'explanation_required');
  end if;

  select * into v_f from public.imprest_fundings where id = p_funding_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_funding');
  elsif v_f.version is distinct from p_expected_version then
    return jsonb_build_object('ok', false, 'reason', 'stale', 'version', v_f.version,
                              'status', v_f.status::text);
  elsif p_correction and v_f.status <> 'disputed' then
    return jsonb_build_object('ok', false, 'reason', 'not_in_dispute', 'status', v_f.status::text);
  elsif not p_correction and v_f.status <> 'approved' then
    return jsonb_build_object('ok', false, 'reason', 'not_awaiting_provision',
                              'status', v_f.status::text);
  end if;

  select amount_tzs into v_limit from public.imprest_funding_approvals
   where funding_id = p_funding_id order by sequence desc limit 1;
  if p_amount_tzs > v_limit then
    -- More than approved needs a recorded approval increase FIRST (exception 9).
    return jsonb_build_object('ok', false, 'reason', 'exceeds_approval',
                              'approved_amount_tzs', v_limit, 'amount_tzs', p_amount_tzs);
  end if;

  if private.imprest_claim_key(p_idempotency_key, v_op, v_actor, v_request, p_funding_id)
     <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  select coalesce(max(cycle), 0) + 1 into v_cycle
    from public.imprest_funding_handovers where funding_id = p_funding_id;

  insert into public.imprest_funding_handovers (funding_id, cycle, amount_tzs, explanation,
                                                provided_by)
  values (p_funding_id, v_cycle, p_amount_tzs,
          case when p_correction then v_expl end, v_actor);
  update public.imprest_fundings set status = 'provided', version = version + 1
   where id = p_funding_id;

  perform private.imprest_audit(v_actor,
    case when p_correction then 'imprest_funding_handover_corrected'
         else 'imprest_funding_provided' end,
    p_funding_id, jsonb_build_object('status', v_f.status::text),
    jsonb_build_object('status', 'provided', 'cycle', v_cycle, 'provided_amount_tzs', p_amount_tzs,
                       'explanation', case when p_correction then v_expl end, 'posted', false),
    case when p_correction then 'api.admin_resolve_imprest_mismatch'
         else 'api.admin_record_imprest_provided' end);

  return private.imprest_funding_result(
    case when p_correction then 'handover_corrected' else 'provided' end, p_funding_id);
end;
$$;

comment on function private.imprest_record_handover(uuid, integer, bigint, text, text, boolean) is
  'Records a handover inside the current approval: the first provision, or a corrected handover '
  'after a mismatch. Neither posts money.';

create or replace function private.impl_admin_record_imprest_provided(
  p_funding_id uuid, p_expected_version integer, p_amount_tzs bigint, p_idempotency_key text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.imprest_record_handover(p_funding_id, p_expected_version, p_amount_tzs, null,
                                         p_idempotency_key, false);
$$;

create or replace function private.impl_admin_resolve_imprest_mismatch(
  p_funding_id uuid, p_expected_version integer, p_amount_tzs bigint, p_explanation text,
  p_idempotency_key text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.imprest_record_handover(p_funding_id, p_expected_version, p_amount_tzs,
                                         p_explanation, p_idempotency_key, true);
$$;

-- ---------------------------------------------------------------------------
-- Cash Received, and Report mismatch
--
-- One body for both. Each answers the same question about the same handover — is this what I
-- counted? — and each must refer to the CURRENT handover and version, so a stale screen can
-- neither confirm an older amount nor dispute a handover already corrected.
-- ---------------------------------------------------------------------------
create or replace function private.imprest_answer_handover(
  p_funding_id uuid, p_expected_version integer, p_handover_id uuid, p_counted_tzs bigint,
  p_note text, p_idempotency_key text, p_mismatch boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := private.acting_staff(array['manager']::public.app_role[]);
  v_note     text := private.normalise_label(p_note);
  v_op       text := case when p_mismatch then 'imprest.report_mismatch'
                          else 'imprest.confirm_received' end;
  v_f        public.imprest_fundings%rowtype;
  v_handover public.imprest_funding_handovers%rowtype;
  v_class    jsonb;
  v_request  jsonb := jsonb_build_object(
    'funding_id', p_funding_id, 'expected_version', p_expected_version,
    'handover_id', p_handover_id, 'counted_tzs', p_counted_tzs, 'note', v_note);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));
  v_class := private.classify_idempotency_key(p_idempotency_key, v_op, v_actor, v_request);
  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  elsif v_class ->> 'status' = 'replay' then
    return private.imprest_funding_result('replayed', p_funding_id);
  end if;

  if p_mismatch and (p_counted_tzs is null or p_counted_tzs < 0 or p_counted_tzs > 100000000) then
    return jsonb_build_object('ok', false, 'reason', 'amount_invalid');
  elsif p_mismatch and private.imprest_text_problem(v_note, false) then
    return jsonb_build_object('ok', false, 'reason', 'note_invalid');
  end if;

  select * into v_f from public.imprest_fundings where id = p_funding_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_funding');
  elsif v_f.version is distinct from p_expected_version then
    return jsonb_build_object('ok', false, 'reason', 'stale', 'version', v_f.version,
                              'status', v_f.status::text);
  elsif v_f.status <> 'provided' then
    return jsonb_build_object('ok', false, 'reason', 'not_awaiting_receipt',
                              'status', v_f.status::text);
  end if;

  select * into v_handover from public.imprest_funding_handovers
   where funding_id = p_funding_id order by cycle desc limit 1;
  if v_handover.id is distinct from p_handover_id then
    return jsonb_build_object('ok', false, 'reason', 'stale', 'version', v_f.version,
                              'status', v_f.status::text);
  elsif p_mismatch and p_counted_tzs = v_handover.amount_tzs then
    return jsonb_build_object('ok', false, 'reason', 'counted_matches_provided',
                              'provided_amount_tzs', v_handover.amount_tzs);
  end if;

  if private.imprest_claim_key(p_idempotency_key, v_op, v_actor, v_request, p_funding_id)
     <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if p_mismatch then
    insert into public.imprest_funding_mismatches (funding_id, handover_id, counted_tzs, note,
                                                   reported_by)
    values (p_funding_id, v_handover.id, p_counted_tzs, nullif(v_note, ''), v_actor);
    update public.imprest_fundings set status = 'disputed', version = version + 1
     where id = p_funding_id;
  else
    -- THE ONLY PLACE MONEY POSTS. The amount is the handover's, never a figure the caller typed,
    -- and the status guard plus the row lock mean it happens once.
    update public.imprest_fundings
       set status = 'received', version = version + 1, received_handover_id = v_handover.id,
           received_amount_tzs = v_handover.amount_tzs, received_by = v_actor,
           received_at = now()
     where id = p_funding_id;
  end if;

  perform private.imprest_audit(v_actor,
    case when p_mismatch then 'imprest_funding_mismatch_reported'
         else 'imprest_funding_received' end,
    p_funding_id, jsonb_build_object('status', 'provided', 'cycle', v_handover.cycle,
                                     'provided_amount_tzs', v_handover.amount_tzs),
    case when p_mismatch
         then jsonb_build_object('status', 'disputed', 'counted_tzs', p_counted_tzs,
                                 'difference_tzs', p_counted_tzs - v_handover.amount_tzs,
                                 'note', nullif(v_note, ''), 'posted', false)
         else jsonb_build_object('status', 'received',
                                 'received_amount_tzs', v_handover.amount_tzs, 'posted', true)
    end,
    case when p_mismatch then 'api.staff_report_imprest_mismatch'
         else 'api.staff_confirm_imprest_received' end);

  return private.imprest_funding_result(
    case when p_mismatch then 'mismatch_reported' else 'received' end, p_funding_id);
end;
$$;

comment on function private.imprest_answer_handover(uuid, integer, uuid, bigint, text, text, boolean) is
  'The Manager''s answer to the current handover: confirm it (the only posting) or report what '
  'was actually counted.';

create or replace function private.impl_staff_confirm_imprest_received(
  p_funding_id uuid, p_expected_version integer, p_handover_id uuid, p_idempotency_key text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.imprest_answer_handover(p_funding_id, p_expected_version, p_handover_id, null,
                                         null, p_idempotency_key, false);
$$;

create or replace function private.impl_staff_report_imprest_mismatch(
  p_funding_id uuid, p_expected_version integer, p_handover_id uuid, p_counted_tzs bigint,
  p_note text, p_idempotency_key text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.imprest_answer_handover(p_funding_id, p_expected_version, p_handover_id,
                                         p_counted_tzs, p_note, p_idempotency_key, true);
$$;

-- ---------------------------------------------------------------------------
-- The api surface: each wrapper commits a refusal to the audit trail
-- ---------------------------------------------------------------------------
create or replace function api.staff_request_imprest_funding(
  p_amount_tzs bigint, p_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_request_imprest_funding(p_amount_tzs, p_reason,
                                                               p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_request_imprest_funding', 'imprest_funding', null, v);
end $$;

comment on function api.staff_request_imprest_funding(bigint, text, text) is
  'The Manager asks for imprest funding (product.md §13.2 step 1). Posts nothing (AC-47).';

create or replace function api.admin_decide_imprest_funding(
  p_funding_id uuid, p_expected_version integer, p_approve boolean, p_amount_tzs bigint,
  p_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_admin_decide_imprest_funding(
  p_funding_id, p_expected_version, p_approve, p_amount_tzs, p_reason, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.admin_decide_imprest_funding', 'imprest_funding', p_funding_id, v);
end $$;

comment on function api.admin_decide_imprest_funding(uuid, integer, boolean, bigint, text, text) is
  'A Director approves an amount or rejects with a reason (product.md §13.2 step 2). Posts nothing.';

create or replace function api.admin_increase_imprest_approval(
  p_funding_id uuid, p_expected_version integer, p_amount_tzs bigint, p_note text,
  p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_admin_increase_imprest_approval(
  p_funding_id, p_expected_version, p_amount_tzs, p_note, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.admin_increase_imprest_approval', 'imprest_funding', p_funding_id, v);
end $$;

comment on function api.admin_increase_imprest_approval(uuid, integer, bigint, text, text) is
  'A Director raises a funding approval before a larger handover. Every earlier approval is kept, '
  'and nothing posts.';

create or replace function api.admin_record_imprest_provided(
  p_funding_id uuid, p_expected_version integer, p_amount_tzs bigint, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_admin_record_imprest_provided(
  p_funding_id, p_expected_version, p_amount_tzs, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.admin_record_imprest_provided', 'imprest_funding', p_funding_id, v);
end $$;

comment on function api.admin_record_imprest_provided(uuid, integer, bigint, text) is
  'Imprest Provided (product.md §13.2 step 5): the amount actually handed over, at most the '
  'current approval. Posts nothing until the Manager confirms.';

create or replace function api.staff_confirm_imprest_received(
  p_funding_id uuid, p_expected_version integer, p_handover_id uuid, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_confirm_imprest_received(
  p_funding_id, p_expected_version, p_handover_id, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_confirm_imprest_received', 'imprest_funding', p_funding_id, v);
end $$;

comment on function api.staff_confirm_imprest_received(uuid, integer, uuid, text) is
  'Cash Received (product.md §13.2 step 6): the Manager confirms the displayed handover, and only '
  'now does it post, exactly once.';

create or replace function api.staff_report_imprest_mismatch(
  p_funding_id uuid, p_expected_version integer, p_handover_id uuid, p_counted_tzs bigint,
  p_note text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_report_imprest_mismatch(
  p_funding_id, p_expected_version, p_handover_id, p_counted_tzs, p_note, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_report_imprest_mismatch', 'imprest_funding', p_funding_id, v);
end $$;

comment on function api.staff_report_imprest_mismatch(uuid, integer, uuid, bigint, text, text) is
  'Report mismatch: the Manager records what was actually counted. The funding stays unconfirmed '
  'and nothing posts.';

create or replace function api.admin_resolve_imprest_mismatch(
  p_funding_id uuid, p_expected_version integer, p_amount_tzs bigint, p_explanation text,
  p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_admin_resolve_imprest_mismatch(
  p_funding_id, p_expected_version, p_amount_tzs, p_explanation, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.admin_resolve_imprest_mismatch', 'imprest_funding', p_funding_id, v);
end $$;

comment on function api.admin_resolve_imprest_mismatch(uuid, integer, bigint, text, text) is
  'A Director records the corrected handover and its explanation after a mismatch. The Manager '
  'must still confirm it; the correction alone posts nothing.';

-- ---------------------------------------------------------------------------
-- Ownership and grants
-- ---------------------------------------------------------------------------
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure::text as signature, n.nspname, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'api' and p.proname like '%imprest%')
        or (n.nspname = 'private'
            and (p.proname like 'impl\_%imprest%' or p.proname like 'imprest\_%'
                 or p.proname = 'active_imprest_fund'))
  loop
    execute format('alter function %s owner to fv_definer_owner', fn.signature);
    execute format('revoke execute on function %s from public, anon, authenticated, service_role',
                   fn.signature);
    if fn.nspname = 'api' then
      if fn.proname like 'admin\_%' or fn.proname like 'staff\_%' then
        execute format('grant execute on function %s to authenticated', fn.signature);
      else
        raise exception 'api.% has no audience prefix', fn.proname;
      end if;
    end if;
  end loop;
end
$$;

commit;
