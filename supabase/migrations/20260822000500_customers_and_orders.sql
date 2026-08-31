-- Stage 11 · Customers, orders, proformas, invoices and stock reservations
--
-- The half of the business that takes money in. product.md §12 governs all of it, and four of its
-- rules shape every table below:
--
--   1. A PROFORMA IS NOT A BILL (§12.1). It creates no debt, no receivable and no inventory change.
--      A final invoice is a different object with a different number, and there is no path in this
--      schema from one to the other except customer confirmation.
--
--   2. EXACTLY ONE FINAL INVOICE PER ORDER (§12.1 point 6, AC-8). Not "the code only makes one" —
--      `invoices.order_id` is UNIQUE, so a second one cannot exist however the code is called.
--
--   3. NOTHING THAT CAN BE CALCULATED IS STORED AS A TYPED FIGURE (§5.2, AC-2). Line totals are
--      generated columns. Subtotals, discounts and totals are computed by the command that writes
--      them and are re-derivable from the lines beside them.
--
--   4. AN INVOICE IS AN IMMUTABLE SNAPSHOT (§12.1 point 8, AC-12). A correction is a cancellation
--      plus a replacement, and a cancelled invoice keeps its number and its history (AC-11).
--
-- EVERY TABLE BELOW CARRIES ITS OWN ACCESS DECISION, immediately after it is created: row-level
-- security, the read grant and policy for `authenticated`, what `fv_definer_owner` may do, and the
-- `service_role` revoke. None of it is deferred to a later migration. A table that is created in
-- one file and protected in another exists unprotected in between, and a reader has to hold two
-- files in their head to answer the only two questions that matter about it.
--
-- WHAT IS DELIBERATELY NOT HERE, and where it goes instead:
--
--   · Payments, tenders and credit authorisation. §12.5 makes credit a SETTLEMENT decision that
--     records no money, and settlement is Stage 12. Building the authority for it now, with no
--     payment to weigh it against, would produce a rule nothing could exercise end to end.
--   · Dispatch, release, and stock actually leaving. §12.6 step 14 is Stage 12.
--   · Customer contact details, TIN and VRN. product.md defines no customer record beyond the name
--     an order attaches to. design.md §14 row 11 makes TIN optional presentation on the proforma,
--     and design.md is a draft that must not be the source of a business rule (memory.md §2).

begin;

-- ---------------------------------------------------------------------------
-- The states an order and an allocation can be in
-- ---------------------------------------------------------------------------
create type public.order_status as enum (
  'proforma',   -- a quotation exists and the customer has not accepted it. NO debt, NO reservation
  'confirmed',  -- the customer accepted. Stock is reserved and an invoice exists (except a cash sale)
  'cancelled'   -- withdrawn before or after confirmation; any reservation is released
);

comment on type public.order_status is
  'Where an order stands (product.md §12.1). `proforma` is the non-financial stage: it creates no '
  'debt and reserves no stock.';

-- The three §8 states that are CLAIMS against available stock rather than places stock sits.
-- §8.1 is the whole reason this type exists: available = physical − reserved − committed.
create type public.allocation_state as enum (
  'reserved',   -- claimed by a confirmed order, not yet paid or approved (§8)
  'committed',  -- settled but not yet handed over — the paid-but-unreleased state (§8, §12.4)
  'released',   -- handed over against a signed dispatch note; the ledger now carries the movement
  'cancelled'   -- the claim was withdrawn and the stock is sellable again
);

comment on type public.allocation_state is
  'A claim against available stock (product.md §8). Physical stock does not move until release: '
  'reserved and committed goods are still in the yard and simply cannot be sold twice (§8.1).';

-- ---------------------------------------------------------------------------
-- customers
--
-- A name, and one permanent system row. product.md §12.4 makes Cash Customer "a permanent,
-- one-click system customer" that captures NO identifying fields, and §12 defines no record for
-- anybody else either — so this holds what an order needs to name who it is for and nothing
-- somebody guessed at.
-- ---------------------------------------------------------------------------
create table public.customers (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (length(btrim(name)) between 1 and 120),
  is_active        boolean not null default true,

  -- The walk-in path, which is a different workflow rather than a flag on the same one (§12.4).
  -- Snapshotted onto every order below, so the rule cannot change under a live order.
  is_cash_customer boolean not null default false,

  created_by       uuid references public.profiles (id),
  created_at       timestamptz not null default now()
);

comment on table public.customers is
  'Who an order is for. Cash Customer is the permanent one-click system row of product.md §12.4 and '
  'captures no identifying fields. Deactivated, never deleted: invoices reference it permanently.';

create unique index customers_identity_idx
  on public.customers (private.canonical_identity(name));

-- Exactly one Cash Customer, forever. A second would give the walk-in path two identities and make
-- "is this a cash sale?" a question with two answers.
create unique index customers_one_cash_customer_idx
  on public.customers ((true)) where is_cash_customer;

create index customers_created_by_idx on public.customers (created_by);
create index customers_listing_idx    on public.customers (is_active, name);

-- Direct access to public.customers
--
-- RLS and the exposure decision sit beside the table they govern. Splitting them into a later
-- migration means a reader has to hold two files in their head to answer the only two questions
-- that matter about a table — who can read it, and who can write it — and a table can exist
-- unprotected between the two.
--
-- READ: every live role. design.md §4.2 puts orders in front of a Cashier who settles them and a
-- Manager who approves against them, and customers and availability come with them.
--
-- WRITE: nobody, through PostgREST. `authenticated` holds no INSERT, UPDATE or DELETE grant on any
-- table in this file and no policy for those actions either, so a hand-rolled call fails on
-- privilege before a policy is ever consulted. Every write goes through an `api` function that
-- derives its actor from the verified session.
alter table public.customers enable row level security;

grant select on public.customers to authenticated;

create policy customers_select_live_staff on public.customers
  for select to authenticated
  using ( (select private.authorize(
             array['director','manager','cashier','sales_rep']::public.app_role[])) );

grant select, insert on public.customers to fv_definer_owner;
grant update         on public.customers to fv_definer_owner;

create policy customers_definer_owner_read on public.customers
  for select to fv_definer_owner using ( true );
create policy customers_definer_owner_insert on public.customers
  for insert to fv_definer_owner with check ( true );
create policy customers_definer_owner_update on public.customers
  for update to fv_definer_owner using ( true ) with check ( true );

revoke all on public.customers from service_role;

-- ---------------------------------------------------------------------------
-- document_sequences — invoice, proforma and order numbers
--
-- product.md §12.2 fixes the invoice format: `FV-INV-YYYYMMDD-####`, using the Tanzania business
-- date (§15.3), increasing daily, never reused and never manually changed. §12.2 also requires
-- proformas to carry "their own separate, consistently formatted number", without saying what it
-- is, so orders and proformas follow the same shape with their own prefixes.
--
-- A counter table rather than a PostgreSQL sequence, for one reason: a sequence is not
-- transactional, so a rolled-back invoice would burn its number permanently and produce a gap
-- nobody can explain. §12.4 tolerates gaps from "safe transaction handling" — it does not ask for
-- them. This gaps only when a transaction that had already claimed a number rolls back, which is
-- the case §12.4 is actually describing.
-- ---------------------------------------------------------------------------
create table public.document_sequences (
  kind          text not null check (kind in ('order', 'proforma', 'invoice')),
  business_date date not null,
  next_value    integer not null default 1 check (next_value > 0),

  primary key (kind, business_date)
);

comment on table public.document_sequences is
  'The daily counter behind FV-INV-YYYYMMDD-#### and its siblings (product.md §12.2). Keyed by the '
  'Africa/Dar_es_Salaam business date (§15.3), so the sequence restarts when the business day does.';

-- Direct access to public.document_sequences — deliberately none
--
-- Written only inside SECURITY DEFINER functions and read by nobody through PostgREST: no grant and
-- no policy for `authenticated` at all. A client that could read it could predict the next invoice
-- number; one that could write it could hand two invoices the same one.
--
-- It therefore carries RLS with no policy, which the advisors tolerate only for tables named in
-- `supabase/advisors.sql` — so it is named there in the same change.
alter table public.document_sequences enable row level security;

grant select, insert, update on public.document_sequences to fv_definer_owner;

create policy sequences_definer_owner_all on public.document_sequences
  for all to fv_definer_owner using ( true ) with check ( true );

revoke all on public.document_sequences from service_role;

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
create table public.orders (
  id           uuid primary key default gen_random_uuid(),
  order_no     text not null unique,
  customer_id  uuid not null references public.customers (id) on delete restrict,
  status       public.order_status not null default 'proforma',

  -- Snapshotted from the customer at creation. §12.4 makes the walk-in path a different workflow,
  -- and a live order must not change which workflow it is in because somebody edited a customer.
  is_cash_sale boolean not null,

  -- A percentage, because §4 states the Manager's limit as one ("up to 5%"). The SHILLING amount is
  -- calculated from it and never typed (§5.2).
  discount_percent numeric(5,2) not null default 0
    check (discount_percent >= 0 and discount_percent <= 100),
  discount_reason  text check (discount_reason is null or length(btrim(discount_reason)) between 3 and 500),

  created_by   uuid not null references public.profiles (id),
  created_role public.app_role not null,
  created_at   timestamptz not null default now(),

  confirmed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text check (cancel_reason is null or length(btrim(cancel_reason)) between 3 and 500),

  -- The status and its timestamps cannot disagree. A confirmed order has a confirmation time; a
  -- cancelled one has a cancellation time and a reason; a proforma has neither.
  constraint order_status_timestamps check (
    case status
      when 'proforma'  then confirmed_at is null and cancelled_at is null
      when 'confirmed' then confirmed_at is not null and cancelled_at is null
      when 'cancelled' then cancelled_at is not null and cancel_reason is not null
    end
  )
);

comment on table public.orders is
  'A customer order (product.md §12). Creating one generates a proforma automatically and creates '
  'no debt; confirming one reserves stock and generates exactly one invoice — except on the Cash '
  'Customer path, where §12.4 says nothing exists until payment.';

create index orders_customer_idx on public.orders (customer_id, created_at desc);
create index orders_status_idx   on public.orders (status, created_at desc);
create index orders_created_by_idx on public.orders (created_by, created_at desc);
create index orders_recent_idx   on public.orders (created_at desc);

-- Direct access to public.orders
alter table public.orders enable row level security;

grant select on public.orders to authenticated;

create policy orders_select_live_staff on public.orders
  for select to authenticated
  using ( (select private.authorize(
             array['director','manager','cashier','sales_rep']::public.app_role[])) );

grant select, insert, update on public.orders to fv_definer_owner;

create policy orders_definer_owner_read on public.orders
  for select to fv_definer_owner using ( true );
create policy orders_definer_owner_insert on public.orders
  for insert to fv_definer_owner with check ( true );
create policy orders_definer_owner_update on public.orders
  for update to fv_definer_owner using ( true ) with check ( true );

revoke all on public.orders from service_role;

-- ---------------------------------------------------------------------------
-- order_lines
--
-- The price is SNAPSHOTTED onto the line. A Director changing a selling price tomorrow must not
-- silently rewrite what a customer was quoted today — product.md §4.4 keeps price history immutable
-- for exactly that reason, and an order that read the current price at render time would undo it.
-- ---------------------------------------------------------------------------
create table public.order_lines (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references public.orders (id) on delete restrict,
  product_id     uuid not null references public.products (id) on delete restrict,

  -- Whole counting units (product.md §6.1 rule 1), on the same terms as every other quantity.
  quantity       bigint not null check (quantity > 0 and quantity <= 10000000),

  unit_price_tzs bigint not null check (unit_price_tzs > 0 and unit_price_tzs <= 100000000),

  -- Calculated, never typed (§5.2, AC-2). There is no field for it anywhere and nothing to override.
  line_total_tzs bigint generated always as (quantity * unit_price_tzs) stored,

  unique (order_id, product_id)
);

comment on table public.order_lines is
  'What is being sold, at the price approved when the order was created. The line total is a '
  'GENERATED column: product.md §5.2 forbids asking anyone to type one.';

create index order_lines_order_idx   on public.order_lines (order_id);
create index order_lines_product_idx on public.order_lines (product_id);

-- Direct access to public.order_lines
--
-- DELETE, on this table alone in the whole sales schema, and only for the definer owner.
--
-- An order line is a WORKING DRAFT: revising a quotation replaces the line set, and the permanent
-- record of what the customer was quoted is the superseded proforma version beside it, which keeps
-- its own line snapshot and cannot be edited or deleted by anybody. Without this, a revision could
-- only add lines and an order could never lose one.
--
-- `authenticated` holds no DELETE here and has no policy for it; pgTAP asserts that separately.
alter table public.order_lines enable row level security;

grant select on public.order_lines to authenticated;

create policy order_lines_select_live_staff on public.order_lines
  for select to authenticated
  using ( (select private.authorize(
             array['director','manager','cashier','sales_rep']::public.app_role[])) );

grant select, insert, delete on public.order_lines to fv_definer_owner;

create policy order_lines_definer_owner_read on public.order_lines
  for select to fv_definer_owner using ( true );
create policy order_lines_definer_owner_insert on public.order_lines
  for insert to fv_definer_owner with check ( true );
create policy order_lines_definer_owner_delete on public.order_lines
  for delete to fv_definer_owner using ( true );

revoke all on public.order_lines from service_role;

-- ---------------------------------------------------------------------------
-- proformas — a quotation, versioned
--
-- §12.1 point 4: a proforma may be revised before acceptance, with full version history, and
-- nothing is overwritten. So a revision is a NEW row, the previous one is marked superseded, and
-- every version stays retrievable exactly as it was issued.
-- ---------------------------------------------------------------------------
create table public.proformas (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders (id) on delete restrict,
  version       integer not null check (version > 0),
  proforma_no   text not null unique,

  subtotal_tzs  bigint not null check (subtotal_tzs >= 0),
  discount_tzs  bigint not null check (discount_tzs >= 0),
  total_tzs     bigint not null check (total_tzs >= 0),

  -- 30 calendar days, expiring 23:59 Africa/Dar_es_Salaam (design.md §14.8).
  --
  -- FLAGGED: product.md requires a validity period and does not fix its length; design.md resolves
  -- it as 30 days and design.md is a DRAFT. Implemented as the only stated figure, recorded in the
  -- Stage 11 plan for the owner rather than presented as approved.
  valid_until   date not null,

  issued_by     uuid not null references public.profiles (id),
  issued_at     timestamptz not null default now(),

  -- Set when a later version replaces this one. The row itself is never edited otherwise.
  superseded_at timestamptz,

  unique (order_id, version)
);

comment on table public.proformas is
  'A quotation (product.md §12.1). NOT a bill: it creates no debt, no receivable and no inventory '
  'change. Revising one issues a new version and supersedes the old; nothing is overwritten.';

create index proformas_order_idx   on public.proformas (order_id, version desc);
create index proformas_issued_by_idx on public.proformas (issued_by);

-- Direct access to public.proformas
alter table public.proformas enable row level security;

grant select on public.proformas to authenticated;

create policy proformas_select_live_staff on public.proformas
  for select to authenticated
  using ( (select private.authorize(
             array['director','manager','cashier','sales_rep']::public.app_role[])) );

grant select, insert, update on public.proformas to fv_definer_owner;

create policy proformas_definer_owner_read on public.proformas
  for select to fv_definer_owner using ( true );
create policy proformas_definer_owner_insert on public.proformas
  for insert to fv_definer_owner with check ( true );
create policy proformas_definer_owner_update on public.proformas
  for update to fv_definer_owner using ( true ) with check ( true );

revoke all on public.proformas from service_role;

-- A proforma version is only retrievable "as issued" if it keeps its own copy of what it said. A
-- join back to `order_lines` would show today's lines under yesterday's version number.
create table public.proforma_lines (
  id                    uuid primary key default gen_random_uuid(),
  proforma_id           uuid not null references public.proformas (id) on delete restrict,
  product_id            uuid not null references public.products (id) on delete restrict,

  -- The product AS IT READ then, including its counting unit and content (product.md §6). A product
  -- renamed next year must not change what a customer was quoted.
  product_name          text not null,
  product_specification text,
  unit_code             text not null,
  unit_content          text,

  quantity              bigint not null check (quantity > 0),
  unit_price_tzs        bigint not null check (unit_price_tzs > 0),
  line_total_tzs        bigint generated always as (quantity * unit_price_tzs) stored
);

create index proforma_lines_proforma_idx on public.proforma_lines (proforma_id);
create index proforma_lines_product_idx  on public.proforma_lines (product_id);

-- Direct access to public.proforma_lines
--
-- No UPDATE and no DELETE for anybody, the definer owner included: a superseded version is the
-- record of what the customer was actually quoted, and the triggers below refuse both regardless.
alter table public.proforma_lines enable row level security;

grant select on public.proforma_lines to authenticated;

create policy proforma_lines_select_live_staff on public.proforma_lines
  for select to authenticated
  using ( (select private.authorize(
             array['director','manager','cashier','sales_rep']::public.app_role[])) );

grant select, insert on public.proforma_lines to fv_definer_owner;

create policy proforma_lines_definer_owner_read on public.proforma_lines
  for select to fv_definer_owner using ( true );
create policy proforma_lines_definer_owner_insert on public.proforma_lines
  for insert to fv_definer_owner with check ( true );

revoke all on public.proforma_lines from service_role;

-- ---------------------------------------------------------------------------
-- invoices — the financial record
--
-- `order_id` is UNIQUE. That single word is AC-8: exactly one final invoice per order, enforced by
-- the database rather than by the care of whoever writes the next command.
-- ---------------------------------------------------------------------------
create table public.invoices (
  id            uuid primary key default gen_random_uuid(),
  invoice_no    text not null unique,
  order_id      uuid not null unique references public.orders (id) on delete restrict,
  customer_id   uuid not null references public.customers (id) on delete restrict,

  subtotal_tzs  bigint not null check (subtotal_tzs >= 0),
  discount_tzs  bigint not null check (discount_tzs >= 0),
  total_tzs     bigint not null check (total_tzs >= 0),

  -- The Tanzania business date the number was issued on (§12.2, §15.3), stored rather than derived
  -- so the number and the date it encodes can never disagree.
  business_date date not null,

  issued_at     timestamptz not null default now(),

  -- A cancelled invoice KEEPS its number and its history (AC-11). It is not deleted and not reused.
  cancelled_at  timestamptz,
  cancel_reason text check (cancel_reason is null or length(btrim(cancel_reason)) between 3 and 500),

  constraint invoice_cancellation_shape check (
    (cancelled_at is null and cancel_reason is null)
    or (cancelled_at is not null and cancel_reason is not null)
  ),

  constraint invoice_total_is_derived check (total_tzs = subtotal_tzs - discount_tzs)
);

comment on table public.invoices is
  'The financial record (product.md §12.1). One per order and no manual creation path: '
  '`order_id` is unique, so AC-8 is a constraint rather than a convention. Values are immutable — '
  'a correction is a cancellation plus a replacement (AC-12).';

create index invoices_customer_idx on public.invoices (customer_id, issued_at desc);
create index invoices_date_idx     on public.invoices (business_date desc);
create index invoices_recent_idx   on public.invoices (issued_at desc);

-- Direct access to public.invoices
--
-- UPDATE reaches one transition and no other: the trigger created below refuses every column but
-- the cancellation pair, for the definer owner as much as for anybody.
alter table public.invoices enable row level security;

grant select on public.invoices to authenticated;

create policy invoices_select_live_staff on public.invoices
  for select to authenticated
  using ( (select private.authorize(
             array['director','manager','cashier','sales_rep']::public.app_role[])) );

grant select, insert, update on public.invoices to fv_definer_owner;

create policy invoices_definer_owner_read on public.invoices
  for select to fv_definer_owner using ( true );
create policy invoices_definer_owner_insert on public.invoices
  for insert to fv_definer_owner with check ( true );
create policy invoices_definer_owner_update on public.invoices
  for update to fv_definer_owner using ( true ) with check ( true );

revoke all on public.invoices from service_role;

create table public.invoice_lines (
  id                    uuid primary key default gen_random_uuid(),
  invoice_id            uuid not null references public.invoices (id) on delete restrict,
  product_id            uuid not null references public.products (id) on delete restrict,

  product_name          text not null,
  product_specification text,
  unit_code             text not null,
  unit_content          text,

  quantity              bigint not null check (quantity > 0),
  unit_price_tzs        bigint not null check (unit_price_tzs > 0),
  line_total_tzs        bigint generated always as (quantity * unit_price_tzs) stored
);

create index invoice_lines_invoice_idx on public.invoice_lines (invoice_id);
create index invoice_lines_product_idx on public.invoice_lines (product_id);

-- Direct access to public.invoice_lines
alter table public.invoice_lines enable row level security;

grant select on public.invoice_lines to authenticated;

create policy invoice_lines_select_live_staff on public.invoice_lines
  for select to authenticated
  using ( (select private.authorize(
             array['director','manager','cashier','sales_rep']::public.app_role[])) );

grant select, insert on public.invoice_lines to fv_definer_owner;

create policy invoice_lines_definer_owner_read on public.invoice_lines
  for select to fv_definer_owner using ( true );
create policy invoice_lines_definer_owner_insert on public.invoice_lines
  for insert to fv_definer_owner with check ( true );

revoke all on public.invoice_lines from service_role;

-- ---------------------------------------------------------------------------
-- An invoice's VALUES are immutable; only its cancellation may be recorded
--
-- AC-12 says final invoice values are immutable and a correction is a cancellation or reversal plus
-- a replacement. AC-11 says a cancelled invoice retains its number and history. Both are true at
-- once only if exactly one transition is writable, so this refuses every other column change for
-- every role — the table owner and the definer owner included.
-- ---------------------------------------------------------------------------
create or replace function private.refuse_invoice_amendment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'invoice % cannot be deleted: a correction is a cancellation and a replacement',
      old.invoice_no using errcode = 'restrict_violation';
  end if;

  if new.invoice_no    is distinct from old.invoice_no
     or new.order_id    is distinct from old.order_id
     or new.customer_id is distinct from old.customer_id
     or new.subtotal_tzs is distinct from old.subtotal_tzs
     or new.discount_tzs is distinct from old.discount_tzs
     or new.total_tzs    is distinct from old.total_tzs
     or new.business_date is distinct from old.business_date
     or new.issued_at    is distinct from old.issued_at then
    raise exception 'invoice % is an immutable snapshot: only its cancellation may be recorded',
      old.invoice_no using errcode = 'restrict_violation';
  end if;

  -- And a cancellation, once recorded, is itself final. Un-cancelling would make the number mean
  -- two different things at two different times.
  if old.cancelled_at is not null then
    raise exception 'invoice % is already cancelled', old.invoice_no
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

comment on function private.refuse_invoice_amendment() is
  'Lets an invoice be cancelled and refuses every other change to it, for every role (AC-11, '
  'AC-12). A price a customer was billed must still read the same years later.';

alter function private.refuse_invoice_amendment() owner to fv_definer_owner;

create trigger invoices_refuse_amendment
  before update on public.invoices
  for each row execute function private.refuse_invoice_amendment();

create trigger invoices_refuse_delete
  before delete on public.invoices
  for each row execute function private.refuse_invoice_amendment();

-- The lines are the invoice. They are never edited or deleted either.
create or replace function private.refuse_line_edit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is a snapshot: % refused', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$;

comment on function private.refuse_line_edit() is
  'Refuses every UPDATE and DELETE on an invoice or proforma line, for every role. A quotation and '
  'a bill must both still read exactly as they were issued.';

alter function private.refuse_line_edit() owner to fv_definer_owner;

create trigger invoice_lines_refuse_update
  before update on public.invoice_lines
  for each row execute function private.refuse_line_edit();
create trigger invoice_lines_refuse_delete
  before delete on public.invoice_lines
  for each row execute function private.refuse_line_edit();

create trigger proforma_lines_refuse_update
  before update on public.proforma_lines
  for each row execute function private.refuse_line_edit();
create trigger proforma_lines_refuse_delete
  before delete on public.proforma_lines
  for each row execute function private.refuse_line_edit();

revoke execute on function private.refuse_invoice_amendment()
  from public, anon, authenticated, service_role;
revoke execute on function private.refuse_line_edit()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- stock_allocations — the claims §8.1 subtracts
--
-- NOT a ledger. Physical stock does not move when an order is confirmed: the goods are still in the
-- yard, they simply cannot be sold twice (§8.1, AC-34). So this is a live claim with a state, on
-- the same footing as `approval_requests.status` — a projection whose transitions are audited —
-- while `inventory_ledger` stays append-only and records only movements that really happened.
-- ---------------------------------------------------------------------------
create table public.stock_allocations (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders (id) on delete restrict,

  -- One claim per order line. Two claims for one line would make "how much is reserved?" a question
  -- with two answers.
  order_line_id uuid not null unique references public.order_lines (id) on delete restrict,

  product_id    uuid not null references public.products (id) on delete restrict,
  quantity      bigint not null check (quantity > 0),
  state         public.allocation_state not null,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.stock_allocations is
  'A claim against available stock (product.md §8.1). Reserved and committed goods are physically '
  'present and cannot be sold again; nothing leaves the ledger until release (§12.6 step 14).';

create index stock_allocations_product_idx on public.stock_allocations (product_id, state);
create index stock_allocations_order_idx   on public.stock_allocations (order_id);

-- Direct access to public.stock_allocations
--
-- Availability is a SALES fact rather than an inventory one: a Sales Representative cannot write an
-- order without knowing whether the stock exists, and §8.1 is what stops them selling it twice.
-- This is the deliberate widening the Stage 10D grants said would arrive when something needed it.
alter table public.stock_allocations enable row level security;

grant select on public.stock_allocations to authenticated;

create policy allocations_select_live_staff on public.stock_allocations
  for select to authenticated
  using ( (select private.authorize(
             array['director','manager','cashier','sales_rep']::public.app_role[])) );

grant select, insert, update on public.stock_allocations to fv_definer_owner;

create policy allocations_definer_owner_read on public.stock_allocations
  for select to fv_definer_owner using ( true );
create policy allocations_definer_owner_insert on public.stock_allocations
  for insert to fv_definer_owner with check ( true );
create policy allocations_definer_owner_update on public.stock_allocations
  for update to fv_definer_owner using ( true ) with check ( true );

revoke all on public.stock_allocations from service_role;

-- ---------------------------------------------------------------------------
-- product_availability — product.md §8.1, as a view
--
--     Available stock = Physical stock − reserved and committed stock
--
-- Every product appears, including the ones holding nothing: "there is none" and "no such product"
-- are different answers and a screen must be able to tell them apart.
-- ---------------------------------------------------------------------------
create view public.product_availability
with (security_invoker = true) as
select p.id as product_id,
       coalesce(physical.quantity, 0)::bigint  as physical_quantity,
       coalesce(claims.reserved, 0)::bigint    as reserved_quantity,
       coalesce(claims.committed, 0)::bigint   as committed_quantity,
       (coalesce(physical.quantity, 0)
        - coalesce(claims.reserved, 0)
        - coalesce(claims.committed, 0))::bigint as available_quantity
  from public.products p
  left join (
    select l.product_id, sum(l.quantity_delta) as quantity
      from public.inventory_ledger l
     where l.stock_state = 'available'
     group by l.product_id
  ) physical on physical.product_id = p.id
  left join (
    select a.product_id,
           sum(a.quantity) filter (where a.state = 'reserved')  as reserved,
           sum(a.quantity) filter (where a.state = 'committed') as committed
      from public.stock_allocations a
     group by a.product_id
  ) claims on claims.product_id = p.id;

comment on view public.product_availability is
  'product.md §8.1 as a view: available = physical − reserved − committed. Physical stock is the '
  'sum of the ledger across every location, because an order names a product and the location is '
  'decided at dispatch (§14).';

-- Direct access to public.product_availability
--
-- A view, so it carries no RLS of its own: `security_invoker` makes every read of it obey the
-- policies on `inventory_ledger` and `stock_allocations` as the person asking, which is the
-- behaviour wanted here.
grant select on public.product_availability to authenticated;
grant select on public.product_availability to fv_definer_owner;

revoke all on public.product_availability from service_role;

-- ---------------------------------------------------------------------------
-- The Cash Customer, seeded
--
-- Reference data the product definition fixes, exactly like the 21 products: §12.4 makes it a
-- PERMANENT system customer, so every environment needs the identical row and no Director has to
-- remember to create it before the first walk-in sale.
-- ---------------------------------------------------------------------------
insert into public.customers (name, is_cash_customer, created_by)
values ('Cash Customer', true, null)
on conflict do nothing;

do $$
begin
  if (select count(*) from public.customers where is_cash_customer) <> 1 then
    raise exception 'there must be exactly one Cash Customer (product.md §12.4)';
  end if;
end
$$;

commit;
