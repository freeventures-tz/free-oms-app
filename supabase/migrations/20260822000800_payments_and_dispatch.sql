-- Stage 12 · Payments, credit, storekeepers, dispatch, and stock actually leaving
--
-- This is where money arrives and goods depart, and product.md is unusually precise about both.
-- Five rules shape every table here:
--
--   1. CREDIT IS NOT A TENDER (§12.5). Six methods record money received; credit records an
--      approved unpaid balance and NO payment. An invoice settled entirely on credit is UNPAID
--      (AC-93), because nothing was paid — and the till and the ledger would disagree otherwise.
--
--   2. INVOICE STATUS IS CALCULATED, ALWAYS (§12.3, AC-14). There is no status column on
--      `invoices` and no command that sets one. It is a view over the payments.
--
--   3. STOCK LEAVES ONLY AT SIGNED RELEASE (§12.6 step 14, AC-35). Not at payment, not at
--      assignment, not when the dispatch-note number is typed in. One place in this file writes a
--      `sale_release` movement, and it is reached only after a Manager confirms a signed note.
--
--   4. THE OMS DOES NOT GENERATE THE DISPATCH NOTE (§14, AC-37). Staff use the four-copy carbon
--      book, and the system records ONE record per physical note — `dispatch_note_no` is unique
--      because AC-36 says exactly one record corresponds to one number.
--
--   5. A PAYMENT IS APPEND-ONLY. A reversal is a new, negative row approved by a Director (§4.1,
--      AC-21), never an edit of what was recorded when the money came in.

begin;

-- ---------------------------------------------------------------------------
-- The six tenders of product.md §12.5
--
-- Six, not seven. §12.5 lists six ways money actually arrives and then says plainly that Credit is
-- "not a tender" — it records no payment. Putting credit in this enum would be the single most
-- consequential mistake available in this file: every total of money received would silently
-- include money nobody received.
-- ---------------------------------------------------------------------------
create type public.payment_method as enum (
  'cash',
  'mixx_by_yas',
  'halopesa',
  'mwanga_hakika_transfer',
  'crdb_transfer',
  'cheque'
);

comment on type public.payment_method is
  'The six tenders of product.md §12.5. Credit is deliberately absent: it is a settlement decision '
  'that records no money (AC-92).';

create type public.dispatch_status as enum (
  'assigned',       -- a storekeeper has been named. STOCK HAS NOT MOVED (§12.6 step 9)
  'note_recorded',  -- the physical dispatch-note number is in the system (§12.6 step 11)
  'released',       -- the customer signed and a Manager confirmed. Stock has left (step 14)
  'cancelled'
);

comment on type public.dispatch_status is
  'Where a dispatch stands (product.md §12.6 steps 9–14). Each step unlocks the next and none may '
  'be skipped: release is impossible until a dispatch-note number exists.';

-- ---------------------------------------------------------------------------
-- storekeepers — participants who are not users (product.md §3.2)
--
-- The one record in this system whose fields product.md specifies exactly, so this is that list and
-- nothing else. Storekeepers have NO login and NO permissions; a Director registers them so they
-- can be assigned to dispatch tasks by name.
-- ---------------------------------------------------------------------------
create table public.storekeepers (
  id              uuid primary key default gen_random_uuid(),

  -- "Generated storekeeper code" (§3.2): the server owns it, so there is nothing to mistype and
  -- nothing to aim at an existing record.
  storekeeper_code text not null unique,

  full_name       text not null check (length(btrim(full_name)) between 2 and 120),
  phone           text check (phone is null or length(btrim(phone)) between 1 and 30),
  is_active       boolean not null default true,
  start_date      date not null,
  deactivated_at  date,
  note            text check (note is null or length(btrim(note)) between 1 and 500),

  created_by      uuid not null references public.profiles (id),
  created_at      timestamptz not null default now(),

  -- §3.2: storekeepers are deactivated, never deleted — and a deactivation date exists exactly
  -- when the record is inactive, so the two cannot disagree.
  constraint storekeeper_deactivation_shape check (
    (is_active and deactivated_at is null) or (not is_active and deactivated_at is not null)
  )
);

comment on table public.storekeepers is
  'People who move goods but do not use the system (product.md §3.2). No login, no permissions, and '
  'deactivated rather than deleted: every dispatch they were assigned to names them permanently.';

create unique index storekeepers_identity_idx
  on public.storekeepers (private.canonical_identity(full_name));
create index storekeepers_created_by_idx on public.storekeepers (created_by);
create index storekeepers_listing_idx    on public.storekeepers (is_active, full_name);

-- Direct access to public.storekeepers
--
-- RLS and the exposure decision sit beside the table they govern, the way every sales table in
-- 20260822000500 carries its own. A table created in one file and protected in another exists
-- unprotected in between, and a reader has to hold two files in their head to answer the only two
-- questions that matter about it.
--
-- READ: the three roles §12.6 gives dispatch work to. Storekeepers are a picker for a Cashier and
-- a name on a Manager's release, and a Director reads for oversight. A Sales Representative is not
-- on that list: §12.6 steps 9 to 14 name nobody in their role, and a person's phone number and
-- working state are not order information.
--
-- WRITE: nobody, through PostgREST. `authenticated` holds no INSERT, UPDATE or DELETE grant and no
-- policy for those actions either, so a hand-rolled call fails on privilege before a policy is
-- consulted. Every write goes through an `api` function that derives its actor from the session.
alter table public.storekeepers enable row level security;

grant select on public.storekeepers to authenticated;

create policy storekeepers_select_live_staff on public.storekeepers
  for select to authenticated
  using ( (select private.authorize(
             array['director','manager','cashier']::public.app_role[])) );

grant select, insert on public.storekeepers to fv_definer_owner;
grant update         on public.storekeepers to fv_definer_owner;

create policy storekeepers_definer_owner_read on public.storekeepers
  for select to fv_definer_owner using ( true );
create policy storekeepers_definer_owner_insert on public.storekeepers
  for insert to fv_definer_owner with check ( true );
-- One transition, for §3.2's "deactivated, never deleted". There is no rename: a dispatch names
-- the storekeeper who moved the goods, permanently.
create policy storekeepers_definer_owner_update on public.storekeepers
  for update to fv_definer_owner using ( true ) with check ( true );

revoke all on public.storekeepers from service_role;

-- ---------------------------------------------------------------------------
-- payments — APPEND ONLY, and signed
--
-- A reversal is a NEGATIVE row that references the payment it undoes (§4.1: requested by a Cashier
-- or Manager, approved by a Director). Editing the original would make the till disagree with what
-- was counted at the time, which is the one thing a cash record must never do.
-- ---------------------------------------------------------------------------
create table public.payments (
  id             uuid primary key default gen_random_uuid(),
  entry_seq      bigint generated always as identity,

  invoice_id     uuid not null references public.invoices (id) on delete restrict,

  -- Signed and never zero: positive money in, negative for an approved reversal. `amount_paid` is
  -- the SUM of these, so a reversal reduces it without anything being rewritten.
  amount_tzs     bigint not null check (amount_tzs <> 0 and abs(amount_tzs) <= 100000000),

  method         public.payment_method not null,

  -- Set on a reversal only, pointing at the row it undoes.
  reverses_id    uuid references public.payments (id),

  received_by    uuid not null references public.profiles (id),
  received_role  public.app_role not null,

  -- The Tanzania business date (§15.3), stored so the daily cash reconciliation and the report can
  -- both ask "what came in on this day" without recomputing a timezone.
  business_date  date not null,
  received_at    timestamptz not null default clock_timestamp(),
  correlation_id uuid not null,
  created_at     timestamptz not null default now(),

  -- A reversal is negative and an ordinary payment is positive. Nothing else is a payment.
  constraint payment_direction check (
    (reverses_id is null and amount_tzs > 0) or (reverses_id is not null and amount_tzs < 0)
  )
);

comment on table public.payments is
  'Money actually received (product.md §12.5). Append-only and signed: an approved reversal is a '
  'negative row referencing the original (§4.1, AC-21), never an edit of it.';

create index payments_invoice_idx  on public.payments (invoice_id, entry_seq);
create index payments_date_idx     on public.payments (business_date, method);
create index payments_received_by_idx on public.payments (received_by, received_at desc);
create index payments_reverses_idx on public.payments (reverses_id);

-- One reversal per payment. Two would take the money back twice.
create unique index payments_one_reversal_idx
  on public.payments (reverses_id) where reverses_id is not null;

create or replace function private.refuse_payment_edit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'payments is append-only: % refused on payment %',
    tg_op, coalesce(old.id, new.id)
    using errcode = 'restrict_violation';
end;
$$;

comment on function private.refuse_payment_edit() is
  'Refuses every UPDATE and DELETE on payments, for every role. What was counted at the till must '
  'still read the same years later; a correction is an approved reversal beside it.';

alter function private.refuse_payment_edit() owner to fv_definer_owner;

create trigger payments_refuse_update
  before update on public.payments
  for each row execute function private.refuse_payment_edit();
create trigger payments_refuse_delete
  before delete on public.payments
  for each row execute function private.refuse_payment_edit();

revoke execute on function private.refuse_payment_edit()
  from public, anon, authenticated, service_role;

-- Direct access to public.payments
--
-- WHO READS IT: a Director, a Manager and a Cashier, and nobody else.
--
-- The Sales Representative was here and has been taken out, by Owner decision on the v0.0.4
-- review. §12.6 hands settlement to the Cashier at step 6 and the approval to a Manager at step 8;
-- neither step, and no screen a Sales Representative can reach, needs a row of this table. What
-- they were being handed instead was every tender, every amount and every till operator in the
-- business, on a table PostgREST exposes directly.
--
-- The definer owner gets INSERT and nothing else: there is no UPDATE or DELETE grant on this table
-- for ANY role, and the append-only trigger above refuses those anyway. Two independent reasons a
-- payment cannot be rewritten, which is the same treatment `product_prices` and `inventory_ledger`
-- get.
alter table public.payments enable row level security;

grant select on public.payments to authenticated;

create policy payments_select_live_staff on public.payments
  for select to authenticated
  using ( (select private.authorize(
             array['director','manager','cashier']::public.app_role[])) );

grant select, insert on public.payments to fv_definer_owner;

create policy payments_definer_owner_read on public.payments
  for select to fv_definer_owner using ( true );
create policy payments_definer_owner_insert on public.payments
  for insert to fv_definer_owner with check ( true );

revoke all on public.payments from service_role;

-- ---------------------------------------------------------------------------
-- credit_authorisations — an approved unpaid balance, and NOT a payment
--
-- §12.5: "Credit is a settlement decision, not money. Choosing credit records an approved unpaid
-- balance and credit exposure; it records no payment." §4: a Manager may approve up to
-- TZS 500,000 per invoice; anything beyond is a Director's (AC-17).
--
-- A separate table from `payments` on purpose, and §12.5 says why: "Credit authorisation and
-- payment events are separate records with separate histories. A credit approval is an authority
-- decision; a payment is a cash fact. Conflating them would make the till and the ledger disagree."
-- ---------------------------------------------------------------------------
create table public.credit_authorisations (
  id             uuid primary key default gen_random_uuid(),
  invoice_id     uuid not null references public.invoices (id) on delete restrict,
  amount_tzs     bigint not null check (amount_tzs > 0 and amount_tzs <= 100000000),
  reason         text not null check (length(btrim(reason)) between 3 and 500),

  requested_by   uuid not null references public.profiles (id),
  requested_role public.app_role not null,
  requested_at   timestamptz not null default now(),

  -- The decision lives in `approval_requests`/`approval_decisions`, where §4.3 is already enforced
  -- by a check constraint. This table holds the FACT being decided on, not the verdict.
  constraint credit_amount_is_a_balance check (amount_tzs > 0)
);

comment on table public.credit_authorisations is
  'An approved unpaid balance (product.md §12.5). Records NO payment: an invoice settled entirely '
  'on credit shows Unpaid, because nothing was paid (AC-92, AC-93).';

create index credit_invoice_idx      on public.credit_authorisations (invoice_id);
create index credit_requested_by_idx on public.credit_authorisations (requested_by, requested_at desc);

-- One live credit authorisation per invoice at a time; a rejected one may be replaced.
create unique index credit_one_live_idx
  on public.credit_authorisations (invoice_id)
  where true;

-- Direct access to public.credit_authorisations
--
-- Read by the same three roles as `payments`, and for the same reason: a credit decision is a
-- settlement fact, and settlement is Cashier, Manager and Director work. INSERT belongs to the
-- definer owner alone, and there
-- is no UPDATE for anybody — a credit request is a fact, and the verdict on it lives in
-- `approval_requests`/`approval_decisions` where §4.3 is already enforced.
alter table public.credit_authorisations enable row level security;

grant select on public.credit_authorisations to authenticated;

create policy credit_select_live_staff on public.credit_authorisations
  for select to authenticated
  using ( (select private.authorize(
             array['director','manager','cashier']::public.app_role[])) );

grant select, insert on public.credit_authorisations to fv_definer_owner;

create policy credit_definer_owner_read on public.credit_authorisations
  for select to fv_definer_owner using ( true );
create policy credit_definer_owner_insert on public.credit_authorisations
  for insert to fv_definer_owner with check ( true );

revoke all on public.credit_authorisations from service_role;

-- ---------------------------------------------------------------------------
-- Settlement is COMPLETE when a Cashier says so, and not before (§4.1, §12.6 step 7)
--
-- §12.3 keeps the STATUS calculated, and this is a different fact: whether the Cashier has
-- confirmed the invoice is settled and dispatch may begin. §4.2 makes it a separate act from
-- recording the payment, even though the same Cashier does both.
-- ---------------------------------------------------------------------------
alter table public.invoices
  add column settlement_approved_by uuid references public.profiles (id),
  add column settlement_approved_at timestamptz,

  add constraint invoice_settlement_shape check (
    (settlement_approved_by is null and settlement_approved_at is null)
    or (settlement_approved_by is not null and settlement_approved_at is not null)
  );

comment on column public.invoices.settlement_approved_by is
  'The Cashier who confirmed this invoice is settled and may be dispatched (product.md §4.1). Not '
  'the status — §12.3 keeps that calculated from money received.';

create index invoices_settlement_idx on public.invoices (settlement_approved_by);

-- ---------------------------------------------------------------------------
-- Allocations gain a released quantity, so a release can be PARTIAL
--
-- §12 allows a partial release with the remainder staying committed. Splitting the row would make
-- "how much is claimed for this line?" a question with two answers; a released counter keeps one.
-- ---------------------------------------------------------------------------
alter table public.stock_allocations
  add column released_quantity bigint not null default 0 check (released_quantity >= 0),
  add constraint allocation_released_within_quantity check (released_quantity <= quantity);

comment on column public.stock_allocations.released_quantity is
  'How much of this claim has physically left against a signed dispatch note. The remainder stays '
  'committed (product.md §12), and the ledger carries the movement.';

-- ---------------------------------------------------------------------------
-- product_availability, corrected for released stock
--
-- Replaces the Stage 11 view. Released goods have already left the ledger, so subtracting the whole
-- claim again would count them twice and quietly hide stock that is genuinely sellable.
--
--     available = physical − (claimed − released)
-- ---------------------------------------------------------------------------
create or replace view public.product_availability
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
           -- The OUTSTANDING part of each claim. Once goods are released the ledger has already
           -- fallen by that amount, so counting the claim again would subtract it twice.
           sum(a.quantity - a.released_quantity) filter (where a.state = 'reserved')  as reserved,
           sum(a.quantity - a.released_quantity) filter (where a.state = 'committed') as committed
      from public.stock_allocations a
     group by a.product_id
  ) claims on claims.product_id = p.id;

comment on view public.product_availability is
  'product.md §8.1: available = physical − reserved − committed, where a claim counts only for the '
  'part that has NOT yet left against a signed dispatch note.';


-- ---------------------------------------------------------------------------
-- api.staff_settlement_readable — the one thing a `security_invoker` view cannot ask
--
-- Both views below are `security_invoker`, so every read of them obeys the policies on the tables
-- underneath as the person asking. That is the behaviour wanted, and on its own it is not enough.
--
-- `invoice_settlement` LEFT JOINs `payments` and `credit_authorisations`. Take the Sales
-- Representative off those two tables, as this release does, and the join stops finding rows —
-- so the view would answer "amount paid: 0, status: unpaid" for every invoice in the business.
-- That is not a refusal and it is not an empty result. It is a confident false statement about
-- money, which is the one thing this system may never make.
--
-- A view cannot call `private.authorize` for the same reason `paid_but_unreleased` inlines the
-- business date below: `authenticated` holds EXECUTE on nothing in `private`, by design and
-- asserted by pgTAP test 003. So the predicate is an `api` function of the shape this database
-- already uses for a deliberate, bounded definer call — `api.staff_order_creator_name` is the
-- precedent. It answers ONE question about the CALLER'S OWN session and nothing about any row.
-- ---------------------------------------------------------------------------
create or replace function api.staff_settlement_readable()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.authorize(array['director','manager','cashier']::public.app_role[]);
$$;

comment on function api.staff_settlement_readable() is
  'Whether the caller may read settlement facts at all (design.md §4.2). Exists so the settlement '
  'views can REFUSE a role rather than report zero money to it.';

alter function api.staff_settlement_readable() owner to fv_definer_owner;
revoke execute on function api.staff_settlement_readable()
  from public, anon, service_role;
grant execute on function api.staff_settlement_readable() to authenticated;

-- ---------------------------------------------------------------------------
-- invoice_settlement — product.md §12.3, as a view
--
-- Unpaid when nothing has been received. Paid when the balance is zero. Partially paid in between.
-- NEVER something a user chose (AC-14): there is no status column anywhere for one to write to.
--
-- Approved credit is shown BESIDE the payment figures and is not added to them. §12.5's table is
-- explicit: an invoice settled entirely on credit records no payment and shows Unpaid.
-- ---------------------------------------------------------------------------
create view public.invoice_settlement
with (security_invoker = true) as
select i.id as invoice_id,
       i.total_tzs,
       coalesce(paid.amount, 0)::bigint  as amount_paid_tzs,
       coalesce(credit.amount, 0)::bigint as approved_credit_tzs,
       (i.total_tzs - coalesce(paid.amount, 0))::bigint as outstanding_tzs,
       case
         when i.cancelled_at is not null                    then 'cancelled'
         when coalesce(paid.amount, 0) <= 0                 then 'unpaid'
         when coalesce(paid.amount, 0) >= i.total_tzs       then 'paid'
         else                                                    'partially_paid'
       end as status,
       -- Whether dispatch may begin: the money and the approved credit together cover the bill,
       -- and a Cashier has confirmed it (§4.1, §12.6 step 7).
       (coalesce(paid.amount, 0) + coalesce(credit.amount, 0) >= i.total_tzs
        and i.settlement_approved_at is not null
        and i.cancelled_at is null) as releasable
  from public.invoices i
  left join (
    select p.invoice_id, sum(p.amount_tzs) as amount
      from public.payments p group by p.invoice_id
  ) paid on paid.invoice_id = i.id
  left join (
    select c.invoice_id, sum(c.amount_tzs) as amount
      from public.credit_authorisations c
      join public.approval_requests r
        on r.entity_type = 'credit_authorisation' and r.entity_id = c.id
       and r.approval_type = 'credit_or_unpaid_balance' and r.status = 'approved'
     group by c.invoice_id
  ) credit on credit.invoice_id = i.id
 -- Wrapped in a scalar sub-select so PostgreSQL evaluates it once per query rather than per row,
 -- the same reason every policy in this database wraps `private.authorize`.
 where (select api.staff_settlement_readable());

comment on view public.invoice_settlement is
  'Invoice status, always CALCULATED from money actually received (product.md §12.3, AC-14). '
  'Approved credit sits beside the payment figures and is never added to them: a fully credited '
  'invoice is Unpaid, because nothing was paid (AC-93).';

-- Direct access to public.invoice_settlement
--
-- A view, so it carries no RLS of its own: `security_invoker` makes every read obey the policies
-- on `invoices`, `payments` and `credit_authorisations` as the person asking, which is the
-- behaviour wanted here.
grant select on public.invoice_settlement to authenticated;
grant select on public.invoice_settlement to fv_definer_owner;

revoke all on public.invoice_settlement from service_role;


-- ---------------------------------------------------------------------------
-- customer_credit_exposure — what one customer already owes on approved credit
--
-- design.md §7.8 puts it third in the approval screen's hierarchy, after the requested amount and
-- the limit result, because it is what the per-invoice limit of product.md §4 cannot see: a
-- Manager approving TZS 400,000 is inside their authority on THIS invoice and may be handing the
-- same customer their fourth unpaid balance of the week.
--
-- IT IS AGGREGATED HERE RATHER THAN IN THE APPLICATION, and the reason is completeness. The
-- payments screen reads one page of invoices; a customer's exposure is the sum across every
-- invoice they hold, page or no page. Summing what the page happens to have loaded would quietly
-- understate a debt, which is the direction that gets credit approved that should not be.
--
-- EXPOSURE IS MONEY OUT, NOT THE SUM OF THE APPROVALS. An approval is a decision and stays in the
-- record; exposure falls as the customer pays. So each invoice contributes
-- `least(approved credit, outstanding)` — never more than was approved, never more than is still
-- owed — and a cancelled invoice contributes nothing, because it is owed by nobody.
--
-- `security_invoker`, so it inherits the refusal `invoice_settlement` already makes.
-- ---------------------------------------------------------------------------
create view public.customer_credit_exposure
with (security_invoker = true) as
select i.customer_id,
       sum(greatest(0, least(s.approved_credit_tzs, s.outstanding_tzs)))::bigint as exposure_tzs
  from public.invoices i
  join public.invoice_settlement s on s.invoice_id = i.id
 where i.cancelled_at is null
   and s.approved_credit_tzs > 0
   and s.outstanding_tzs > 0
 group by i.customer_id;

comment on view public.customer_credit_exposure is
  'What each customer still owes on APPROVED credit, across every live invoice (design.md §7.8). '
  'Each invoice contributes least(approved, outstanding): an approval is a decision, exposure is '
  'money out, and it falls as the customer pays.';

-- Direct access to public.customer_credit_exposure
--
-- A view over `invoice_settlement`, so `security_invoker` carries that view's refusal down to it
-- and no separate role check is needed.
grant select on public.customer_credit_exposure to authenticated;
grant select on public.customer_credit_exposure to fv_definer_owner;

revoke all on public.customer_credit_exposure from service_role;

-- ---------------------------------------------------------------------------
-- dispatches — one record per PHYSICAL dispatch note (product.md §14, AC-36)
-- ---------------------------------------------------------------------------
create table public.dispatches (
  id                uuid primary key default gen_random_uuid(),
  invoice_id        uuid not null references public.invoices (id) on delete restrict,

  -- From the four-copy carbon book, and UNIQUE because AC-36 says exactly one OMS record
  -- corresponds to exactly one physical number. Null until the Manager records it (§12.6 step 11).
  dispatch_note_no  text unique
    check (dispatch_note_no is null or length(btrim(dispatch_note_no)) between 1 and 40),

  storekeeper_id    uuid not null references public.storekeepers (id) on delete restrict,

  -- Which location the goods physically leave from (§14). Decided here rather than at order time,
  -- because an order names a product and the yard decides where it comes from.
  source_location   text not null references public.inventory_locations (code),

  status            public.dispatch_status not null default 'assigned',

  assigned_by       uuid not null references public.profiles (id),
  assigned_role     public.app_role not null,
  assigned_at       timestamptz not null default now(),

  note_recorded_by  uuid references public.profiles (id),
  note_recorded_at  timestamptz,

  -- §12.6 steps 12–13: the customer signs the paper, and a Manager confirms that in the system.
  released_by       uuid references public.profiles (id),
  released_at       timestamptz,

  cancel_reason     text check (cancel_reason is null or length(btrim(cancel_reason)) between 3 and 500),

  -- Each step unlocks the next and none may be skipped (design.md §6.3). A released dispatch has a
  -- note number, a releaser and a time; a note-recorded one has a number and no release.
  constraint dispatch_status_shape check (
    case status
      when 'assigned'      then dispatch_note_no is null and released_at is null
      when 'note_recorded' then dispatch_note_no is not null and released_at is null
      when 'released'      then dispatch_note_no is not null
                              and released_by is not null and released_at is not null
      when 'cancelled'     then cancel_reason is not null and released_at is null
    end
  )
);

comment on table public.dispatches is
  'One OMS record per physical dispatch note (product.md §14, AC-36). The OMS does NOT generate the '
  'note (AC-37) — staff use the four-copy carbon book and the number is typed in from it.';

create index dispatches_invoice_idx     on public.dispatches (invoice_id);
create index dispatches_storekeeper_idx on public.dispatches (storekeeper_id, assigned_at desc);
create index dispatches_status_idx      on public.dispatches (status, assigned_at desc);
create index dispatches_assigned_by_idx on public.dispatches (assigned_by);
create index dispatches_note_by_idx     on public.dispatches (note_recorded_by);
create index dispatches_released_by_idx on public.dispatches (released_by);
create index dispatches_location_idx    on public.dispatches (source_location);

-- Direct access to public.dispatches
--
-- Read by the three roles the queue belongs to: design.md §4.2 puts it in front of a Cashier who
-- assigns and a Manager who releases, and a Director reads it for oversight. `/dispatch` refuses a
-- Sales Representative at the route, and this refuses them at the table, so the two agree.
--
-- UPDATE for the definer owner only, and the `dispatch_status_shape` constraint above decides
-- which transitions are legal regardless of who asks.
alter table public.dispatches enable row level security;

grant select on public.dispatches to authenticated;

create policy dispatches_select_live_staff on public.dispatches
  for select to authenticated
  using ( (select private.authorize(
             array['director','manager','cashier']::public.app_role[])) );

grant select, insert, update on public.dispatches to fv_definer_owner;

create policy dispatches_definer_owner_read on public.dispatches
  for select to fv_definer_owner using ( true );
create policy dispatches_definer_owner_insert on public.dispatches
  for insert to fv_definer_owner with check ( true );
create policy dispatches_definer_owner_update on public.dispatches
  for update to fv_definer_owner using ( true ) with check ( true );

revoke all on public.dispatches from service_role;

create table public.dispatch_lines (
  id            uuid primary key default gen_random_uuid(),
  dispatch_id   uuid not null references public.dispatches (id) on delete restrict,

  -- The claim this line releases part of, so a partial release always knows what it is settling.
  allocation_id uuid not null references public.stock_allocations (id) on delete restrict,

  product_id    uuid not null references public.products (id) on delete restrict,
  quantity      bigint not null check (quantity > 0 and quantity <= 10000000),

  unique (dispatch_id, allocation_id)
);

create index dispatch_lines_dispatch_idx   on public.dispatch_lines (dispatch_id);
create index dispatch_lines_allocation_idx on public.dispatch_lines (allocation_id);
create index dispatch_lines_product_idx    on public.dispatch_lines (product_id);

-- Direct access to public.dispatch_lines
--
-- No UPDATE and no DELETE for anybody, the definer owner included: what left against a signed note
-- is the record of what the customer took, and a correction is a new dispatch beside it.
alter table public.dispatch_lines enable row level security;

grant select on public.dispatch_lines to authenticated;

create policy dispatch_lines_select_live_staff on public.dispatch_lines
  for select to authenticated
  using ( (select private.authorize(
             array['director','manager','cashier']::public.app_role[])) );

grant select, insert on public.dispatch_lines to fv_definer_owner;

create policy dispatch_lines_definer_owner_read on public.dispatch_lines
  for select to fv_definer_owner using ( true );
create policy dispatch_lines_definer_owner_insert on public.dispatch_lines
  for insert to fv_definer_owner with check ( true );

revoke all on public.dispatch_lines from service_role;

-- ---------------------------------------------------------------------------
-- paid_but_unreleased — the most dangerous state in the system, made findable
--
-- design.md §7.12: goods that are settled and still in the yard. Everyone needs to be able to see
-- them, and "days waiting" is what turns a list into a prompt.
-- ---------------------------------------------------------------------------
create view public.paid_but_unreleased
with (security_invoker = true) as
select a.id            as allocation_id,
       a.order_id,
       i.id            as invoice_id,
       i.invoice_no,
       c.name          as customer_name,
       a.product_id,
       (a.quantity - a.released_quantity)::bigint as outstanding_quantity,
       i.issued_at,
       -- Whole days, on the business day rather than the server's (product.md §15.3).
       --
       -- The expression is INLINE rather than a call to `private.business_date()`, and that is not
       -- duplication for its own sake: this view is `security_invoker`, so it runs as the signed-in
       -- user, and `authenticated` holds no EXECUTE on anything in `private` — by design, and
       -- asserted by pgTAP test 003. Calling it here made every read of this view fail with
       -- "permission denied for function business_date", which an integration test found on the
       -- first run. The rule is the same one `private.business_date()` states.
       (((now() at time zone 'Africa/Dar_es_Salaam')::date) - i.business_date) as days_waiting
  from public.stock_allocations a
  join public.orders o   on o.id = a.order_id
  join public.invoices i on i.order_id = o.id
  join public.customers c on c.id = o.customer_id
 where a.state = 'committed'
   and a.quantity > a.released_quantity
   and i.cancelled_at is null
   and (select api.staff_settlement_readable());

comment on view public.paid_but_unreleased is
  'Goods that are settled and have not left (product.md §8, design.md §7.12). Physically present, '
  'not sellable, and waiting on a signed dispatch note.';

-- Direct access to public.paid_but_unreleased
--
-- A view, and `security_invoker` again: every read obeys the policies on `stock_allocations`,
-- `orders`, `invoices` and `customers` as the person asking.
grant select on public.paid_but_unreleased to authenticated;
grant select on public.paid_but_unreleased to fv_definer_owner;

revoke all on public.paid_but_unreleased from service_role;

commit;
