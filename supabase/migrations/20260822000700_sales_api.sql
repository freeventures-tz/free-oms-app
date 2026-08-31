-- Stage 11 · The order command surface
--
-- Eight commands, built to the shape every stage before this one established: the actor comes from
-- the verified session, an advisory lock on the presented idempotency key is taken before the first
-- classification, validation runs before the key is claimed, and everything is one transaction.
--
-- THE THREE RULES THAT SHAPE THESE PARTICULAR COMMANDS:
--
--   · CREATING AN ORDER CREATES A PROFORMA, AUTOMATICALLY. §12.1 point 2, and AC-9: there is no
--     manual creation path for a proforma or an invoice, so no command here is named for one.
--     `staff_create_order` issues the proforma itself, and `staff_confirm_order` issues the invoice.
--
--   · CONFIRMATION IS THE MOMENT STOCK IS CLAIMED AND A BILL EXISTS — except on the Cash Customer
--     path, where §12.4 says nothing exists until payment. Both live in `staff_confirm_order`,
--     because they are the same decision with two consequences, and separating them would let a
--     caller pick the wrong one.
--
--   · A DISCOUNT IS AN AUTHORITY DECISION BEFORE IT IS A NUMBER. §4 lets a Manager approve up to
--     5%, and only on orders above TZS 1,000,000; anything else is a Director's. The requested
--     percentage lives on the approval request until somebody with the authority approves it, so an
--     unapproved discount can never reach an invoice.

begin;

-- ---------------------------------------------------------------------------
-- private.available_quantity — product.md §8.1, for a decision rather than a screen
--
-- The view is for reading. This is for the moment a command must know whether a claim is allowed,
-- and it is separate so the caller has already taken the advisory lock that keeps the answer true a
-- line later.
-- ---------------------------------------------------------------------------
create or replace function private.available_quantity(p_product_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select a.available_quantity from public.product_availability a
      where a.product_id = p_product_id), 0);
$$;

comment on function private.available_quantity(uuid) is
  'Physical stock minus reserved and committed (product.md §8.1). Paid or approved goods remain '
  'physically present and simply cannot be sold again.';

alter function private.available_quantity(uuid) owner to fv_definer_owner;
revoke execute on function private.available_quantity(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.discount_needs_director — product.md §4, as one function
--
-- "Manager approval of discounts: up to 5%, and only for orders above TZS 1,000,000. Anything
-- beyond these limits requires Director approval." AC-18 states the same thing from the other side.
--
-- Written once because it is asked twice — when the request is raised, to decide whose decision it
-- is, and when it is approved, to check that the person approving actually holds that authority. A
-- second copy is how a stale `required_role` becomes a way around the limit.
-- ---------------------------------------------------------------------------
create or replace function private.discount_needs_director(
  p_percent  numeric,
  p_subtotal bigint
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  -- Above 5%, OR any discount at all on an order of TZS 1,000,000 or below.
  select p_percent > 5 or p_subtotal <= 1000000;
$$;

comment on function private.discount_needs_director(numeric, bigint) is
  'Whether a discount is beyond a Manager''s authority (product.md §4, AC-18): above 5%, or any '
  'discount on an order of TZS 1,000,000 or below.';

alter function private.discount_needs_director(numeric, bigint) owner to fv_definer_owner;
revoke execute on function private.discount_needs_director(numeric, bigint)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- api.staff_add_customer
--
-- FLAGGED FOR THE OWNER, alongside the supplier decision in Stage 10D, because the two look
-- inconsistent and the difference is deliberate:
--
--   A supplier delivery is arranged in advance, so registering a supplier can wait for a Director.
--   A customer walks in unannounced, and making a sale wait for a Director would stop the yard.
--
-- So a customer may be registered by whoever may create an order. product.md defines neither, and
-- this is the reading that keeps the business working; the owner may narrow it.
-- ---------------------------------------------------------------------------
create or replace function api.staff_add_customer(
  p_name            text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor       uuid := private.acting_staff(
                          array['sales_rep','manager','director']::public.app_role[]);
  v_role        public.app_role := private.live_role_of(v_actor);
  v_name        text := private.normalise_label(p_name);
  v_corr        uuid := gen_random_uuid();
  v_customer_id uuid := gen_random_uuid();
  v_customer    public.customers%rowtype;
  v_class       jsonb;
  v_claimed     integer;
  v_request     jsonb := jsonb_build_object('name', private.canonical_identity(v_name));
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'sales.add_customer', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_customer from public.customers where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'customer', to_jsonb(v_customer));
  end if;

  if length(v_name) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'customer_name_required');
  end if;

  if exists (
    select 1 from public.customers c
     where private.canonical_identity(c.name) = private.canonical_identity(v_name)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'customer_exists');
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'sales.add_customer', v_customer_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'sales.add_customer', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    select * into v_customer from public.customers where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'customer', to_jsonb(v_customer));
  end if;

  -- `is_cash_customer` is not a parameter. There is exactly one Cash Customer, it is seeded, and no
  -- caller may mint a second walk-in identity (§12.4).
  insert into public.customers (id, name, created_by)
  values (v_customer_id, v_name, v_actor)
  returning * into v_customer;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'customer_added', 'customer', v_customer.id,
    null, to_jsonb(v_customer), v_corr, 'api.staff_add_customer'
  );

  return jsonb_build_object('ok', true, 'reason', 'added', 'customer', to_jsonb(v_customer));
end;
$$;

comment on function api.staff_add_customer(text, text) is
  'Registers a customer. Cannot create a second Cash Customer: that row is seeded and its flag is '
  'not a parameter (product.md §12.4).';

-- ---------------------------------------------------------------------------
-- api.staff_create_order
--
-- Creates the order, its lines at the CURRENTLY APPROVED price, and — automatically — its first
-- proforma. AC-5 and AC-9 together: a draft order produces a proforma, and no interface anywhere
-- offers to create one by hand.
--
-- Reserves nothing. AC-6: a proforma creates no debt and no inventory change.
-- ---------------------------------------------------------------------------
create or replace function api.staff_create_order(
  p_customer_id     uuid,
  p_lines           jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := private.acting_staff(
                       array['sales_rep','manager','director']::public.app_role[]);
  v_role     public.app_role := private.live_role_of(v_actor);
  v_corr     uuid := gen_random_uuid();
  v_order_id uuid := gen_random_uuid();
  v_order    public.orders%rowtype;
  v_customer public.customers%rowtype;
  v_proforma public.proformas%rowtype;
  v_problem  text;
  v_class    jsonb;
  v_claimed  integer;
  v_request  jsonb := jsonb_build_object(
    'customer_id', p_customer_id, 'lines', coalesce(p_lines, '[]'::jsonb));
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'sales.create_order', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_order from public.orders where id = (v_class ->> 'result_ref')::uuid;
    select * into v_proforma from public.proformas
      where order_id = v_order.id order by version desc limit 1;
    return jsonb_build_object('ok', true, 'reason', 'replayed',
                              'order', to_jsonb(v_order), 'proforma', to_jsonb(v_proforma));
  end if;

  select * into v_customer from public.customers where id = p_customer_id and is_active;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_customer');
  end if;

  v_problem := private.check_order_lines(p_lines);

  if v_problem is not null then
    return jsonb_build_object('ok', false, 'reason', v_problem);
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'sales.create_order', v_order_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'sales.create_order', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    select * into v_order from public.orders where id = (v_class ->> 'result_ref')::uuid;
    select * into v_proforma from public.proformas
      where order_id = v_order.id order by version desc limit 1;
    return jsonb_build_object('ok', true, 'reason', 'replayed',
                              'order', to_jsonb(v_order), 'proforma', to_jsonb(v_proforma));
  end if;

  insert into public.orders (
    id, order_no, customer_id, status, is_cash_sale, created_by, created_role
  )
  values (
    v_order_id, private.next_document_number('order', 'FV-ORD'), p_customer_id, 'proforma',
    v_customer.is_cash_customer, v_actor, v_role
  )
  returning * into v_order;

  -- The price is read from the approved current price and SNAPSHOTTED. A Director changing it
  -- tomorrow must not silently rewrite what this customer was quoted today.
  insert into public.order_lines (order_id, product_id, quantity, unit_price_tzs)
  select v_order_id,
         (t.elem ->> 'product_id')::uuid,
         (t.elem ->> 'quantity')::bigint,
         c.price_tzs
    from jsonb_array_elements(p_lines) as t(elem)
    join public.product_current_prices c on c.product_id = (t.elem ->> 'product_id')::uuid;

  v_proforma := private.issue_proforma(v_order_id, v_actor, gen_random_uuid());

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'order_created', 'order', v_order_id,
    null,
    jsonb_build_object('order_no', v_order.order_no, 'proforma_no', v_proforma.proforma_no,
                       'total_tzs', v_proforma.total_tzs),
    v_corr, 'api.staff_create_order'
  );

  return jsonb_build_object('ok', true, 'reason', 'created',
                            'order', to_jsonb(v_order), 'proforma', to_jsonb(v_proforma));
end;
$$;

comment on function api.staff_create_order(uuid, jsonb, text) is
  'Creates an order and its first proforma automatically (product.md §12.1, AC-5). Creates no debt '
  'and reserves no stock (AC-6). Refuses any product without an approved selling price.';

-- ---------------------------------------------------------------------------
-- api.staff_revise_proforma
--
-- §12.1 point 4: a proforma may be revised BEFORE acceptance, with full version history. After
-- acceptance an invoice exists, and an invoice is immutable — the correction is a cancellation and
-- a replacement (AC-12), not a quieter edit here.
-- ---------------------------------------------------------------------------
create or replace function api.staff_revise_proforma(
  p_order_id        uuid,
  p_lines           jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := private.acting_staff(
                       array['sales_rep','manager','director']::public.app_role[]);
  v_role     public.app_role := private.live_role_of(v_actor);
  v_corr     uuid := gen_random_uuid();
  v_order    public.orders%rowtype;
  v_proforma public.proformas%rowtype;
  -- Minted here so the key can be claimed with the id of the version this call will create, in one
  -- statement. A replay then hands back THIS version rather than whichever is newest when the
  -- replay arrives.
  v_proforma_id uuid := gen_random_uuid();
  v_problem  text;
  v_class    jsonb;
  v_claimed  integer;
  v_request  jsonb := jsonb_build_object(
    'order_id', p_order_id, 'lines', coalesce(p_lines, '[]'::jsonb));
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'sales.revise_proforma', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_proforma from public.proformas where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'proforma', to_jsonb(v_proforma));
  end if;

  perform pg_advisory_xact_lock(hashtextextended('order:' || p_order_id::text, 0));

  select * into v_order from public.orders where id = p_order_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_order');
  end if;

  if v_order.status <> 'proforma' then
    return jsonb_build_object('ok', false, 'reason', 'order_not_revisable',
                              'status', v_order.status::text);
  end if;

  v_problem := private.check_order_lines(p_lines);

  if v_problem is not null then
    return jsonb_build_object('ok', false, 'reason', v_problem);
  end if;

  -- The key is claimed with the PROFORMA it is about to create as its result, so a replay hands
  -- back the version this call made rather than whichever is newest at the time it is replayed.
  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'sales.revise_proforma', v_proforma_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'sales.revise_proforma', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    select * into v_proforma from public.proformas where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'proforma', to_jsonb(v_proforma));
  end if;

  -- Lines are REPLACED, not merged. `order_lines` has no update path and no delete grant, so a
  -- revision writes a new set only after removing the old one — which is the single place in the
  -- sales schema where a delete is legitimate, because an order line is a working draft and the
  -- permanent record of what was quoted is the superseded proforma version beside it.
  delete from public.order_lines where order_id = p_order_id;

  insert into public.order_lines (order_id, product_id, quantity, unit_price_tzs)
  select p_order_id,
         (t.elem ->> 'product_id')::uuid,
         (t.elem ->> 'quantity')::bigint,
         c.price_tzs
    from jsonb_array_elements(p_lines) as t(elem)
    join public.product_current_prices c on c.product_id = (t.elem ->> 'product_id')::uuid;

  v_proforma := private.issue_proforma(p_order_id, v_actor, v_proforma_id);

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'proforma_revised', 'order', p_order_id,
    null,
    jsonb_build_object('proforma_no', v_proforma.proforma_no, 'version', v_proforma.version,
                       'total_tzs', v_proforma.total_tzs),
    v_corr, 'api.staff_revise_proforma'
  );

  return jsonb_build_object('ok', true, 'reason', 'revised', 'proforma', to_jsonb(v_proforma));
end;
$$;

comment on function api.staff_revise_proforma(uuid, jsonb, text) is
  'Issues the next proforma version (product.md §12.1 point 4). Every earlier version stays '
  'retrievable exactly as it was issued. Refused once the order is confirmed: an invoice exists by '
  'then, and an invoice is corrected by cancellation and replacement (AC-12).';

-- ---------------------------------------------------------------------------
-- api.staff_request_discount
--
-- Raises the approval; it does NOT apply the discount. The requested percentage lives on the
-- approval request until somebody with the authority approves it, so an unapproved discount cannot
-- reach a proforma, an invoice or a customer.
-- ---------------------------------------------------------------------------
create or replace function api.staff_request_discount(
  p_order_id        uuid,
  p_percent         numeric,
  p_reason          text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := private.acting_staff(
                       array['sales_rep','manager','director']::public.app_role[]);
  v_role     public.app_role := private.live_role_of(v_actor);
  v_reason   text := private.normalise_label(p_reason);
  v_corr     uuid := gen_random_uuid();
  v_order    public.orders%rowtype;
  v_totals   record;
  v_required public.app_role;
  -- Minted here for the same reason the proforma id is: the key is claimed with the id of the
  -- approval this call creates, in one statement, so there is no second update to forget.
  v_request_id uuid := gen_random_uuid();
  v_class    jsonb;
  v_claimed  integer;
  v_request  jsonb := jsonb_build_object(
    'order_id', p_order_id, 'percent', p_percent,
    'reason', private.canonical_identity(v_reason));
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'sales.request_discount', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    return jsonb_build_object('ok', true, 'reason', 'replayed',
                              'approval_request_id', v_class ->> 'result_ref');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('order:' || p_order_id::text, 0));

  select * into v_order from public.orders where id = p_order_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_order');
  end if;

  if v_order.status <> 'proforma' then
    return jsonb_build_object('ok', false, 'reason', 'order_not_revisable',
                              'status', v_order.status::text);
  end if;

  if p_percent is null or p_percent <= 0 or p_percent > 100 then
    return jsonb_build_object('ok', false, 'reason', 'discount_invalid');
  end if;

  if length(v_reason) < 3 then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  if exists (
    select 1 from public.approval_requests r
     where r.entity_type = 'order' and r.entity_id = p_order_id
       and r.approval_type = 'discount' and r.status = 'pending'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'discount_already_pending');
  end if;

  select * into v_totals from private.order_totals(p_order_id);

  -- Whose decision this is, decided from the limits rather than from who happened to ask (§4).
  v_required := case
    when private.discount_needs_director(p_percent, v_totals.subtotal_tzs) then 'director'
    else 'manager'
  end::public.app_role;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'sales.request_discount', v_request_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'sales.request_discount', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    return jsonb_build_object('ok', true, 'reason', 'replayed',
                              'approval_request_id', v_class ->> 'result_ref');
  end if;

  -- `request_seq` climbs, so a rejected discount can be asked for again with a different figure and
  -- the earlier decision stays in the record (§4.3: a later decision never overwrites an earlier).
  insert into public.approval_requests (
    id, entity_type, entity_id, approval_type, request_seq,
    requested_by, requested_role, requested_percent, required_role, status
  )
  values (
    v_request_id, 'order', p_order_id, 'discount',
    (select coalesce(max(r.request_seq), 0) + 1 from public.approval_requests r
      where r.entity_type = 'order' and r.entity_id = p_order_id and r.approval_type = 'discount'),
    v_actor, v_role, p_percent, v_required, 'pending'
  );

  -- Kept on the order so the screen can show what was asked for while it waits, without the
  -- percentage being APPLIED to anything: `discount_percent` is untouched until approval.
  update public.orders set discount_reason = v_reason where id = p_order_id;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, approval_reference, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'discount_requested', 'order', p_order_id,
    jsonb_build_object('discount_percent', v_order.discount_percent),
    jsonb_build_object('requested_percent', p_percent, 'required_role', v_required::text,
                       'reason', v_reason),
    v_request_id, v_corr, 'api.staff_request_discount'
  );

  return jsonb_build_object('ok', true, 'reason', 'requested',
                            'approval_request_id', v_request_id,
                            'required_role', v_required::text,
                            'subtotal_tzs', v_totals.subtotal_tzs);
end;
$$;

comment on function api.staff_request_discount(uuid, numeric, text, text) is
  'Raises a discount approval and applies nothing (product.md §4). Whose decision it is comes from '
  'the limits — above 5%, or any discount on an order of TZS 1,000,000 or below, is a Director''s.';

-- ---------------------------------------------------------------------------
-- api.staff_approve_discount
--
-- Open to a Manager AND a Director, and the limit is re-checked here against the live subtotal. A
-- Manager who is asked to approve something beyond their authority is refused by the database, not
-- merely by a disabled button (design.md §7.8 shows the reason; this is what enforces it).
-- ---------------------------------------------------------------------------
create or replace function api.staff_approve_discount(
  p_order_id        uuid,
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
  v_order    public.orders%rowtype;
  v_req      public.approval_requests%rowtype;
  v_totals   record;
  v_proforma public.proformas%rowtype;
  v_decision uuid;
  v_class    jsonb;
  v_claimed  integer;
  v_request  jsonb := jsonb_build_object('order_id', p_order_id, 'outcome', 'approved');
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'sales.approve_discount', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_order from public.orders where id = p_order_id;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'order', to_jsonb(v_order));
  end if;

  perform pg_advisory_xact_lock(hashtextextended('order:' || p_order_id::text, 0));

  select * into v_order from public.orders where id = p_order_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_order');
  end if;

  select * into v_req from public.approval_requests
   where entity_type = 'order' and entity_id = p_order_id
     and approval_type = 'discount' and status = 'pending'
   order by request_seq desc limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_approval_request');
  end if;

  select * into v_totals from private.order_totals(p_order_id);

  -- The limit, re-checked against the subtotal AS IT IS NOW. The order may have been revised since
  -- the request was raised, and `required_role` on a stale row must never be what decides this.
  if v_role = 'manager'
     and private.discount_needs_director(v_req.requested_percent, v_totals.subtotal_tzs) then
    return jsonb_build_object(
      'ok', false, 'reason', 'director_approval_required',
      'requested_percent', v_req.requested_percent, 'subtotal_tzs', v_totals.subtotal_tzs);
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'sales.approve_discount', p_order_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'sales.approve_discount', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'order', to_jsonb(v_order));
  end if;

  v_decision := private.settle_approval(v_req.id, 'approved', v_actor, v_role, null);

  -- Only NOW does the percentage become the order's.
  update public.orders set discount_percent = v_req.requested_percent
   where id = p_order_id
  returning * into v_order;

  -- What the customer is quoted has changed, so they are quoted again: a new proforma version
  -- rather than a silent edit of the one they already hold (§12.1 point 4).
  v_proforma := private.issue_proforma(p_order_id, v_actor, gen_random_uuid());

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, approval_reference, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'discount_approved', 'order', p_order_id,
    jsonb_build_object('discount_percent', 0),
    jsonb_build_object('discount_percent', v_req.requested_percent,
                       'decision_id', v_decision, 'proforma_no', v_proforma.proforma_no),
    v_req.id, v_corr, 'api.staff_approve_discount'
  );

  return jsonb_build_object('ok', true, 'reason', 'approved',
                            'order', to_jsonb(v_order), 'proforma', to_jsonb(v_proforma));
end;
$$;

comment on function api.staff_approve_discount(uuid, text) is
  'Approves a discount within the approver''s authority (product.md §4, AC-17, AC-18) and issues a '
  'new proforma version, because what the customer is quoted has changed.';

-- ---------------------------------------------------------------------------
-- api.staff_reject_discount
-- ---------------------------------------------------------------------------
create or replace function api.staff_reject_discount(
  p_order_id        uuid,
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
  v_req      public.approval_requests%rowtype;
  v_totals   record;
  v_decision uuid;
  v_class    jsonb;
  v_claimed  integer;
  v_request  jsonb := jsonb_build_object(
    'order_id', p_order_id, 'outcome', 'rejected', 'reason', v_reason);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'sales.reject_discount', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    return jsonb_build_object('ok', true, 'reason', 'replayed');
  end if;

  if length(v_reason) < 3 then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('order:' || p_order_id::text, 0));

  select * into v_req from public.approval_requests
   where entity_type = 'order' and entity_id = p_order_id
     and approval_type = 'discount' and status = 'pending'
   order by request_seq desc limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_approval_request');
  end if;

  select * into v_totals from private.order_totals(p_order_id);

  -- THE SAME LIMIT THE APPROVAL PATH CHECKS, against the subtotal AS IT IS NOW (product.md §4).
  --
  -- A rejection is not a lesser decision than an approval: §4.3 makes it a completed decision that
  -- settles the request and closes it, and §4 gives "anything beyond these limits" to a Director.
  -- A Manager who could refuse a discount only a Director may grant would be deciding it either
  -- way — the customer gets no discount, the request is closed, and no Director ever saw it.
  --
  -- Judged on the CURRENT total for the same reason approval is: the order can be revised after the
  -- request is raised, and `required_role` on a stale row must never be what decides authority.
  if v_role = 'manager'
     and private.discount_needs_director(v_req.requested_percent, v_totals.subtotal_tzs) then
    return jsonb_build_object(
      'ok', false, 'reason', 'director_approval_required',
      'requested_percent', v_req.requested_percent, 'subtotal_tzs', v_totals.subtotal_tzs);
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'sales.reject_discount', v_req.id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'sales.reject_discount', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    return jsonb_build_object('ok', true, 'reason', 'replayed');
  end if;

  -- No approver is recorded, and the check constraint on approval_requests would refuse the row if
  -- one were (§4.3, AC-84). The order's discount stays at zero because it was never applied.
  v_decision := private.settle_approval(v_req.id, 'rejected', v_actor, v_role, v_reason);

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, approval_reference, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'discount_rejected', 'order', p_order_id,
    jsonb_build_object('requested_percent', v_req.requested_percent),
    jsonb_build_object('reason', v_reason, 'decision_id', v_decision),
    v_req.id, v_corr, 'api.staff_reject_discount'
  );

  return jsonb_build_object('ok', true, 'reason', 'rejected');
end;
$$;

comment on function api.staff_reject_discount(uuid, text, text) is
  'Rejects a discount within the rejector''s authority (product.md §4): a discount only a Director '
  'may approve is one only a Director may refuse. Records NO approver (§4.3, AC-84) and leaves the '
  'order at the price it already carried.';

-- ---------------------------------------------------------------------------
-- api.staff_confirm_order — where a quotation becomes a commitment
--
-- TWO OUTCOMES, and which one applies is the customer's, not the caller's:
--
--   Normal customer  reserves stock and generates EXACTLY ONE final invoice (§12.6 steps 4–5).
--   Cash Customer    marks the order confirmed and NOTHING ELSE. §12.4 points 2 and 3, and AC-86
--                    and AC-87: no invoice, no unpaid balance, no reservation, and availability
--                    elsewhere is not reduced by one. A walk-in sale has no unpaid stage, so it
--                    must not create one.
-- ---------------------------------------------------------------------------
create or replace function api.staff_confirm_order(
  p_order_id        uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor     uuid := private.acting_staff(
                        array['sales_rep','manager','director']::public.app_role[]);
  v_role      public.app_role := private.live_role_of(v_actor);
  v_corr      uuid := gen_random_uuid();
  v_order     public.orders%rowtype;
  v_proforma  public.proformas%rowtype;
  v_totals    record;
  v_line      public.order_lines%rowtype;
  v_available bigint;
  v_invoice   public.invoices%rowtype;
  v_class     jsonb;
  v_claimed   integer;
  v_request   jsonb := jsonb_build_object('order_id', p_order_id);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'sales.confirm_order', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_order from public.orders where id = p_order_id;
    select * into v_invoice from public.invoices where order_id = p_order_id;
    return jsonb_build_object('ok', true, 'reason', 'replayed',
                              'order', to_jsonb(v_order), 'invoice', to_jsonb(v_invoice));
  end if;

  perform pg_advisory_xact_lock(hashtextextended('order:' || p_order_id::text, 0));

  select * into v_order from public.orders where id = p_order_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_order');
  end if;

  if v_order.status <> 'proforma' then
    return jsonb_build_object('ok', false, 'reason', 'order_not_confirmable',
                              'status', v_order.status::text);
  end if;

  -- A discount nobody has decided yet would change the invoice total after it was issued, and an
  -- invoice is immutable. So the decision comes first.
  if exists (
    select 1 from public.approval_requests r
     where r.entity_type = 'order' and r.entity_id = p_order_id
       and r.approval_type = 'discount' and r.status = 'pending'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'discount_pending');
  end if;

  select * into v_proforma from public.proformas
   where order_id = p_order_id and superseded_at is null
   order by version desc limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_proforma');
  end if;

  -- An expired quotation must be revised or reissued before confirmation (design.md §14.8). The
  -- prices in it may be months old, and confirming would bill a customer at them.
  if v_proforma.valid_until < private.business_date() then
    return jsonb_build_object('ok', false, 'reason', 'proforma_expired',
                              'valid_until', v_proforma.valid_until::text);
  end if;

  -- THE CASH CUSTOMER PATH. §12.4 point 2: confirmation creates no final invoice, no unpaid
  -- balance and no stock reservation. Point 3: before payment, no Cash Customer stock allocation
  -- exists AT ALL. Everything happens atomically at payment instead (Stage 12).
  if not v_order.is_cash_sale then
    -- Locked in product order, which is what stops two orders for the same product from
    -- deadlocking: both take the same locks in the same sequence.
    for v_line in
      select * from public.order_lines where order_id = p_order_id order by product_id
    loop
      perform pg_advisory_xact_lock(hashtextextended('stock:' || v_line.product_id::text, 0));

      v_available := private.available_quantity(v_line.product_id);

      if v_available < v_line.quantity then
        return jsonb_build_object(
          'ok', false, 'reason', 'insufficient_stock',
          'product_id', v_line.product_id,
          'available', v_available, 'requested', v_line.quantity);
      end if;
    end loop;
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'sales.confirm_order', p_order_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'sales.confirm_order', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    select * into v_invoice from public.invoices where order_id = p_order_id;
    return jsonb_build_object('ok', true, 'reason', 'replayed',
                              'order', to_jsonb(v_order), 'invoice', to_jsonb(v_invoice));
  end if;

  update public.orders set status = 'confirmed', confirmed_at = now()
   where id = p_order_id
  returning * into v_order;

  if v_order.is_cash_sale then
    insert into public.audit_events (
      actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
      before_state, after_state, correlation_id, source_operation
    )
    values (
      v_actor, v_role, false, 'cash_order_confirmed', 'order', p_order_id,
      jsonb_build_object('status', 'proforma'),
      jsonb_build_object('status', 'confirmed', 'invoice', null, 'reservation', null),
      v_corr, 'api.staff_confirm_order'
    );

    return jsonb_build_object('ok', true, 'reason', 'confirmed_cash_sale',
                              'order', to_jsonb(v_order), 'invoice', null);
  end if;

  -- The claim. Physical stock does NOT move (AC-34): the goods are still in the yard and simply
  -- cannot be sold again (§8.1, AC-33).
  insert into public.stock_allocations (order_id, order_line_id, product_id, quantity, state)
  select p_order_id, l.id, l.product_id, l.quantity, 'reserved'
    from public.order_lines l where l.order_id = p_order_id;

  select * into v_totals from private.order_totals(p_order_id);

  insert into public.invoices (
    invoice_no, order_id, customer_id, subtotal_tzs, discount_tzs, total_tzs, business_date
  )
  values (
    private.next_document_number('invoice', 'FV-INV'), p_order_id, v_order.customer_id,
    v_totals.subtotal_tzs, v_totals.discount_tzs, v_totals.total_tzs, private.business_date()
  )
  returning * into v_invoice;

  insert into public.invoice_lines (
    invoice_id, product_id, product_name, product_specification, unit_code, unit_content,
    quantity, unit_price_tzs
  )
  select v_invoice.id, l.product_id, p.name, p.specification, p.unit_code, p.unit_content,
         l.quantity, l.unit_price_tzs
    from public.order_lines l
    join public.products p on p.id = l.product_id
   where l.order_id = p_order_id
   order by p.name;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'order_confirmed', 'order', p_order_id,
    jsonb_build_object('status', 'proforma'),
    jsonb_build_object('status', 'confirmed', 'invoice_no', v_invoice.invoice_no,
                       'total_tzs', v_invoice.total_tzs),
    v_corr, 'api.staff_confirm_order'
  );

  return jsonb_build_object('ok', true, 'reason', 'confirmed',
                            'order', to_jsonb(v_order), 'invoice', to_jsonb(v_invoice));
end;
$$;

comment on function api.staff_confirm_order(uuid, text) is
  'Records customer confirmation. For a normal customer it reserves stock and generates exactly one '
  'final invoice (product.md §12.6, AC-8). For the Cash Customer it creates NO invoice, NO unpaid '
  'balance and NO reservation (§12.4, AC-86, AC-87).';

-- ---------------------------------------------------------------------------
-- api.staff_cancel_order
--
-- §4.3: a cancellation is a completed decision and NOT an approval. It releases every reservation
-- and, where one exists, cancels the invoice — which keeps its number and its history (AC-11).
-- ---------------------------------------------------------------------------
create or replace function api.staff_cancel_order(
  p_order_id        uuid,
  p_reason          text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor     uuid := private.acting_staff(
                        array['sales_rep','manager','director']::public.app_role[]);
  v_role      public.app_role := private.live_role_of(v_actor);
  v_reason    text := private.normalise_label(p_reason);
  v_corr      uuid := gen_random_uuid();
  v_order     public.orders%rowtype;
  v_invoice   public.invoices%rowtype;
  -- What the order ACTUALLY was before this command touched it. The audit record used to state
  -- 'confirmed' unconditionally, which was wrong for every quotation ever cancelled — and an audit
  -- trail that invents the state it changed from is worse than one that records nothing.
  v_prev      public.order_status;
  v_pending   record;
  v_decision  uuid;
  v_decisions jsonb := '[]'::jsonb;
  v_class     jsonb;
  v_claimed   integer;
  v_request   jsonb := jsonb_build_object('order_id', p_order_id, 'reason', v_reason);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'sales.cancel_order', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_order from public.orders where id = p_order_id;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'order', to_jsonb(v_order));
  end if;

  if length(v_reason) < 3 then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('order:' || p_order_id::text, 0));

  select * into v_order from public.orders where id = p_order_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_order');
  end if;

  if v_order.status = 'cancelled' then
    return jsonb_build_object('ok', false, 'reason', 'already_settled', 'status', 'cancelled');
  end if;

  v_prev := v_order.status;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'sales.cancel_order', p_order_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'sales.cancel_order', v_actor, v_request);
    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'order', to_jsonb(v_order));
  end if;

  -- Released, so the stock becomes sellable again. A claim that outlived its order would take
  -- goods out of the yard's availability with nothing to point at.
  update public.stock_allocations
     set state = 'cancelled', updated_at = now()
   where order_id = p_order_id and state in ('reserved', 'committed');

  update public.orders
     set status = 'cancelled', cancelled_at = now(), cancel_reason = v_reason
   where id = p_order_id
  returning * into v_order;

  -- The invoice keeps its number and its history (AC-11). It is not deleted and the number is
  -- never handed to anything else.
  update public.invoices
     set cancelled_at = now(), cancel_reason = v_reason
   where order_id = p_order_id and cancelled_at is null
  returning * into v_invoice;

  -- Any undecided discount is withdrawn with the order it belonged to — THROUGH THE SAME FUNCTION
  -- every other decision goes through.
  --
  -- §4.3 is explicit that a cancelled record is a completed decision and that EVERY decision
  -- records its actor, role, timestamp, reason and outcome in append-only history. Moving
  -- `approval_requests.status` by hand moved the projection and wrote no decision at all, so the
  -- request went from pending to cancelled with nobody's name on it and no reason beside it —
  -- exactly the silent transition §4.3 exists to forbid. `settle_approval` appends the decision and
  -- leaves `approved_by` null for every outcome but `approved`, which the table's own check
  -- constraint enforces besides.
  for v_pending in
    select id from public.approval_requests
     where entity_type = 'order' and entity_id = p_order_id and status = 'pending'
     order by request_seq
  loop
    v_decision := private.settle_approval(v_pending.id, 'cancelled', v_actor, v_role, v_reason);
    v_decisions := v_decisions || to_jsonb(v_decision);
  end loop;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, v_role, false, 'order_cancelled', 'order', p_order_id,
    jsonb_build_object('status', v_prev),
    jsonb_build_object('status', 'cancelled', 'reason', v_reason,
                       'invoice_no', v_invoice.invoice_no,
                       'withdrawn_decisions', v_decisions),
    v_corr, 'api.staff_cancel_order'
  );

  return jsonb_build_object('ok', true, 'reason', 'cancelled', 'order', to_jsonb(v_order));
end;
$$;

comment on function api.staff_cancel_order(uuid, text, text) is
  'Cancels an order, releases every reservation, and cancels its invoice if one exists — which '
  'keeps its number and its history (product.md §4.3, AC-11). Records the status the order was '
  'actually in, and settles every pending decision on it as cancelled, with an actor and a reason '
  'and no approver (§4.3).';

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
