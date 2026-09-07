-- Stage 13 · Brick production, curing and inspection — the objects, and their protection
--
-- product.md §11 governs all of it, and four of its rules shape every table here. Each one is a
-- place where the obvious implementation is the wrong one:
--
--   1. THE RECIPE IS NOT THE DEDUCTION (§11.1). "The standard is the expected recipe, not the
--      deduction. Actual usage is what the ledger deducts." So the standard is stored beside the
--      actual on every input line, the difference is a generated column, and the ledger reads the
--      actual. A schema that stored only one number would make the variance unrecoverable.
--
--   2. CONTENT IS NEVER DEDUCTED (§11.1, AC-120). A batch consumes 1 bag and 10 buckets. `50 kg`
--      and `20 litres` describe what one of them holds and are not quantities — Stage 10 Part C
--      separated them for exactly this moment.
--
--   3. CURING ENDING IS NOT THE SAME AS BEING SELLABLE (§11.4, AC-44). After 72 hours a lot is
--      READY FOR INSPECTION and nothing more. Only a Manager-accepted quantity becomes available,
--      and the accepted quantity is a decision somebody makes, not a timer expiring.
--
--   4. OUTPUT OUTSIDE THE EXPECTED RANGE IS FLAGGED AND EXPLAINED, NOT BLOCKED (§11.2, AC-41). A
--      batch that produced 18 bricks instead of 20 is a fact about the yard, and refusing to record
--      it would lose the fact rather than fix it.
--
-- WHY THERE IS NO "READY FOR INSPECTION" STATE ANYWHERE: it is `curing_started_at + 72 hours <=
-- now()`, derived from a timestamp. A scheduled job moving lots between two states every night
-- would be a second writer of permanent history doing nothing a comparison cannot do.
--
-- EVERY OBJECT IS PROTECTED IN THE SAME MIGRATION THAT CREATES IT. A release applies its
-- migrations before the new application code is serving, so the database sits at exactly this
-- point for as long as that gap lasts. A file that created five public tables and left row-level
-- security to the NEXT file would leave them readable by every signed-in account for the whole of
-- it. Creation, exposure, RLS and grants therefore travel together here, and the second migration
-- adds commands only.

begin;

-- ---------------------------------------------------------------------------
-- The four reject reasons of product.md §11.5, and nothing else
--
-- An enum rather than free text, because AC-3 says reject reasons are chosen from preset controls
-- and not typed — and because four fixed reasons can be counted at the end of a month, while four
-- hundred spellings of "broken" cannot.
-- ---------------------------------------------------------------------------
create type public.brick_reject_reason as enum ('broken', 'cracked', 'undersized', 'weak');

comment on type public.brick_reject_reason is
  'The four reject reasons of product.md §11.5. Preset, not typed (AC-3, AC-45).';

create type public.production_batch_status as enum (
  'draft',      -- recorded, nothing deducted, nothing produced (§11.1: approval is what deducts)
  'approved',   -- the Manager approved: inputs deducted, output in curing
  'rejected',   -- a completed decision that is NOT an approval (§4.3)
  'cancelled'
);

comment on type public.production_batch_status is
  'Where a batch stands. NOTHING is deducted until `approved` (product.md §11.1, AC-39).';

-- ---------------------------------------------------------------------------
-- The expected standard recipe (product.md §11.1), as reference data
--
-- Seeded by migration for the same reason the catalogue is: product.md fixes it, every environment
-- needs the identical set, and it is the same in all of them. It is the PRE-FILL and the variance
-- baseline — never the deduction.
-- ---------------------------------------------------------------------------
create table public.production_recipe_inputs (
  product_id        uuid primary key references public.products (id) on delete restrict,
  standard_quantity bigint not null check (standard_quantity > 0 and standard_quantity <= 1000),
  sort_order        integer not null
);

comment on table public.production_recipe_inputs is
  'What one mixer batch is EXPECTED to consume (product.md §11.1). Pre-fills the form and gives the '
  'variance something to be measured against. Never deducted: the ledger takes the actual.';

-- ---------------------------------------------------------------------------
-- The expected yield range (product.md §11.2)
--
-- Output outside it is flagged and explained, not blocked (AC-41), so this table exists to decide
-- when an explanation is required — never to refuse a number somebody counted.
-- ---------------------------------------------------------------------------
create table public.production_yield_ranges (
  product_id    uuid primary key references public.products (id) on delete restrict,
  min_per_batch bigint not null check (min_per_batch > 0),
  max_per_batch bigint not null check (max_per_batch > 0),

  constraint yield_range_is_a_range check (max_per_batch >= min_per_batch)
);

comment on table public.production_yield_ranges is
  'The approved expected yield per batch (product.md §11.2). Output outside it is FLAGGED and '
  'explained, never blocked (AC-41).';

-- ---------------------------------------------------------------------------
-- production_batches
-- ---------------------------------------------------------------------------
create table public.production_batches (
  id             uuid primary key default gen_random_uuid(),
  batch_no       text not null unique,

  -- Where the materials come from and the bricks are made. product.md §7 puts production in the
  -- yard, and §10's transfer is what gets the materials there.
  location_code  text not null references public.inventory_locations (code),

  status         public.production_batch_status not null default 'draft',

  -- §11.4: "Curing starts at the actual moulding-completion time, not at data entry." The current
  -- time is pre-filled and the Manager confirms or corrects it, so this is their answer rather
  -- than a clock reading.
  moulded_at     timestamptz not null,

  -- §11.2, AC-41: required when any lot fell outside its expected range, and refused otherwise so
  -- an explanation always means something happened.
  yield_note     text check (yield_note is null or length(btrim(yield_note)) between 3 and 500),

  entered_by     uuid not null references public.profiles (id),
  entered_role   public.app_role not null,
  entered_at     timestamptz not null default now(),

  decided_by     uuid references public.profiles (id),
  decided_role   public.app_role,
  decided_at     timestamptz,
  decision_reason text check (decision_reason is null or length(btrim(decision_reason)) between 3 and 500),

  -- A draft has no decision; anything settled has one. §4.3: a rejection is a completed decision
  -- and carries a reason, and it is NOT an approval.
  constraint batch_decision_shape check (
    case status
      when 'draft' then decided_by is null and decided_at is null
      when 'approved' then decided_by is not null and decided_at is not null
      else decided_by is not null and decided_at is not null and decision_reason is not null
    end
  )
);

comment on table public.production_batches is
  'One mixer batch (product.md §11). Recording it deducts nothing: the Manager approves, and THAT '
  'is what consumes the confirmed actual quantities (§11.1, AC-39).';

create index production_batches_status_idx  on public.production_batches (status, entered_at desc);
create index production_batches_entered_idx on public.production_batches (entered_by, entered_at desc);
create index production_batches_decided_idx on public.production_batches (decided_by);
create index production_batches_location_idx on public.production_batches (location_code);
create index production_batches_recent_idx  on public.production_batches (entered_at desc);

-- The drafts queue is read INDEPENDENTLY of the history, ordered on `entered_at` and broken by
-- `id` so that a range over it is a page rather than a guess: two batches entered in the same
-- millisecond would otherwise be free to appear twice or not at all.
create index production_batches_drafts_idx
  on public.production_batches (entered_at desc, id desc)
  where status = 'draft';

-- ---------------------------------------------------------------------------
-- production_batch_inputs — the standard, the actual, and the difference
--
-- All three on one row, because §11.1 wants the variance recorded for every input and "never used
-- to adjust the deduction back toward the standard". Keeping only the actual would lose the
-- variance; keeping only the standard would deduct a fiction.
-- ---------------------------------------------------------------------------
create table public.production_batch_inputs (
  id                uuid primary key default gen_random_uuid(),
  batch_id          uuid not null references public.production_batches (id) on delete restrict,
  product_id        uuid not null references public.products (id) on delete restrict,

  -- Snapshotted at entry, so a later change to the recipe cannot rewrite what a past batch was
  -- measured against.
  standard_quantity bigint not null check (standard_quantity >= 0 and standard_quantity <= 1000),

  -- What the Manager confirmed was actually used. THIS is what the ledger deducts (AC-38). Zero is
  -- a legitimate confirmed actual — a batch that used no aggregate used none — and its variance is
  -- recorded like every other one.
  actual_quantity   bigint not null check (actual_quantity >= 0 and actual_quantity <= 10000),

  -- Calculated, never typed (§5.2). Recorded for every input, and never suppressed (§15.1).
  variance_quantity bigint generated always as (actual_quantity - standard_quantity) stored,

  unique (batch_id, product_id)
);

comment on table public.production_batch_inputs is
  'What a batch was expected to use and what it actually used (product.md §11.1). The ledger '
  'deducts the ACTUAL; the variance is a generated column and is recorded whatever it says.';

create index production_inputs_batch_idx   on public.production_batch_inputs (batch_id);
create index production_inputs_product_idx on public.production_batch_inputs (product_id);

-- ---------------------------------------------------------------------------
-- production_lots — one per brick size, each with its OWN curing clock
--
-- §11.4: "Every output lot carries its own curing-start timestamp. Five-inch and six-inch lots
-- from one batch MAY SHARE A TIMESTAMP BUT REMAIN SEPARATE LOTS." So the timestamp lives here and
-- not on the batch, even though both lots of one batch will usually carry the same value.
-- ---------------------------------------------------------------------------
create table public.production_lots (
  id                    uuid primary key default gen_random_uuid(),
  batch_id              uuid not null references public.production_batches (id) on delete restrict,
  product_id            uuid not null references public.products (id) on delete restrict,

  -- What came out of the mould, before anything was thrown away.
  quantity_moulded      bigint not null check (quantity_moulded > 0 and quantity_moulded <= 100000),

  -- §11.3 point 5: the Manager records good output AND rejected output at moulding.
  rejected_at_moulding  bigint not null default 0 check (rejected_at_moulding >= 0),
  moulding_reject_reason public.brick_reject_reason,

  -- Its own clock (§11.4). Copied from the batch at entry and never derived from it afterwards.
  curing_started_at     timestamptz not null,

  -- §11.4, AC-45: the inspection. Only the accepted quantity becomes available for sale.
  inspected_at          timestamptz,
  inspected_by          uuid references public.profiles (id),
  -- The role the inspector HELD AT THE TIME, kept for the reason every other decision keeps one
  -- (§4.2, AC-82): a role that changes next month must not rewrite who accepted these bricks.
  inspected_role        public.app_role,
  accepted_quantity     bigint check (accepted_quantity >= 0),
  rejected_at_inspection bigint check (rejected_at_inspection >= 0),
  inspection_reject_reason public.brick_reject_reason,

  constraint lot_moulding_rejects_within_output
    check (rejected_at_moulding <= quantity_moulded),

  -- A reject count with no reason is a number nobody can act on; a reason with no rejects is a
  -- claim about nothing (§11.5, AC-45).
  constraint lot_moulding_reject_reason check (
    (rejected_at_moulding = 0 and moulding_reject_reason is null)
    or (rejected_at_moulding > 0 and moulding_reject_reason is not null)
  ),

  -- An inspection is all of its parts or none of them.
  constraint lot_inspection_shape check (
    (inspected_at is null and inspected_by is null and inspected_role is null
      and accepted_quantity is null and rejected_at_inspection is null
      and inspection_reject_reason is null)
    or (inspected_at is not null and inspected_by is not null and inspected_role is not null
      and accepted_quantity is not null and rejected_at_inspection is not null)
  ),

  constraint lot_inspection_reject_reason check (
    inspected_at is null
    or (rejected_at_inspection = 0 and inspection_reject_reason is null)
    or (rejected_at_inspection > 0 and inspection_reject_reason is not null)
  ),

  -- Nothing may be accounted for twice: what was accepted plus what was rejected at inspection
  -- is exactly what actually went into curing.
  constraint lot_inspection_within_curing check (
    inspected_at is null
    or (accepted_quantity + rejected_at_inspection = quantity_moulded - rejected_at_moulding)
  ),

  unique (batch_id, product_id)
);

comment on table public.production_lots is
  'One curing lot per brick size (product.md §11.4). Each carries its OWN curing clock: two lots '
  'from one batch may share a timestamp and are still two lots. Reaching 72 hours makes a lot READY '
  'FOR INSPECTION and nothing more — only an accepted quantity becomes sellable (AC-44, AC-45).';

create index production_lots_batch_idx   on public.production_lots (batch_id);
create index production_lots_product_idx on public.production_lots (product_id);
-- The inspection queue, ordered exactly the way it is read and broken by `id` for the same reason
-- as the drafts index above.
create index production_lots_curing_idx  on public.production_lots (curing_started_at, id)
  where inspected_at is null;
create index production_lots_inspector_idx on public.production_lots (inspected_by);

-- ---------------------------------------------------------------------------
-- curing_lots — what is curing, and whether it is ready to look at
--
-- The 72 hours of §11.4 live here, once. `security_invoker` so the view is not a way around RLS.
-- ---------------------------------------------------------------------------
create view public.curing_lots
with (security_invoker = true) as
select l.id            as lot_id,
       l.batch_id,
       b.batch_no,
       l.product_id,
       b.location_code,
       (l.quantity_moulded - l.rejected_at_moulding)::bigint as quantity_curing,
       l.quantity_moulded,
       l.rejected_at_moulding,
       l.moulding_reject_reason,
       l.curing_started_at,
       (l.curing_started_at + interval '72 hours')            as ready_at,
       -- READY FOR INSPECTION, and nothing more. §11.4 and AC-44: reaching this does NOT make the
       -- bricks available, and the interface must never imply that it does.
       (now() >= l.curing_started_at + interval '72 hours')   as ready_for_inspection,
       l.inspected_at,
       l.accepted_quantity,
       l.rejected_at_inspection,
       l.inspection_reject_reason
  from public.production_lots l
  join public.production_batches b on b.id = l.batch_id
 where b.status = 'approved';

comment on view public.curing_lots is
  'Bricks inside the curing period, with their own countdowns (product.md §11.4). '
  '`ready_for_inspection` is 72 hours elapsed and NOTHING ELSE: only a Manager-accepted quantity '
  'becomes available for sale (AC-44, AC-45).';

-- ---------------------------------------------------------------------------
-- Exposure, row-level security and grants — HERE, beside the objects they protect
--
-- product.md §4.1: "Production release and production batch — Manager / Manager." Entry and
-- approval are both the Manager's, and §4.2 keeps them two separate acts: recording a batch
-- deducts nothing, and approving it is a deliberate second step that consumes the yard.
--
-- READS are Manager and Director (design.md §4.2 gives Production to those two). A Cashier and a
-- Sales Representative do not work a mixer and are offered nothing here.
--
-- WRITES: no INSERT, UPDATE or DELETE grant to `authenticated` on any table below. Every change
-- goes through the commands the next migration creates.
-- ---------------------------------------------------------------------------
alter table public.production_recipe_inputs enable row level security;
alter table public.production_yield_ranges  enable row level security;
alter table public.production_batches       enable row level security;
alter table public.production_batch_inputs  enable row level security;
alter table public.production_lots          enable row level security;

grant select on public.production_recipe_inputs to authenticated;
grant select on public.production_yield_ranges  to authenticated;
grant select on public.production_batches       to authenticated;
grant select on public.production_batch_inputs  to authenticated;
grant select on public.production_lots          to authenticated;
grant select on public.curing_lots              to authenticated;

create policy recipe_select_oversight on public.production_recipe_inputs
  for select to authenticated
  using ( (select private.authorize(array['director','manager']::public.app_role[])) );

create policy yield_select_oversight on public.production_yield_ranges
  for select to authenticated
  using ( (select private.authorize(array['director','manager']::public.app_role[])) );

create policy batches_select_oversight on public.production_batches
  for select to authenticated
  using ( (select private.authorize(array['director','manager']::public.app_role[])) );

create policy batch_inputs_select_oversight on public.production_batch_inputs
  for select to authenticated
  using ( (select private.authorize(array['director','manager']::public.app_role[])) );

create policy lots_select_oversight on public.production_lots
  for select to authenticated
  using ( (select private.authorize(array['director','manager']::public.app_role[])) );

grant select                 on public.production_recipe_inputs to fv_definer_owner;
grant select                 on public.production_yield_ranges  to fv_definer_owner;
grant select, insert, update on public.production_batches       to fv_definer_owner;
grant select, insert         on public.production_batch_inputs  to fv_definer_owner;
grant select, insert, update on public.production_lots          to fv_definer_owner;
grant select                 on public.curing_lots              to fv_definer_owner;

create policy recipe_definer_owner_read on public.production_recipe_inputs
  for select to fv_definer_owner using ( true );
create policy yield_definer_owner_read on public.production_yield_ranges
  for select to fv_definer_owner using ( true );

create policy batches_definer_owner_read on public.production_batches
  for select to fv_definer_owner using ( true );
create policy batches_definer_owner_insert on public.production_batches
  for insert to fv_definer_owner with check ( true );
create policy batches_definer_owner_update on public.production_batches
  for update to fv_definer_owner using ( true ) with check ( true );

create policy batch_inputs_definer_owner_read on public.production_batch_inputs
  for select to fv_definer_owner using ( true );
create policy batch_inputs_definer_owner_insert on public.production_batch_inputs
  for insert to fv_definer_owner with check ( true );

create policy lots_definer_owner_read on public.production_lots
  for select to fv_definer_owner using ( true );
create policy lots_definer_owner_insert on public.production_lots
  for insert to fv_definer_owner with check ( true );
-- UPDATE reaches one transition: recording the inspection. The table's own constraints refuse a
-- half-recorded one, and pgTAP asserts a lot cannot be inspected twice.
create policy lots_definer_owner_update on public.production_lots
  for update to fv_definer_owner using ( true ) with check ( true );

revoke all on public.production_recipe_inputs from service_role;
revoke all on public.production_yield_ranges  from service_role;
revoke all on public.production_batches       from service_role;
revoke all on public.production_batch_inputs  from service_role;
revoke all on public.production_lots          from service_role;
revoke all on public.curing_lots              from service_role;

-- ---------------------------------------------------------------------------
-- The catalogue this reference data depends on, checked BEFORE anything is written
--
-- §11.1 names three materials and §11.2 names two brick sizes, and the seed below is keyed by
-- product NAME because the ids are generated per environment. A name that has been renamed,
-- removed, duplicated or moved to an incompatible counting unit therefore has to stop the
-- migration with a sentence somebody can act on — not seed two rows out of five and leave a batch
-- form that pre-fills with nothing.
--
-- IT REPAIRS NOTHING. A live catalogue is the business's own record, and a migration that renamed
-- a product to make its own seed fit would be editing that record to suit itself.
-- ---------------------------------------------------------------------------
do $$
declare
  v_wanted  record;
  v_matches integer;
  v_units   text;
begin
  for v_wanted in
    select * from (values
      ('Dangote Cement 42R', 'bag'),
      ('Sand',               'bucket'),
      ('Aggregate',          'bucket'),
      ('Tofali 6"',          'piece'),
      ('Tofali 5"',          'piece')
    ) as t(name, unit_code)
  loop
    select count(*) into v_matches from public.products p where p.name = v_wanted.name;

    if v_matches = 0 then
      raise exception
        'brick production needs the product "%" from product.md §11, and this catalogue has none. '
        'Restore or re-add it under that exact name before applying this migration.',
        v_wanted.name;
    end if;

    if v_matches > 1 then
      raise exception
        'brick production needs exactly one product named "%", and this catalogue has %. Resolve '
        'the duplicate before applying this migration: the recipe cannot choose between them.',
        v_wanted.name, v_matches;
    end if;

    select string_agg(distinct p.unit_code, ', ') into v_units
      from public.products p where p.name = v_wanted.name;

    if v_units is distinct from v_wanted.unit_code then
      raise exception
        'brick production counts "%" in % (product.md §6, §11.1), and this catalogue counts it in '
        '%. A batch would deduct the wrong unit. Correct the product''s counting unit before '
        'applying this migration.',
        v_wanted.name, v_wanted.unit_code, v_units;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- The recipe and the yield ranges, seeded from product.md §11.1 and §11.2
--
-- Reference data the product definition fixes, exactly like the 21 products. Nothing about an
-- existing product, price or counter is touched: this migration reads the catalogue and writes
-- only its own two tables.
-- ---------------------------------------------------------------------------
insert into public.production_recipe_inputs (product_id, standard_quantity, sort_order)
select p.id, v.quantity, v.sort_order
  from (values
    ('Dangote Cement 42R', 1::bigint, 10),
    ('Sand',               5::bigint, 20),
    ('Aggregate',          5::bigint, 30)
  ) as v(name, quantity, sort_order)
  join public.products p on p.name = v.name
on conflict (product_id) do nothing;

insert into public.production_yield_ranges (product_id, min_per_batch, max_per_batch)
select p.id, v.lo, v.hi
  from (values
    ('Tofali 6"', 20::bigint, 25::bigint),
    ('Tofali 5"', 25::bigint, 30::bigint)
  ) as v(name, lo, hi)
  join public.products p on p.name = v.name
on conflict (product_id) do nothing;

do $$
begin
  -- Three inputs and two sizes, exactly as §11.1 and §11.2 write them. Water is absent on purpose:
  -- §11.1 calls it a utility cost that is never inventory and is never deducted.
  if (select count(*) from public.production_recipe_inputs) <> 3 then
    raise exception 'the standard recipe needs the three inputs of product.md §11.1';
  end if;

  if (select count(*) from public.production_yield_ranges) <> 2 then
    raise exception 'the expected yield needs the two brick sizes of product.md §11.2';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The daily numbering sequence gains a batch kind (product.md §12.2's shape, reused)
--
-- ADDITIVE, and it proves that before it changes anything. The released constraint permits three
-- kinds; this widens it to four. If some later change has already altered that set, this migration
-- refuses rather than silently narrowing it back and breaking whatever added the fourth. No
-- counter is reset: the rows of `document_sequences` are not touched at all.
-- ---------------------------------------------------------------------------
do $$
declare
  v_definition text := (
    select pg_get_constraintdef(c.oid)
      from pg_constraint c
      join pg_class t     on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'document_sequences'
       and c.conname = 'document_sequences_kind_check');
  v_kind text;
begin
  if v_definition is null then
    raise exception
      'public.document_sequences has no constraint named document_sequences_kind_check, so the '
      'batch numbering kind cannot be added to a set this migration can read';
  end if;

  foreach v_kind in array array['order', 'proforma', 'invoice'] loop
    if position('''' || v_kind || '''' in v_definition) = 0 then
      raise exception
        'the released document numbering permits the % kind and this migration would drop it. Its '
        'check now reads: %', v_kind, v_definition;
    end if;
  end loop;

  if position('''batch''' in v_definition) > 0 then
    raise exception
      'public.document_sequences already permits a batch kind, so something else has added it: %',
      v_definition;
  end if;
end
$$;

alter table public.document_sequences drop constraint document_sequences_kind_check;
alter table public.document_sequences
  add constraint document_sequences_kind_check
  check (kind in ('order', 'proforma', 'invoice', 'batch'));

commit;
