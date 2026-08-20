-- Stage 10 Part C · Counting units, and what one counted unit contains
--
-- Part B gave every product a unit, and three of those units answered two questions at once:
-- `piece_12ft`, `bag_50kg`, `bucket_20l`. Each one names a thing you can count AND the amount that
-- thing holds. A catalogue survives that. A ledger does not: a movement of 40 against `bag_50kg`
-- reads as 40 bags or as 2 000 kg depending on who is looking, and stock rows cannot be rewritten
-- afterwards by anyone, including us.
--
-- So the two facts are separated now, before the receiving ledger exists to record the ambiguity
-- permanently (product.md §6):
--
--   · the COUNTING UNIT is what the business counts, receives, transfers, deducts and prices.
--     There is exactly one per product, and every quantity in the system is a count of it.
--   · the CONTENT is what one counted item holds — `50 kg`, `20 litres`, `12 ft`. It is
--     descriptive. V1 stores no conversion factor, no base measurement and no second quantity,
--     and nothing computes with it.
--
-- Content is part of product IDENTITY (§6.2), for the same reason grade already is: a 50 kg bag of
-- cement and a 25 kg bag are counted separately, priced separately and sold separately.
--
-- FORWARD ONLY. The 21 applied migrations are untouched. Products are migrated IN PLACE — this file
-- snapshots every product id and every price row before it starts and refuses to commit if one of
-- them moved, because production holds real products with real audit history behind them.

begin;

-- ---------------------------------------------------------------------------
-- units — now a Director-creatable counting unit rather than a fixed code
--
-- Labels live on the ROW, one per language, and are read at runtime. This is a deliberate and
-- narrow exception to "every word a user reads is a translation key" (design.md §8.2): a Director
-- who needs a `drum` at six in the morning cannot wait for a message file to ship. Every other word
-- on the screen is still a key.
--
-- `code` stays the primary key because products reference it and the seed is written in terms of
-- it. `id` is the stable identity the idempotency ledger points at, since `result_ref` is a uuid.
-- Two identifiers on one table earns its keep here and nowhere else.
-- ---------------------------------------------------------------------------
alter table public.units
  add column id         uuid not null default gen_random_uuid(),
  add column label_en   text,
  add column label_sw   text,
  add column is_active  boolean not null default true,
  add column created_by uuid references public.profiles (id),
  add column created_at timestamptz not null default now();

alter table public.units add constraint units_id_key unique (id);

comment on column public.units.id is
  'The stable identity a claimed idempotency key points at. Products reference `code`.';
comment on column public.units.label_en is
  'What a Director typed for English readers. Business data, not a translation key.';
comment on column public.units.label_sw is
  'The same unit in Swahili. Required: a unit with no Swahili name is unusable to half the yard.';
comment on column public.units.is_active is
  'Whether this unit may be chosen for a new product. Retiring one never rewrites the products '
  'that already use it.';

-- The generic counting units. `piece`, `sheet` and `bar` already exist and only need naming.
update public.units set label_en = 'piece', label_sw = 'kipande', sort_order = 10 where code = 'piece';
update public.units set label_en = 'sheet', label_sw = 'bati',    sort_order = 50 where code = 'sheet';
update public.units set label_en = 'bar',   label_sw = 'fito',    sort_order = 60 where code = 'bar';

insert into public.units (code, sort_order, label_en, label_sw) values
  ('bag',    20, 'bag',    'mfuko'),
  ('bucket', 30, 'bucket', 'ndoo')
on conflict (code) do nothing;

-- The three that combined a count with a content. Kept, so a future reader of an old row can still
-- find out what `bag_50kg` meant, and sorted out of the way of the units that are actually offered.
update public.units set
  label_en = '12 ft piece', label_sw = 'kipande cha futi 12', is_active = false, sort_order = 910
 where code = 'piece_12ft';
update public.units set
  label_en = '50 kg bag',   label_sw = 'mfuko wa kilo 50',    is_active = false, sort_order = 920
 where code = 'bag_50kg';
update public.units set
  label_en = '20-litre bucket', label_sw = 'ndoo ya lita 20', is_active = false, sort_order = 930
 where code = 'bucket_20l';

alter table public.units
  alter column label_en set not null,
  alter column label_sw set not null,
  add constraint units_label_en_shape check (length(btrim(label_en)) between 1 and 40),
  add constraint units_label_sw_shape check (length(btrim(label_sw)) between 1 and 40);

-- Uniqueness is about what a Director can CHOOSE, so it covers active units only. Two units that
-- read identically in either language would be indistinguishable in the picker, which is the whole
-- failure. A retired label is free to be used again.
create unique index units_active_label_en_idx
  on public.units (private.canonical_identity(label_en)) where is_active;
create unique index units_active_label_sw_idx
  on public.units (private.canonical_identity(label_sw)) where is_active;

create index units_created_by_idx on public.units (created_by);

-- ---------------------------------------------------------------------------
-- products.unit_content — what one counted unit holds
--
-- Nullable, because most products hold nothing in particular: a sheet of marine ply is a sheet.
-- Blank is folded to null on the way in, so there is exactly one way to say "none" and the
-- identity rule below never has to know about two.
-- ---------------------------------------------------------------------------
alter table public.products
  add column unit_content text
    check (unit_content is null or length(btrim(unit_content)) between 1 and 40);

comment on column public.products.unit_content is
  'What one counting unit of this product contains: 50 kg, 20 litres, 12 ft. DESCRIPTIVE — nothing '
  'converts it and nothing counts in it (product.md §6.1 rule 3). Part of product identity, so a '
  '50 kg bag and a 25 kg bag are two products.';

-- ---------------------------------------------------------------------------
-- The catalogue, migrated in place
--
-- By UNIT rather than by name, because the mapping is exact: `bag_50kg` meant a bag holding 50 kg,
-- and that is now a `bag` with content `50 kg`. Doing it by name would leave any product a Director
-- added since Part B behind.
--
-- The snapshot below is the point of this block. Production holds 21 products with price history
-- and audit rows keyed to their ids; an UPDATE preserves them and a delete-and-reinsert would
-- silently orphan every one. The check makes the difference impossible to get wrong quietly.
-- ---------------------------------------------------------------------------
create temporary table _fv_products_before on commit drop as
  select id, name, specification, unit_code from public.products;

create temporary table _fv_prices_before on commit drop as
  select id, product_id from public.product_prices;

update public.products set unit_code = 'bag',    unit_content = '50 kg'     where unit_code = 'bag_50kg';
update public.products set unit_code = 'bucket', unit_content = '20 litres' where unit_code = 'bucket_20l';
update public.products set unit_code = 'piece',  unit_content = '12 ft'     where unit_code = 'piece_12ft';

do $$
declare
  v_lost      integer;
  v_gained    integer;
  v_renamed   integer;
  v_prices    integer;
  v_stranded  integer;
begin
  select count(*) into v_lost
    from _fv_products_before b
   where not exists (select 1 from public.products p where p.id = b.id);

  select count(*) into v_gained
    from public.products p
   where not exists (select 1 from _fv_products_before b where b.id = p.id);

  select count(*) into v_renamed
    from _fv_products_before b
    join public.products p on p.id = b.id
   where p.name is distinct from b.name
      or p.specification is distinct from b.specification;

  select count(*) into v_prices
    from _fv_prices_before b
   where not exists (
     select 1 from public.product_prices pp where pp.id = b.id and pp.product_id = b.product_id);

  if v_lost > 0 or v_gained > 0 then
    raise exception
      'product identities changed during the counting-unit migration: % lost, % new. Every id must '
      'survive, because price history and audit rows point at them', v_lost, v_gained;
  end if;

  if v_renamed > 0 then
    raise exception 'this migration changes units and content only, but % product name(s) or '
      'specification(s) changed', v_renamed;
  end if;

  if v_prices > 0 then
    raise exception '% price row(s) no longer point at the product they were written for', v_prices;
  end if;

  -- The reason the whole exercise exists: after this, no product is counted in a unit that also
  -- states an amount.
  select count(*) into v_stranded
    from public.products p join public.units u on u.code = p.unit_code
   where not u.is_active;

  if v_stranded > 0 then
    raise exception '% product(s) still reference a retired package-specific unit', v_stranded;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Identity now includes content
--
-- Same canonical form as before, one more column in it. "Cement / 50 kg" and "Cement / 25 kg" are
-- two products; "Cement / 50 kg" and "cement /  50  KG " are one.
-- ---------------------------------------------------------------------------
drop index public.products_identity_idx;

create unique index products_identity_idx
  on public.products (
    private.canonical_identity(name),
    private.canonical_identity(coalesce(specification, '')),
    private.canonical_identity(coalesce(unit_content, ''))
  );

-- ---------------------------------------------------------------------------
-- Grants and policies for the one new write path
--
-- `authenticated` gains nothing: no INSERT, no UPDATE, no DELETE grant on `units` and no policy for
-- any of them, so a hand-rolled PostgREST call fails on privilege before a policy is consulted.
-- Part C adds no rename and no delete path for anybody, including the definer owner.
-- ---------------------------------------------------------------------------
grant insert on public.units to fv_definer_owner;

create policy units_definer_owner_insert on public.units
  for insert to fv_definer_owner with check ( true );

-- ---------------------------------------------------------------------------
-- api.admin_add_unit
--
-- Same shape as every other command in this system: the actor is derived from the verified session
-- and is not a parameter, the key is bound to the command it was claimed for, validation runs
-- before the claim so a corrected retry is a real attempt, and the whole thing is one transaction.
-- ---------------------------------------------------------------------------
create or replace function api.admin_add_unit(
  p_label_en        text,
  p_label_sw        text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := private.acting_director();

  v_label_en text := private.normalise_label(p_label_en);
  v_label_sw text := private.normalise_label(p_label_sw);

  v_corr     uuid := gen_random_uuid();
  v_unit_id  uuid := gen_random_uuid();
  v_unit     public.units%rowtype;
  v_class    jsonb;
  v_claimed  integer;
  v_slug     text;
  v_code     text;
  v_suffix   integer := 1;
  v_sort     integer;

  v_request  jsonb := jsonb_build_object(
    'label_en', private.canonical_identity(v_label_en),
    'label_sw', private.canonical_identity(v_label_sw)
  );
begin
  -- Same key, same instant. An impatient double-tap arrives as several transactions that all begin
  -- before any of them commits, so without this they classify the key as unclaimed TOGETHER, run
  -- the duplicate check TOGETHER against a catalogue none of them has written to yet, and only then
  -- race for the claim. The losers have already decided there is no duplicate — but by the time
  -- they look again the winner has committed one, and they answer `unit_exists` for the very
  -- request that just succeeded. That is a refusal reported for a change that happened.
  --
  -- Serialised on the presented KEY, before the first classification, so the second transaction
  -- reads the database the first one left behind and replays its result. Two unrelated keys may
  -- hash to the same lock and wait for each other; that costs milliseconds and changes no answer.
  -- Held for the rest of the transaction and released with it, the same as the per-product lock in
  -- `api.admin_set_product_price`.
  --
  -- `coalesce` because `pg_advisory_xact_lock` is strict: a null key would hash to null, take no
  -- lock at all, and leave this comment describing something that did not happen. A null key is
  -- refused a few lines further down by the primary key on `idempotency_keys`.
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'catalogue.add_unit', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_unit from public.units where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'unit', to_jsonb(v_unit));
  end if;

  if length(v_label_en) = 0 or length(v_label_sw) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'label_required');
  end if;

  -- Compared through the same canonical form the partial unique indexes use, so the refusal is a
  -- sentence a Director can act on rather than a constraint violation they cannot read.
  if exists (
    select 1 from public.units u
     where u.is_active
       and (private.canonical_identity(u.label_en) = private.canonical_identity(v_label_en)
         or private.canonical_identity(u.label_sw) = private.canonical_identity(v_label_sw))
  ) then
    return jsonb_build_object('ok', false, 'reason', 'unit_exists');
  end if;

  -- The server owns the identifier. The caller supplies two labels and nothing else, so there is
  -- no code to collide, mistype, or aim at an existing row.
  v_slug := btrim(regexp_replace(lower(v_label_en), '[^a-z0-9]+', '_', 'g'), '_');
  if v_slug = '' then
    v_slug := 'unit';
  end if;
  v_slug := left(v_slug, 36);
  v_code := v_slug;

  while exists (select 1 from public.units u where u.code = v_code) loop
    v_suffix := v_suffix + 1;
    v_code := v_slug || '_' || v_suffix::text;
  end loop;

  -- New units sort after the seeded ones and before the retired block, in creation order.
  select coalesce(max(u.sort_order), 60) + 10 into v_sort
    from public.units u where u.is_active;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'catalogue.add_unit', v_unit_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'catalogue.add_unit', v_actor, v_request);

    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;

    select * into v_unit from public.units where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'unit', to_jsonb(v_unit));
  end if;

  insert into public.units (id, code, sort_order, label_en, label_sw, is_active, created_by)
  values (v_unit_id, v_code, v_sort, v_label_en, v_label_sw, true, v_actor)
  returning * into v_unit;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_actor, private.live_role_of(v_actor), false,
    'unit_added', 'unit', v_unit.id,
    null, to_jsonb(v_unit), v_corr, 'api.admin_add_unit'
  );

  return jsonb_build_object('ok', true, 'reason', 'added', 'unit', to_jsonb(v_unit));
end;
$$;

comment on function api.admin_add_unit(text, text, text) is
  'Creates a reusable counting unit, Director-only (product.md §6.1 rule 5). Takes two labels and '
  'an idempotency key; the server owns the identifier. There is no rename and no delete path.';

-- ---------------------------------------------------------------------------
-- api.admin_add_product, now carrying content
--
-- DROPPED and recreated rather than replaced, because adding a parameter to a function creates an
-- overload rather than replacing it, and PostgREST would then have two candidates for one name.
--
-- `p_unit_content` DEFAULTS, which is not decoration: the migration and the application deploy
-- separately, and between the two the live site still calls this with four arguments. A default
-- keeps that call resolving instead of breaking the Add product screen for the length of a deploy.
-- ---------------------------------------------------------------------------
drop function api.admin_add_product(text, text, text, text);

create or replace function api.admin_add_product(
  p_name            text,
  p_specification   text,
  p_unit_code       text,
  p_idempotency_key text,
  p_unit_content    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := private.acting_director();

  v_name       text := private.normalise_label(p_name);
  v_spec       text := nullif(private.normalise_label(p_specification), '');
  -- Blank folds to null here, so "  " and nothing at all are the same answer rather than two.
  v_content    text := nullif(private.normalise_label(p_unit_content), '');

  v_corr       uuid := gen_random_uuid();
  v_product_id uuid := gen_random_uuid();
  v_product    public.products%rowtype;
  v_class      jsonb;
  v_claimed    integer;

  v_request    jsonb := jsonb_build_object(
    'name',          private.canonical_identity(v_name),
    'specification', private.canonical_identity(coalesce(v_spec, '')),
    'unit_code',     p_unit_code,
    'unit_content',  private.canonical_identity(coalesce(v_content, ''))
  );
begin
  -- Serialised on the presented KEY before anything reads the catalogue, for the reason set out at
  -- length over `api.admin_add_unit` above: without it, concurrent identical requests all decide
  -- there is no duplicate before any of them commits, and the losers then answer `product_exists`
  -- for the request that just succeeded.
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));

  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'catalogue.add_product', v_actor, v_request);

  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  if v_class ->> 'status' = 'replay' then
    select * into v_product from public.products where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'product', to_jsonb(v_product));
  end if;

  if length(v_name) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'name_required');
  end if;

  -- ACTIVE, not merely present. `bag_50kg` still exists so old rows remain readable, and offering
  -- it to a new product would undo this whole migration one product at a time.
  if not exists (select 1 from public.units u where u.code = p_unit_code and u.is_active) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_unit');
  end if;

  -- Identity is the TRIPLE now (product.md §6.2): same name and grade with different content is a
  -- different product, and the catalogue is expected to hold both.
  if exists (
    select 1 from public.products p
     where private.canonical_identity(p.name) = private.canonical_identity(v_name)
       and private.canonical_identity(coalesce(p.specification, ''))
         = private.canonical_identity(coalesce(v_spec, ''))
       and private.canonical_identity(coalesce(p.unit_content, ''))
         = private.canonical_identity(coalesce(v_content, ''))
  ) then
    return jsonb_build_object('ok', false, 'reason', 'product_exists');
  end if;

  insert into public.idempotency_keys (key, operation, result_ref, created_by, request)
  values (p_idempotency_key, 'catalogue.add_product', v_product_id, v_actor, v_request)
  on conflict (key) do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    v_class := private.classify_idempotency_key(
      p_idempotency_key, 'catalogue.add_product', v_actor, v_request);

    if v_class ->> 'status' <> 'replay' then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;

    select * into v_product from public.products where id = (v_class ->> 'result_ref')::uuid;
    return jsonb_build_object('ok', true, 'reason', 'replayed', 'product', to_jsonb(v_product));
  end if;

  insert into public.products (id, name, specification, unit_code, unit_content, created_by)
  values (v_product_id, v_name, v_spec, p_unit_code, v_content, v_actor)
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

comment on function api.admin_add_product(text, text, text, text, text) is
  'Adds a catalogue product with its counting unit and optional content. Director-only: the actor '
  'comes from the verified session, so there is no parameter for a caller to aim. Adds NO price — '
  'a new product is priceless until a Director sets one, and the interface says so.';

-- ---------------------------------------------------------------------------
-- The ownership and grant rule, re-applied over the whole api schema.
--
-- Not optional housekeeping: `drop function` took the old grants with it, and a function created
-- without an explicit REVOKE keeps PostgreSQL's default in which PUBLIC holds EXECUTE.
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

-- service_role holds no table privilege in `public`, and the altered tables must not have quietly
-- acquired one. Re-asserted rather than assumed; the advisors fail the run otherwise.
revoke all on public.units    from service_role;
revoke all on public.products from service_role;

commit;
