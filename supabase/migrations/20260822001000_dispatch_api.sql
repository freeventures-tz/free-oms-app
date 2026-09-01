-- Stage 12 · The settlement and dispatch command surface
--
-- Ten commands. The shape is the one every stage before this uses — actor from the verified
-- session, advisory lock on the presented key before the first classification, validation before
-- the claim, one transaction — and four rules are specific to this file:
--
--   · A PAYMENT IS A CASH FACT AND CREDIT IS A DECISION (§12.5). They are two commands writing two
--     tables, and neither can be mistaken for the other. `staff_record_payment` takes a tender;
--     `staff_request_credit` takes an amount and raises an approval.
--
--   · STOCK LEAVES IN EXACTLY ONE PLACE. `staff_confirm_release`, and only after a Manager confirms
--     a customer-signed note against a dispatch that already carries its physical number
--     (§12.6 step 14, AC-35). Nothing else in this file writes an `inventory_ledger` row.
--
--   · THE CASH CUSTOMER SALE IS ONE ATOMIC ACT (§12.4 point 4, AC-88, AC-89). Rechecks stock,
--     records the tender, generates the invoice, marks it settled, and commits the stock — or
--     leaves nothing behind at all. It is one function because it is one transaction, and splitting
--     it would let a caller stop halfway.
--
--   · WHO MAY DO WHAT, from product.md §4.1 and §12.6:
--
--       Register a storekeeper       Director (§3.2)
--       Record a payment             Cashier (§12.6 step 6)
--       Request credit               Cashier (§12.6 step 6)
--       Approve credit ≤ 500 000     Manager (§4)
--       Approve any other credit     Director (§4)
--       Approve a settled invoice    Cashier (§4.1, §12.6 step 7)
--       Assign a storekeeper         Cashier (§12.6 step 9)
--       Record the dispatch note     Manager (§12.6 step 11)
--       Confirm the signed release   Manager (§12.6 step 13)
--       Request a payment reversal   Cashier or Manager (§4.1)
--       Approve a payment reversal   Director (§4.1, AC-21)

begin;

-- ---------------------------------------------------------------------------
-- api.admin_add_storekeeper — product.md §3.2
-- ---------------------------------------------------------------------------
create or replace function api.admin_add_storekeeper(
  p_full_name       text,
  p_phone           text,
  p_start_date      date,
  p_note            text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor       uuid := private.acting_director();
  v_role        public.app_role := private.live_role_of(v_actor);
  v_name        text := private.normalise_label(p_full_name);
  v_phone       text := nullif(private.normalise_label(p_phone), '');
  v_note        text := nullif(private.normalise_label(p_note), '');
  v_corr        uuid := gen_random_uuid();
  v_keeper_id   uuid := gen_random_uuid();
  v_keeper      public.storekeepers%rowtype;
  v_class       jsonb;
  v_claimed     integer;
  v_request     jsonb := jsonb_build_object('full_name', private.canonical_identity(v_name));
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'dispatch.add_storekeeper', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_keeper from public.storekeepers where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'storekeeper', to_jsonb(v_keeper));
  end if;

  if length(v_name) < 2 then
    return jsonb_build_object('ok', false, 'reason', 'storekeeper_name_required');
  end if;

  if exists (
    select 1 from public.storekeepers s
     where private.canonical_identity(s.full_name) = private.canonical_identity(v_name)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'storekeeper_exists');
  end if;

  -- A start date in the future would put somebody on a dispatch before they worked here.
  if p_start_date is null or p_start_date > private.business_date() then
    return jsonb_build_object('ok', false, 'reason', 'start_date_invalid');
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'dispatch.add_storekeeper', v_keeper_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'dispatch.add_storekeeper', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    select * into v_keeper from public.storekeepers where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'storekeeper', to_jsonb(v_keeper));
  end if;

  insert into public.storekeepers (
    id, storekeeper_code, full_name, phone, start_date, note, created_by
  )
  values (
    v_keeper_id, private.next_storekeeper_code(), v_name, v_phone, p_start_date, v_note, v_actor
  )
  returning * into v_keeper;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'storekeeper_registered', 'storekeeper', v_keeper_id,
    null, to_jsonb(v_keeper), v_corr, 'api.admin_add_storekeeper'
  );

  return jsonb_build_object('ok', true, 'reason', 'added', 'storekeeper', to_jsonb(v_keeper));
end;
$$;

comment on function api.admin_add_storekeeper(text, text, date, text, text) is
  'Registers a storekeeper, Director-only (product.md §3.2). They get no login and no permissions '
  '— the record exists so they can be ASSIGNED to a dispatch by name.';

-- ---------------------------------------------------------------------------
-- api.admin_set_storekeeper_active — §3.2: deactivated, never deleted
-- ---------------------------------------------------------------------------
create or replace function api.admin_set_storekeeper_active(
  p_storekeeper_id  uuid,
  p_is_active       boolean,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := private.acting_director();
  v_role    public.app_role := private.live_role_of(v_actor);
  v_corr    uuid := gen_random_uuid();
  v_before  public.storekeepers%rowtype;
  v_after   public.storekeepers%rowtype;
  v_class   jsonb;
  v_claimed integer;
  v_request jsonb := jsonb_build_object(
    'storekeeper_id', p_storekeeper_id, 'is_active', p_is_active);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'dispatch.set_storekeeper_active', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_after from public.storekeepers where id = p_storekeeper_id;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'storekeeper', to_jsonb(v_after));
  end if;

  select * into v_before from public.storekeepers where id = p_storekeeper_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_storekeeper');
  end if;

  if p_is_active is null then
    return jsonb_build_object('ok', false, 'reason', 'storekeeper_state_required');
  end if;

  if v_before.is_active = p_is_active then
    return jsonb_build_object('ok', false, 'reason', 'storekeeper_unchanged');
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'dispatch.set_storekeeper_active', p_storekeeper_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'dispatch.set_storekeeper_active', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    select * into v_after from public.storekeepers where id = p_storekeeper_id;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'storekeeper', to_jsonb(v_after));
  end if;

  -- §3.2 requires a deactivation date when deactivated, and the table's own check constraint
  -- refuses the row if these two ever disagree.
  update public.storekeepers
     set is_active      = p_is_active,
         deactivated_at = case when p_is_active then null else private.business_date() end
   where id = p_storekeeper_id
  returning * into v_after;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false,
    case when p_is_active then 'storekeeper_reactivated' else 'storekeeper_deactivated' end,
    'storekeeper', p_storekeeper_id,
    to_jsonb(v_before), to_jsonb(v_after), v_corr, 'api.admin_set_storekeeper_active'
  );

  return jsonb_build_object('ok', true, 'reason',
    case when p_is_active then 'reactivated' else 'deactivated' end,
    'storekeeper', to_jsonb(v_after));
end;
$$;

comment on function api.admin_set_storekeeper_active(uuid, boolean, text) is
  'Switches a storekeeper off or back on, Director-only. Never deletes: every dispatch they were '
  'assigned to names them permanently (product.md §3.2).';

-- ---------------------------------------------------------------------------
-- api.staff_record_payment — money actually received (§12.5)
--
-- Records a tender and nothing else. It does not mark the invoice paid, because §12.3 keeps the
-- status calculated: the sum of these rows IS the answer, and there is no column to set.
-- ---------------------------------------------------------------------------
create or replace function api.staff_record_payment(
  p_invoice_id      uuid,
  p_method          public.payment_method,
  p_amount_tzs      bigint,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := private.acting_staff(array['cashier']::public.app_role[]);
  v_role       public.app_role := private.live_role_of(v_actor);
  v_corr       uuid := gen_random_uuid();
  v_payment_id uuid := gen_random_uuid();
  v_invoice    public.invoices%rowtype;
  v_settle     record;
  v_payment    public.payments%rowtype;
  v_class      jsonb;
  v_claimed    integer;
  v_request    jsonb := jsonb_build_object(
    'invoice_id', p_invoice_id, 'method', p_method::text, 'amount_tzs', p_amount_tzs);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'settlement.record_payment', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_payment from public.payments where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'payment', to_jsonb(v_payment));
  end if;

  select * into v_invoice from public.invoices where id = p_invoice_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_invoice');
  end if;

  if v_invoice.cancelled_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'invoice_cancelled');
  end if;

  if p_amount_tzs is null or p_amount_tzs <= 0 or p_amount_tzs > 100000000 then
    return jsonb_build_object('ok', false, 'reason', 'amount_invalid');
  end if;

  -- Serialised per invoice, so two Cashiers taking money at once cannot both pass the overpayment
  -- check against the same balance.
  perform pg_advisory_xact_lock(hashtextextended('invoice:' || p_invoice_id::text, 0));

  select * into v_settle from private.settlement_of(p_invoice_id);

  -- Taking more than is owed is not a payment, it is a mistake with somebody's money in it. The
  -- refusal names the balance so the Cashier can correct it at the counter.
  if p_amount_tzs > v_settle.outstanding_tzs then
    return jsonb_build_object(
      'ok', false, 'reason', 'payment_exceeds_balance',
      'outstanding', v_settle.outstanding_tzs, 'offered', p_amount_tzs);
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'settlement.record_payment', v_payment_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'settlement.record_payment', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    select * into v_payment from public.payments where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'payment', to_jsonb(v_payment));
  end if;

  insert into public.payments (
    id, invoice_id, amount_tzs, method, received_by, received_role, business_date, correlation_id
  )
  values (
    v_payment_id, p_invoice_id, p_amount_tzs, p_method, v_actor, v_role,
    private.business_date(), v_corr
  )
  returning * into v_payment;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'payment_recorded', 'invoice', p_invoice_id,
    jsonb_build_object('amount_paid_tzs', v_settle.amount_paid_tzs),
    jsonb_build_object('amount_tzs', p_amount_tzs, 'method', p_method::text,
                       'amount_paid_tzs', v_settle.amount_paid_tzs + p_amount_tzs),
    v_corr, 'api.staff_record_payment'
  );

  select * into v_settle from private.settlement_of(p_invoice_id);

  return jsonb_build_object('ok', true, 'reason', 'recorded',
                            'payment', to_jsonb(v_payment),
                            'status', v_settle.status,
                            'outstanding', v_settle.outstanding_tzs);
end;
$$;

comment on function api.staff_record_payment(uuid, public.payment_method, bigint, text) is
  'Records money received against an invoice (product.md §12.5). Sets no status: §12.3 keeps that '
  'calculated from the sum of these rows, and AC-14 forbids a user choosing one.';

-- ---------------------------------------------------------------------------
-- api.staff_request_credit — a settlement decision, and NOT a payment (§12.5)
-- ---------------------------------------------------------------------------
create or replace function api.staff_request_credit(
  p_invoice_id      uuid,
  p_amount_tzs      bigint,
  p_reason          text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := private.acting_staff(array['cashier']::public.app_role[]);
  v_role       public.app_role := private.live_role_of(v_actor);
  v_reason     text := private.normalise_label(p_reason);
  v_corr       uuid := gen_random_uuid();
  v_credit_id  uuid := gen_random_uuid();
  v_request_id uuid := gen_random_uuid();
  v_invoice    public.invoices%rowtype;
  v_settle     record;
  v_required   public.app_role;
  v_class      jsonb;
  v_claimed    integer;
  v_request    jsonb := jsonb_build_object(
    'invoice_id', p_invoice_id, 'amount_tzs', p_amount_tzs,
    'reason', private.canonical_identity(v_reason));
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'settlement.request_credit', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    return jsonb_build_object('ok', true, 'reason', 'replayed',
                              'credit_id', v_class ->> 'result_ref');
  end if;

  select * into v_invoice from public.invoices where id = p_invoice_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_invoice');
  end if;

  if v_invoice.cancelled_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'invoice_cancelled');
  end if;

  if length(v_reason) < 3 then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('invoice:' || p_invoice_id::text, 0));

  select * into v_settle from private.settlement_of(p_invoice_id);

  if p_amount_tzs is null or p_amount_tzs <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'amount_invalid');
  end if;

  -- Carrying more on credit than is outstanding would record an exposure the customer does not owe.
  if p_amount_tzs > v_settle.outstanding_tzs then
    return jsonb_build_object(
      'ok', false, 'reason', 'credit_exceeds_balance',
      'outstanding', v_settle.outstanding_tzs, 'offered', p_amount_tzs);
  end if;

  if exists (select 1 from public.credit_authorisations c where c.invoice_id = p_invoice_id) then
    return jsonb_build_object('ok', false, 'reason', 'credit_already_requested');
  end if;

  -- Whose decision it is, from the limit rather than from who happened to ask (§4, AC-17).
  v_required := case
    when private.credit_needs_director(p_amount_tzs) then 'director' else 'manager'
  end::public.app_role;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'settlement.request_credit', v_credit_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'settlement.request_credit', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    return jsonb_build_object('ok', true, 'reason', 'replayed',
                              'credit_id', v_class ->> 'result_ref');
  end if;

  insert into public.credit_authorisations (
    id, invoice_id, amount_tzs, reason, requested_by, requested_role
  )
  values (v_credit_id, p_invoice_id, p_amount_tzs, v_reason, v_actor, v_role);

  insert into public.approval_requests (
    id, entity_type, entity_id, approval_type,
    requested_by, requested_role, requested_amount, required_role, status
  )
  values (
    v_request_id, 'credit_authorisation', v_credit_id, 'credit_or_unpaid_balance',
    v_actor, v_role, p_amount_tzs, v_required, 'pending'
  );

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, approval_reference, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'credit_requested', 'invoice', p_invoice_id,
    null,
    jsonb_build_object('amount_tzs', p_amount_tzs, 'required_role', v_required::text,
                       'reason', v_reason),
    v_request_id, v_corr, 'api.staff_request_credit'
  );

  return jsonb_build_object('ok', true, 'reason', 'requested',
                            'credit_id', v_credit_id,
                            'required_role', v_required::text);
end;
$$;

comment on function api.staff_request_credit(uuid, bigint, text, text) is
  'Asks for an unpaid balance to be carried as credit (product.md §12.5). Records NO payment: an '
  'invoice settled entirely on credit shows Unpaid (AC-92, AC-93).';

-- ---------------------------------------------------------------------------
-- api.staff_approve_credit
--
-- Open to a Manager AND a Director, with the TZS 500,000 limit re-checked here. A Manager asked to
-- approve beyond their authority is refused by the database, not merely by a disabled button.
-- ---------------------------------------------------------------------------
create or replace function api.staff_approve_credit(
  p_credit_id       uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := private.acting_staff(array['manager','director']::public.app_role[]);
  v_role     public.app_role := private.live_role_of(v_actor);
  v_corr     uuid := gen_random_uuid();
  v_credit   public.credit_authorisations%rowtype;
  v_req      public.approval_requests%rowtype;
  v_decision uuid;
  v_class    jsonb;
  v_claimed  integer;
  v_request  jsonb := jsonb_build_object('credit_id', p_credit_id, 'outcome', 'approved');
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'settlement.approve_credit', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_credit from public.credit_authorisations where id = p_credit_id;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'credit', to_jsonb(v_credit));
  end if;

  select * into v_credit from public.credit_authorisations where id = p_credit_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_credit_request');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('credit:' || p_credit_id::text, 0));

  select * into v_req from public.approval_requests
   where entity_type = 'credit_authorisation' and entity_id = p_credit_id
     and approval_type = 'credit_or_unpaid_balance';

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_approval_request');
  end if;

  if v_req.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'already_settled',
                              'status', v_req.status::text);
  end if;

  -- The limit, checked against the amount actually being approved rather than against a
  -- `required_role` written when the request was raised.
  if v_role = 'manager' and private.credit_needs_director(v_credit.amount_tzs) then
    return jsonb_build_object(
      'ok', false, 'reason', 'director_approval_required',
      'amount_tzs', v_credit.amount_tzs, 'manager_limit_tzs', 500000);
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'settlement.approve_credit', p_credit_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'settlement.approve_credit', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'credit', to_jsonb(v_credit));
  end if;

  v_decision := private.settle_approval(v_req.id, 'approved', v_actor, v_role, null);

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, approval_reference, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'credit_approved', 'invoice', v_credit.invoice_id,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'approved', 'amount_tzs', v_credit.amount_tzs,
                       'decision_id', v_decision),
    v_req.id, v_corr, 'api.staff_approve_credit'
  );

  return jsonb_build_object('ok', true, 'reason', 'approved', 'credit', to_jsonb(v_credit));
end;
$$;

comment on function api.staff_approve_credit(uuid, text) is
  'Approves an unpaid balance within the approver''s authority (product.md §4, AC-17). Records no '
  'payment — the invoice stays Unpaid or Partially paid on the money actually received (AC-93).';

-- ---------------------------------------------------------------------------
-- api.staff_reject_credit
-- ---------------------------------------------------------------------------
create or replace function api.staff_reject_credit(
  p_credit_id       uuid,
  p_reason          text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := private.acting_staff(array['manager','director']::public.app_role[]);
  v_role     public.app_role := private.live_role_of(v_actor);
  v_reason   text := private.normalise_label(p_reason);
  v_corr     uuid := gen_random_uuid();
  v_credit   public.credit_authorisations%rowtype;
  v_req      public.approval_requests%rowtype;
  v_decision uuid;
  v_class    jsonb;
  v_claimed  integer;
  v_request  jsonb := jsonb_build_object(
    'credit_id', p_credit_id, 'outcome', 'rejected', 'reason', v_reason);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'settlement.reject_credit', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    return jsonb_build_object('ok', true, 'reason', 'replayed');
  end if;

  if length(v_reason) < 3 then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  select * into v_credit from public.credit_authorisations where id = p_credit_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_credit_request');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('credit:' || p_credit_id::text, 0));

  select * into v_req from public.approval_requests
   where entity_type = 'credit_authorisation' and entity_id = p_credit_id
     and approval_type = 'credit_or_unpaid_balance';

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_approval_request');
  end if;

  if v_req.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'already_settled',
                              'status', v_req.status::text);
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'settlement.reject_credit', p_credit_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'settlement.reject_credit', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    return jsonb_build_object('ok', true, 'reason', 'replayed');
  end if;

  v_decision := private.settle_approval(v_req.id, 'rejected', v_actor, v_role, v_reason);

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, approval_reference, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'credit_rejected', 'invoice', v_credit.invoice_id,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'rejected', 'reason', v_reason, 'decision_id', v_decision),
    v_req.id, v_corr, 'api.staff_reject_credit'
  );

  return jsonb_build_object('ok', true, 'reason', 'rejected');
end;
$$;

comment on function api.staff_reject_credit(uuid, text, text) is
  'Rejects an unpaid balance. Records no approver (product.md §4.3) and leaves the invoice owing '
  'exactly what it owed.';

-- ---------------------------------------------------------------------------
-- api.staff_approve_settlement — §4.1: "Fully paid invoice — Cashier / Cashier"
--
-- §4.2 makes this a SEPARATE act from recording the payment, even though the same Cashier does
-- both. It is not the status — §12.3 keeps that calculated — it is the confirmation that the
-- invoice is settled and dispatch may begin, and it is where reserved stock becomes committed:
-- §8's "Committed (paid or approved, awaiting release)".
-- ---------------------------------------------------------------------------
create or replace function api.staff_approve_settlement(
  p_invoice_id      uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := private.acting_staff(array['cashier']::public.app_role[]);
  v_role    public.app_role := private.live_role_of(v_actor);
  v_corr    uuid := gen_random_uuid();
  v_invoice public.invoices%rowtype;
  v_settle  record;
  v_class   jsonb;
  v_claimed integer;
  v_request jsonb := jsonb_build_object('invoice_id', p_invoice_id);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'settlement.approve', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_invoice from public.invoices where id = p_invoice_id;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'invoice', to_jsonb(v_invoice));
  end if;

  perform pg_advisory_xact_lock(hashtextextended('invoice:' || p_invoice_id::text, 0));

  select * into v_invoice from public.invoices where id = p_invoice_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_invoice');
  end if;

  if v_invoice.cancelled_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'invoice_cancelled');
  end if;

  if v_invoice.settlement_approved_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_settled');
  end if;

  select * into v_settle from private.settlement_of(p_invoice_id);

  -- Money received PLUS approved credit has to cover the bill. Credit is not money, but it is an
  -- authorised way for the balance to be carried, and §12.5's part-tender-part-credit row is
  -- exactly this case.
  if v_settle.amount_paid_tzs + v_settle.approved_credit_tzs < v_settle.total_tzs then
    return jsonb_build_object(
      'ok', false, 'reason', 'not_settled',
      'outstanding', v_settle.total_tzs - v_settle.amount_paid_tzs - v_settle.approved_credit_tzs);
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'settlement.approve', p_invoice_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'settlement.approve', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'invoice', to_jsonb(v_invoice));
  end if;

  update public.invoices
     set settlement_approved_by = v_actor, settlement_approved_at = now()
   where id = p_invoice_id
  returning * into v_invoice;

  -- Reserved becomes committed. The QUANTITY does not change and no stock moves — §8 calls this
  -- "settled but not yet handed over", and §12.6 keeps the goods in the yard until step 14.
  update public.stock_allocations
     set state = 'committed', updated_at = now()
   where order_id = v_invoice.order_id and state = 'reserved';

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'settlement_approved', 'invoice', p_invoice_id,
    jsonb_build_object('settlement_approved_at', null),
    jsonb_build_object('amount_paid_tzs', v_settle.amount_paid_tzs,
                       'approved_credit_tzs', v_settle.approved_credit_tzs,
                       'status', v_settle.status),
    v_corr, 'api.staff_approve_settlement'
  );

  return jsonb_build_object('ok', true, 'reason', 'approved', 'invoice', to_jsonb(v_invoice));
end;
$$;

comment on function api.staff_approve_settlement(uuid, text) is
  'The Cashier confirming an invoice is settled and may be dispatched (product.md §4.1, §12.6 step '
  '7). Moves reserved stock to committed WITHOUT moving any quantity: §8''s paid-but-unreleased.';

-- ---------------------------------------------------------------------------
-- api.staff_assign_dispatch — §12.6 step 9. STOCK HAS NOT MOVED.
-- ---------------------------------------------------------------------------
create or replace function api.staff_assign_dispatch(
  p_invoice_id      uuid,
  p_storekeeper_id  uuid,
  p_source_location text,
  p_lines           jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor       uuid := private.acting_staff(array['cashier']::public.app_role[]);
  v_role        public.app_role := private.live_role_of(v_actor);
  v_corr        uuid := gen_random_uuid();
  v_dispatch_id uuid := gen_random_uuid();
  v_invoice     public.invoices%rowtype;
  v_settle      record;
  v_dispatch    public.dispatches%rowtype;
  v_line        jsonb;
  v_alloc       public.stock_allocations%rowtype;
  v_quantity    numeric;
  v_outstanding bigint;
  v_class       jsonb;
  v_claimed     integer;
  v_request     jsonb := jsonb_build_object(
    'invoice_id', p_invoice_id, 'storekeeper_id', p_storekeeper_id,
    'source_location', p_source_location, 'lines', coalesce(p_lines, '[]'::jsonb));
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'dispatch.assign', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_dispatch from public.dispatches where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'dispatch', to_jsonb(v_dispatch));
  end if;

  select * into v_invoice from public.invoices where id = p_invoice_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_invoice');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('invoice:' || p_invoice_id::text, 0));

  select * into v_settle from private.settlement_of(p_invoice_id);

  -- Nothing is assigned for dispatch until the Cashier has confirmed the invoice is settled
  -- (§12.6 steps 7 then 9). Assigning first would put goods on somebody's list that nobody has
  -- paid for or approved credit against.
  if not v_settle.releasable then
    return jsonb_build_object('ok', false, 'reason', 'not_releasable');
  end if;

  if not exists (
    select 1 from public.storekeepers s where s.id = p_storekeeper_id and s.is_active
  ) then
    return jsonb_build_object('ok', false, 'reason', 'no_storekeeper');
  end if;

  if not exists (
    select 1 from public.inventory_locations l where l.code = p_source_location
  ) then
    return jsonb_build_object('ok', false, 'reason', 'no_location');
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'lines_required');
  end if;

  -- Every line is checked before any is written, so a bad third line does not leave two behind.
  for v_line in select t.elem from jsonb_array_elements(p_lines) as t(elem) loop
    if jsonb_typeof(v_line -> 'allocation_id') <> 'string'
       or jsonb_typeof(v_line -> 'quantity') <> 'number' then
      return jsonb_build_object('ok', false, 'reason', 'line_invalid');
    end if;

    select * into v_alloc from public.stock_allocations
     where id = (v_line ->> 'allocation_id')::uuid and order_id = v_invoice.order_id;

    if not found then
      return jsonb_build_object('ok', false, 'reason', 'no_allocation');
    end if;

    v_quantity := (v_line ->> 'quantity')::numeric;

    if v_quantity <> trunc(v_quantity) or v_quantity <= 0 then
      return jsonb_build_object('ok', false, 'reason', 'quantity_invalid');
    end if;

    -- What is still owed to the customer on this line, after anything already dispatched. A
    -- partial release leaves the remainder committed (§12), and this is what stops a second
    -- dispatch handing over the same goods twice.
    v_outstanding := v_alloc.quantity - v_alloc.released_quantity
      - coalesce((
          select sum(dl.quantity) from public.dispatch_lines dl
            join public.dispatches d on d.id = dl.dispatch_id
           where dl.allocation_id = v_alloc.id
             and d.status in ('assigned', 'note_recorded')
        ), 0);

    if v_quantity > v_outstanding then
      return jsonb_build_object(
        'ok', false, 'reason', 'exceeds_outstanding',
        'allocation_id', v_alloc.id, 'outstanding', v_outstanding, 'requested', v_quantity);
    end if;
  end loop;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'dispatch.assign', v_dispatch_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'dispatch.assign', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    select * into v_dispatch from public.dispatches where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'dispatch', to_jsonb(v_dispatch));
  end if;

  insert into public.dispatches (
    id, invoice_id, storekeeper_id, source_location, status, assigned_by, assigned_role
  )
  values (
    v_dispatch_id, p_invoice_id, p_storekeeper_id, p_source_location, 'assigned', v_actor, v_role
  )
  returning * into v_dispatch;

  insert into public.dispatch_lines (dispatch_id, allocation_id, product_id, quantity)
  select v_dispatch_id,
         (t.elem ->> 'allocation_id')::uuid,
         a.product_id,
         (t.elem ->> 'quantity')::bigint
    from jsonb_array_elements(p_lines) as t(elem)
    join public.stock_allocations a on a.id = (t.elem ->> 'allocation_id')::uuid;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'dispatch_assigned', 'dispatch', v_dispatch_id,
    null,
    jsonb_build_object('invoice_id', p_invoice_id, 'storekeeper_id', p_storekeeper_id,
                       'stock_moved', false),
    v_corr, 'api.staff_assign_dispatch'
  );

  return jsonb_build_object('ok', true, 'reason', 'assigned', 'dispatch', to_jsonb(v_dispatch));
end;
$$;

comment on function api.staff_assign_dispatch(uuid, uuid, text, jsonb, text) is
  'Names the storekeeper who will fetch the goods (product.md §12.6 step 9). Moves NO stock — the '
  'screen says so, and so does this.';

-- ---------------------------------------------------------------------------
-- api.staff_record_dispatch_note — §12.6 step 11
--
-- One of the few genuinely required typed inputs (design.md §10.2). The number comes from the
-- four-copy carbon book, because the OMS does not produce the note (§14, AC-37).
-- ---------------------------------------------------------------------------
create or replace function api.staff_record_dispatch_note(
  p_dispatch_id     uuid,
  p_note_no         text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := private.acting_staff(array['manager']::public.app_role[]);
  v_role     public.app_role := private.live_role_of(v_actor);
  v_note     text := private.normalise_label(p_note_no);
  v_corr     uuid := gen_random_uuid();
  v_dispatch public.dispatches%rowtype;
  v_class    jsonb;
  v_claimed  integer;
  v_request  jsonb := jsonb_build_object(
    'dispatch_id', p_dispatch_id, 'note_no', private.canonical_identity(v_note));
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'dispatch.record_note', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_dispatch from public.dispatches where id = p_dispatch_id;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'dispatch', to_jsonb(v_dispatch));
  end if;

  if length(v_note) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'dispatch_note_required');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('dispatch:' || p_dispatch_id::text, 0));

  select * into v_dispatch from public.dispatches where id = p_dispatch_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_dispatch');
  end if;

  if v_dispatch.status <> 'assigned' then
    return jsonb_build_object('ok', false, 'reason', 'dispatch_not_assignable',
                              'status', v_dispatch.status::text);
  end if;

  -- AC-36: one OMS record per physical note. The unique index enforces it; this makes the refusal
  -- a sentence a Manager can act on rather than a constraint violation they cannot read.
  if exists (select 1 from public.dispatches d where d.dispatch_note_no = v_note) then
    return jsonb_build_object('ok', false, 'reason', 'dispatch_note_in_use');
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'dispatch.record_note', p_dispatch_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'dispatch.record_note', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'dispatch', to_jsonb(v_dispatch));
  end if;

  update public.dispatches
     set dispatch_note_no = v_note, status = 'note_recorded',
         note_recorded_by = v_actor, note_recorded_at = now()
   where id = p_dispatch_id
  returning * into v_dispatch;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'dispatch_note_recorded', 'dispatch', p_dispatch_id,
    jsonb_build_object('status', 'assigned'),
    jsonb_build_object('status', 'note_recorded', 'dispatch_note_no', v_note,
                       'stock_moved', false),
    v_corr, 'api.staff_record_dispatch_note'
  );

  return jsonb_build_object('ok', true, 'reason', 'recorded', 'dispatch', to_jsonb(v_dispatch));
end;
$$;

comment on function api.staff_record_dispatch_note(uuid, text, text) is
  'Ties the OMS record to the physical carbon-copy note (product.md §14, AC-36). The OMS does not '
  'produce the note (AC-37); the number is typed in from the book. Moves no stock.';

-- ---------------------------------------------------------------------------
-- api.staff_confirm_release — §12.6 step 14, and THE ONLY PLACE STOCK LEAVES
--
-- Reached only when a dispatch already carries its physical note number, so the steps cannot be
-- skipped (design.md §6.3). AC-35: stock leaves the system only after the Manager confirms the
-- customer-signed release.
-- ---------------------------------------------------------------------------
create or replace function api.staff_confirm_release(
  p_dispatch_id     uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor     uuid := private.acting_staff(array['manager']::public.app_role[]);
  v_role      public.app_role := private.live_role_of(v_actor);
  v_corr      uuid := gen_random_uuid();
  v_dispatch  public.dispatches%rowtype;
  v_invoice   public.invoices%rowtype;
  v_line      public.dispatch_lines%rowtype;
  v_available bigint;
  v_class     jsonb;
  v_claimed   integer;
  v_request   jsonb := jsonb_build_object('dispatch_id', p_dispatch_id);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'dispatch.confirm_release', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_dispatch from public.dispatches where id = p_dispatch_id;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'dispatch', to_jsonb(v_dispatch));
  end if;

  perform pg_advisory_xact_lock(hashtextextended('dispatch:' || p_dispatch_id::text, 0));

  select * into v_dispatch from public.dispatches where id = p_dispatch_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_dispatch');
  end if;

  -- The gate design.md §6.3 describes: "Confirm Release stays disabled — with a stated reason —
  -- until a dispatch-note number exists". The screen disables it; this is what makes it true.
  if v_dispatch.status = 'assigned' then
    return jsonb_build_object('ok', false, 'reason', 'dispatch_note_missing');
  end if;

  if v_dispatch.status <> 'note_recorded' then
    return jsonb_build_object('ok', false, 'reason', 'already_settled',
                              'status', v_dispatch.status::text);
  end if;

  select * into v_invoice from public.invoices where id = v_dispatch.invoice_id;

  if v_invoice.cancelled_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'invoice_cancelled');
  end if;

  -- The goods have to physically be at the location they are leaving from. They were committed
  -- against the product rather than against a place (§8.1 has no location dimension), so this is
  -- the first moment the yard's own arithmetic is checked.
  --
  -- Locked in product order, which is what stops two releases from the same location deadlocking.
  for v_line in
    select * from public.dispatch_lines where dispatch_id = p_dispatch_id order by product_id
  loop
    perform pg_advisory_xact_lock(
      hashtextextended(v_dispatch.source_location || ':' || v_line.product_id::text, 0));

    v_available := private.stock_on_hand(
      v_line.product_id, v_dispatch.source_location, 'available');

    if v_available < v_line.quantity then
      return jsonb_build_object(
        'ok', false, 'reason', 'insufficient_stock_at_location',
        'product_id', v_line.product_id, 'location', v_dispatch.source_location,
        'available', v_available, 'requested', v_line.quantity);
    end if;
  end loop;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'dispatch.confirm_release', p_dispatch_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'dispatch.confirm_release', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'dispatch', to_jsonb(v_dispatch));
  end if;

  update public.dispatches
     set status = 'released', released_by = v_actor, released_at = now()
   where id = p_dispatch_id
  returning * into v_dispatch;

  for v_line in
    select * from public.dispatch_lines where dispatch_id = p_dispatch_id order by product_id
  loop
    -- STOCK LEAVES. The one `sale_release` movement in the whole system, and it is here because
    -- here is where a customer has signed for the goods (§12.6 step 14, AC-35).
    perform private.write_stock_movement(
      v_line.product_id, v_dispatch.source_location, 'available',
      -v_line.quantity, 'sale_release',
      'dispatch', p_dispatch_id,
      v_dispatch.assigned_by, v_dispatch.assigned_role, v_actor, v_role, v_corr);

    -- The claim shrinks by what left. A partial release leaves the remainder committed, which is
    -- what keeps `paid_but_unreleased` honest about what is still owed to the customer.
    update public.stock_allocations
       set released_quantity = released_quantity + v_line.quantity,
           state = case
                     when released_quantity + v_line.quantity >= quantity then 'released'
                     else state
                   end,
           updated_at = now()
     where id = v_line.allocation_id;
  end loop;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'stock_released', 'dispatch', p_dispatch_id,
    jsonb_build_object('status', 'note_recorded'),
    jsonb_build_object('status', 'released', 'dispatch_note_no', v_dispatch.dispatch_note_no,
                       'source_location', v_dispatch.source_location),
    v_corr, 'api.staff_confirm_release'
  );

  return jsonb_build_object('ok', true, 'reason', 'released', 'dispatch', to_jsonb(v_dispatch));
end;
$$;

comment on function api.staff_confirm_release(uuid, text) is
  'The Manager confirming a customer-signed dispatch note, and the ONLY place stock leaves the '
  'system (product.md §12.6 step 14, AC-35). Refused until a dispatch-note number exists.';

-- ---------------------------------------------------------------------------
-- api.staff_take_cash_payment — the atomic walk-in sale (§12.4, AC-88, AC-89)
--
-- ONE function because it is one transaction. §12.4 point 6: "If stock or payment recording fails,
-- the whole action fails, leaving no invoice, no payment, and no stock commitment." Splitting this
-- into four commands would let a caller stop after two and leave exactly the half-finished sale
-- §12.4 forbids showing.
-- ---------------------------------------------------------------------------
create or replace function api.staff_take_cash_payment(
  p_order_id        uuid,
  p_method          public.payment_method,
  p_amount_tzs      bigint,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := private.acting_staff(array['cashier']::public.app_role[]);
  v_role       public.app_role := private.live_role_of(v_actor);
  v_corr       uuid := gen_random_uuid();
  v_invoice_id uuid := gen_random_uuid();
  v_order      public.orders%rowtype;
  v_totals     record;
  v_line       public.order_lines%rowtype;
  v_available  bigint;
  v_invoice    public.invoices%rowtype;
  v_class      jsonb;
  v_claimed    integer;
  v_request    jsonb := jsonb_build_object(
    'order_id', p_order_id, 'method', p_method::text, 'amount_tzs', p_amount_tzs);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'settlement.cash_sale', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_invoice from public.invoices where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'invoice', to_jsonb(v_invoice));
  end if;

  perform pg_advisory_xact_lock(hashtextextended('order:' || p_order_id::text, 0));

  select * into v_order from public.orders where id = p_order_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_order');
  end if;

  -- This path exists for the walk-in customer alone. A normal order has an invoice already and is
  -- settled through `staff_record_payment`.
  if not v_order.is_cash_sale then
    return jsonb_build_object('ok', false, 'reason', 'not_a_cash_sale');
  end if;

  if v_order.status <> 'confirmed' then
    return jsonb_build_object('ok', false, 'reason', 'order_not_confirmable',
                              'status', v_order.status::text);
  end if;

  if exists (select 1 from public.invoices i where i.order_id = p_order_id) then
    return jsonb_build_object('ok', false, 'reason', 'already_settled');
  end if;

  select * into v_totals from private.order_totals(p_order_id);

  -- Fully paid, or nothing. §12.4: Cash Customer may be used ONLY for a fully paid walk-in sale,
  -- and never for credit, a partial payment or any unpaid balance (AC-16).
  if p_amount_tzs is distinct from v_totals.total_tzs then
    return jsonb_build_object(
      'ok', false, 'reason', 'cash_sale_must_be_paid_in_full',
      'total', v_totals.total_tzs, 'offered', p_amount_tzs);
  end if;

  -- Stock is LOCKED AND RECHECKED at the moment of payment (§12.4 point 4). Nothing was reserved
  -- for this order, deliberately, so this is the first and only availability check it gets.
  for v_line in
    select * from public.order_lines where order_id = p_order_id order by product_id
  loop
    perform pg_advisory_xact_lock(hashtextextended('stock:' || v_line.product_id::text, 0));

    v_available := private.available_quantity(v_line.product_id);

    if v_available < v_line.quantity then
      -- Nothing is written, so nothing has to be undone: no invoice, no payment, no commitment
      -- (§12.4 point 6, AC-89).
      return jsonb_build_object(
        'ok', false, 'reason', 'insufficient_stock',
        'product_id', v_line.product_id,
        'available', v_available, 'requested', v_line.quantity);
    end if;
  end loop;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'settlement.cash_sale', v_invoice_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'settlement.cash_sale', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    select * into v_invoice from public.invoices where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'invoice', to_jsonb(v_invoice));
  end if;

  -- Everything below is one transaction. Any failure takes all of it (§12.4 point 6).
  insert into public.invoices (
    id, invoice_no, order_id, customer_id, subtotal_tzs, discount_tzs, total_tzs, business_date,
    settlement_approved_by, settlement_approved_at
  )
  values (
    v_invoice_id, private.next_document_number('invoice', 'FV-INV'), p_order_id,
    v_order.customer_id, v_totals.subtotal_tzs, v_totals.discount_tzs, v_totals.total_tzs,
    private.business_date(), v_actor, now()
  )
  returning * into v_invoice;

  insert into public.invoice_lines (
    invoice_id, product_id, product_name, product_specification, unit_code, unit_content,
    quantity, unit_price_tzs
  )
  select v_invoice_id, l.product_id, p.name, p.specification, p.unit_code, p.unit_content,
         l.quantity, l.unit_price_tzs
    from public.order_lines l
    join public.products p on p.id = l.product_id
   where l.order_id = p_order_id
   order by p.name;

  insert into public.payments (
    invoice_id, amount_tzs, method, received_by, received_role, business_date, correlation_id
  )
  values (
    v_invoice_id, p_amount_tzs, p_method, v_actor, v_role, private.business_date(), v_corr
  );

  -- COMMITTED, not reserved. §12.4 point 5: after payment the stock is sold-but-unreleased, never
  -- an unpaid reservation (AC-90).
  insert into public.stock_allocations (order_id, order_line_id, product_id, quantity, state)
  select p_order_id, l.id, l.product_id, l.quantity, 'committed'
    from public.order_lines l where l.order_id = p_order_id;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'cash_sale_completed', 'invoice', v_invoice_id,
    null,
    jsonb_build_object('invoice_no', v_invoice.invoice_no, 'total_tzs', v_totals.total_tzs,
                       'method', p_method::text, 'allocation_state', 'committed'),
    v_corr, 'api.staff_take_cash_payment'
  );

  return jsonb_build_object('ok', true, 'reason', 'paid', 'invoice', to_jsonb(v_invoice));
end;
$$;

comment on function api.staff_take_cash_payment(uuid, public.payment_method, bigint, text) is
  'The atomic walk-in sale (product.md §12.4, AC-88). Rechecks stock, takes the tender, generates '
  'the invoice, marks it settled and commits the stock — or leaves nothing at all (AC-89).';

-- ---------------------------------------------------------------------------
-- api.staff_request_payment_reversal — §4.1: Cashier or Manager requests
-- ---------------------------------------------------------------------------
create or replace function api.staff_request_payment_reversal(
  p_payment_id      uuid,
  p_reason          text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := private.acting_staff(array['cashier','manager']::public.app_role[]);
  v_role       public.app_role := private.live_role_of(v_actor);
  v_reason     text := private.normalise_label(p_reason);
  v_corr       uuid := gen_random_uuid();
  v_request_id uuid := gen_random_uuid();
  v_payment    public.payments%rowtype;
  v_class      jsonb;
  v_claimed    integer;
  v_request    jsonb := jsonb_build_object(
    'payment_id', p_payment_id, 'reason', private.canonical_identity(v_reason));
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'settlement.request_reversal', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    return jsonb_build_object('ok', true, 'reason', 'replayed',
                              'approval_request_id', v_class ->> 'result_ref');
  end if;

  if length(v_reason) < 3 then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  select * into v_payment from public.payments where id = p_payment_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_payment');
  end if;

  if v_payment.reverses_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'cannot_reverse_a_reversal');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('payment:' || p_payment_id::text, 0));

  if exists (select 1 from public.payments p where p.reverses_id = p_payment_id) then
    return jsonb_build_object('ok', false, 'reason', 'already_reversed');
  end if;

  if exists (
    select 1 from public.approval_requests r
     where r.entity_type = 'payment' and r.entity_id = p_payment_id
       and r.approval_type = 'payment_reversal' and r.status = 'pending'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'reversal_already_pending');
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'settlement.request_reversal', v_request_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'settlement.request_reversal', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    return jsonb_build_object('ok', true, 'reason', 'replayed',
                              'approval_request_id', v_class ->> 'result_ref');
  end if;

  -- A Director's decision, whatever the amount and whoever asked (§4.1, AC-21).
  insert into public.approval_requests (
    id, entity_type, entity_id, approval_type, request_seq,
    requested_by, requested_role, requested_amount, required_role, status
  )
  values (
    v_request_id, 'payment', p_payment_id, 'payment_reversal',
    (select coalesce(max(r.request_seq), 0) + 1 from public.approval_requests r
      where r.entity_type = 'payment' and r.entity_id = p_payment_id
        and r.approval_type = 'payment_reversal'),
    v_actor, v_role, v_payment.amount_tzs, 'director', 'pending'
  );

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, approval_reference, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'payment_reversal_requested', 'payment', p_payment_id,
    jsonb_build_object('amount_tzs', v_payment.amount_tzs),
    jsonb_build_object('reason', v_reason, 'required_role', 'director'),
    v_request_id, v_corr, 'api.staff_request_payment_reversal'
  );

  return jsonb_build_object('ok', true, 'reason', 'requested',
                            'approval_request_id', v_request_id);
end;
$$;

comment on function api.staff_request_payment_reversal(uuid, text, text) is
  'Asks a Director to reverse a payment (product.md §4.1, AC-21). Reverses nothing by itself: the '
  'money stays recorded until the Director decides.';

-- ---------------------------------------------------------------------------
-- api.admin_approve_payment_reversal — §4.1: a Director approves, and only a Director
-- ---------------------------------------------------------------------------
create or replace function api.admin_approve_payment_reversal(
  p_payment_id      uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := private.acting_director();
  v_role     public.app_role := private.live_role_of(v_actor);
  v_corr     uuid := gen_random_uuid();
  v_payment  public.payments%rowtype;
  v_reversal public.payments%rowtype;
  -- Minted here so the key is claimed with the id of the row this call will write, in one
  -- statement. Claiming with a placeholder and reading it back afterwards is the two-step this
  -- system has been bitten by before (memory.md §6).
  v_reversal_id uuid := gen_random_uuid();
  v_req      public.approval_requests%rowtype;
  v_decision uuid;
  v_class    jsonb;
  v_claimed  integer;
  v_request  jsonb := jsonb_build_object('payment_id', p_payment_id, 'outcome', 'approved');
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'settlement.approve_reversal', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_reversal from public.payments where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'reversal', to_jsonb(v_reversal));
  end if;

  select * into v_payment from public.payments where id = p_payment_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_payment');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('payment:' || p_payment_id::text, 0));

  select * into v_req from public.approval_requests
   where entity_type = 'payment' and entity_id = p_payment_id
     and approval_type = 'payment_reversal' and status = 'pending'
   order by request_seq desc limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_approval_request');
  end if;

  if exists (select 1 from public.payments p where p.reverses_id = p_payment_id) then
    return jsonb_build_object('ok', false, 'reason', 'already_reversed');
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'settlement.approve_reversal', v_reversal_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'settlement.approve_reversal', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    select * into v_reversal from public.payments where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'reversal', to_jsonb(v_reversal));
  end if;

  v_decision := private.settle_approval(v_req.id, 'approved', v_actor, v_role, null);

  -- A NEW, negative row. The original stays exactly as it was recorded when the money came in.
  insert into public.payments (
    id, invoice_id, amount_tzs, method, reverses_id,
    received_by, received_role, business_date, correlation_id
  )
  values (
    v_reversal_id,
    v_payment.invoice_id, -v_payment.amount_tzs, v_payment.method, p_payment_id,
    v_actor, v_role, private.business_date(), v_corr
  )
  returning * into v_reversal;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, approval_reference, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'payment_reversed', 'payment', p_payment_id,
    jsonb_build_object('amount_tzs', v_payment.amount_tzs),
    jsonb_build_object('reversal_id', v_reversal.id, 'amount_tzs', v_reversal.amount_tzs,
                       'decision_id', v_decision),
    v_req.id, v_corr, 'api.admin_approve_payment_reversal'
  );

  return jsonb_build_object('ok', true, 'reason', 'reversed', 'reversal', to_jsonb(v_reversal));
end;
$$;

comment on function api.admin_approve_payment_reversal(uuid, text) is
  'Director approval of a payment reversal (product.md §4.1, AC-21). Writes a NEW negative payment '
  'row; the original is never edited, because what was counted at the till must still read the same.';

-- ---------------------------------------------------------------------------
-- The ownership and grant rule, re-applied over the whole api schema.
-- ---------------------------------------------------------------------------
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure::text as signature
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'api'
  loop
    execute format('alter function %s owner to fv_definer_owner', fn.signature);
  end loop;
end
$$;

revoke execute on all functions in schema api from public, anon, authenticated, service_role;

do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure::text as signature, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'api'
  loop
    if fn.proname like 'admin\_%' or fn.proname like 'self\_%' or fn.proname like 'staff\_%' then
      execute format('grant execute on function %s to authenticated', fn.signature);
    elsif fn.proname like 'service\_%' then
      execute format('grant execute on function %s to service_role', fn.signature);
    else
      raise exception 'api.% has no audience prefix (admin_, staff_, self_ or service_)', fn.proname;
    end if;
  end loop;
end
$$;

commit;
