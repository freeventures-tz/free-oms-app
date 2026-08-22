-- Stage 10D · The stock command surface
--
-- Twelve commands, all built to the shape Stage 8B established and Part B repeated:
--
--   1. The actor comes from the VERIFIED SESSION. No function here takes an actor parameter, so no
--      caller — server, script, or leaked secret key — can nominate somebody else.
--   2. An advisory lock on the presented idempotency key is taken BEFORE the first classification.
--      Part C round 4 found what happens without it: concurrent identical requests all decide there
--      is no duplicate before any of them commits, and the losers then refuse the request that just
--      succeeded.
--   3. Validation runs BEFORE the key is claimed, so a corrected retry under the same key is a real
--      attempt rather than a replay of the refusal it corrects.
--   4. Everything is one transaction. A later failure unclaims the key along with it.
--
-- A FOURTH PREFIX ARRIVES HERE, and it is a real change to the naming rule test 006 enforces:
--
--   api.admin_*    Director-only. Derives the acting Director.
--   api.staff_*    Role-scoped. Derives the actor AND the roles the command allows.
--   api.self_*     Any authenticated user, acting only on themselves.
--   api.service_*  service_role only. Takes ids, never an identity.
--
-- `staff_` exists because product.md §4.1 gives supplier-receipt entry to a Manager, a Cashier or a
-- Sales Representative, and transfer entry and approval to a Manager. None of those is a Director,
-- and calling a Manager command `admin_` would make the prefix mean nothing — the prefix's whole
-- job is that a test can check the grant matches the audience. `staff_` carries the same guarantee
-- as `admin_`: executable by `authenticated`, refused inside the function unless the caller holds
-- one of the roles product.md names.
--
-- WHO MAY DO WHAT, and where each rule comes from:
--
--   | Command                  | Entered by                        | Approved by |
--   | Supplier record          | Director *(derived — see below)*  | —           |
--   | Opening stock            | Director *(derived — see below)*  | —           |
--   | Supplier receipt         | Manager, Cashier, Sales Rep (§9.1)| Manager (§4.1, always) |
--   | Internal transfer        | Manager (§4.1)                    | Manager (§4.1) |
--   | Manual stock adjustment  | Manager (§4.1)                    | Director (§4.1) |
--
-- TWO AUTHORITIES ARE DERIVED RATHER THAN QUOTED, and both are flagged for the owner in the stage
-- plan rather than buried here:
--
--   · WHO CREATES A SUPPLIER. product.md never says. Every other piece of reference data the
--     catalogue depends on — products, counting units, storekeeper records (§3.2) — is Director-
--     only, and a supplier is referenced permanently by receipts. Director-only is the most
--     restrictive reading available, and loosening a rule later is safe in a way that tightening
--     one is not.
--   · WHO ENTERS OPENING STOCK. product.md never says. It creates inventory that no receipt
--     justifies, which is the same risk shape as §4.1's manual stock adjustment — somebody types a
--     number and stock exists. §4.1 puts a Director on the approving side of that, so a Director
--     does both here, in one act, recorded as actor and approver on the ledger row.
--
-- AND ONE RULE IS IMPLEMENTED EXACTLY AS WRITTEN even though it has an awkward consequence:
-- §4.1 names the MANAGER as the approver of a supplier receipt and names no alternate. So a
-- Director cannot approve one. If the business needs a Director to stand in when the Manager is
-- away, that is an owner decision and not something to infer from seniority.

begin;

-- ---------------------------------------------------------------------------
-- api.admin_add_supplier
-- ---------------------------------------------------------------------------
create or replace function api.admin_add_supplier(
  p_name            text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor       uuid := private.acting_director();
  v_name        text := private.normalise_label(p_name);
  v_corr        uuid := gen_random_uuid();
  v_supplier_id uuid := gen_random_uuid();
  v_supplier    public.suppliers%rowtype;
  v_class       jsonb;
  v_claimed     integer;
  v_request     jsonb := jsonb_build_object('name', private.canonical_identity(v_name));
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'inventory.add_supplier', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_supplier from public.suppliers where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'supplier', to_jsonb(v_supplier));
  end if;

  if length(v_name) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'supplier_name_required');
  end if;

  -- Compared through the same canonical form the unique index uses, so the refusal is a sentence a
  -- Director can act on rather than a constraint violation they cannot read.
  if exists (
    select 1 from public.suppliers s
     where private.canonical_identity(s.name) = private.canonical_identity(v_name)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'supplier_exists');
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'inventory.add_supplier', v_supplier_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'inventory.add_supplier', v_actor, v_request);

    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;

    select * into v_supplier from public.suppliers where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'supplier', to_jsonb(v_supplier));
  end if;

  insert into public.suppliers (id, name, created_by)
  values (v_supplier_id, v_name, v_actor)
  returning * into v_supplier;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, private.live_role_of(v_actor), false,
    'supplier_added', 'supplier', v_supplier.id,
    null, to_jsonb(v_supplier), v_corr, 'api.admin_add_supplier'
  );

  return jsonb_build_object('ok', true, 'reason', 'added', 'supplier', to_jsonb(v_supplier));
end;
$$;

comment on function api.admin_add_supplier(text, text) is
  'Registers a supplier, Director-only. product.md defines no supplier record, so this holds a name '
  'and nothing invented. Deactivated, never deleted.';

-- ---------------------------------------------------------------------------
-- api.admin_set_supplier_active
--
-- The only UPDATE in this stage, and it touches one boolean. A supplier is never renamed: receipts
-- reference the row permanently, and changing what a past delivery says it came from is exactly the
-- kind of quiet rewrite §16 forbids.
-- ---------------------------------------------------------------------------
create or replace function api.admin_set_supplier_active(
  p_supplier_id     uuid,
  p_is_active       boolean,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := private.acting_director();
  v_corr     uuid := gen_random_uuid();
  v_before   public.suppliers%rowtype;
  v_after    public.suppliers%rowtype;
  v_class    jsonb;
  v_claimed  integer;
  v_request  jsonb := jsonb_build_object(
    'supplier_id', p_supplier_id, 'is_active', p_is_active);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'inventory.set_supplier_active', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_after from public.suppliers where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'supplier', to_jsonb(v_after));
  end if;

  select * into v_before from public.suppliers where id = p_supplier_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_supplier');
  end if;

  if p_is_active is null then
    return jsonb_build_object('ok', false, 'reason', 'supplier_state_required');
  end if;

  -- Setting a supplier to the state it is already in is not a change, and recording it would put an
  -- event in the audit history that reads as a decision nobody made.
  if v_before.is_active = p_is_active then
    return jsonb_build_object('ok', false, 'reason', 'supplier_unchanged');
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'inventory.set_supplier_active', p_supplier_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'inventory.set_supplier_active', v_actor, v_request);

    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;

    select * into v_after from public.suppliers where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'supplier', to_jsonb(v_after));
  end if;

  update public.suppliers set is_active = p_is_active
   where id = p_supplier_id
  returning * into v_after;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, private.live_role_of(v_actor), false,
    case when p_is_active then 'supplier_reactivated' else 'supplier_deactivated' end,
    'supplier', p_supplier_id,
    to_jsonb(v_before), to_jsonb(v_after), v_corr, 'api.admin_set_supplier_active'
  );

  return jsonb_build_object('ok', true, 'reason',
    case when p_is_active then 'reactivated' else 'deactivated' end,
    'supplier', to_jsonb(v_after));
end;
$$;

comment on function api.admin_set_supplier_active(uuid, boolean, text) is
  'Switches a supplier off or back on, Director-only. There is no rename and no delete: a receipt '
  'references its supplier permanently.';

-- ---------------------------------------------------------------------------
-- api.admin_record_opening_stock
--
-- One act, no approval step, because the Director is both the enterer and the authority (see the
-- header). The ledger row it writes therefore names the same person twice, which is honest rather
-- than redundant: §4.2 records entry and approval separately even when one person did both.
--
-- A quantity of ZERO is accepted and writes no ledger row. "We checked the yard and there is none"
-- is a real answer and a different one from "nobody has looked yet", and the entry row is what
-- tells them apart.
-- ---------------------------------------------------------------------------
create or replace function api.admin_record_opening_stock(
  p_product_id      uuid,
  p_location_code   text,
  p_quantity        bigint,
  p_note            text,
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
  v_note     text := nullif(private.normalise_label(p_note), '');
  v_corr     uuid := gen_random_uuid();
  v_entry_id uuid := gen_random_uuid();
  v_entry    public.opening_stock_entries%rowtype;
  v_class    jsonb;
  v_claimed  integer;
  v_request  jsonb := jsonb_build_object(
    'product_id', p_product_id, 'location_code', p_location_code, 'quantity', p_quantity);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'inventory.opening_stock', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_entry from public.opening_stock_entries
      where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'entry', to_jsonb(v_entry));
  end if;

  if not exists (select 1 from public.products p where p.id = p_product_id and p.is_active) then
    return jsonb_build_object('ok', false, 'reason', 'no_product');
  end if;

  if not exists (select 1 from public.inventory_locations l where l.code = p_location_code) then
    return jsonb_build_object('ok', false, 'reason', 'no_location');
  end if;

  if p_quantity is null or p_quantity < 0 or p_quantity > 10000000 then
    return jsonb_build_object('ok', false, 'reason', 'quantity_invalid');
  end if;

  -- ONCE per product and location (Stage 10 §3). The unique index enforces it; this makes the
  -- refusal readable, and says what to do instead.
  if exists (
    select 1 from public.opening_stock_entries e
     where e.product_id = p_product_id and e.location_code = p_location_code
  ) then
    return jsonb_build_object('ok', false, 'reason', 'opening_stock_exists');
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'inventory.opening_stock', v_entry_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'inventory.opening_stock', v_actor, v_request);

    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;

    select * into v_entry from public.opening_stock_entries
      where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'entry', to_jsonb(v_entry));
  end if;

  insert into public.opening_stock_entries (
    id, product_id, location_code, quantity, note, entered_by, entered_role
  )
  values (v_entry_id, p_product_id, p_location_code, p_quantity, v_note, v_actor, v_role)
  returning * into v_entry;

  perform private.write_stock_movement(
    p_product_id, p_location_code, 'available', p_quantity, 'opening_stock',
    'opening_stock_entry', v_entry_id, v_actor, v_role, v_actor, v_role, v_corr);

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false,
    'opening_stock_recorded', 'opening_stock_entry', v_entry_id,
    null, to_jsonb(v_entry), v_corr, 'api.admin_record_opening_stock'
  );

  return jsonb_build_object('ok', true, 'reason', 'recorded', 'entry', to_jsonb(v_entry));
end;
$$;

comment on function api.admin_record_opening_stock(uuid, text, bigint, text, text) is
  'The baseline a location starts from, once per product and location, Director-only. A quantity of '
  'zero is recorded as an entry with no movement behind it, because "none" and "not yet counted" '
  'are different answers.';

-- ---------------------------------------------------------------------------
-- api.staff_enter_stock_receipt
--
-- Entry only. §9.1: stock increases only after Manager approval, and this writes no ledger row.
-- ---------------------------------------------------------------------------
create or replace function api.staff_enter_stock_receipt(
  p_supplier_id       uuid,
  p_location_code     text,
  p_delivery_date     date,
  p_delivery_note_ref text,
  p_lines             jsonb,
  p_idempotency_key   text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := private.acting_staff(
                         array['manager','cashier','sales_rep']::public.app_role[]);
  v_role       public.app_role := private.live_role_of(v_actor);
  v_note_ref   text := private.normalise_label(p_delivery_note_ref);
  v_corr       uuid := gen_random_uuid();
  v_receipt_id uuid := gen_random_uuid();
  v_receipt    public.stock_receipts%rowtype;
  v_class      jsonb;
  v_claimed    integer;
  v_line       jsonb;
  v_expected   numeric;
  v_received   numeric;
  v_damaged    numeric;
  v_distinct   integer;
  v_total      integer;
  v_request    jsonb := jsonb_build_object(
    'supplier_id',       p_supplier_id,
    'location_code',     p_location_code,
    'delivery_date',     p_delivery_date,
    'delivery_note_ref', private.canonical_identity(v_note_ref),
    -- The lines as presented. Two retries of the same submission send the identical payload, and
    -- anything else — a different order, a changed quantity — is a CONFLICT, which changes nothing.
    -- That is the safe direction to be wrong in.
    'lines',             coalesce(p_lines, '[]'::jsonb)
  );
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'inventory.enter_receipt', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_receipt from public.stock_receipts where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'receipt', to_jsonb(v_receipt));
  end if;

  if not exists (
    select 1 from public.suppliers s where s.id = p_supplier_id and s.is_active
  ) then
    return jsonb_build_object('ok', false, 'reason', 'no_supplier');
  end if;

  if not exists (select 1 from public.inventory_locations l where l.code = p_location_code) then
    return jsonb_build_object('ok', false, 'reason', 'no_location');
  end if;

  if length(v_note_ref) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'delivery_note_required');
  end if;

  if p_delivery_date is null then
    return jsonb_build_object('ok', false, 'reason', 'delivery_date_required');
  end if;

  -- A delivery cannot have arrived tomorrow. The business day is Africa/Dar_es_Salaam (§15.3), so
  -- the comparison is made there rather than in whatever zone the server happens to run in.
  if p_delivery_date > (now() at time zone 'Africa/Dar_es_Salaam')::date then
    return jsonb_build_object('ok', false, 'reason', 'delivery_date_future');
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'lines_required');
  end if;

  select count(distinct t.elem ->> 'product_id'), count(*)
    into v_distinct, v_total
    from jsonb_array_elements(p_lines) as t(elem);

  if v_distinct is distinct from v_total then
    return jsonb_build_object('ok', false, 'reason', 'duplicate_product_line');
  end if;

  -- Every line is checked before ANY of them is written, so a bad fifth line does not leave four
  -- good ones behind for somebody to wonder about.
  for v_line in select t.elem from jsonb_array_elements(p_lines) as t(elem) loop
    if jsonb_typeof(v_line -> 'product_id')        <> 'string'
       or jsonb_typeof(v_line -> 'expected_quantity') <> 'number'
       or jsonb_typeof(v_line -> 'received_quantity') <> 'number' then
      return jsonb_build_object('ok', false, 'reason', 'line_invalid');
    end if;

    if not exists (
      select 1 from public.products p
       where p.id = (v_line ->> 'product_id')::uuid and p.is_active
    ) then
      return jsonb_build_object('ok', false, 'reason', 'no_product');
    end if;

    v_expected := (v_line ->> 'expected_quantity')::numeric;
    v_received := (v_line ->> 'received_quantity')::numeric;
    v_damaged  := coalesce((v_line ->> 'damaged_quantity')::numeric, 0);

    -- Whole counting units only (product.md §6.1 rule 1). Half a bag is not a quantity this system
    -- can express, and rounding one silently is how a ledger stops reconciling.
    if v_expected <> trunc(v_expected) or v_received <> trunc(v_received)
       or v_damaged <> trunc(v_damaged) then
      return jsonb_build_object('ok', false, 'reason', 'quantity_not_whole');
    end if;

    if v_expected < 0 or v_received < 0 or v_damaged < 0
       or v_expected > 10000000 or v_received > 10000000 then
      return jsonb_build_object('ok', false, 'reason', 'quantity_invalid');
    end if;

    if v_damaged > v_received then
      return jsonb_build_object('ok', false, 'reason', 'damaged_exceeds_received');
    end if;
  end loop;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'inventory.enter_receipt', v_receipt_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'inventory.enter_receipt', v_actor, v_request);

    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;

    select * into v_receipt from public.stock_receipts where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'receipt', to_jsonb(v_receipt));
  end if;

  insert into public.stock_receipts (
    id, supplier_id, location_code, delivery_note_ref, delivery_date, entered_by, entered_role
  )
  values (
    v_receipt_id, p_supplier_id, p_location_code, v_note_ref, p_delivery_date, v_actor, v_role
  )
  returning * into v_receipt;

  insert into public.stock_receipt_lines (
    receipt_id, product_id, expected_quantity, received_quantity, damaged_quantity, damage_note
  )
  select v_receipt_id,
         (t.elem ->> 'product_id')::uuid,
         (t.elem ->> 'expected_quantity')::bigint,
         (t.elem ->> 'received_quantity')::bigint,
         coalesce((t.elem ->> 'damaged_quantity')::bigint, 0),
         nullif(private.normalise_label(t.elem ->> 'damage_note'), '')
    from jsonb_array_elements(p_lines) as t(elem);

  -- Entry is not approval (§4.2). This records that a decision is OWED, from a Manager, and the
  -- record stays pending until one is made.
  perform private.open_approval(
    'stock_receipt', v_receipt_id, 'supplier_receipt', v_actor, v_role, 'manager');

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false,
    'stock_receipt_entered', 'stock_receipt', v_receipt_id,
    null, to_jsonb(v_receipt), v_corr, 'api.staff_enter_stock_receipt'
  );

  return jsonb_build_object('ok', true, 'reason', 'entered', 'receipt', to_jsonb(v_receipt));
end;
$$;

comment on function api.staff_enter_stock_receipt(uuid, text, date, text, jsonb, text) is
  'Records what arrived from a supplier (product.md §9). Entry may be delegated to a Cashier or a '
  'Sales Representative (§9.1). Writes NO ledger row: stock increases only on Manager approval.';

-- ---------------------------------------------------------------------------
-- api.staff_approve_stock_receipt
--
-- Where stock actually increases. §4.2: a Manager who entered this receipt personally may approve
-- it, as a separate action — the function does not care who entered it, only who is deciding.
-- ---------------------------------------------------------------------------
create or replace function api.staff_approve_stock_receipt(
  p_receipt_id      uuid,
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
  v_corr     uuid := gen_random_uuid();
  v_receipt  public.stock_receipts%rowtype;
  v_req      public.approval_requests%rowtype;
  v_line     public.stock_receipt_lines%rowtype;
  v_decision uuid;
  v_class    jsonb;
  v_claimed  integer;
  v_request  jsonb := jsonb_build_object('receipt_id', p_receipt_id, 'outcome', 'approved');
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'inventory.approve_receipt', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_receipt from public.stock_receipts where id = p_receipt_id;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'receipt', to_jsonb(v_receipt));
  end if;

  select * into v_receipt from public.stock_receipts where id = p_receipt_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_receipt');
  end if;

  -- Serialised per receipt, so two Managers tapping Approve at once cannot both get past the
  -- pending check and write the movements twice.
  perform pg_advisory_xact_lock(hashtextextended('stock_receipt:' || p_receipt_id::text, 0));

  select * into v_req from public.approval_requests
   where entity_type = 'stock_receipt' and entity_id = p_receipt_id
     and approval_type = 'supplier_receipt';

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_approval_request');
  end if;

  -- §4.3: a decision that has been made is not remade. A rejected receipt is closed, and the
  -- correction is a new receipt rather than a second verdict on this one.
  if v_req.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'already_settled',
                              'status', v_req.status::text);
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'inventory.approve_receipt', p_receipt_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'inventory.approve_receipt', v_actor, v_request);

    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;

    return jsonb_build_object('ok', true, 'reason', 'replayed', 'receipt', to_jsonb(v_receipt));
  end if;

  v_decision := private.settle_approval(v_req.id, 'approved', v_actor, v_role, null);

  -- ACCEPTED quantity, not received. §8 records damaged goods as unsellable, so they never reach a
  -- yard balance; the quantity stays on the line as a permanent documented fact.
  --
  -- The shortage needs no arithmetic here at all: it is a generated column on the line and remains
  -- recorded whatever this approval does (§9.1, AC-28).
  for v_line in
    select * from public.stock_receipt_lines where receipt_id = p_receipt_id order by id
  loop
    perform private.write_stock_movement(
      v_line.product_id, v_receipt.location_code, 'available',
      v_line.accepted_quantity, 'supplier_receipt',
      'stock_receipt', p_receipt_id,
      -- The enterer caused the movement; the Manager authorised it. Both, on the row (§4.2).
      v_receipt.entered_by, v_receipt.entered_role,
      v_actor, v_role, v_corr);
  end loop;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, approval_reference, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false,
    'stock_receipt_approved', 'stock_receipt', p_receipt_id,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'approved', 'decision_id', v_decision),
    v_req.id, v_corr, 'api.staff_approve_stock_receipt'
  );

  return jsonb_build_object('ok', true, 'reason', 'approved', 'receipt', to_jsonb(v_receipt));
end;
$$;

comment on function api.staff_approve_stock_receipt(uuid, text) is
  'Manager approval of a supplier receipt, and the moment stock increases (product.md §9.1). Adds '
  'the ACCEPTED quantity — received minus damaged — because §8 records damaged goods as unsellable.';

-- ---------------------------------------------------------------------------
-- api.staff_reject_stock_receipt
-- ---------------------------------------------------------------------------
create or replace function api.staff_reject_stock_receipt(
  p_receipt_id      uuid,
  p_reason          text,
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
  v_reason   text := private.normalise_label(p_reason);
  v_corr     uuid := gen_random_uuid();
  v_receipt  public.stock_receipts%rowtype;
  v_req      public.approval_requests%rowtype;
  v_decision uuid;
  v_class    jsonb;
  v_claimed  integer;
  v_request  jsonb := jsonb_build_object(
    'receipt_id', p_receipt_id, 'outcome', 'rejected', 'reason', v_reason);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'inventory.reject_receipt', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_receipt from public.stock_receipts where id = p_receipt_id;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'receipt', to_jsonb(v_receipt));
  end if;

  select * into v_receipt from public.stock_receipts where id = p_receipt_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_receipt');
  end if;

  -- §4.3 requires a reason on every decision, not only on approvals. A rejection with no stated
  -- ground is the shape of record that cannot be answered a year later.
  if length(v_reason) < 3 then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('stock_receipt:' || p_receipt_id::text, 0));

  select * into v_req from public.approval_requests
   where entity_type = 'stock_receipt' and entity_id = p_receipt_id
     and approval_type = 'supplier_receipt';

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_approval_request');
  end if;

  if v_req.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'already_settled',
                              'status', v_req.status::text);
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'inventory.reject_receipt', p_receipt_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'inventory.reject_receipt', v_actor, v_request);

    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;

    return jsonb_build_object('ok', true, 'reason', 'replayed', 'receipt', to_jsonb(v_receipt));
  end if;

  -- No approver is recorded, and the check constraint on approval_requests would refuse the row if
  -- one were (§4.3, AC-84). The rejecting Manager is recorded in approval_decisions instead.
  v_decision := private.settle_approval(v_req.id, 'rejected', v_actor, v_role, v_reason);

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, approval_reference, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false,
    'stock_receipt_rejected', 'stock_receipt', p_receipt_id,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'rejected', 'reason', v_reason, 'decision_id', v_decision),
    v_req.id, v_corr, 'api.staff_reject_stock_receipt'
  );

  return jsonb_build_object('ok', true, 'reason', 'rejected', 'receipt', to_jsonb(v_receipt));
end;
$$;

comment on function api.staff_reject_stock_receipt(uuid, text, text) is
  'Manager rejection of a supplier receipt. Records NO approver (product.md §4.3, AC-84) and moves '
  'no stock. A corrected delivery is a new receipt, never a second verdict on this one.';

-- ---------------------------------------------------------------------------
-- api.staff_enter_stock_transfer
-- ---------------------------------------------------------------------------
create or replace function api.staff_enter_stock_transfer(
  p_from_location   text,
  p_to_location     text,
  p_note            text,
  p_lines           jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor       uuid := private.acting_staff(array['manager']::public.app_role[]);
  v_role        public.app_role := private.live_role_of(v_actor);
  v_note        text := nullif(private.normalise_label(p_note), '');
  v_corr        uuid := gen_random_uuid();
  v_transfer_id uuid := gen_random_uuid();
  v_transfer    public.stock_transfers%rowtype;
  v_class       jsonb;
  v_claimed     integer;
  v_line        jsonb;
  v_quantity    numeric;
  v_distinct    integer;
  v_total       integer;
  v_request     jsonb := jsonb_build_object(
    'from_location', p_from_location,
    'to_location',   p_to_location,
    'lines',         coalesce(p_lines, '[]'::jsonb));
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'inventory.enter_transfer', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_transfer from public.stock_transfers where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'transfer', to_jsonb(v_transfer));
  end if;

  if not exists (select 1 from public.inventory_locations l where l.code = p_from_location)
     or not exists (select 1 from public.inventory_locations l where l.code = p_to_location) then
    return jsonb_build_object('ok', false, 'reason', 'no_location');
  end if;

  if p_from_location = p_to_location then
    return jsonb_build_object('ok', false, 'reason', 'same_location');
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'lines_required');
  end if;

  select count(distinct t.elem ->> 'product_id'), count(*)
    into v_distinct, v_total
    from jsonb_array_elements(p_lines) as t(elem);

  if v_distinct is distinct from v_total then
    return jsonb_build_object('ok', false, 'reason', 'duplicate_product_line');
  end if;

  for v_line in select t.elem from jsonb_array_elements(p_lines) as t(elem) loop
    if jsonb_typeof(v_line -> 'product_id') <> 'string'
       or jsonb_typeof(v_line -> 'quantity') <> 'number' then
      return jsonb_build_object('ok', false, 'reason', 'line_invalid');
    end if;

    if not exists (
      select 1 from public.products p
       where p.id = (v_line ->> 'product_id')::uuid and p.is_active
    ) then
      return jsonb_build_object('ok', false, 'reason', 'no_product');
    end if;

    v_quantity := (v_line ->> 'quantity')::numeric;

    if v_quantity <> trunc(v_quantity) then
      return jsonb_build_object('ok', false, 'reason', 'quantity_not_whole');
    end if;

    if v_quantity <= 0 or v_quantity > 10000000 then
      return jsonb_build_object('ok', false, 'reason', 'quantity_invalid');
    end if;
  end loop;

  -- Availability is NOT checked here, deliberately. design.md §7.15 shows the limit before
  -- submission, and this function is not that screen: stock can change between entry and approval,
  -- so the check that decides anything is the one at approval, where the movement happens.

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'inventory.enter_transfer', v_transfer_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'inventory.enter_transfer', v_actor, v_request);

    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;

    select * into v_transfer from public.stock_transfers where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'transfer', to_jsonb(v_transfer));
  end if;

  insert into public.stock_transfers (
    id, from_location, to_location, note, entered_by, entered_role
  )
  values (v_transfer_id, p_from_location, p_to_location, v_note, v_actor, v_role)
  returning * into v_transfer;

  insert into public.stock_transfer_lines (transfer_id, product_id, quantity)
  select v_transfer_id, (t.elem ->> 'product_id')::uuid, (t.elem ->> 'quantity')::bigint
    from jsonb_array_elements(p_lines) as t(elem);

  perform private.open_approval(
    'stock_transfer', v_transfer_id, 'stock_transfer', v_actor, v_role, 'manager');

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false,
    'stock_transfer_entered', 'stock_transfer', v_transfer_id,
    null, to_jsonb(v_transfer), v_corr, 'api.staff_enter_stock_transfer'
  );

  return jsonb_build_object('ok', true, 'reason', 'entered', 'transfer', to_jsonb(v_transfer));
end;
$$;

comment on function api.staff_enter_stock_transfer(text, text, text, jsonb, text) is
  'Records an intended move between locations (product.md §10). Moves nothing: balances change only '
  'on Manager approval, and the source is checked there rather than here.';

-- ---------------------------------------------------------------------------
-- api.staff_approve_stock_transfer
-- ---------------------------------------------------------------------------
create or replace function api.staff_approve_stock_transfer(
  p_transfer_id     uuid,
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
  v_transfer  public.stock_transfers%rowtype;
  v_req       public.approval_requests%rowtype;
  v_line      public.stock_transfer_lines%rowtype;
  v_available bigint;
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
  -- Locked in product order, which is what stops two transfers out of the same location from
  -- deadlocking: both take the same locks in the same sequence.
  for v_line in
    select * from public.stock_transfer_lines
     where transfer_id = p_transfer_id order by product_id
  loop
    perform pg_advisory_xact_lock(
      hashtextextended(v_transfer.from_location || ':' || v_line.product_id::text, 0));

    v_available := private.stock_on_hand(v_line.product_id, v_transfer.from_location, 'available');

    if v_available < v_line.quantity then
      return jsonb_build_object(
        'ok', false, 'reason', 'insufficient_stock',
        'product_id', v_line.product_id, 'available', v_available, 'requested', v_line.quantity);
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
$$;

comment on function api.staff_approve_stock_transfer(uuid, text) is
  'Manager approval of an internal transfer, and the moment balances change (product.md §10). The '
  'source is re-checked here because stock can move between entry and approval.';

-- ---------------------------------------------------------------------------
-- api.staff_reject_stock_transfer
-- ---------------------------------------------------------------------------
create or replace function api.staff_reject_stock_transfer(
  p_transfer_id     uuid,
  p_reason          text,
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
  v_reason   text := private.normalise_label(p_reason);
  v_corr     uuid := gen_random_uuid();
  v_transfer public.stock_transfers%rowtype;
  v_req      public.approval_requests%rowtype;
  v_decision uuid;
  v_class    jsonb;
  v_claimed  integer;
  v_request  jsonb := jsonb_build_object(
    'transfer_id', p_transfer_id, 'outcome', 'rejected', 'reason', v_reason);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'inventory.reject_transfer', v_actor, v_request);

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

  if length(v_reason) < 3 then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
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

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'inventory.reject_transfer', p_transfer_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'inventory.reject_transfer', v_actor, v_request);

    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;

    return jsonb_build_object('ok', true, 'reason', 'replayed', 'transfer', to_jsonb(v_transfer));
  end if;

  v_decision := private.settle_approval(v_req.id, 'rejected', v_actor, v_role, v_reason);

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, approval_reference, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false,
    'stock_transfer_rejected', 'stock_transfer', p_transfer_id,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'rejected', 'reason', v_reason, 'decision_id', v_decision),
    v_req.id, v_corr, 'api.staff_reject_stock_transfer'
  );

  return jsonb_build_object('ok', true, 'reason', 'rejected', 'transfer', to_jsonb(v_transfer));
end;
$$;

comment on function api.staff_reject_stock_transfer(uuid, text, text) is
  'Manager rejection of an internal transfer. Records no approver (product.md §4.3) and moves '
  'nothing.';

-- ---------------------------------------------------------------------------
-- api.staff_enter_stock_adjustment
--
-- product.md §4.1: "Manual stock adjustment, unexplained loss, shortage correction — entered by a
-- Manager, approved by a Director."
-- ---------------------------------------------------------------------------
create or replace function api.staff_enter_stock_adjustment(
  p_product_id      uuid,
  p_location_code   text,
  p_quantity_delta  bigint,
  p_reason          text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := private.acting_staff(array['manager']::public.app_role[]);
  v_role       public.app_role := private.live_role_of(v_actor);
  v_reason     text := private.normalise_label(p_reason);
  v_corr       uuid := gen_random_uuid();
  v_adjust_id  uuid := gen_random_uuid();
  v_adjustment public.stock_adjustments%rowtype;
  v_class      jsonb;
  v_claimed    integer;
  v_request    jsonb := jsonb_build_object(
    'product_id',     p_product_id,
    'location_code',  p_location_code,
    'quantity_delta', p_quantity_delta,
    'reason',         private.canonical_identity(v_reason));
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'inventory.enter_adjustment', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_adjustment from public.stock_adjustments
      where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed',
                              'adjustment', to_jsonb(v_adjustment));
  end if;

  if not exists (select 1 from public.products p where p.id = p_product_id and p.is_active) then
    return jsonb_build_object('ok', false, 'reason', 'no_product');
  end if;

  if not exists (select 1 from public.inventory_locations l where l.code = p_location_code) then
    return jsonb_build_object('ok', false, 'reason', 'no_location');
  end if;

  if p_quantity_delta is null or p_quantity_delta = 0
     or abs(p_quantity_delta) > 10000000 then
    return jsonb_build_object('ok', false, 'reason', 'quantity_invalid');
  end if;

  if length(v_reason) < 3 then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'inventory.enter_adjustment', v_adjust_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'inventory.enter_adjustment', v_actor, v_request);

    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;

    select * into v_adjustment from public.stock_adjustments
      where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed',
                              'adjustment', to_jsonb(v_adjustment));
  end if;

  insert into public.stock_adjustments (
    id, product_id, location_code, quantity_delta, reason, entered_by, entered_role
  )
  values (v_adjust_id, p_product_id, p_location_code, p_quantity_delta, v_reason, v_actor, v_role)
  returning * into v_adjustment;

  perform private.open_approval(
    'stock_adjustment', v_adjust_id, 'stock_adjustment', v_actor, v_role, 'director');

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false,
    'stock_adjustment_entered', 'stock_adjustment', v_adjust_id,
    null, to_jsonb(v_adjustment), v_corr, 'api.staff_enter_stock_adjustment'
  );

  return jsonb_build_object('ok', true, 'reason', 'entered',
                            'adjustment', to_jsonb(v_adjustment));
end;
$$;

comment on function api.staff_enter_stock_adjustment(uuid, text, bigint, text, text) is
  'A Manager-entered correction to stock, awaiting Director approval (product.md §4.1). Moves '
  'nothing. The reason is required because no delivery note or transfer explains this one.';

-- ---------------------------------------------------------------------------
-- api.admin_approve_stock_adjustment
-- ---------------------------------------------------------------------------
create or replace function api.admin_approve_stock_adjustment(
  p_adjustment_id   uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := private.acting_director();
  v_role       public.app_role := private.live_role_of(v_actor);
  v_corr       uuid := gen_random_uuid();
  v_adjustment public.stock_adjustments%rowtype;
  v_req        public.approval_requests%rowtype;
  v_available  bigint;
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

  perform pg_advisory_xact_lock(
    hashtextextended(v_adjustment.location_code || ':' || v_adjustment.product_id::text, 0));

  v_available := private.stock_on_hand(
    v_adjustment.product_id, v_adjustment.location_code, 'available');

  -- The deferred constraint trigger would catch this at commit, as an exception. Catching it here
  -- turns "something went wrong" into a sentence naming the balance and the amount asked for.
  if v_available + v_adjustment.quantity_delta < 0 then
    return jsonb_build_object(
      'ok', false, 'reason', 'insufficient_stock',
      'product_id', v_adjustment.product_id,
      'available', v_available, 'requested', abs(v_adjustment.quantity_delta));
  end if;

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
$$;

comment on function api.admin_approve_stock_adjustment(uuid, text) is
  'Director approval of a manual stock adjustment (product.md §4.1), and the moment it takes '
  'effect. Refused if it would drive the balance below zero.';

-- ---------------------------------------------------------------------------
-- api.admin_reject_stock_adjustment
-- ---------------------------------------------------------------------------
create or replace function api.admin_reject_stock_adjustment(
  p_adjustment_id   uuid,
  p_reason          text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := private.acting_director();
  v_role       public.app_role := private.live_role_of(v_actor);
  v_reason     text := private.normalise_label(p_reason);
  v_corr       uuid := gen_random_uuid();
  v_adjustment public.stock_adjustments%rowtype;
  v_req        public.approval_requests%rowtype;
  v_decision   uuid;
  v_class      jsonb;
  v_claimed    integer;
  v_request    jsonb := jsonb_build_object(
    'adjustment_id', p_adjustment_id, 'outcome', 'rejected', 'reason', v_reason);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'inventory.reject_adjustment', v_actor, v_request);

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

  if length(v_reason) < 3 then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
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

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'inventory.reject_adjustment', p_adjustment_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'inventory.reject_adjustment', v_actor, v_request);

    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;

    return jsonb_build_object('ok', true, 'reason', 'replayed',
                              'adjustment', to_jsonb(v_adjustment));
  end if;

  v_decision := private.settle_approval(v_req.id, 'rejected', v_actor, v_role, v_reason);

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, approval_reference, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false,
    'stock_adjustment_rejected', 'stock_adjustment', p_adjustment_id,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'rejected', 'reason', v_reason, 'decision_id', v_decision),
    v_req.id, v_corr, 'api.admin_reject_stock_adjustment'
  );

  return jsonb_build_object('ok', true, 'reason', 'rejected',
                            'adjustment', to_jsonb(v_adjustment));
end;
$$;

comment on function api.admin_reject_stock_adjustment(uuid, text, text) is
  'Director rejection of a manual stock adjustment. Records no approver (product.md §4.3) and '
  'changes no balance.';

-- ---------------------------------------------------------------------------
-- The ownership and grant rule, re-applied over the whole api schema — now with four prefixes.
--
-- Not optional housekeeping: a function created without an explicit REVOKE keeps PostgreSQL's
-- default, in which PUBLIC holds EXECUTE. Migration 000100 records that
-- `alter default privileges ... revoke execute` reports success on this database and writes no
-- pg_default_acl row, so this loop is the control.
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
