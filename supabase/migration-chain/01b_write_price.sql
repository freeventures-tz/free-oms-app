-- Stage 10 Part C · Migration chain, step 1b: one real price row, in the priced fixture only
--
-- Runs after 01_capture_before.sql, in the fixture that carries prices. The zero-price fixture
-- skips this file entirely, because production holds no prices today and the gate has to work
-- against that database as well as against a full one.
--
-- The row could have been inserted directly as the table owner, and it would have been a fiction:
-- `product_prices` has no INSERT grant for anybody but the definer owner, and `set_by` is a foreign
-- key to a real profile. Going through `api.admin_set_product_price` as the Director created in
-- step 1 produces the row the product actually produces, with real attribution and a real audit
-- event behind it.
--
-- Sand is chosen deliberately: it is one of the products migration 22 MOVES, from the
-- package-specific `bucket_20l` to the generic `bucket` plus content `20 litres`. A price row
-- attached to a product that does not move would prove much less.

begin;

select set_config(
  'request.jwt.claims',
  json_build_object('sub', 'e0000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text,
  true);

create table migration_chain.price_before as
select
  (result -> 'price' ->> 'id')::uuid          as price_id,
  (result -> 'price' ->> 'product_id')::uuid  as product_id,
  (result -> 'price' ->> 'price_tzs')::bigint as price_tzs
from (
  select api.admin_set_product_price(
    (select id from public.products where name = 'Sand'),
    4500,
    'Opening price, written before the counting-unit migration',
    'migration-chain-price-key-1'
  ) as result
) as issued;

do $$
declare v_id uuid;
begin
  select price_id into v_id from migration_chain.price_before;
  if v_id is null then
    raise exception 'the price fixture did not produce a price row; the harness has nothing to prove';
  end if;
end
$$;

commit;

\echo 'migration-chain: wrote one real price row before migration 22'
