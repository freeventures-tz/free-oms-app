-- Stage 10 Part C · Migration chain, step 2: what survived migration 22
--
-- Runs after `supabase migration up` has applied 20260820000100 through the ordinary migration
-- mechanism, against the snapshot 01_capture_before.sql took of a genuine Part B database.
--
-- Every check raises rather than returns a row, so the harness fails on the first broken invariant
-- with a sentence naming what broke. A post-migration query that only proves rows currently exist
-- would pass just as happily against a database that had been emptied and re-seeded, which is the
-- failure this file exists to catch.
--
-- Runs in BOTH fixtures, the one with prices and the one without, because none of what it asserts
-- depends on a price existing. The price row's survival is 02b_assert_price_survived.sql.

\set ON_ERROR_STOP on

do $$
declare
  v_lost        integer;
  v_gained      integer;
  v_renamed     integer;
  v_wrong       integer;
  v_untouched   integer;
  v_active      integer;
  v_retired     integer;
  v_stranded    integer;
begin
  -- -------------------------------------------------------------------------
  -- 1. The product id set is IDENTICAL. Not "the same size" — the same ids.
  --
  -- This is the check the whole harness is built around. Price history, audit rows and every
  -- future stock movement point at these uuids; a delete-and-reinsert would leave them all
  -- orphaned while a count of 21 still looked correct.
  -- -------------------------------------------------------------------------
  select count(*) into v_lost
    from migration_chain.products_before b
   where not exists (select 1 from public.products p where p.id = b.id);

  select count(*) into v_gained
    from public.products p
   where not exists (select 1 from migration_chain.products_before b where b.id = p.id);

  if v_lost > 0 or v_gained > 0 then
    raise exception
      'product ids did not survive migration 22: % lost, % new. Price history and audit rows point '
      'at these ids', v_lost, v_gained;
  end if;

  -- -------------------------------------------------------------------------
  -- 2. Nothing was renamed. Migration 22 changes how a product is COUNTED, never what it is.
  -- -------------------------------------------------------------------------
  select count(*) into v_renamed
    from migration_chain.products_before b
    join public.products p on p.id = b.id
   where p.name is distinct from b.name
      or p.specification is distinct from b.specification;

  if v_renamed > 0 then
    raise exception '% product name(s) or specification(s) changed during migration 22', v_renamed;
  end if;

  -- -------------------------------------------------------------------------
  -- 3. The approved unit and content mapping, product by product (product.md §6)
  --
  -- Driven from the BEFORE snapshot, so it checks the transformation that actually happened rather
  -- than restating today's rows back to themselves.
  -- -------------------------------------------------------------------------
  select count(*) into v_wrong
    from migration_chain.products_before b
    join public.products p on p.id = b.id
   where (b.unit_code, coalesce(p.unit_code, ''), coalesce(p.unit_content, '')) not in (
           ('bag_50kg',   'bag',    '50 kg'),
           ('bucket_20l', 'bucket', '20 litres'),
           ('piece_12ft', 'piece',  '12 ft'),
           ('piece',      'piece',  ''),
           ('sheet',      'sheet',  ''),
           ('bar',        'bar',    '')
         );

  if v_wrong > 0 then
    raise exception
      '% product(s) were not migrated to the approved counting unit and content (product.md §6)',
      v_wrong;
  end if;

  -- A product that already had a generic unit must not have acquired a content it never had.
  select count(*) into v_untouched
    from migration_chain.products_before b
    join public.products p on p.id = b.id
   where b.unit_code in ('piece', 'sheet', 'bar')
     and (p.unit_code is distinct from b.unit_code or p.unit_content is not null);

  if v_untouched > 0 then
    raise exception '% product(s) counted in an already-generic unit were altered', v_untouched;
  end if;

  -- -------------------------------------------------------------------------
  -- 4. The units on offer are the approved ones, and the package-specific rows are retired
  --
  -- Counted rather than eyeballed, because "the picker looks right" is what a Director will do and
  -- it is not evidence. Five generic units a new product may be counted in, three retired rows kept
  -- only so an old value can still be read back.
  -- -------------------------------------------------------------------------
  select count(*) into v_active  from public.units where is_active;
  select count(*) into v_retired from public.units where not is_active;

  if v_active <> 5 or v_retired <> 3 then
    raise exception
      'expected 5 active and 3 retired counting units after migration 22, found % active and % '
      'retired', v_active, v_retired;
  end if;

  if exists (
    select 1 from public.units
     where is_active and code not in ('bag', 'bar', 'bucket', 'piece', 'sheet')
  ) then
    raise exception 'a counting unit outside the approved set is on offer after migration 22';
  end if;

  if exists (
    select 1 from public.units
     where not is_active and code not in ('bag_50kg', 'bucket_20l', 'piece_12ft')
  ) then
    raise exception 'a unit was retired that migration 22 was not supposed to retire';
  end if;

  -- -------------------------------------------------------------------------
  -- 5. The point of the exercise: no product is counted in a unit that also states an amount.
  -- -------------------------------------------------------------------------
  select count(*) into v_stranded
    from public.products p join public.units u on u.code = p.unit_code
   where not u.is_active;

  if v_stranded > 0 then
    raise exception '% product(s) are still counted in a retired package-specific unit', v_stranded;
  end if;

  raise notice 'migration-chain: % products kept their ids, names and specifications',
    (select count(*) from migration_chain.products_before);
  raise notice 'migration-chain: % counting units on offer, % retired, 0 stranded products',
    v_active, v_retired;
end
$$;

\echo 'migration-chain: every product id, name and specification survived, and the units are the approved ones'
