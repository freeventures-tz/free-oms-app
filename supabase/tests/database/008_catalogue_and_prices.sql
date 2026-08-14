-- Stage 10 Part B · Catalogue, selling prices, and who may change them
--
-- The claims under test are the ones the business actually depends on:
--
--   · the seeded catalogue is exactly what product.md §6 approves, and carries no prices;
--   · grade is part of product IDENTITY, so BS 300 and BS 500 are two products;
--   · only a Director may add a product or set a price, refused by the DATABASE and not by a
--     screen that happened to hide a button;
--   · price history cannot be edited or deleted by anyone, including the definer owner;
--   · every write is attributed and idempotent.
create extension if not exists pgtap with schema extensions;

begin;
select plan(54);

create schema if not exists tests;

create or replace function tests.mk_user(p_id uuid) returns void language plpgsql as $$
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          created_at, updated_at)
  values (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          p_id::text || '@test.local', extensions.crypt('x', extensions.gen_salt('bf')),
          now(), now());
end $$;

/** Acts as this user for the statements that follow, exactly as PostgREST would. */
create or replace function tests.acting_as(p_id uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_id::text, 'role', 'authenticated')::text, true);
$$;

select tests.mk_user('c0000000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('c0000000-0000-0000-0000-000000000002'::uuid);  -- Manager
select tests.mk_user('c0000000-0000-0000-0000-000000000003'::uuid);  -- Sales Rep
-- A SECOND Director, because either may act independently (product.md §4) — and because a key
-- claimed by one must not be replayable by the other.
select tests.mk_user('c0000000-0000-0000-0000-000000000004'::uuid);

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('c0000000-0000-0000-0000-000000000001', 'Catalogue Director', '+255700000091', true, false),
  ('c0000000-0000-0000-0000-000000000002', 'Catalogue Manager',  '+255700000092', true, false),
  ('c0000000-0000-0000-0000-000000000003', 'Catalogue Rep',      '+255700000093', true, false),
  ('c0000000-0000-0000-0000-000000000004', 'Second Director',    '+255700000094', true, false);

insert into public.user_roles (user_id, role) values
  ('c0000000-0000-0000-0000-000000000001', 'director'),
  ('c0000000-0000-0000-0000-000000000002', 'manager'),
  ('c0000000-0000-0000-0000-000000000003', 'sales_rep'),
  ('c0000000-0000-0000-0000-000000000004', 'director');

-- ---------------------------------------------------------------------------
-- The seed is the approved catalogue, and nothing more
-- ---------------------------------------------------------------------------
select is((select count(*)::int from public.products), 21,
  'exactly the 21 products product.md §6 approves are seeded');

select is((select count(*)::int from public.units), 6,
  'the six approved units of measure are seeded');

select is((select count(*)::int from public.inventory_locations), 3,
  'Store, Warehouse and Yard are seeded (product.md §7)');

select bag_eq(
  'select code from public.inventory_locations',
  $$ values ('store'), ('warehouse'), ('yard') $$,
  'the three locations are exactly those named in product.md §7');

-- The single most consequential seeding decision in this migration.
select is((select count(*)::int from public.product_prices), 0,
  'NO price is seeded: a selling price is a Director decision, never a starting figure');

select is((select count(*)::int from public.products where created_by is not null), 0,
  'the seeded catalogue is attributed to nobody, because nobody entered it');

-- ---------------------------------------------------------------------------
-- Grade is identity (product.md §6), not an attribute
-- ---------------------------------------------------------------------------
select is((select count(*)::int from public.products where name = 'Nondo 12 mm'), 2,
  'Nondo 12 mm BS 300 and BS 500 are two products, not one with a grade field');

select bag_eq(
  $$ select specification from public.products where name = 'Nondo 12 mm' $$,
  $$ values ('BS 300'), ('BS 500') $$,
  'both Nondo 12 mm grades are present and distinct');

select is((select count(*)::int from public.products where name ilike 'water%'), 0,
  'Water is not a product: product.md §6 records it as a utility cost with no stock');

select throws_ok(
  $$ insert into public.products (name, specification, unit_code)
     values ('nondo 12 mm', 'bs 300', 'bar') $$,
  '23505',
  null,
  'the same product in different capitalisation is refused as a duplicate identity');

select throws_ok(
  $$ insert into public.products (name, unit_code) values ('Ghost Product', 'not_a_unit') $$,
  '23503',
  null,
  'a product cannot be sold by a unit that is not approved');

-- ---------------------------------------------------------------------------
-- Money is whole shillings, and a price entry is a record of a decision
-- ---------------------------------------------------------------------------
select is(
  (select data_type from information_schema.columns
    where table_schema = 'public' and table_name = 'product_prices' and column_name = 'price_tzs'),
  'bigint',
  'a price is a bigint of whole shillings — no floating-point type anywhere near money');

select throws_ok(
  $$ insert into public.product_prices (product_id, price_tzs, reason, set_by, set_by_role, correlation_id)
     select id, 0, 'zero', 'c0000000-0000-0000-0000-000000000001', 'director', gen_random_uuid()
       from public.products limit 1 $$,
  '23514',
  null,
  'a price of zero is refused: free is not a price, it is a mistake');

select throws_ok(
  $$ insert into public.product_prices (product_id, price_tzs, reason, set_by, set_by_role, correlation_id)
     select id, 12000, '  ', 'c0000000-0000-0000-0000-000000000001', 'director', gen_random_uuid()
       from public.products limit 1 $$,
  '23514',
  null,
  'a price entry without a reason is refused (product.md §4.4)');

-- ---------------------------------------------------------------------------
-- Only a Director may write. This is the database refusing, not a hidden button.
-- ---------------------------------------------------------------------------
select tests.acting_as('c0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select throws_ok(
  $$ select api.admin_add_product('Manager Product', null, 'piece', gen_random_uuid()::text) $$,
  '42501',
  null,
  'a Manager cannot add a product');

select throws_ok(
  $$ select api.admin_set_product_price(
       (select id from public.products where name = 'Sand'), 5000, 'trying it on',
       gen_random_uuid()::text) $$,
  '42501',
  null,
  'a Manager cannot set a selling price — Directors only (product.md §4)');

select tests.acting_as('c0000000-0000-0000-0000-000000000003'::uuid);   -- Sales Rep

select throws_ok(
  $$ select api.admin_set_product_price(
       (select id from public.products where name = 'Sand'), 5000, 'trying it on',
       gen_random_uuid()::text) $$,
  '42501',
  null,
  'a Sales Representative cannot set a selling price either');

select is((select count(*)::int from public.product_prices), 0,
  'not one refused attempt left a price behind');

-- ---------------------------------------------------------------------------
-- A Director sets the first price
-- ---------------------------------------------------------------------------
select tests.acting_as('c0000000-0000-0000-0000-000000000001'::uuid);   -- Director

select is(
  (api.admin_set_product_price(
     (select id from public.products where name = 'Sand'), 4500, 'Opening price for the season',
     'catalogue-price-key-1') ->> 'reason'),
  'set',
  'a Director sets the first price for a product');

select is(
  (select price_tzs::int from public.product_prices
    where product_id = (select id from public.products where name = 'Sand')),
  4500,
  'the price is stored exactly as approved, in whole shillings');

select is(
  (select previous_price_tzs from public.product_prices
    where product_id = (select id from public.products where name = 'Sand')),
  null,
  'the first price records no previous price — that is different from "it used to be zero"');

select is(
  (select set_by::text from public.product_prices
    where product_id = (select id from public.products where name = 'Sand')),
  'c0000000-0000-0000-0000-000000000001',
  'the acting Director is recorded from the session, not from an argument (product.md §4.4)');

-- ---------------------------------------------------------------------------
-- Changing it records what it was
-- ---------------------------------------------------------------------------
select is(
  (api.admin_set_product_price(
     (select id from public.products where name = 'Sand'), 5200, 'Cement supplier raised prices',
     'catalogue-price-key-2') ->> 'reason'),
  'changed',
  'a Director changes an existing price');

select is(
  (select previous_price_tzs::int from public.product_prices
    where product_id = (select id from public.products where name = 'Sand')
      and price_tzs = 5200),
  4500,
  'the change records the price it replaced');

select is(
  (select count(*)::int from public.product_prices
    where product_id = (select id from public.products where name = 'Sand')),
  2,
  'both prices survive: history is appended to, never overwritten');

select is(
  (select price_tzs::int from public.product_current_prices
    where product_id = (select id from public.products where name = 'Sand')),
  5200,
  'the current-price view returns the newest entry');

select is(
  (api.admin_set_product_price(
     (select id from public.products where name = 'Sand'), 5200, 'same again',
     'catalogue-price-key-3') ->> 'reason'),
  'price_unchanged',
  're-approving the same figure is refused: it is not a decision to record');

-- ---------------------------------------------------------------------------
-- History cannot be rewritten. By anyone.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ update public.product_prices set price_tzs = 1 $$,
  '23001',
  null,
  'a price entry cannot be updated, even by the owner of the table');

select throws_ok(
  $$ delete from public.product_prices $$,
  '23001',
  null,
  'a price entry cannot be deleted, even by the owner of the table');

select is((select count(*)::int from public.product_prices), 2,
  'the refused rewrite left the history exactly as it was');

-- ---------------------------------------------------------------------------
-- Idempotency: the same key is the same operation, not a second one
-- ---------------------------------------------------------------------------
-- The SAME request under the same key. Anything else is a conflict, which the section further
-- down proves one argument at a time.
select is(
  (api.admin_set_product_price(
     (select id from public.products where name = 'Sand'), 5200, 'Cement supplier raised prices',
     'catalogue-price-key-2') ->> 'reason'),
  'replayed',
  'a replayed key returns the original entry rather than writing a second one');

select is(
  (select count(*)::int from public.product_prices
    where product_id = (select id from public.products where name = 'Sand')),
  2,
  'and the replay wrote nothing: still exactly two entries');

-- ---------------------------------------------------------------------------
-- Adding a product, attributed and audited
-- ---------------------------------------------------------------------------
select is(
  (api.admin_add_product('Test Beam', 'Grade A', 'piece', 'catalogue-add-key-1') ->> 'reason'),
  'added',
  'a Director adds a product');

select is(
  (select created_by::text from public.products where name = 'Test Beam'),
  'c0000000-0000-0000-0000-000000000001',
  'the product records the Director who added it');

select is(
  (select count(*)::int from public.product_prices pp
     join public.products p on p.id = pp.product_id where p.name = 'Test Beam'),
  0,
  'a newly added product has NO price — the interface says so rather than showing a zero');

select is(
  (api.admin_add_product('test beam', 'grade a', 'piece', 'catalogue-add-key-2') ->> 'reason'),
  'product_exists',
  'the same identity in different capitalisation is refused with a sentence, not a constraint error');

select is(
  (api.admin_add_product('Test Beam', 'Grade A', 'piece', 'catalogue-add-key-1') ->> 'reason'),
  'replayed',
  'a replayed add returns the product the first call created');

select is((select count(*)::int from public.products where name ilike 'test beam'), 1,
  'and only one Test Beam exists, however many times it was asked for');

-- ---------------------------------------------------------------------------
-- Audit attribution (product.md §16)
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from public.audit_events
    where action in ('product_added', 'product_price_set', 'product_price_changed')
      and actor_id = 'c0000000-0000-0000-0000-000000000001'
      and actor_role = 'director'
      and not is_system_actor),
  3,
  'adding a product and setting and changing a price are each audited to the acting Director');

select is(
  (select before_state ->> 'price_tzs' from public.audit_events
    where action = 'product_price_changed'),
  '4500',
  'the audit entry for a price change carries the price it replaced');

-- ---------------------------------------------------------------------------
-- A key is bound to the COMMAND, not just to itself
--
-- Found in review: the same key presented for a different product answered `ok: replayed` and
-- handed back the FIRST product's price entry, while the second product stayed unpriced. A success
-- reported for a change that never happened is the worst shape a bug can take on this screen.
-- ---------------------------------------------------------------------------
select is(
  (api.admin_set_product_price(
     (select id from public.products where name = 'Aggregate'), 9999, 'Opening price for the season',
     'catalogue-price-key-2') ->> 'reason'),
  'idempotency_key_conflict',
  'the same key presented for a DIFFERENT product is a conflict, never a replay');

select is(
  (select count(*)::int from public.product_prices pp
     join public.products p on p.id = pp.product_id where p.name = 'Aggregate'),
  0,
  'and the product it named was not priced — the refusal changed nothing');

select is(
  (api.admin_set_product_price(
     (select id from public.products where name = 'Sand'), 6100, 'Cement supplier raised prices',
     'catalogue-price-key-2') ->> 'reason'),
  'idempotency_key_conflict',
  'the same key with a different PRICE is a conflict');

select is(
  (api.admin_set_product_price(
     (select id from public.products where name = 'Sand'), 5200, 'a different reason entirely',
     'catalogue-price-key-2') ->> 'reason'),
  'idempotency_key_conflict',
  'the same key with a different REASON is a conflict — the reason is part of the record');

select is(
  (select count(*)::int from public.product_prices
    where product_id = (select id from public.products where name = 'Sand')),
  2,
  'none of those refusals appended anything to permanent history');

-- The other Director now presents a key the first one claimed.
select tests.acting_as('c0000000-0000-0000-0000-000000000004'::uuid);

select is(
  (api.admin_set_product_price(
     (select id from public.products where name = 'Sand'), 5200, 'Cement supplier raised prices',
     'catalogue-price-key-2') ->> 'reason'),
  'idempotency_key_conflict',
  'a key claimed by one Director is not replayable by the other, even for the identical request');

select tests.acting_as('c0000000-0000-0000-0000-000000000001'::uuid);

select is(
  (api.admin_set_product_price(
     (select id from public.products where name = 'Sand'), 5200, 'Cement supplier raised prices',
     'catalogue-price-key-2') ->> 'reason'),
  'replayed',
  'the SAME Director asking the SAME thing under that key still replays, as it should');

select is(
  (api.admin_add_product('Something Else', 'Grade B', 'sheet', 'catalogue-add-key-1') ->> 'reason'),
  'idempotency_key_conflict',
  'an add key presented for different product details is a conflict');

select is((select count(*)::int from public.products where name = 'Something Else'), 0,
  'and no product was created by that refusal');

-- ---------------------------------------------------------------------------
-- Identity really is case- AND whitespace-insensitive
--
-- Also found in review: `btrim` strips the ends and leaves the middle, so "Review Spacing" and
-- "Review  Spacing" were accepted as two products. On a phone keyboard a doubled space is not an
-- unusual thing to type, and the result is two catalogue entries for one thing — each separately
-- priced, separately counted, separately sold.
-- ---------------------------------------------------------------------------
select is(
  (api.admin_add_product('Review Spacing', 'Grade A', 'piece', 'catalogue-space-1') ->> 'reason'),
  'added',
  'a product with a single internal space is added');

select is(
  (api.admin_add_product('Review  Spacing', 'Grade  A', 'piece', 'catalogue-space-2') ->> 'reason'),
  'product_exists',
  'the same product typed with a DOUBLED internal space is refused as a duplicate');

select is(
  (api.admin_add_product('  review   spacing  ', E'	grade a ', 'piece', 'catalogue-space-3')
     ->> 'reason'),
  'product_exists',
  'and so is any mixture of case, padding and tabs');

select is(
  (select count(*)::int from public.products where name ilike '%spacing%'),
  1,
  'exactly one Review Spacing exists, however it was typed');

select is(
  (select name || ' / ' || specification from public.products where name ilike '%spacing%'),
  'Review Spacing / Grade A',
  'and it is STORED in the canonical display form — collapsed spacing, original capitalisation');

select * from finish();
rollback;
