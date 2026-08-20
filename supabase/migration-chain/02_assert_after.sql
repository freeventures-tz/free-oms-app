-- Stage 10 Part C · Migration chain, step 2: what survived migration 22
--
-- Runs after `supabase migration up` has applied 20260820000100 through the ordinary migration
-- mechanism, against the snapshot 01_capture_before.sql took of a genuine Part B database.
--
-- Every check raises rather than returns a row, so the harness fails on the first broken invariant
-- with a sentence naming what broke. A post-migration query that only proves rows currently exist
-- would pass just as happily against a database that had been emptied and re-seeded, which is the
-- failure this file exists to catch.

\set ON_ERROR_STOP on

do $$
declare
  v_lost        integer;
  v_gained      integer;
  v_renamed     integer;
  v_wrong       integer;
  v_price       record;
  v_now         record;
  v_untouched   integer;
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
  -- 4. The price row written BEFORE the migration still exists, with the same id, still pointing
  --    at the same product.
  --
  -- The single most consequential thing to get wrong. A price a Director handed to a customer must
  -- still be readable afterwards, attached to the product it was set for.
  -- -------------------------------------------------------------------------
  select * into v_price from migration_chain.price_before;

  select id, product_id, price_tzs into v_now
    from public.product_prices where id = v_price.price_id;

  if not found then
    raise exception
      'the price row written before migration 22 (%) no longer exists', v_price.price_id;
  end if;

  if v_now.product_id is distinct from v_price.product_id then
    raise exception
      'price row % now points at product % instead of the product it was written for (%)',
      v_price.price_id, v_now.product_id, v_price.product_id;
  end if;

  if v_now.price_tzs is distinct from v_price.price_tzs then
    raise exception 'price row % changed value from % to %',
      v_price.price_id, v_price.price_tzs, v_now.price_tzs;
  end if;

  -- And the product it points at is one of the products that MOVED, so this proves the reference
  -- survived a real transformation rather than an untouched row.
  if not exists (
    select 1 from public.products p
     where p.id = v_price.product_id and p.unit_code = 'bucket' and p.unit_content = '20 litres'
  ) then
    raise exception
      'the priced product did not receive the approved counting unit and content, so the surviving '
      'reference proves nothing';
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
  raise notice 'migration-chain: price row % still points at product %',
    v_price.price_id, v_price.product_id;
end
$$;

\echo 'migration-chain: PASS — every product id, name, specification and price reference survived migration 22'
