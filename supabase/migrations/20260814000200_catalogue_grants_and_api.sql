-- Stage 10 Part B · Catalogue grants, RLS, and the Director-only write surface
--
-- The same two independent mechanisms as Stage 8A (architecture.md §13.1): GRANT decides which
-- tables and columns a role may touch, RLS decides which rows. Both are required, and neither is
-- allowed to be the only one.
--
-- READ is deliberately wide: every live role may read the catalogue and its prices. A Sales
-- Representative cannot write an order without knowing what a thing costs, and hiding the price
-- from them would be a rule product.md does not contain. What is narrow is the NAVIGATION — only
-- a Manager and a Director are offered Products & prices (design.md §4.2) — and the WRITE, which
-- is Director-only (product.md §4).
--
-- Hiding a control is a usability measure. The refusal that matters happens here.

begin;

alter table public.units                enable row level security;
alter table public.inventory_locations  enable row level security;
alter table public.products             enable row level security;
alter table public.product_prices       enable row level security;

-- ---------------------------------------------------------------------------
-- Reads. One permissive policy per table and action: two would be ORed and evaluated separately
-- on every row, which the advisors flag and which makes "who can see this?" a harder question
-- than it needs to be.
--
-- `private.authorize` is wrapped in a scalar subquery so the planner evaluates it once per
-- statement rather than once per row (the `auth_rls_initplan` rule).
-- ---------------------------------------------------------------------------
grant select on public.units               to authenticated;
grant select on public.inventory_locations to authenticated;
grant select on public.products            to authenticated;
grant select on public.product_prices      to authenticated;
grant select on public.product_current_prices to authenticated;

create policy units_select_live_staff on public.units
  for select to authenticated
  using ( (select private.authorize(
             array['director','manager','cashier','sales_rep']::public.app_role[])) );

create policy locations_select_live_staff on public.inventory_locations
  for select to authenticated
  using ( (select private.authorize(
             array['director','manager','cashier','sales_rep']::public.app_role[])) );

create policy products_select_live_staff on public.products
  for select to authenticated
  using ( (select private.authorize(
             array['director','manager','cashier','sales_rep']::public.app_role[])) );

create policy prices_select_live_staff on public.product_prices
  for select to authenticated
  using ( (select private.authorize(
             array['director','manager','cashier','sales_rep']::public.app_role[])) );

-- ---------------------------------------------------------------------------
-- Writes. There is no INSERT, UPDATE or DELETE grant to `authenticated` on any of these tables,
-- and no policy for those actions either — so a hand-rolled PostgREST call fails on privilege
-- before a policy is ever consulted. Every write goes through the `api.admin_*` functions below,
-- which derive the acting Director from the verified session and take no actor parameter.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- What the definer owner needs, and no more.
--
-- `fv_definer_owner` is not the owner of these tables, so RLS applies to it inside SECURITY
-- DEFINER functions and it needs both a grant and a policy. It gets INSERT and SELECT and nothing
-- else: there is no UPDATE or DELETE grant on `product_prices` for anybody, and the append-only
-- trigger refuses those anyway. Two independent reasons a price cannot be rewritten.
--
-- `idempotency_keys` is written only inside functions and read by nobody, which is why it carries
-- RLS with no policy for `authenticated` (advisors.sql tolerates it by name). The definer owner
-- needs its own policy to write there.
-- ---------------------------------------------------------------------------
grant select         on public.units             to fv_definer_owner;
grant select, insert on public.products          to fv_definer_owner;
grant select, insert on public.product_prices    to fv_definer_owner;
grant select, insert on public.idempotency_keys  to fv_definer_owner;

create policy units_definer_owner_select on public.units
  for select to fv_definer_owner using ( true );

create policy products_definer_owner_read on public.products
  for select to fv_definer_owner using ( true );

create policy products_definer_owner_insert on public.products
  for insert to fv_definer_owner with check ( true );

create policy prices_definer_owner_read on public.product_prices
  for select to fv_definer_owner using ( true );

create policy prices_definer_owner_insert on public.product_prices
  for insert to fv_definer_owner with check ( true );

create policy idempotency_definer_owner_read on public.idempotency_keys
  for select to fv_definer_owner using ( true );

create policy idempotency_definer_owner_insert on public.idempotency_keys
  for insert to fv_definer_owner with check ( true );

-- The append-only trigger function is reachable by nobody: PostgreSQL does not check EXECUTE when
-- firing a trigger, so this costs nothing and closes the default PUBLIC grant that the Stage 8A
-- surface tests refuse to tolerate.
revoke execute on function private.refuse_price_history_edit()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- api.admin_add_product
-- ---------------------------------------------------------------------------
create or replace function api.admin_add_product(
  p_name            text,
  p_specification   text,
  p_unit_code       text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := private.acting_director();
  v_name       text := btrim(coalesce(p_name, ''));
  v_spec       text := nullif(btrim(coalesce(p_specification, '')), '');
  v_corr       uuid := gen_random_uuid();
  v_product_id uuid := gen_random_uuid();
  v_product    public.products%rowtype;
  v_key        public.idempotency_keys%rowtype;
  v_claimed    integer;
begin
  -- A key that already exists is a REPLAY: return what the first call produced rather than
  -- doing the work again. Read without a lock — `select ... for update` needs an UPDATE privilege
  -- this role deliberately does not hold, and the claim below settles the race on its own.
  select * into v_key from public.idempotency_keys where key = p_idempotency_key;
  if found then
    if v_key.operation <> 'catalogue.add_product' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    select * into v_product from public.products where id = v_key.result_ref;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'product', to_jsonb(v_product));
  end if;

  -- Validation runs before the key is CLAIMED, so a refusal leaves it free. The interface reuses
  -- one key for a whole interaction: a Director who mistypes, corrects it and submits again would
  -- otherwise be told their corrected attempt was a replay of the refusal it corrects.
  if length(v_name) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'name_required');
  end if;

  if not exists (select 1 from public.units u where u.code = p_unit_code) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_unit');
  end if;

  -- Identity is name + specification, compared the way the unique index compares it, so the
  -- refusal is a sentence the Director can act on rather than a constraint violation.
  if exists (
    select 1 from public.products p
     where lower(btrim(p.name)) = lower(v_name)
       and lower(coalesce(btrim(p.specification), '')) = lower(coalesce(v_spec, ''))
  ) then
    return jsonb_build_object('ok', false, 'reason', 'product_exists');
  end if;

  -- Claimed by inserting it, carrying the id the product is about to be given. One statement
  -- decides the winner and records the result, so there is no second update to forget. Everything
  -- below is one transaction: a later failure unclaims the key along with it.
  insert into public.idempotency_keys (key, operation, result_ref, created_by)
  values (p_idempotency_key, 'catalogue.add_product', v_product_id, v_actor)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    select * into v_key from public.idempotency_keys where key = p_idempotency_key;
    if v_key.operation <> 'catalogue.add_product' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    select * into v_product from public.products where id = v_key.result_ref;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'product', to_jsonb(v_product));
  end if;

  insert into public.products (id, name, specification, unit_code, created_by)
  values (v_product_id, v_name, v_spec, p_unit_code, v_actor)
  returning * into v_product;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, private.live_role_of(v_actor), false,
    'product_added', 'product', v_product.id,
    null, to_jsonb(v_product), v_corr, 'api.admin_add_product'
  );

  return jsonb_build_object('ok', true, 'reason', 'added', 'product', to_jsonb(v_product));
end;
$$;

comment on function api.admin_add_product(text, text, text, text) is
  'Adds a catalogue product. Director-only: the actor comes from the verified session, so there is '
  'no parameter for a caller to aim. Adds NO price — a new product is priceless until a Director '
  'sets one, and the interface says so.';

-- ---------------------------------------------------------------------------
-- api.admin_set_product_price
-- ---------------------------------------------------------------------------
create or replace function api.admin_set_product_price(
  p_product_id      uuid,
  p_price_tzs       bigint,
  p_reason          text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := private.acting_director();
  v_reason   text := btrim(coalesce(p_reason, ''));
  v_corr     uuid := gen_random_uuid();
  v_entry_id uuid := gen_random_uuid();
  v_current  public.product_prices%rowtype;
  v_entry    public.product_prices%rowtype;
  v_key      public.idempotency_keys%rowtype;
  v_claimed  integer;
begin
  -- A key that already exists is a REPLAY: hand back the entry the first call wrote. Checked
  -- before anything else, so a repeated request can never append a second price to permanent
  -- history.
  select * into v_key from public.idempotency_keys where key = p_idempotency_key;
  if found then
    if v_key.operation <> 'catalogue.set_price' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    select * into v_entry from public.product_prices where id = v_key.result_ref;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'price', to_jsonb(v_entry));
  end if;

  -- Validation before the CLAIM, for the same reason as add_product: a corrected retry under the
  -- same key must be a real attempt, not a replay of the refusal it is correcting.
  if not exists (select 1 from public.products where id = p_product_id) then
    return jsonb_build_object('ok', false, 'reason', 'no_product');
  end if;

  if p_price_tzs is null or p_price_tzs <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'price_required');
  end if;

  if length(v_reason) < 3 then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  -- Serialised per product for the rest of the transaction. Either Director may act independently
  -- (product.md §4), so two price changes to one product can genuinely arrive at once — and
  -- `previous_price_tzs` has to be the price that was current when THIS entry was written, or the
  -- history reads as a chain of changes that never happened.
  --
  -- An advisory lock rather than `select ... for update`: row locking needs an UPDATE privilege,
  -- and nothing in this system updates a product row. Released when the transaction ends.
  perform pg_advisory_xact_lock(hashtextextended(p_product_id::text, 0));

  select * into v_current from public.product_prices
   where product_id = p_product_id
   order by entry_seq desc
   limit 1;

  -- Re-approving the same number is not a price change, and writing it would put an entry in the
  -- history that reads as a decision nobody made.
  if found and v_current.price_tzs = p_price_tzs then
    return jsonb_build_object('ok', false, 'reason', 'price_unchanged');
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by)
  values (p_idempotency_key, 'catalogue.set_price', v_entry_id, v_actor)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    select * into v_key from public.idempotency_keys where key = p_idempotency_key;
    if v_key.operation <> 'catalogue.set_price' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    select * into v_entry from public.product_prices where id = v_key.result_ref;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'price', to_jsonb(v_entry));
  end if;

  insert into public.product_prices (
    id, product_id, price_tzs, previous_price_tzs, reason, set_by, set_by_role, correlation_id
  )
  values (
    v_entry_id, p_product_id, p_price_tzs, v_current.price_tzs, v_reason,
    v_actor, private.live_role_of(v_actor), v_corr
  )
  returning * into v_entry;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, private.live_role_of(v_actor), false,
    case when v_current.id is null then 'product_price_set' else 'product_price_changed' end,
    'product', p_product_id,
    case when v_current.id is null then null
         else jsonb_build_object('price_tzs', v_current.price_tzs) end,
    jsonb_build_object('price_tzs', p_price_tzs, 'reason', v_reason),
    v_corr, 'api.admin_set_product_price'
  );

  return jsonb_build_object('ok', true, 'reason',
    case when v_current.id is null then 'set' else 'changed' end,
    'price', to_jsonb(v_entry));
end;
$$;

comment on function api.admin_set_product_price(uuid, bigint, text, text) is
  'Sets or changes a selling price, Director-only (product.md §4). Appends immutable history '
  'carrying the acting Director, the old price, the new price, the effective time and a reason '
  '(§4.4). Never updates a previous entry.';

-- ---------------------------------------------------------------------------
-- The same ownership and grant policy Stage 8B established, re-applied so the two new functions
-- are covered by exactly the rule the tests assert: `admin_` to authenticated, nothing public.
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
    if fn.proname like 'admin\_%' or fn.proname like 'self\_%' then
      execute format('grant execute on function %s to authenticated', fn.signature);
    elsif fn.proname like 'service\_%' then
      execute format('grant execute on function %s to service_role', fn.signature);
    else
      raise exception 'api.% has no audience prefix (admin_, self_ or service_)', fn.proname;
    end if;
  end loop;
end
$$;

-- service_role holds no table privilege in `public`, and the two new tables and the view must not
-- have quietly acquired one. Re-asserted rather than assumed; the advisors fail the run otherwise.
revoke all on public.units                 from service_role;
revoke all on public.inventory_locations   from service_role;
revoke all on public.products              from service_role;
revoke all on public.product_prices        from service_role;
revoke all on public.product_current_prices from service_role;

commit;
