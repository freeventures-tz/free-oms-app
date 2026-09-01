-- Stage 13 · The four production commands
--
-- The tables, the view, the reference data and every grant and policy that protects them were
-- created and closed in the migration before this one, so there is no window in which a public
-- production table exists without row-level security on it. This file adds behaviour only.
--
-- product.md §4.1: "Production release and production batch — Manager / Manager." Entry and
-- approval are both the Manager's, and §4.2 keeps them two separate acts: recording a batch
-- deducts nothing, and approving it is a deliberate second step that consumes the yard.
--
-- No command below takes an actor. Every one derives the acting person and the role they hold at
-- this instant from the verified JWT, through the same `private.acting_staff` the inventory
-- commands use, so a caller cannot name somebody else as the Manager who approved.

begin;

-- ---------------------------------------------------------------------------
-- api.staff_enter_production_batch
--
-- Records what a batch used and what it produced. DEDUCTS NOTHING and PRODUCES NOTHING: §11.1 says
-- the deduction affects stock only after the Manager approves, and AC-39 says a batch cannot be
-- completed until actual usage is recorded — which is why the actual quantities are required here
-- rather than defaulted at approval.
--
-- EVERY VALIDATION HAPPENS BEFORE THE FIRST INSERT. A payload that is refused leaves no batch, no
-- input line, no lot and no claimed idempotency key, so a Manager who fixes a typo and sends the
-- same request again is entering their first batch rather than their second.
-- ---------------------------------------------------------------------------
create or replace function api.staff_enter_production_batch(
  p_location_code   text,
  p_moulded_at      timestamptz,
  p_inputs          jsonb,
  p_outputs         jsonb,
  p_yield_note      text,
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
  v_note      text := nullif(private.normalise_label(p_yield_note), '');
  v_corr      uuid := gen_random_uuid();
  v_batch_id  uuid := gen_random_uuid();
  v_batch     public.production_batches%rowtype;
  v_line      jsonb;
  v_product   uuid;
  v_quantity  numeric;
  v_rejected  numeric;
  v_reason    text;
  v_distinct  integer;
  v_total     integer;
  v_expected  integer;
  v_confirmed integer;
  v_outside   boolean := false;
  v_class     jsonb;
  v_claimed   integer;
  -- THE WHOLE REQUEST, including the explanation. Idempotency compares this against what the key
  -- was first used for, so anything business-significant that is left out of it is something a
  -- second send may quietly change while replaying the first result. The yield note is exactly
  -- that: it is the Manager's account of an out-of-range batch, kept permanently on the record.
  -- Normalised rather than raw, so a difference in surrounding whitespace is not a conflict.
  v_request   jsonb := jsonb_build_object(
    'location_code', p_location_code,
    'moulded_at',    p_moulded_at,
    'inputs',        coalesce(p_inputs, '[]'::jsonb),
    'outputs',       coalesce(p_outputs, '[]'::jsonb),
    'yield_note',    v_note);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'production.enter_batch', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_batch from public.production_batches where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'batch', to_jsonb(v_batch));
  end if;

  if not exists (select 1 from public.inventory_locations l where l.code = p_location_code) then
    return jsonb_build_object('ok', false, 'reason', 'no_location');
  end if;

  -- §11.4: curing starts at the moulding-completion time. A time in the future would start a
  -- countdown that has not begun.
  if p_moulded_at is null or p_moulded_at > now() then
    return jsonb_build_object('ok', false, 'reason', 'moulded_at_invalid');
  end if;

  -- INPUTS. Every one must carry a confirmed actual quantity (AC-39).
  if p_inputs is null or jsonb_typeof(p_inputs) <> 'array' or jsonb_array_length(p_inputs) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'inputs_required');
  end if;

  for v_line in select t.elem from jsonb_array_elements(p_inputs) as t(elem) loop
    -- `is distinct from` rather than `<>`, and the element's own type checked first. A line that
    -- is a number, a string or null has no `product_id` at all, and `jsonb_typeof` of a missing
    -- key is NULL — which `<>` answers with NULL, and an `if NULL then` falls straight through the
    -- guard it was written to be.
    if jsonb_typeof(v_line) is distinct from 'object'
       or jsonb_typeof(v_line -> 'product_id') is distinct from 'string'
       or jsonb_typeof(v_line -> 'actual_quantity') is distinct from 'number' then
      return jsonb_build_object('ok', false, 'reason', 'line_invalid');
    end if;

    -- Checked as text before it is cast. `'not-a-uuid'::uuid` raises, and a raise here would reach
    -- the client as a 500 rather than as the refusal it is.
    if (v_line ->> 'product_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return jsonb_build_object('ok', false, 'reason', 'line_invalid');
    end if;

    v_product := (v_line ->> 'product_id')::uuid;

    if not exists (
      select 1 from public.production_recipe_inputs r where r.product_id = v_product
    ) then
      -- An input that is not in the recipe has no standard to be measured against, so its variance
      -- would be meaningless (§11.1). The recipe is the set of things a batch consumes.
      return jsonb_build_object('ok', false, 'reason', 'not_a_recipe_input');
    end if;

    v_quantity := (v_line ->> 'actual_quantity')::numeric;

    -- Whole counting units: bags and buckets (§11.1, AC-120). Content is never a quantity.
    if v_quantity <> trunc(v_quantity) then
      return jsonb_build_object('ok', false, 'reason', 'quantity_not_whole');
    end if;

    if v_quantity < 0 or v_quantity > 10000 then
      return jsonb_build_object('ok', false, 'reason', 'quantity_invalid');
    end if;
  end loop;

  -- Counted AFTER the shape loop, never before it. A line that is not an object has no
  -- `product_id` at all, `count(distinct null)` is zero, and a single malformed line would
  -- otherwise be refused as a duplicate of itself — a true refusal with a false reason.
  select count(distinct t.elem ->> 'product_id'), count(*)
    into v_distinct, v_total from jsonb_array_elements(p_inputs) as t(elem);

  if v_distinct is distinct from v_total then
    return jsonb_build_object('ok', false, 'reason', 'duplicate_product_line');
  end if;

  -- EVERY RECIPE INPUT, CONFIRMED EXACTLY ONCE (AC-39, design.md §7.17).
  --
  -- "Actual usage must be recorded or confirmed before the batch can be completed." A payload
  -- carrying two of the three materials is not a confirmation of the third — it is silence about
  -- it, and silence would be stored as a batch that used no cement without anybody saying so.
  -- Confirming ZERO is different, and allowed: it is an answer, and its variance is recorded like
  -- any other.
  select count(*) into v_expected from public.production_recipe_inputs;

  select count(*) into v_confirmed
    from public.production_recipe_inputs r
   where exists (
     select 1 from jsonb_array_elements(p_inputs) as t(elem)
      where (t.elem ->> 'product_id')::uuid = r.product_id);

  if v_confirmed <> v_expected or v_total <> v_expected then
    return jsonb_build_object(
      'ok', false, 'reason', 'incomplete_recipe_inputs',
      'expected', v_expected, 'confirmed', v_confirmed);
  end if;

  -- OUTPUTS.
  if p_outputs is null or jsonb_typeof(p_outputs) <> 'array' or jsonb_array_length(p_outputs) = 0
  then
    return jsonb_build_object('ok', false, 'reason', 'outputs_required');
  end if;

  for v_line in select t.elem from jsonb_array_elements(p_outputs) as t(elem) loop
    if jsonb_typeof(v_line) is distinct from 'object'
       or jsonb_typeof(v_line -> 'product_id') is distinct from 'string'
       or jsonb_typeof(v_line -> 'quantity_moulded') is distinct from 'number' then
      return jsonb_build_object('ok', false, 'reason', 'line_invalid');
    end if;

    if (v_line ->> 'product_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return jsonb_build_object('ok', false, 'reason', 'line_invalid');
    end if;

    -- An absent reject count is zero; a present one has to be a number. `->>` on a string would
    -- otherwise reach `::numeric` and raise.
    if v_line ? 'rejected_quantity'
       and jsonb_typeof(v_line -> 'rejected_quantity') not in ('number', 'null') then
      return jsonb_build_object('ok', false, 'reason', 'line_invalid');
    end if;

    if v_line ? 'reject_reason'
       and jsonb_typeof(v_line -> 'reject_reason') not in ('string', 'null') then
      return jsonb_build_object('ok', false, 'reason', 'line_invalid');
    end if;

    v_product := (v_line ->> 'product_id')::uuid;

    if not exists (
      select 1 from public.production_yield_ranges y where y.product_id = v_product
    ) then
      -- §11.2 names two sizes. A batch that produced something else is not a brick batch.
      return jsonb_build_object('ok', false, 'reason', 'not_a_produced_product');
    end if;

    v_quantity := (v_line ->> 'quantity_moulded')::numeric;
    v_rejected := coalesce((v_line ->> 'rejected_quantity')::numeric, 0);
    v_reason   := nullif(btrim(coalesce(v_line ->> 'reject_reason', '')), '');

    if v_quantity <> trunc(v_quantity) or v_rejected <> trunc(v_rejected) then
      return jsonb_build_object('ok', false, 'reason', 'quantity_not_whole');
    end if;

    if v_quantity <= 0 or v_quantity > 100000 or v_rejected < 0 then
      return jsonb_build_object('ok', false, 'reason', 'quantity_invalid');
    end if;

    if v_rejected > v_quantity then
      return jsonb_build_object('ok', false, 'reason', 'rejects_exceed_output');
    end if;

    -- §11.5, AC-45: a reject count is chosen from the four preset reasons, never left blank.
    if v_rejected > 0 and v_reason is null then
      return jsonb_build_object('ok', false, 'reason', 'reject_reason_required');
    end if;

    if v_rejected > 0 and v_reason not in ('broken', 'cracked', 'undersized', 'weak') then
      return jsonb_build_object('ok', false, 'reason', 'reject_reason_invalid');
    end if;

    -- A reason with nothing to explain is a claim about nothing — and, left unchecked, a value the
    -- insert below would try to cast into the enum.
    if v_rejected = 0 and v_reason is not null then
      return jsonb_build_object('ok', false, 'reason', 'reject_reason_without_rejects');
    end if;

    -- §11.2, AC-41: outside the approved range is FLAGGED and explained, never blocked. The flag
    -- is what makes the explanation required a few lines below.
    if exists (
      select 1 from public.production_yield_ranges y
       where y.product_id = v_product
         and (v_quantity < y.min_per_batch or v_quantity > y.max_per_batch)
    ) then
      v_outside := true;
    end if;
  end loop;

  -- After the shape loop, for the reason given above the input version.
  select count(distinct t.elem ->> 'product_id'), count(*)
    into v_distinct, v_total from jsonb_array_elements(p_outputs) as t(elem);

  if v_distinct is distinct from v_total then
    return jsonb_build_object('ok', false, 'reason', 'duplicate_product_line');
  end if;

  if v_outside and v_note is null then
    return jsonb_build_object('ok', false, 'reason', 'yield_explanation_required');
  end if;

  -- An explanation with nothing to explain is a claim about nothing.
  if not v_outside and v_note is not null then
    return jsonb_build_object('ok', false, 'reason', 'yield_within_range');
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'production.enter_batch', v_batch_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'production.enter_batch', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    select * into v_batch from public.production_batches where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'batch', to_jsonb(v_batch));
  end if;

  insert into public.production_batches (
    id, batch_no, location_code, status, moulded_at, yield_note, entered_by, entered_role
  )
  values (
    v_batch_id, private.next_document_number('batch', 'FV-BAT'), p_location_code, 'draft',
    p_moulded_at, v_note, v_actor, v_role
  )
  returning * into v_batch;

  -- The standard is SNAPSHOTTED from the recipe, so a later change to it cannot rewrite what this
  -- batch was measured against.
  insert into public.production_batch_inputs (
    batch_id, product_id, standard_quantity, actual_quantity
  )
  select v_batch_id,
         (t.elem ->> 'product_id')::uuid,
         r.standard_quantity,
         (t.elem ->> 'actual_quantity')::bigint
    from jsonb_array_elements(p_inputs) as t(elem)
    join public.production_recipe_inputs r on r.product_id = (t.elem ->> 'product_id')::uuid;

  -- Every lot takes its own copy of the moulding time (§11.4). Two lots from one batch will share
  -- the value and are still two lots with two clocks.
  insert into public.production_lots (
    batch_id, product_id, quantity_moulded, rejected_at_moulding, moulding_reject_reason,
    curing_started_at
  )
  select v_batch_id,
         (t.elem ->> 'product_id')::uuid,
         (t.elem ->> 'quantity_moulded')::bigint,
         coalesce((t.elem ->> 'rejected_quantity')::bigint, 0),
         nullif(btrim(coalesce(t.elem ->> 'reject_reason', '')), '')::public.brick_reject_reason,
         p_moulded_at
    from jsonb_array_elements(p_outputs) as t(elem);

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'production_batch_entered', 'production_batch', v_batch_id,
    null,
    jsonb_build_object('batch_no', v_batch.batch_no, 'stock_moved', false,
                       'yield_outside_range', v_outside),
    v_corr, 'api.staff_enter_production_batch'
  );

  return jsonb_build_object('ok', true, 'reason', 'entered', 'batch', to_jsonb(v_batch),
                            'yield_outside_range', v_outside);
end;
$$;

comment on function api.staff_enter_production_batch(text, timestamptz, jsonb, jsonb, text, text) is
  'Records a mixer batch: the actual quantities used and the bricks moulded (product.md §11). '
  'Deducts NOTHING — the Manager approves, and that is what consumes the yard (§11.1, AC-39).';

-- ---------------------------------------------------------------------------
-- api.staff_approve_production_batch — where the yard is actually consumed
--
-- Deducts the CONFIRMED ACTUAL quantities (AC-38), not the standard recipe, and puts the moulded
-- output into CURING rather than into available stock (§11.4, AC-44).
--
-- WHAT THIS RELEASE DOES NOT DO, said plainly: it checks the SELECTED LOCATION'S PHYSICAL BALANCE,
-- exactly as the released transfer and correction commands do. product.md §8.1 also refuses a
-- claim that would take stock a customer has already been promised, and that check — the
-- product-wide lock, the availability figure and the refusal that shows the promised quantity
-- beside the physical one — belongs to the separate promised-stock correction. Until it lands, a
-- batch approved here can consume reserved or committed bricks and materials.
-- ---------------------------------------------------------------------------
create or replace function api.staff_approve_production_batch(
  p_batch_id        uuid,
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
  v_batch     public.production_batches%rowtype;
  v_input     public.production_batch_inputs%rowtype;
  v_lot       public.production_lots%rowtype;
  v_physical  bigint;
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

  -- Every input has to be there before anything is taken. Locked on `location:product` in product
  -- order — the same key and the same order the released transfer and correction approvals use, so
  -- a batch and a transfer competing for the same sand queue rather than deadlock.
  for v_input in
    select * from public.production_batch_inputs where batch_id = p_batch_id order by product_id
  loop
    perform pg_advisory_xact_lock(
      hashtextextended(v_batch.location_code || ':' || v_input.product_id::text, 0));

    v_physical := private.stock_on_hand(
      v_input.product_id, v_batch.location_code, 'available');

    if v_physical < v_input.actual_quantity then
      return jsonb_build_object(
        'ok', false, 'reason', 'insufficient_stock',
        'product_id', v_input.product_id,
        'available', v_physical, 'requested', v_input.actual_quantity);
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
$$;

comment on function api.staff_approve_production_batch(uuid, text) is
  'Manager approval of a batch, and the moment the yard is consumed (product.md §11.1, AC-38). '
  'Deducts the CONFIRMED ACTUAL quantities and puts the output into CURING, never into available '
  'stock (§11.4, AC-44). Checks the location''s PHYSICAL balance; the promised-stock rule of §8.1 '
  'is a later correction and is not enforced here.';

-- ---------------------------------------------------------------------------
-- api.staff_reject_production_batch
-- ---------------------------------------------------------------------------
create or replace function api.staff_reject_production_batch(
  p_batch_id        uuid,
  p_reason          text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := private.acting_staff(array['manager']::public.app_role[]);
  v_role    public.app_role := private.live_role_of(v_actor);
  v_reason  text := private.normalise_label(p_reason);
  v_corr    uuid := gen_random_uuid();
  v_batch   public.production_batches%rowtype;
  v_class   jsonb;
  v_claimed integer;
  v_request jsonb := jsonb_build_object(
    'batch_id', p_batch_id, 'outcome', 'rejected', 'reason', v_reason);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'production.reject_batch', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_batch from public.production_batches where id = p_batch_id;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'batch', to_jsonb(v_batch));
  end if;

  if v_reason is null or length(v_reason) < 3 then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
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

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'production.reject_batch', p_batch_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'production.reject_batch', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'batch', to_jsonb(v_batch));
  end if;

  -- `rejected` records a decider and a reason, and it is NOT an approval (§4.3, AC-84). Nothing is
  -- deducted and nothing is produced.
  update public.production_batches
     set status = 'rejected', decided_by = v_actor, decided_role = v_role,
         decided_at = now(), decision_reason = v_reason
   where id = p_batch_id
  returning * into v_batch;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'production_batch_rejected', 'production_batch', p_batch_id,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'rejected', 'reason', v_reason),
    v_corr, 'api.staff_reject_production_batch'
  );

  return jsonb_build_object('ok', true, 'reason', 'rejected', 'batch', to_jsonb(v_batch));
end;
$$;

comment on function api.staff_reject_production_batch(uuid, text, text) is
  'Rejects a batch. Records no approver (product.md §4.3), consumes nothing and produces nothing.';

-- ---------------------------------------------------------------------------
-- api.staff_inspect_curing_lot — §11.4, and the ONLY way a brick becomes sellable
--
-- Refused before 72 hours. AC-44: reaching the end of curing makes a lot ready for INSPECTION, and
-- inspection is a decision a Manager makes — the countdown does not make anything available.
-- ---------------------------------------------------------------------------
create or replace function api.staff_inspect_curing_lot(
  p_lot_id          uuid,
  p_accepted        bigint,
  p_rejected        bigint,
  p_reject_reason   text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := private.acting_staff(array['manager']::public.app_role[]);
  v_role    public.app_role := private.live_role_of(v_actor);
  v_corr    uuid := gen_random_uuid();
  v_lot     public.production_lots%rowtype;
  v_batch   public.production_batches%rowtype;
  v_curing  bigint;
  v_reason  text := nullif(btrim(coalesce(p_reject_reason, '')), '');
  v_class   jsonb;
  v_claimed integer;
  v_request jsonb := jsonb_build_object(
    'lot_id', p_lot_id, 'accepted', p_accepted, 'rejected', p_rejected,
    'reject_reason', v_reason);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'production.inspect_lot', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_lot from public.production_lots where id = p_lot_id;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'lot', to_jsonb(v_lot));
  end if;

  perform pg_advisory_xact_lock(hashtextextended('lot:' || p_lot_id::text, 0));

  select * into v_lot from public.production_lots where id = p_lot_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_lot');
  end if;

  select * into v_batch from public.production_batches where id = v_lot.batch_id;

  if v_batch.status <> 'approved' then
    return jsonb_build_object('ok', false, 'reason', 'batch_not_approved');
  end if;

  if v_lot.inspected_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_inspected');
  end if;

  -- 72 HOURS (§11.4). The accept action stays disabled with its reason shown on the screen; this is
  -- what makes that true rather than decorative.
  if now() < v_lot.curing_started_at + interval '72 hours' then
    return jsonb_build_object(
      'ok', false, 'reason', 'still_curing',
      'ready_at', (v_lot.curing_started_at + interval '72 hours')::text);
  end if;

  v_curing := v_lot.quantity_moulded - v_lot.rejected_at_moulding;

  if p_accepted is null or p_rejected is null or p_accepted < 0 or p_rejected < 0 then
    return jsonb_build_object('ok', false, 'reason', 'quantity_invalid');
  end if;

  -- Everything that went into curing has to be accounted for. Accepting 18 of 20 and rejecting
  -- nothing would lose two bricks out of a permanent record.
  if p_accepted + p_rejected <> v_curing then
    return jsonb_build_object(
      'ok', false, 'reason', 'inspection_must_account_for_all',
      'curing', v_curing, 'offered', p_accepted + p_rejected);
  end if;

  if p_rejected > 0 and v_reason is null then
    return jsonb_build_object('ok', false, 'reason', 'reject_reason_required');
  end if;

  if p_rejected > 0 and v_reason not in ('broken', 'cracked', 'undersized', 'weak') then
    return jsonb_build_object('ok', false, 'reason', 'reject_reason_invalid');
  end if;

  if p_rejected = 0 and v_reason is not null then
    return jsonb_build_object('ok', false, 'reason', 'reject_reason_without_rejects');
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'production.inspect_lot', p_lot_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'production.inspect_lot', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'lot', to_jsonb(v_lot));
  end if;

  update public.production_lots
     set inspected_at = now(), inspected_by = v_actor, inspected_role = v_role,
         accepted_quantity = p_accepted, rejected_at_inspection = p_rejected,
         inspection_reject_reason = v_reason::public.brick_reject_reason
   where id = p_lot_id
     and inspected_at is null
  returning * into v_lot;

  -- The row was there and uninspected a moment ago, under a lock nobody else can hold. If it is
  -- gone now, something the lock does not cover changed it, and finishing the ledger writes on an
  -- assumption would be worse than stopping.
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'already_inspected');
  end if;

  -- The whole lot leaves curing: what was accepted and what was rejected together. A curing
  -- balance that outlived its inspection would be stock nobody can find in the yard.
  perform private.write_stock_movement(
    v_lot.product_id, v_batch.location_code, 'curing',
    -v_curing, 'curing_accepted', 'production_lot', p_lot_id,
    v_batch.entered_by, v_batch.entered_role, v_actor, v_role, v_corr);

  -- ONLY the accepted quantity becomes available for sale (§11.4, AC-45). The rejected bricks are
  -- recorded on the lot and never enter a balance. A zero accepted quantity writes no row at all:
  -- `write_stock_movement` returns early on a movement of nothing, which is what keeps an
  -- all-rejected lot out of the ledger rather than in it as a row saying zero.
  perform private.write_stock_movement(
    v_lot.product_id, v_batch.location_code, 'available',
    p_accepted, 'curing_accepted', 'production_lot', p_lot_id,
    v_batch.entered_by, v_batch.entered_role, v_actor, v_role, v_corr);

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'curing_lot_inspected', 'production_lot', p_lot_id,
    jsonb_build_object('quantity_curing', v_curing),
    jsonb_build_object('accepted', p_accepted, 'rejected', p_rejected,
                       'reject_reason', v_reason),
    v_corr, 'api.staff_inspect_curing_lot'
  );

  return jsonb_build_object('ok', true, 'reason', 'inspected', 'lot', to_jsonb(v_lot));
end;
$$;

comment on function api.staff_inspect_curing_lot(uuid, bigint, bigint, text, text) is
  'The Manager inspecting a cured lot (product.md §11.4). Refused before 72 hours, and ONLY the '
  'accepted quantity becomes available for sale (AC-44, AC-45).';

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
