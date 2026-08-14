-- Stage 10 Part B · Catalogue: units, locations, products, and immutable selling prices
--
-- ADDITIVE ONLY. Nothing here alters or drops an existing object, so the deployed application —
-- which knows none of these tables — keeps working unchanged after this migration is applied.
-- That is what lets the migration ship before the code that uses it.
--
-- The shape follows product.md rather than convenience:
--
--   · Grade is part of product IDENTITY, not an attribute (§6). "Nondo 12 mm BS 300" and
--     "Nondo 12 mm BS 500" are two products, and the uniqueness rule says so.
--   · A selling price is Director-only (§4), and every change is immutable history carrying the
--     acting Director, the old price, the new price, the effective time and a reason (§4.4).
--   · A product with no approved price is a normal state, not a zero. There is no price row, and
--     nothing invents one.
--   · Money is whole shillings as bigint (architecture.md §5.12). No numeric, no float, anywhere.

begin;

-- ---------------------------------------------------------------------------
-- units — the approved units of measure, exactly those product.md §6 uses.
--
-- A code, not a label. Every word a user reads is a translation key (design.md §8.2), so the
-- English and Swahili names live in the message dictionaries and never in a row.
-- ---------------------------------------------------------------------------
create table public.units (
  code       text primary key check (code ~ '^[a-z0-9_]+$'),
  sort_order integer not null
);

comment on table public.units is
  'Approved units of measure (product.md §6). Reference data: seeded here, never user-editable.';

-- ---------------------------------------------------------------------------
-- inventory_locations — Store, Warehouse, Yard (product.md §7).
--
-- Seeded now because the catalogue is where reference data belongs and the set is fixed at three.
-- NOTHING in this stage reads stock: there are no balances, no ledger and no movements yet.
-- ---------------------------------------------------------------------------
create table public.inventory_locations (
  code       text primary key check (code ~ '^[a-z0-9_]+$'),
  sort_order integer not null
);

comment on table public.inventory_locations is
  'The three V1 inventory locations (product.md §7). Reference data only in this stage — no '
  'balances, no ledger, no movements exist yet.';

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------
create table public.products (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(btrim(name)) between 1 and 80),

  -- Grade or specification, part of identity. NULL for a product that has none — an empty string
  -- would be a second way to say "none" and the uniqueness rule would have to know about both.
  specification text check (specification is null or length(btrim(specification)) between 1 and 40),

  unit_code     text not null references public.units (code),
  is_active     boolean not null default true,

  -- NULL for the seeded catalogue: it was approved in product.md, not entered by anyone.
  created_by    uuid references public.profiles (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.products is
  'The sellable catalogue (product.md §6). Grade is part of identity: Nondo 12 mm BS 300 and '
  'Nondo 12 mm BS 500 are two rows, not one row with an attribute.';

-- Identity is the pair, compared case- and space-insensitively so "nondo 12 mm / bs 300" cannot be
-- entered a second time in different clothes.
create unique index products_identity_idx
  on public.products (lower(btrim(name)), lower(coalesce(btrim(specification), '')));

create index products_unit_idx       on public.products (unit_code);
create index products_created_by_idx on public.products (created_by);
create index products_listing_idx    on public.products (is_active, name, specification);

-- ---------------------------------------------------------------------------
-- product_prices — append-only selling-price history (product.md §4.4)
--
-- The current price is not a column anywhere. It is the newest row for a product, which means the
-- displayed price and the history are the same fact and cannot drift apart.
-- ---------------------------------------------------------------------------
create table public.product_prices (
  id                 uuid primary key default gen_random_uuid(),

  -- What "newest" MEANS. `effective_at` is the business fact — when the price took effect — and it
  -- is not safe to order by: `now()` returns the TRANSACTION timestamp, so two entries written in
  -- one transaction carry the identical time, and a random v4 uuid is no tiebreaker at all. A
  -- pgTAP run found exactly that, picking an arbitrary row as "current". This is monotonic, so
  -- the newest entry is never in doubt.
  entry_seq          bigint generated always as identity,

  product_id         uuid not null references public.products (id) on delete restrict,

  -- Whole shillings. The upper bound is a typo guard, not a business rule: it is far above any
  -- plausible unit price and far below the point where a slipped keypress goes unnoticed.
  price_tzs          bigint not null check (price_tzs > 0 and price_tzs <= 100000000),

  -- What this entry replaced. NULL means this is the first price the product ever had, which is a
  -- different fact from "it used to be zero".
  previous_price_tzs bigint check (previous_price_tzs is null or previous_price_tzs > 0),

  reason             text not null check (length(btrim(reason)) between 3 and 500),

  set_by             uuid not null references public.profiles (id),
  set_by_role        public.app_role not null,
  -- clock_timestamp(), not now(): the moment this entry was written, not the moment the
  -- transaction began. Ordering is `entry_seq`'s job; this is the fact a Director reads.
  effective_at       timestamptz not null default clock_timestamp(),
  correlation_id     uuid not null,
  created_at         timestamptz not null default now(),

  -- A price change that changes nothing is a mistake, not history.
  constraint product_prices_is_a_change
    check (previous_price_tzs is null or previous_price_tzs <> price_tzs)
);

comment on table public.product_prices is
  'Append-only selling-price history (product.md §4.4). Never edited, never deleted. The newest '
  'row for a product IS its current price.';

create index product_prices_history_idx on public.product_prices (product_id, entry_seq desc);
create index product_prices_set_by_idx  on public.product_prices (set_by);

-- ---------------------------------------------------------------------------
-- Immutability, enforced rather than promised.
--
-- The grant layer already withholds UPDATE and DELETE from `authenticated`, and service_role holds
-- no table privilege at all. This trigger is the layer that does not depend on a grant being right:
-- it refuses the write for every role, including the definer owner and the table owner, so no
-- future function can quietly amend history either.
-- ---------------------------------------------------------------------------
create or replace function private.refuse_price_history_edit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'product_prices is append-only: % refused on price entry %',
    tg_op, coalesce(old.id, new.id)
    using errcode = 'restrict_violation';
end;
$$;

comment on function private.refuse_price_history_edit() is
  'Refuses every UPDATE and DELETE on product_prices, for every role. A price a Director handed to '
  'a customer must still be readable years later exactly as it was set.';

alter function private.refuse_price_history_edit() owner to fv_definer_owner;

create trigger product_prices_refuse_update
  before update on public.product_prices
  for each row execute function private.refuse_price_history_edit();

create trigger product_prices_refuse_delete
  before delete on public.product_prices
  for each row execute function private.refuse_price_history_edit();

-- ---------------------------------------------------------------------------
-- product_current_prices — the newest entry per product.
--
-- `security_invoker` so the view is not a way around RLS: it sees exactly what the caller's own
-- policies allow on product_prices. A product with no price simply has no row here, which is what
-- lets the interface say "no price set" rather than display a zero nobody approved.
-- ---------------------------------------------------------------------------
create view public.product_current_prices
with (security_invoker = true) as
select distinct on (pp.product_id)
       pp.product_id,
       pp.id           as price_id,
       pp.price_tzs,
       pp.effective_at,
       pp.set_by,
       pp.reason
  from public.product_prices pp
 order by pp.product_id, pp.entry_seq desc;

comment on view public.product_current_prices is
  'The current selling price per product: the newest history entry. No row means no approved '
  'price, which is a state the interface names rather than a zero it invents.';

commit;
