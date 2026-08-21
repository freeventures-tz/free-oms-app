-- Stage 10 Part C · Migration chain, step 2b: the price row survived, in the priced fixture only
--
-- Runs after 02_assert_after.sql, in the fixture that wrote a price in step 1b. The zero-price
-- fixture skips it, because there is no price row to follow.
--
-- The single most consequential thing to get wrong. A price a Director handed to a customer must
-- still be readable afterwards, attached to the product it was set for.

\set ON_ERROR_STOP on

do $$
declare
  v_price record;
  v_now   record;
begin
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

  raise notice 'migration-chain: price row % still points at product %',
    v_price.price_id, v_price.product_id;
end
$$;

\echo 'migration-chain: the price reference written before migration 22 survived it'
