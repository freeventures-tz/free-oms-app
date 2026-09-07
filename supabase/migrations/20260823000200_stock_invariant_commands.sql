-- Issue #7 · The commands that obey the stock invariant, and the refusals they now record
--
-- Companion to 20260823000100_stock_invariant.sql, which holds the rule, the lock helpers and the
-- constraint that enforces §8.1 whether a command remembers to ask or not. This file changes the
-- commands themselves.
--
-- TWO CHANGES, and they are separable.
--
-- 1. THE CHECK. Production consumption and negative corrections now ask both questions the rule
--    defines — does the business still own this unpromised, and does this place physically hold it
--    — through `private.claim_stock_for_withdrawal`. Transfers ask the location question through
--    `private.claim_location_stock`.
--
--    WHAT IS NOT HERE, AND WHY. `api.staff_confirm_order`, `api.staff_take_cash_payment` and
--    `api.staff_confirm_release` make the same claims on the same stock, and the helpers in
--    migration 20260823000100 are written for them to call. They are NOT re-issued here: Stage 12B
--    re-issues every sales and settlement command, and two migrations rewriting one function would
--    mean whichever landed second silently reverted the other. The owner's decision is that this
--    ticket keeps to inventory and production, and Stage 12B adopts the helpers.
--
--    Nothing is left unprotected by the wait, and migration 20260823000100 sets out exactly why for
--    each of the three. In short: the two sales commands already take `stock:<product>`, the key
--    `private.lock_product_stock` was built to reproduce; release takes only the location key and
--    needs no more, because a release does not move the §8.1 figure at all.
--
-- 2. THE REFUSAL RECORD. architecture.md §14.2 has always said a refusal returns rather than raises
--    SO THAT the transaction commits its audit row. The returning was built and the row was not. A
--    refused attempt to grind up eighty bags somebody had already paid for left no trace at all.
--
--    Rather than edit a hundred and twenty return sites and hope the hundred and twenty-first
--    remembers, each command moves into `private` under an `impl_` name and gains a thin `api`
--    wrapper that records any `ok: false` result through `private.refuse`. The wrapper is the only
--    new place a refusal can escape through, and there is one per command.
--
--    `private.refuse` is the helper Stage 12B uses for the same job on the sales and settlement
--    commands, defined identically in both migrations so neither depends on the other's merge
--    order. One helper, so the audit trail has one shape.
--
--    A REPLAY IS NOT A REFUSAL. It carries `ok: true`, and the operation it replays was audited
--    when it committed. An authority failure is not one either: `private.acting_staff` RAISES, the
--    transaction rolls back, and nothing may claim to have audited it (§14.2, second row).
--
-- The `api` surface is unchanged in count, name and signature. What a caller sees is identical
-- except that a refusal now carries the numbers the interface needs to explain it.
--
-- EXTRACTED ONTO THE v0.0.5 BOUNDARY. This pair was written on a branch that never included the
-- four releases, so the three bodies restated below were re-derived from the functions as they
-- actually stand at `525418e` — read back with `pg_get_functiondef` from a database holding
-- exactly the 34 released migrations, and diffed line by line against the branch's versions. The
-- three agreed everywhere except at the stock check, which is the only edit made to them here.
-- The other thirteen commands are never restated at all: `alter function ... set schema` carries
-- whichever body production actually has, so a released correction cannot be reverted by this
-- migration even in principle.

begin;


-- ---------------------------------------------------------------------------
-- Every command governed by the invariant moves into `private` under `impl_`
--
-- `alter function ... set schema` preserves the body, the owner and the grants. The grants are then
-- taken back below: nothing in `private` is callable by `authenticated`, and the wrapper is what
-- the browser reaches.
-- ---------------------------------------------------------------------------
alter function api.admin_add_supplier(text, text) set schema private;
alter function private.admin_add_supplier(text, text) rename to impl_admin_add_supplier;
alter function api.admin_set_supplier_active(uuid, boolean, text) set schema private;
alter function private.admin_set_supplier_active(uuid, boolean, text) rename to impl_admin_set_supplier_active;
alter function api.admin_record_opening_stock(uuid, text, bigint, text, text) set schema private;
alter function private.admin_record_opening_stock(uuid, text, bigint, text, text) rename to impl_admin_record_opening_stock;
alter function api.staff_enter_stock_receipt(uuid, text, date, text, jsonb, text) set schema private;
alter function private.staff_enter_stock_receipt(uuid, text, date, text, jsonb, text) rename to impl_staff_enter_stock_receipt;
alter function api.staff_approve_stock_receipt(uuid, text) set schema private;
alter function private.staff_approve_stock_receipt(uuid, text) rename to impl_staff_approve_stock_receipt;
alter function api.staff_reject_stock_receipt(uuid, text, text) set schema private;
alter function private.staff_reject_stock_receipt(uuid, text, text) rename to impl_staff_reject_stock_receipt;
alter function api.staff_enter_stock_transfer(text, text, text, jsonb, text) set schema private;
alter function private.staff_enter_stock_transfer(text, text, text, jsonb, text) rename to impl_staff_enter_stock_transfer;
alter function api.staff_approve_stock_transfer(uuid, text) set schema private;
alter function private.staff_approve_stock_transfer(uuid, text) rename to impl_staff_approve_stock_transfer;
alter function api.staff_reject_stock_transfer(uuid, text, text) set schema private;
alter function private.staff_reject_stock_transfer(uuid, text, text) rename to impl_staff_reject_stock_transfer;
alter function api.staff_enter_stock_adjustment(uuid, text, bigint, text, text) set schema private;
alter function private.staff_enter_stock_adjustment(uuid, text, bigint, text, text) rename to impl_staff_enter_stock_adjustment;
alter function api.admin_approve_stock_adjustment(uuid, text) set schema private;
alter function private.admin_approve_stock_adjustment(uuid, text) rename to impl_admin_approve_stock_adjustment;
alter function api.admin_reject_stock_adjustment(uuid, text, text) set schema private;
alter function private.admin_reject_stock_adjustment(uuid, text, text) rename to impl_admin_reject_stock_adjustment;
alter function api.staff_enter_production_batch(text, timestamp with time zone, jsonb, jsonb, text, text) set schema private;
alter function private.staff_enter_production_batch(text, timestamp with time zone, jsonb, jsonb, text, text) rename to impl_staff_enter_production_batch;
alter function api.staff_approve_production_batch(uuid, text) set schema private;
alter function private.staff_approve_production_batch(uuid, text) rename to impl_staff_approve_production_batch;
alter function api.staff_reject_production_batch(uuid, text, text) set schema private;
alter function private.staff_reject_production_batch(uuid, text, text) rename to impl_staff_reject_production_batch;
alter function api.staff_inspect_curing_lot(uuid, bigint, bigint, text, text) set schema private;
alter function private.staff_inspect_curing_lot(uuid, bigint, bigint, text, text) rename to impl_staff_inspect_curing_lot;

-- ---------------------------------------------------------------------------
-- The three bodies that change, replaced in place
--
-- Taken verbatim from the functions above; every line not shown as changed is the line that was
-- there before. What changed in each is the stock check and nothing else.
-- ---------------------------------------------------------------------------

create or replace function private.impl_staff_approve_stock_transfer(p_transfer_id uuid, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor     uuid := private.acting_staff(array['manager']::public.app_role[]);
  v_role      public.app_role := private.live_role_of(v_actor);
  v_corr      uuid := gen_random_uuid();
  v_transfer  public.stock_transfers%rowtype;
  v_req       public.approval_requests%rowtype;
  v_line      public.stock_transfer_lines%rowtype;
  v_refusal   jsonb;
  v_decision  uuid;
  v_class     jsonb;
  v_claimed   integer;
  v_request   jsonb := jsonb_build_object('transfer_id', p_transfer_id, 'outcome', 'approved');
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'inventory.approve_transfer', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_transfer from public.stock_transfers where id = p_transfer_id;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'transfer', to_jsonb(v_transfer));
  end if;

  select * into v_transfer from public.stock_transfers where id = p_transfer_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_transfer');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('stock_transfer:' || p_transfer_id::text, 0));

  select * into v_req from public.approval_requests
   where entity_type = 'stock_transfer' and entity_id = p_transfer_id
     and approval_type = 'stock_transfer';

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_approval_request');
  end if;

  if v_req.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'already_settled',
                              'status', v_req.status::text);
  end if;

  -- The source is checked HERE, at the moment stock moves, and not at entry — because between
  -- entry and approval a receipt could have been rejected, another transfer approved, or a batch
  -- consumed the same sand.
  --
  -- Locked in product order, and the shared claim takes the product lock before the location
  -- lock, so a transfer serialises against a reservation and a batch rather than racing them.
  --
  -- The LOCATION is the only question a transfer has to answer. Moving goods between our own
  -- places takes nothing out of the business, so it cannot consume a customer's promise however
  -- large that promise is — which is why this is claim_location_stock and not the withdrawal one.
  for v_line in
    select * from public.stock_transfer_lines
     where transfer_id = p_transfer_id order by product_id
  loop
    v_refusal := private.claim_location_stock(
      v_line.product_id, v_transfer.from_location, v_line.quantity);

    if v_refusal is not null then
      return v_refusal;
    end if;
  end loop;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'inventory.approve_transfer', p_transfer_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'inventory.approve_transfer', v_actor, v_request);

    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;

    return jsonb_build_object('ok', true, 'reason', 'replayed', 'transfer', to_jsonb(v_transfer));
  end if;

  v_decision := private.settle_approval(v_req.id, 'approved', v_actor, v_role, null);

  for v_line in
    select * from public.stock_transfer_lines
     where transfer_id = p_transfer_id order by product_id
  loop
    perform private.write_stock_movement(
      v_line.product_id, v_transfer.from_location, 'available',
      -v_line.quantity, 'transfer_out', 'stock_transfer', p_transfer_id,
      v_transfer.entered_by, v_transfer.entered_role, v_actor, v_role, v_corr);

    perform private.write_stock_movement(
      v_line.product_id, v_transfer.to_location, 'available',
      v_line.quantity, 'transfer_in', 'stock_transfer', p_transfer_id,
      v_transfer.entered_by, v_transfer.entered_role, v_actor, v_role, v_corr);
  end loop;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, approval_reference, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false,
    'stock_transfer_approved', 'stock_transfer', p_transfer_id,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'approved', 'decision_id', v_decision),
    v_req.id, v_corr, 'api.staff_approve_stock_transfer'
  );

  return jsonb_build_object('ok', true, 'reason', 'approved', 'transfer', to_jsonb(v_transfer));
end;
$function$;

create or replace function private.impl_admin_approve_stock_adjustment(p_adjustment_id uuid, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor      uuid := private.acting_director();
  v_role       public.app_role := private.live_role_of(v_actor);
  v_corr       uuid := gen_random_uuid();
  v_adjustment public.stock_adjustments%rowtype;
  v_req        public.approval_requests%rowtype;
  v_available  bigint;
  v_refusal    jsonb;
  v_decision   uuid;
  v_class      jsonb;
  v_claimed    integer;
  v_request    jsonb := jsonb_build_object(
    'adjustment_id', p_adjustment_id, 'outcome', 'approved');
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'inventory.approve_adjustment', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_adjustment from public.stock_adjustments where id = p_adjustment_id;
    return jsonb_build_object('ok', true, 'reason', 'replayed',
                              'adjustment', to_jsonb(v_adjustment));
  end if;

  select * into v_adjustment from public.stock_adjustments where id = p_adjustment_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_adjustment');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('stock_adjustment:' || p_adjustment_id::text, 0));

  select * into v_req from public.approval_requests
   where entity_type = 'stock_adjustment' and entity_id = p_adjustment_id
     and approval_type = 'stock_adjustment';

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_approval_request');
  end if;

  if v_req.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'already_settled',
                              'status', v_req.status::text);
  end if;

  -- A CORRECTION DOWNWARD TAKES STOCK OUT OF THE BUSINESS, so it answers both questions: the
  -- business must still own the quantity unpromised, and the place must physically hold it.
  -- Reading only the location is the defect this migration exists to fix -- eighty bags sold to a
  -- customer are still standing in the yard, and writing them off leaves the customer with nothing.
  --
  -- A correction UPWARD takes nothing out and is refused by nothing. It still takes the locks, so
  -- the balance it is added to is the balance that was there.
  if v_adjustment.quantity_delta < 0 then
    v_refusal := private.claim_stock_for_withdrawal(
      v_adjustment.product_id, v_adjustment.location_code, -v_adjustment.quantity_delta);

    if v_refusal is not null then
      return v_refusal;
    end if;
  else
    perform private.lock_product_stock(v_adjustment.product_id);
    perform private.lock_location_stock(v_adjustment.product_id, v_adjustment.location_code);
  end if;

  v_available := private.stock_on_hand(
    v_adjustment.product_id, v_adjustment.location_code, 'available');

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'inventory.approve_adjustment', p_adjustment_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'inventory.approve_adjustment', v_actor, v_request);

    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;

    return jsonb_build_object('ok', true, 'reason', 'replayed',
                              'adjustment', to_jsonb(v_adjustment));
  end if;

  v_decision := private.settle_approval(v_req.id, 'approved', v_actor, v_role, null);

  perform private.write_stock_movement(
    v_adjustment.product_id, v_adjustment.location_code, 'available',
    v_adjustment.quantity_delta, 'stock_adjustment',
    'stock_adjustment', p_adjustment_id,
    v_adjustment.entered_by, v_adjustment.entered_role, v_actor, v_role, v_corr);

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, approval_reference, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false,
    'stock_adjustment_approved', 'stock_adjustment', p_adjustment_id,
    jsonb_build_object('status', 'pending', 'available_before', v_available),
    jsonb_build_object('status', 'approved', 'decision_id', v_decision,
                       'available_after', v_available + v_adjustment.quantity_delta),
    v_req.id, v_corr, 'api.admin_approve_stock_adjustment'
  );

  return jsonb_build_object('ok', true, 'reason', 'approved',
                            'adjustment', to_jsonb(v_adjustment));
end;
$function$;

create or replace function private.impl_staff_approve_production_batch(p_batch_id uuid, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor     uuid := private.acting_staff(array['manager']::public.app_role[]);
  v_role      public.app_role := private.live_role_of(v_actor);
  v_corr      uuid := gen_random_uuid();
  v_batch     public.production_batches%rowtype;
  v_input     public.production_batch_inputs%rowtype;
  v_lot       public.production_lots%rowtype;
  v_refusal   jsonb;
  v_class     jsonb;
  v_claimed   integer;
  v_request   jsonb := jsonb_build_object('batch_id', p_batch_id, 'outcome', 'approved');
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'production.approve_batch', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_batch from public.production_batches where id = p_batch_id;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'batch', to_jsonb(v_batch));
  end if;

  perform pg_advisory_xact_lock(hashtextextended('batch:' || p_batch_id::text, 0));

  select * into v_batch from public.production_batches where id = p_batch_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_batch');
  end if;

  if v_batch.status <> 'draft' then
    return jsonb_build_object('ok', false, 'reason', 'already_settled',
                              'status', v_batch.status::text);
  end if;

  -- EVERY INPUT HAS TO BE THERE, AND HAVE TO BE OURS TO TAKE, before anything is consumed.
  --
  -- The second half is the fix. This loop used to read the yard's physical balance and nothing
  -- else, so a batch could grind up cement a customer had already paid for: the bags were standing
  -- right there, and the dispatch that followed found an empty yard. product.md §8.1 says available
  -- stock is physical minus reserved and committed, and consumption is exactly as much a claim on
  -- it as a sale is.
  --
  -- Locked in product order, product lock before location lock, so two batches cannot deadlock and
  -- neither can overtake a reservation.
  for v_input in
    select * from public.production_batch_inputs where batch_id = p_batch_id order by product_id
  loop
    v_refusal := private.claim_stock_for_withdrawal(
      v_input.product_id, v_batch.location_code, v_input.actual_quantity);

    if v_refusal is not null then
      return v_refusal;
    end if;
  end loop;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'production.approve_batch', p_batch_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'production.approve_batch', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'batch', to_jsonb(v_batch));
  end if;

  update public.production_batches
     set status = 'approved', decided_by = v_actor, decided_role = v_role, decided_at = now()
   where id = p_batch_id
  returning * into v_batch;

  -- THE ACTUAL, not the standard (AC-38). §11.1 is explicit that the variance is never used to
  -- adjust the deduction back toward the recipe.
  for v_input in
    select * from public.production_batch_inputs where batch_id = p_batch_id order by product_id
  loop
    perform private.write_stock_movement(
      v_input.product_id, v_batch.location_code, 'available',
      -v_input.actual_quantity, 'production_input',
      'production_batch', p_batch_id,
      v_batch.entered_by, v_batch.entered_role, v_actor, v_role, v_corr);
  end loop;

  -- Into CURING, not into available stock. §11.4 and AC-44: reaching the end of curing does not by
  -- itself make a brick sellable, and putting it in `available` now would say it does.
  --
  -- Rejects at moulding never enter the ledger at all: §8 records them as unsellable, and V1 has no
  -- disposal workflow to move them through.
  for v_lot in
    select * from public.production_lots where batch_id = p_batch_id order by product_id
  loop
    perform private.write_stock_movement(
      v_lot.product_id, v_batch.location_code, 'curing',
      v_lot.quantity_moulded - v_lot.rejected_at_moulding, 'production_output',
      'production_batch', p_batch_id,
      v_batch.entered_by, v_batch.entered_role, v_actor, v_role, v_corr);
  end loop;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'production_batch_approved', 'production_batch', p_batch_id,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'approved', 'batch_no', v_batch.batch_no),
    v_corr, 'api.staff_approve_production_batch'
  );

  return jsonb_build_object('ok', true, 'reason', 'approved', 'batch', to_jsonb(v_batch));
end;
$function$;

-- ---------------------------------------------------------------------------
-- The wrappers · one per command, and the only place a refusal can leave through
-- ---------------------------------------------------------------------------

create or replace function api.admin_add_supplier(p_name text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := private.impl_admin_add_supplier(p_name, p_idempotency_key);

  if coalesce((v_result ->> 'ok')::boolean, false) then
    return v_result;
  end if;

  return private.refuse('api.admin_add_supplier', 'supplier', null, v_result);
end;
$$;

comment on function api.admin_add_supplier(text, text) is
  'Registers a supplier, Director-only. product.md defines no supplier record, so this holds a '
  'name and nothing invented. Deactivated, never deleted.';

create or replace function api.admin_set_supplier_active(p_supplier_id uuid, p_is_active boolean, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := private.impl_admin_set_supplier_active(p_supplier_id, p_is_active, p_idempotency_key);

  if coalesce((v_result ->> 'ok')::boolean, false) then
    return v_result;
  end if;

  return private.refuse('api.admin_set_supplier_active', 'supplier', p_supplier_id, v_result);
end;
$$;

comment on function api.admin_set_supplier_active(uuid, boolean, text) is
  'Switches a supplier off or back on, Director-only. There is no rename and no delete: a '
  'receipt references its supplier permanently.';

create or replace function api.admin_record_opening_stock(p_product_id uuid, p_location_code text, p_quantity bigint, p_note text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := private.impl_admin_record_opening_stock(p_product_id, p_location_code, p_quantity, p_note, p_idempotency_key);

  if coalesce((v_result ->> 'ok')::boolean, false) then
    return v_result;
  end if;

  return private.refuse('api.admin_record_opening_stock', 'product', p_product_id, v_result);
end;
$$;

comment on function api.admin_record_opening_stock(uuid, text, bigint, text, text) is
  'The baseline a location starts from, once per product and location, Director-only. A '
  'quantity of zero is recorded as an entry with no movement behind it, because "none" and "not '
  'yet counted" are different answers.';

create or replace function api.staff_enter_stock_receipt(p_supplier_id uuid, p_location_code text, p_delivery_date date, p_delivery_note_ref text, p_lines jsonb, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := private.impl_staff_enter_stock_receipt(p_supplier_id, p_location_code, p_delivery_date, p_delivery_note_ref, p_lines, p_idempotency_key);

  if coalesce((v_result ->> 'ok')::boolean, false) then
    return v_result;
  end if;

  return private.refuse('api.staff_enter_stock_receipt', 'supplier', p_supplier_id, v_result);
end;
$$;

comment on function api.staff_enter_stock_receipt(uuid, text, date, text, jsonb, text) is
  'Records what arrived from a supplier (product.md §9). Entry may be delegated to a Cashier or '
  'a Sales Representative (§9.1). Writes NO ledger row: stock increases only on Manager '
  'approval.';

create or replace function api.staff_approve_stock_receipt(p_receipt_id uuid, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := private.impl_staff_approve_stock_receipt(p_receipt_id, p_idempotency_key);

  if coalesce((v_result ->> 'ok')::boolean, false) then
    return v_result;
  end if;

  return private.refuse('api.staff_approve_stock_receipt', 'stock_receipt', p_receipt_id, v_result);
end;
$$;

comment on function api.staff_approve_stock_receipt(uuid, text) is
  'Manager approval of a supplier receipt, and the moment stock increases (product.md §9.1). '
  'Adds the ACCEPTED quantity — received minus damaged — because §8 records damaged goods as '
  'unsellable.';

create or replace function api.staff_reject_stock_receipt(p_receipt_id uuid, p_reason text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := private.impl_staff_reject_stock_receipt(p_receipt_id, p_reason, p_idempotency_key);

  if coalesce((v_result ->> 'ok')::boolean, false) then
    return v_result;
  end if;

  return private.refuse('api.staff_reject_stock_receipt', 'stock_receipt', p_receipt_id, v_result);
end;
$$;

comment on function api.staff_reject_stock_receipt(uuid, text, text) is
  'Manager rejection of a supplier receipt. Records NO approver (product.md §4.3, AC-84) and '
  'moves no stock. A corrected delivery is a new receipt, never a second verdict on this one.';

create or replace function api.staff_enter_stock_transfer(p_from_location text, p_to_location text, p_note text, p_lines jsonb, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := private.impl_staff_enter_stock_transfer(p_from_location, p_to_location, p_note, p_lines, p_idempotency_key);

  if coalesce((v_result ->> 'ok')::boolean, false) then
    return v_result;
  end if;

  return private.refuse('api.staff_enter_stock_transfer', 'stock_transfer', null, v_result);
end;
$$;

comment on function api.staff_enter_stock_transfer(text, text, text, jsonb, text) is
  'Records an intended move between locations (product.md §10). Moves nothing: balances change '
  'only on Manager approval, and the source is checked there rather than here.';

create or replace function api.staff_approve_stock_transfer(p_transfer_id uuid, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := private.impl_staff_approve_stock_transfer(p_transfer_id, p_idempotency_key);

  if coalesce((v_result ->> 'ok')::boolean, false) then
    return v_result;
  end if;

  return private.refuse('api.staff_approve_stock_transfer', 'stock_transfer', p_transfer_id, v_result);
end;
$$;

comment on function api.staff_approve_stock_transfer(uuid, text) is
  'Manager approval of an internal transfer, and the moment balances change (product.md §10). '
  'The source is re-checked here because stock can move between entry and approval. Only the '
  'LOCATION is checked: a transfer moves goods between our own places and takes nothing out of '
  'the business, so promised stock may still be moved (§8.1).';

create or replace function api.staff_reject_stock_transfer(p_transfer_id uuid, p_reason text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := private.impl_staff_reject_stock_transfer(p_transfer_id, p_reason, p_idempotency_key);

  if coalesce((v_result ->> 'ok')::boolean, false) then
    return v_result;
  end if;

  return private.refuse('api.staff_reject_stock_transfer', 'stock_transfer', p_transfer_id, v_result);
end;
$$;

comment on function api.staff_reject_stock_transfer(uuid, text, text) is
  'Manager rejection of an internal transfer. Records no approver (product.md §4.3) and moves '
  'nothing.';

create or replace function api.staff_enter_stock_adjustment(p_product_id uuid, p_location_code text, p_quantity_delta bigint, p_reason text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := private.impl_staff_enter_stock_adjustment(p_product_id, p_location_code, p_quantity_delta, p_reason, p_idempotency_key);

  if coalesce((v_result ->> 'ok')::boolean, false) then
    return v_result;
  end if;

  return private.refuse('api.staff_enter_stock_adjustment', 'stock_adjustment', null, v_result);
end;
$$;

comment on function api.staff_enter_stock_adjustment(uuid, text, bigint, text, text) is
  'A Manager-entered correction to stock, awaiting Director approval (product.md §4.1). Moves '
  'nothing. The reason is required because no delivery note or transfer explains this one.';

create or replace function api.admin_approve_stock_adjustment(p_adjustment_id uuid, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := private.impl_admin_approve_stock_adjustment(p_adjustment_id, p_idempotency_key);

  if coalesce((v_result ->> 'ok')::boolean, false) then
    return v_result;
  end if;

  return private.refuse('api.admin_approve_stock_adjustment', 'stock_adjustment', p_adjustment_id, v_result);
end;
$$;

comment on function api.admin_approve_stock_adjustment(uuid, text) is
  'Director approval of a manual stock adjustment (product.md §4.1), and the moment it takes '
  'effect. A DOWNWARD correction takes stock out of the business, so it is refused when it would '
  'drive AVAILABLE stock below zero (§8.1) as well as when the location cannot supply it. An '
  'upward correction takes nothing out and is refused by neither.';

create or replace function api.admin_reject_stock_adjustment(p_adjustment_id uuid, p_reason text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := private.impl_admin_reject_stock_adjustment(p_adjustment_id, p_reason, p_idempotency_key);

  if coalesce((v_result ->> 'ok')::boolean, false) then
    return v_result;
  end if;

  return private.refuse('api.admin_reject_stock_adjustment', 'stock_adjustment', p_adjustment_id, v_result);
end;
$$;

comment on function api.admin_reject_stock_adjustment(uuid, text, text) is
  'Director rejection of a manual stock adjustment. Records no approver (product.md §4.3) and '
  'changes no balance.';

create or replace function api.staff_enter_production_batch(p_location_code text, p_moulded_at timestamp with time zone, p_inputs jsonb, p_outputs jsonb, p_yield_note text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := private.impl_staff_enter_production_batch(p_location_code, p_moulded_at, p_inputs, p_outputs, p_yield_note, p_idempotency_key);

  if coalesce((v_result ->> 'ok')::boolean, false) then
    return v_result;
  end if;

  return private.refuse('api.staff_enter_production_batch', 'production_batch', null, v_result);
end;
$$;

comment on function api.staff_enter_production_batch(text, timestamp with time zone, jsonb, jsonb, text, text) is
  'Records a mixer batch: the actual quantities used and the bricks moulded (product.md §11). '
  'Deducts NOTHING — the Manager approves, and that is what consumes the yard (§11.1, AC-39).';

create or replace function api.staff_approve_production_batch(p_batch_id uuid, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := private.impl_staff_approve_production_batch(p_batch_id, p_idempotency_key);

  if coalesce((v_result ->> 'ok')::boolean, false) then
    return v_result;
  end if;

  return private.refuse('api.staff_approve_production_batch', 'production_batch', p_batch_id, v_result);
end;
$$;

comment on function api.staff_approve_production_batch(uuid, text) is
  'Manager approval of a batch, and the moment the yard is consumed (product.md §11.1, AC-38). '
  'Deducts the CONFIRMED ACTUAL quantities and puts the output into CURING, never into '
  'available stock (§11.4, AC-44). Checks AVAILABLE stock — physical minus reserved and '
  'committed (§8.1) — and then the location separately, so a batch cannot consume material a '
  'customer has already been promised however full the yard looks.';

create or replace function api.staff_reject_production_batch(p_batch_id uuid, p_reason text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := private.impl_staff_reject_production_batch(p_batch_id, p_reason, p_idempotency_key);

  if coalesce((v_result ->> 'ok')::boolean, false) then
    return v_result;
  end if;

  return private.refuse('api.staff_reject_production_batch', 'production_batch', p_batch_id, v_result);
end;
$$;

comment on function api.staff_reject_production_batch(uuid, text, text) is
  'Rejects a batch. Records no approver (product.md §4.3), consumes nothing and produces '
  'nothing.';

create or replace function api.staff_inspect_curing_lot(p_lot_id uuid, p_accepted bigint, p_rejected bigint, p_reject_reason text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := private.impl_staff_inspect_curing_lot(p_lot_id, p_accepted, p_rejected, p_reject_reason, p_idempotency_key);

  if coalesce((v_result ->> 'ok')::boolean, false) then
    return v_result;
  end if;

  return private.refuse('api.staff_inspect_curing_lot', 'production_lot', p_lot_id, v_result);
end;
$$;

comment on function api.staff_inspect_curing_lot(uuid, bigint, bigint, text, text) is
  'The Manager inspecting a cured lot (product.md §11.4). Refused before 72 hours, and ONLY the '
  'accepted quantity becomes available for sale (AC-44, AC-45).';

-- ---------------------------------------------------------------------------
-- Ownership and grants, re-applied over both schemas
--
-- The same control migration 20260822000400 established, for the same stated reason: a function
-- created without an explicit REVOKE keeps PostgreSQL's default, in which PUBLIC holds EXECUTE.
-- `alter default privileges ... revoke execute` writes no pg_default_acl row on this database, so
-- these loops are the control and not housekeeping.
-- ---------------------------------------------------------------------------
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure::text as signature
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('api', 'private')
  loop
    execute format('alter function %s owner to fv_definer_owner', fn.signature);
  end loop;
end
$$;

-- The `private` revoke is TARGETED at the functions this migration moved, and that is not fussiness.
--
-- A blanket `revoke execute on all functions in schema private from authenticated` was written here
-- first, and pgTAP 006 refused it: `private.authorize`, `private.request_uid` and
-- `private.current_role_hint` are granted to `authenticated` on purpose, because every RLS policy in
-- the database calls them from its own USING clause. Revoking them does not lock the schema down —
-- it stops every policy evaluating, for everybody.
--
-- The moved functions are the only ones whose grants need taking back: they arrived here carrying
-- the EXECUTE that `authenticated` held on them while they lived in `api`.
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure::text as signature
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'private' and p.proname like 'impl\_%'
  loop
    execute format(
      'revoke execute on function %s from public, anon, authenticated, service_role',
      fn.signature);
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
