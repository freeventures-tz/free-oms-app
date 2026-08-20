-- Stage 10 Part B · The approved catalogue, seeded
--
-- This is REFERENCE DATA the product definition fixes, not user data and not a privileged account:
-- product.md §6 lists exactly these 21 products and their units, and §7 exactly these 3 locations.
-- A migration is the right shape for it — every environment needs the identical set, and it is the
-- same in all of them. (Contrast the first Director, which is a runbook step for exactly the
-- opposite reasons: it is privileged, it differs per environment, and it must not re-run.)
--
-- NO PRICES ARE SEEDED. Not one. A selling price is a Director's decision under product.md §4, and
-- inventing a starting figure here would put a number in front of a customer that no Director ever
-- approved. Every product begins with no price, and the interface says so in words.
--
-- Idempotent throughout, because `supabase db reset` replays every migration on every developer
-- machine and in CI.

begin;

-- ---------------------------------------------------------------------------
-- Units — exactly the six distinct units product.md §6 uses.
--
-- "piece" and "12 ft piece" are separate units on purpose: a Mirunda is sold by the piece and a
-- length of timber by the 12-foot piece, and collapsing them would lose the length.
-- ---------------------------------------------------------------------------
insert into public.units (code, sort_order) values
  ('piece',        10),
  ('piece_12ft',   20),
  ('bag_50kg',     30),
  ('bucket_20l',   40),
  ('sheet',        50),
  ('bar',          60)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Inventory locations — product.md §7.
-- ---------------------------------------------------------------------------
insert into public.inventory_locations (code, sort_order) values
  ('store',     10),
  ('warehouse', 20),
  ('yard',      30)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- The 21 products of product.md §6, in the order that table lists them.
--
-- The four Nondo rows carry their grade in `specification` because §6 says grade is part of
-- product identity: "Nondo 12 mm BS 300" and "Nondo 12 mm BS 500" are distinct products, and the
-- unique index on (name, specification) is what makes that true rather than a note.
--
-- Water is absent, deliberately: §6 records it as a utility cost that is never stock.
-- ---------------------------------------------------------------------------
insert into public.products (name, specification, unit_code, created_by)
values
  ('Tofali 5"',           null,     'piece',      null),
  ('Tofali 6"',           null,     'piece',      null),
  ('Culvert 900D',        null,     'piece',      null),
  ('Culvert 600D',        null,     'piece',      null),
  ('Dangote Cement 42R',  null,     'bag_50kg',   null),
  ('Sand',                null,     'bucket_20l', null),
  ('Aggregate',           null,     'bucket_20l', null),
  ('Timber 1 × 10',       null,     'piece_12ft', null),
  ('Timber 1 × 6',        null,     'piece_12ft', null),
  ('Timber 1 × 8',        null,     'piece_12ft', null),
  ('Timber 2 × 2',        null,     'piece_12ft', null),
  ('Timber 2 × 4',        null,     'piece_12ft', null),
  ('Timber 2 × 6',        null,     'piece_12ft', null),
  ('Mirunda 4 × 12',      null,     'piece',      null),
  ('Mirunda 4 × 18',      null,     'piece',      null),
  ('Marine 12 mm',        null,     'sheet',      null),
  ('Marine 18 mm',        null,     'sheet',      null),
  ('Nondo 12 mm',         'BS 300', 'bar',        null),
  ('Nondo 12 mm',         'BS 500', 'bar',        null),
  ('Nondo 16 mm',         'BS 300', 'bar',        null),
  ('Nondo 8 mm',          'BS 300', 'bar',        null)
on conflict do nothing;

-- The count is asserted here as well as in pgTAP, so a mistake in this file fails the migration
-- rather than waiting for a test run. 21 is not a round number chosen for tidiness — it is the
-- length of the table in product.md §6.
do $$
declare v_count integer;
begin
  select count(*) into v_count from public.products;
  if v_count <> 21 then
    raise exception 'catalogue seed expected 21 products from product.md §6, found %', v_count;
  end if;

  if exists (select 1 from public.product_prices) then
    raise exception 'catalogue seed must create no prices; a selling price is a Director decision';
  end if;
end
$$;

commit;
