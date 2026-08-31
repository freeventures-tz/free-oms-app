-- Stage 10D · Suppliers, the append-only inventory ledger, receiving, opening stock,
--              internal transfers and manual adjustments
--
-- This is the migration that makes stock a fact rather than an estimate. Everything in it exists to
-- serve one sentence from product.md §1: every physical item must be traceable from entry into Free
-- Ventures until sale, consumption, dispatch, rejection or reconciliation.
--
-- Four decisions shape the whole file, and each is load-bearing:
--
--   1. THE LEDGER IS THE STOCK. There is no balance column anywhere. A balance is the sum of signed
--      movements, so the number on the screen and the history behind it are the same fact and
--      cannot drift apart. This is the `product_prices` decision from Part B, applied to quantity.
--
--   2. EVERY LEDGER ROW CARRIES AN AUTHORISER, and the column is NOT NULL. AC-82 says no silent
--      stock change occurs and every change carries a record identifying cause, actor and
--      authorisation. A nullable `approved_by` would make that a convention; NOT NULL makes it a
--      thing the database cannot be talked out of.
--
--   3. SHORT AND EXCESS ARE GENERATED COLUMNS. §5.2 and AC-27/AC-28 say they are calculated, never
--      typed, and never netted against one another. Generated columns mean there is nowhere to type
--      them and no single field in which one could cancel the other.
--
--   4. QUANTITIES ARE WHOLE COUNTING UNITS. product.md §6 says a product is COUNTED in one counting
--      unit, and every quantity in the document is a whole number — 1 bag, 5 buckets, 20 bricks.
--      bigint, therefore, and no numeric anywhere. Part C separated the count from the content
--      precisely so that a quantity of 40 has exactly one meaning (§6.1 rule 3).
--
-- What this migration deliberately does NOT contain, because product.md does not define it:
--
--   · Reserved and committed stock. §8.1 subtracts them from physical stock, and they are created
--     by orders, which do not exist yet. Stage 10 §4 puts them out of scope by name.
--   · A preset list of delivery-damage reasons. design.md §7.14 asks for presets; product.md
--     defines none, and design.md is a draft that must not be the source of a business rule
--     (memory.md §2). The quantity is captured — which is what §9 actually requires — with an
--     optional note beside it.
--   · Supplier contact details. §9 requires "supplier" on a receipt and nothing more. A phone
--     number, an address and a TIN are all plausible and all invented, so none is here.

begin;

-- ---------------------------------------------------------------------------
-- What a movement IS, and what state the stock is in
--
-- Both enums are declared with their whole V1 set now, the way `approval_type` was in Stage 8A,
-- because the alternative is a later migration that changes what an existing row means. Only the
-- first five movement kinds are written by this stage; the rest arrive with their own modules and
-- are cited so a reader can check that none was invented.
-- ---------------------------------------------------------------------------
create type public.stock_movement_kind as enum (
  'opening_stock',      -- the baseline a location starts from (Stage 10 §3)
  'supplier_receipt',   -- goods accepted from a supplier, after Manager approval (§9)
  'transfer_out',       -- leaving the source location  (§10)
  'transfer_in',        -- arriving at the destination  (§10)
  'stock_adjustment',   -- Manager-entered, Director-approved correction (§4.1)
  'production_input',   -- materials consumed by a batch, actual confirmed usage (§11.1)
  'production_output',  -- bricks moulded, entering curing (§11.2)
  'curing_accepted',    -- the Manager-accepted quantity leaving curing (§11.4)
  'sale_release'        -- goods handed over against a signed dispatch note (§12.6 step 14)
);

comment on type public.stock_movement_kind is
  'Why a quantity moved. The whole V1 set (product.md §9, §10, §11, §12, §4.1); Stage 10D writes '
  'the first five and the rest arrive with their modules.';

-- Two states, not the seven of §8, and the difference is worth stating.
--
-- §8 lists Available, Reserved, Committed, Curing, Ready for inspection, Released, and
-- Rejected/damaged. Only two of those are places physical stock SITS:
--
--   · Reserved and Committed are claims against available stock, not a separate pile. §8.1 makes
--     that explicit — available = physical MINUS reserved and committed — so they are allocations
--     and they belong to sales.
--   · Released stock has left. It is a negative movement, not a state to hold a balance in.
--   · Rejected and damaged stock is recorded on the record that found it — a receipt line, a curing
--     inspection — because V1 has no disposal workflow to move it through and inventing one would
--     put a quantity somewhere nobody ever empties.
--   · Ready for inspection is CURING STOCK WHOSE 72 HOURS HAVE ELAPSED (§11.4). It is derived from
--     a timestamp, and time does not write ledger rows. A scheduled job that moved stock between
--     two states every night would be a second writer of permanent history, doing nothing a
--     comparison against `now()` cannot do.
create type public.stock_state as enum ('available', 'curing');

comment on type public.stock_state is
  'Where physical stock sits: sellable, or inside the curing period (product.md §8, §11.4). '
  'Reserved and committed are allocations against available stock, not states — see §8.1.';

-- ---------------------------------------------------------------------------
-- suppliers
--
-- A name and nothing else. product.md §9 requires a receipt to identify its supplier; it defines no
-- supplier record, so this holds exactly what receiving needs and no field somebody guessed at.
--
-- Deactivated, never deleted — the same rule §3.2 sets for storekeepers and §17.3 for accounts, and
-- for the same reason: receipts point at this row permanently, so it has to keep existing.
-- ---------------------------------------------------------------------------
create table public.suppliers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) between 1 and 120),
  is_active  boolean not null default true,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);

comment on table public.suppliers is
  'Who goods came from (product.md §9). Deactivated, never deleted: a receipt references its '
  'supplier permanently. No contact fields — §9 does not define any, so none is invented.';

-- Total, not partial. Two suppliers reading the same on a receipt are indistinguishable whether one
-- is retired or not, and the receipt is the document somebody will be asked about in a year.
create unique index suppliers_identity_idx
  on public.suppliers (private.canonical_identity(name));

create index suppliers_created_by_idx on public.suppliers (created_by);
create index suppliers_listing_idx    on public.suppliers (is_active, name);

-- ---------------------------------------------------------------------------
-- inventory_ledger — APPEND ONLY
--
-- One row per movement of one product, at one location, in one state. Nothing updates it and
-- nothing deletes from it, enforced below by a trigger that refuses every role including the
-- definer owner — the same three-independent-ways treatment `product_prices` gets.
-- ---------------------------------------------------------------------------
create table public.inventory_ledger (
  id             uuid primary key default gen_random_uuid(),

  -- What "latest" means, and why `occurred_at` is not it: `now()` is the TRANSACTION timestamp, so
  -- two movements written by one approval carry the identical time and a v4 uuid is no tiebreaker.
  -- Part B learned this on `product_prices` when a pgTAP run picked an arbitrary row as current.
  entry_seq      bigint generated always as identity,

  product_id     uuid not null references public.products (id) on delete restrict,
  location_code  text not null references public.inventory_locations (code),
  stock_state    public.stock_state not null,

  -- Signed, and never zero: a movement of nothing is not a movement, and a row recording one would
  -- be an event in the history that nobody caused.
  --
  -- The bound is a typo guard rather than a business rule, exactly as `product_prices.price_tzs`
  -- is: far above any plausible single movement, far below the point where a slipped keypress
  -- passes unnoticed.
  quantity_delta bigint not null
    check (quantity_delta <> 0 and abs(quantity_delta) <= 10000000),

  movement_kind  public.stock_movement_kind not null,

  -- What caused it, in two columns rather than nine nullable foreign keys. `source_type` names the
  -- table and `source_id` the row, so a reader can always get from a quantity back to the document
  -- that justifies it — which is the whole of §1.
  source_type    text not null check (length(btrim(source_type)) > 0),
  source_id      uuid not null,

  -- WHO, twice, because §4.2 says entry and approval are separate facts and both are recorded with
  -- their own actor, role and timestamp. On a receipt entered by a Cashier and approved by a
  -- Manager these are two different people; on a Manager's own receipt they are the same person
  -- acting twice, which §4.2 explicitly permits.
  actor_id       uuid not null references public.profiles (id),
  actor_role     public.app_role not null,

  -- NOT NULL. There is no such thing in V1 as stock that moved on nobody's authority (AC-82).
  approved_by    uuid not null references public.profiles (id),
  approved_role  public.app_role not null,

  correlation_id uuid not null,
  occurred_at    timestamptz not null default clock_timestamp(),
  created_at     timestamptz not null default now()
);

comment on table public.inventory_ledger is
  'Every stock movement, append-only and permanent (product.md §8, §16). Balances are the sum of '
  'these rows and are stored nowhere, so the figure on screen and the history behind it are one '
  'fact. Every row names who caused the movement and who authorised it (AC-82).';

create index inventory_ledger_balance_idx
  on public.inventory_ledger (product_id, location_code, stock_state);
create index inventory_ledger_source_idx    on public.inventory_ledger (source_type, source_id);
create index inventory_ledger_location_idx  on public.inventory_ledger (location_code, entry_seq desc);
create index inventory_ledger_actor_idx     on public.inventory_ledger (actor_id, occurred_at desc);
create index inventory_ledger_approver_idx  on public.inventory_ledger (approved_by, occurred_at desc);
create index inventory_ledger_recent_idx    on public.inventory_ledger (entry_seq desc);

-- Immutability, enforced rather than promised — and not by the grant layer, which is a separate
-- mechanism that could be got wrong in isolation. This refuses the write for EVERY role, so no
-- future function can quietly amend a movement either.
create or replace function private.refuse_ledger_edit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'inventory_ledger is append-only: % refused on movement %',
    tg_op, coalesce(old.id, new.id)
    using errcode = 'restrict_violation';
end;
$$;

comment on function private.refuse_ledger_edit() is
  'Refuses every UPDATE and DELETE on inventory_ledger, for every role. A movement that put a '
  'quantity somewhere must still read the same years later; a correction is a new row (§16).';

alter function private.refuse_ledger_edit() owner to fv_definer_owner;

create trigger inventory_ledger_refuse_update
  before update on public.inventory_ledger
  for each row execute function private.refuse_ledger_edit();

create trigger inventory_ledger_refuse_delete
  before delete on public.inventory_ledger
  for each row execute function private.refuse_ledger_edit();

-- ---------------------------------------------------------------------------
-- Stock cannot go negative, and this is where that is decided
--
-- Every command below takes an advisory lock and checks the balance before it writes. This trigger
-- exists because that is a check each command has to REMEMBER to do, and there will be more
-- commands: production consumption, sale release, adjustments nobody has thought of yet. A
-- constraint trigger deferred to the end of the transaction sees the whole effect of a multi-row
-- movement — a transfer writes a negative and a positive, and judging the negative alone would
-- refuse legitimate work — and it cannot be forgotten by a function written next year.
-- ---------------------------------------------------------------------------
create or replace function private.refuse_negative_stock()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_balance bigint;
begin
  select coalesce(sum(l.quantity_delta), 0) into v_balance
    from public.inventory_ledger l
   where l.product_id    = new.product_id
     and l.location_code = new.location_code
     and l.stock_state   = new.stock_state;

  if v_balance < 0 then
    raise exception
      'stock at % for product % in state % would fall to %, and a location cannot hold less than '
      'nothing', new.location_code, new.product_id, new.stock_state, v_balance
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

comment on function private.refuse_negative_stock() is
  'A location cannot hold less than nothing. Deferred to commit so a multi-row movement is judged '
  'by its whole effect rather than by whichever row happened to be written first.';

alter function private.refuse_negative_stock() owner to fv_definer_owner;

create constraint trigger inventory_ledger_no_negative_stock
  after insert on public.inventory_ledger
  deferrable initially deferred
  for each row execute function private.refuse_negative_stock();

-- ---------------------------------------------------------------------------
-- current_stock — the balance, derived
--
-- `security_invoker` so the view is not a way around RLS: it sees exactly what the caller's own
-- policies allow on the ledger.
--
-- Zero balances are KEPT. "This product was here and is now none" and "this product was never
-- here" are different answers, and a `having sum(...) <> 0` would render them identically — the
-- same mistake as `data ?? []` on a failed read (lib/supabase/query.ts), one layer down.
-- ---------------------------------------------------------------------------
create view public.current_stock
with (security_invoker = true) as
select l.product_id,
       l.location_code,
       l.stock_state,
       -- `sum(bigint)` widens to numeric, which would hand the application a decimal type for a
       -- count of whole bags. Cast back: every movement is capped at ten million and bigint holds
       -- nine quintillion, so the sum cannot leave the range the column itself allows.
       sum(l.quantity_delta)::bigint as quantity,
       max(l.occurred_at)            as last_movement_at,
       count(*)                      as movement_count
  from public.inventory_ledger l
 group by l.product_id, l.location_code, l.stock_state;

comment on view public.current_stock is
  'Physical stock per product, location and state: the sum of the ledger. Not available stock — '
  '§8.1 subtracts reserved and committed, which are created by orders and do not exist yet.';

-- ---------------------------------------------------------------------------
-- opening_stock_entries — the baseline, once per product and location
--
-- Director-only and single-step. Opening stock creates inventory that no supplier receipt
-- justifies, which is the same risk shape as a manual adjustment (§4.1) — somebody types a number
-- and stock exists. §4.1 puts a Director on the approving side of that, and the most restrictive
-- reading available is to put a Director on both sides: they enter it and they are the authority
-- for it, in one act, recorded as both actor and approver on the ledger row.
--
-- ONCE per product and location is a plain unique index because there is no pending state to make
-- it complicated: the entry either exists or it does not. Correcting one is a manual stock
-- adjustment (§4.1), which is below in this same file.
-- ---------------------------------------------------------------------------
create table public.opening_stock_entries (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null references public.products (id) on delete restrict,
  location_code text not null references public.inventory_locations (code),
  quantity      bigint not null check (quantity >= 0 and quantity <= 10000000),
  note          text check (note is null or length(btrim(note)) between 1 and 500),
  entered_by    uuid not null references public.profiles (id),
  entered_role  public.app_role not null,
  entered_at    timestamptz not null default now(),

  unique (product_id, location_code)
);

comment on table public.opening_stock_entries is
  'What a location held when the system started counting, entered once per product and location by '
  'a Director. A quantity of zero is a real answer — "we checked, there is none" — and is recorded '
  'as an entry with no ledger movement behind it.';

create index opening_stock_entered_by_idx on public.opening_stock_entries (entered_by);
create index opening_stock_location_idx   on public.opening_stock_entries (location_code);

-- ---------------------------------------------------------------------------
-- stock_receipts — what arrived from a supplier (product.md §9)
--
-- The record carries no status column. Its status is the `approval_requests` row that points at it,
-- because §4.3's rule — only an approved outcome records an approver — is already implemented there
-- as a check constraint, and a mirrored column would be a second copy of the truth to keep in step.
-- ---------------------------------------------------------------------------
create table public.stock_receipts (
  id                uuid primary key default gen_random_uuid(),
  supplier_id       uuid not null references public.suppliers (id) on delete restrict,
  location_code     text not null references public.inventory_locations (code),

  -- "Supporting delivery information" (§9), required because §9 says the record must capture it and
  -- §5.3 says required accountability data cannot be skipped. One of the few genuinely necessary
  -- text inputs, in the same class as the physical dispatch-note number (design.md §10.2).
  delivery_note_ref text not null check (length(btrim(delivery_note_ref)) between 1 and 60),
  delivery_date     date not null,

  entered_by        uuid not null references public.profiles (id),
  entered_role      public.app_role not null,
  entered_at        timestamptz not null default now()
);

comment on table public.stock_receipts is
  'A delivery from a supplier (product.md §9). Entry may be delegated to a Cashier or a Sales '
  'Representative; Manager approval is always required and stock increases only then (§9.1).';

create index stock_receipts_supplier_idx  on public.stock_receipts (supplier_id, delivery_date desc);
create index stock_receipts_location_idx  on public.stock_receipts (location_code, delivery_date desc);
create index stock_receipts_entered_by_idx on public.stock_receipts (entered_by, entered_at desc);
create index stock_receipts_recent_idx    on public.stock_receipts (entered_at desc);

-- ---------------------------------------------------------------------------
-- stock_receipt_lines
--
-- The three quantities a human records, and the three the system works out. §5.2 lists supplier
-- shortages and excesses among the values a user must never be asked to type, and AC-28 says a
-- shortage is never netted against an excess. Generated columns settle both: there is no field to
-- type them into, and short and excess are two separate stored expressions that cannot cancel.
-- ---------------------------------------------------------------------------
create table public.stock_receipt_lines (
  id                uuid primary key default gen_random_uuid(),
  receipt_id        uuid not null references public.stock_receipts (id) on delete restrict,
  product_id        uuid not null references public.products (id) on delete restrict,

  expected_quantity bigint not null check (expected_quantity >= 0 and expected_quantity <= 10000000),
  received_quantity bigint not null check (received_quantity >= 0 and received_quantity <= 10000000),
  damaged_quantity  bigint not null default 0
    check (damaged_quantity >= 0 and damaged_quantity <= 10000000),

  -- Optional, and optional on purpose. design.md §7.14 wants preset damage reasons; product.md
  -- defines none, and a draft is not a source of business rules (memory.md §2). §9 requires the
  -- QUANTITY, which is above and is not optional.
  damage_note       text check (damage_note is null or length(btrim(damage_note)) between 1 and 500),

  -- Calculated, never typed (§5.2, AC-27, AC-28). A shortage of one unit is a shortage.
  short_quantity    bigint generated always as
                      (greatest(expected_quantity - received_quantity, 0)) stored,
  excess_quantity   bigint generated always as
                      (greatest(received_quantity - expected_quantity, 0)) stored,

  -- What actually becomes sellable stock. §8 records damaged goods as unsellable, so they never
  -- enter the ledger: the quantity stays on this line as a permanent documented fact instead of
  -- being added to a yard balance and then subtracted again by a disposal step V1 does not have.
  accepted_quantity bigint generated always as (received_quantity - damaged_quantity) stored,

  constraint receipt_line_damage_within_received check (damaged_quantity <= received_quantity),

  -- One line per product per receipt, so two lines cannot disagree about the same delivery.
  unique (receipt_id, product_id)
);

comment on table public.stock_receipt_lines is
  'What was expected, what arrived, and what was damaged. Short, excess and accepted are GENERATED '
  'columns: product.md §5.2 forbids asking a user to type them and AC-28 forbids netting a '
  'shortage against an excess, and a generated column makes both impossible rather than unlikely.';

create index stock_receipt_lines_receipt_idx on public.stock_receipt_lines (receipt_id);
create index stock_receipt_lines_product_idx on public.stock_receipt_lines (product_id);
-- The shortage register (§9.1: every shortage remains documented, however small).
create index stock_receipt_lines_short_idx
  on public.stock_receipt_lines (product_id) where short_quantity > 0;

-- ---------------------------------------------------------------------------
-- stock_transfers — Store, Warehouse, Yard (product.md §10)
-- ---------------------------------------------------------------------------
create table public.stock_transfers (
  id            uuid primary key default gen_random_uuid(),
  from_location text not null references public.inventory_locations (code),
  to_location   text not null references public.inventory_locations (code),
  note          text check (note is null or length(btrim(note)) between 1 and 500),
  entered_by    uuid not null references public.profiles (id),
  entered_role  public.app_role not null,
  entered_at    timestamptz not null default now(),

  constraint transfer_locations_differ check (from_location <> to_location)
);

comment on table public.stock_transfers is
  'A move between the three V1 locations (product.md §10). Balances change only on Manager '
  'approval, and the source is re-checked at that moment rather than at entry.';

create index stock_transfers_from_idx       on public.stock_transfers (from_location, entered_at desc);
create index stock_transfers_to_idx         on public.stock_transfers (to_location, entered_at desc);
create index stock_transfers_entered_by_idx on public.stock_transfers (entered_by, entered_at desc);
create index stock_transfers_recent_idx     on public.stock_transfers (entered_at desc);

create table public.stock_transfer_lines (
  id          uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.stock_transfers (id) on delete restrict,
  product_id  uuid not null references public.products (id) on delete restrict,
  quantity    bigint not null check (quantity > 0 and quantity <= 10000000),

  unique (transfer_id, product_id)
);

create index stock_transfer_lines_transfer_idx on public.stock_transfer_lines (transfer_id);
create index stock_transfer_lines_product_idx  on public.stock_transfer_lines (product_id);

-- ---------------------------------------------------------------------------
-- stock_adjustments — the correction path (product.md §4.1)
--
-- "Manual stock adjustment, unexplained loss, shortage correction | Manager enters | Director
-- approves". It lives here rather than with reconciliation because it is a stock movement with an
-- approval, and because without it an append-only ledger has no way to be corrected at all — which
-- is not a missing convenience but a defect in a permanent record.
-- ---------------------------------------------------------------------------
create table public.stock_adjustments (
  id             uuid primary key default gen_random_uuid(),
  product_id     uuid not null references public.products (id) on delete restrict,
  location_code  text not null references public.inventory_locations (code),

  -- Signed: an unexplained loss is negative, a shortage correction may be either.
  quantity_delta bigint not null
    check (quantity_delta <> 0 and abs(quantity_delta) <= 10000000),

  -- Required. An adjustment is the one movement with no document behind it, so the explanation IS
  -- the document. Same rule as a price change (§4.4), for the same reason.
  reason         text not null check (length(btrim(reason)) between 3 and 500),

  entered_by     uuid not null references public.profiles (id),
  entered_role   public.app_role not null,
  entered_at     timestamptz not null default now()
);

comment on table public.stock_adjustments is
  'A Manager-entered, Director-approved correction to stock (product.md §4.1). Nothing moves until '
  'the Director approves, and the reason is required because no other document explains it.';

create index stock_adjustments_product_idx    on public.stock_adjustments (product_id, entered_at desc);
create index stock_adjustments_location_idx   on public.stock_adjustments (location_code, entered_at desc);
create index stock_adjustments_entered_by_idx on public.stock_adjustments (entered_by, entered_at desc);
create index stock_adjustments_recent_idx     on public.stock_adjustments (entered_at desc);

commit;
