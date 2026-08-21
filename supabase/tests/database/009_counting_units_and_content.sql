-- Stage 10 Part C · Counting units, product content, and the migration of the existing catalogue
--
-- The claim under test is one sentence: a product is counted in ONE reusable counting unit, and may
-- separately record what one counted unit CONTAINS, which is descriptive and is never counted
-- (product.md §6).
--
-- Part B shipped three units that combined the two — `piece_12ft`, `bag_50kg`, `bucket_20l`. A
-- movement of 40 against `bag_50kg` reads as 40 bags or as 2 000 kg depending on who is looking,
-- and the receiving ledger that Stage 10 builds next cannot be rewritten once it holds rows. So the
-- separation happens here, before there is anything to rewrite.
--
-- What this file CANNOT prove, and where it is proved instead: that the migration preserved every
-- existing product UUID. pgTAP runs after every migration has already applied, so there is no
-- before-state left to compare against. The migration itself snapshots the ids it is about to touch
-- and refuses to commit if any of them changed — which runs on the hosted database too, where it
-- actually matters.
create extension if not exists pgtap with schema extensions;

begin;
select plan(46);

create schema if not exists tests;

create or replace function tests.mk_user(p_id uuid) returns void language plpgsql as $$
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          created_at, updated_at)
  values (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          p_id::text || '@test.local', extensions.crypt('x', extensions.gen_salt('bf')),
          now(), now());
end $$;

create or replace function tests.acting_as(p_id uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_id::text, 'role', 'authenticated')::text, true);
$$;

select tests.mk_user('d0000000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('d0000000-0000-0000-0000-000000000002'::uuid);  -- Manager
select tests.mk_user('d0000000-0000-0000-0000-000000000003'::uuid);  -- Sales Rep
select tests.mk_user('d0000000-0000-0000-0000-000000000004'::uuid);  -- Second Director

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('d0000000-0000-0000-0000-000000000001', 'Unit Director',  '+255700000081', true, false),
  ('d0000000-0000-0000-0000-000000000002', 'Unit Manager',   '+255700000082', true, false),
  ('d0000000-0000-0000-0000-000000000003', 'Unit Rep',       '+255700000083', true, false),
  ('d0000000-0000-0000-0000-000000000004', 'Other Director', '+255700000084', true, false);

insert into public.user_roles (user_id, role) values
  ('d0000000-0000-0000-0000-000000000001', 'director'),
  ('d0000000-0000-0000-0000-000000000002', 'manager'),
  ('d0000000-0000-0000-0000-000000000003', 'sales_rep'),
  ('d0000000-0000-0000-0000-000000000004', 'director');

-- ---------------------------------------------------------------------------
-- The counting units themselves
-- ---------------------------------------------------------------------------
select bag_eq(
  $$ select code from public.units where is_active order by code $$,
  $$ values ('bag'), ('bar'), ('bucket'), ('piece'), ('sheet') $$,
  'the five generic counting units are the ones available, and they count nothing but themselves');

select bag_eq(
  $$ select code from public.units where not is_active order by code $$,
  $$ values ('bag_50kg'), ('bucket_20l'), ('piece_12ft') $$,
  'the package-specific Part B rows are kept for traceability and made unavailable');

select is(
  (select label_en || ' / ' || label_sw from public.units where code = 'bucket'),
  'bucket / ndoo',
  'a counting unit carries its own English and Swahili labels, read at runtime');

select is(
  (select count(*)::int from public.units where btrim(label_en) = '' or btrim(label_sw) = ''),
  0,
  'no unit carries a blank label in either language, including the retained legacy rows');

select is(
  (select count(*)::int from public.units where created_by is not null),
  0,
  'the seeded units are attributed to nobody, because nobody entered them');

-- ---------------------------------------------------------------------------
-- The existing catalogue, migrated in place
-- ---------------------------------------------------------------------------
select is((select count(*)::int from public.products), 21,
  'the migration moved the catalogue, it did not add to it or lose any of it');

select is(
  (select unit_code || ' / ' || unit_content from public.products
    where name = 'Dangote Cement 42R'),
  'bag / 50 kg',
  'cement is counted in bags, and 50 kg is what one bag holds');

select bag_eq(
  $$ select name, unit_code, unit_content from public.products
      where name in ('Sand', 'Aggregate') $$,
  $$ values ('Sand', 'bucket', '20 litres'), ('Aggregate', 'bucket', '20 litres') $$,
  'sand and aggregate are counted in buckets, and 20 litres is what one bucket holds');

select is(
  (select count(*)::int from public.products
    where name like 'Timber %' and unit_code = 'piece' and unit_content = '12 ft'),
  6,
  'every seeded timber product is counted in pieces, each 12 ft long');

select is(
  (select count(*)::int from public.products
    where name not like 'Timber %'
      and name not in ('Dangote Cement 42R', 'Sand', 'Aggregate')
      and unit_content is not null),
  0,
  'nothing else acquired a content it never had');

select is(
  (select count(*)::int from public.products p
     join public.units u on u.code = p.unit_code where not u.is_active),
  0,
  'not one product is left counted in a unit that mixes a count with a content');

select is(
  (select count(*)::int from public.product_prices pp
    where not exists (select 1 from public.products p where p.id = pp.product_id)),
  0,
  'every price row still points at a product that exists');

-- ---------------------------------------------------------------------------
-- Only a Director creates a counting unit, and only through the command
-- ---------------------------------------------------------------------------
select tests.acting_as('d0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select throws_ok(
  $$ select api.admin_add_unit('drum', 'ngoma', 'unit-key-manager') $$,
  '42501',
  null,
  'a Manager cannot create a counting unit');

select tests.acting_as('d0000000-0000-0000-0000-000000000003'::uuid);   -- Sales Rep

select throws_ok(
  $$ select api.admin_add_unit('drum', 'ngoma', 'unit-key-rep') $$,
  '42501',
  null,
  'neither can a Sales Representative');

-- Reaching around the command is refused by GRANT, which pgTAP cannot demonstrate by attempting it:
-- these statements run as the table OWNER, who is precisely the role a grant does not constrain.
-- What can be proved here is that the privilege does not exist. The refusal itself is proved over
-- real HTTP, as `authenticated`, in tests/integration/catalogue.test.ts.
select is(
  (select coalesce(string_agg(grantee || ':' || privilege_type, ', '
                              order by grantee || ':' || privilege_type), '')
     from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'units'
      and grantee in ('anon', 'authenticated', 'service_role', 'fv_definer_owner')),
  'authenticated:SELECT, fv_definer_owner:INSERT, fv_definer_owner:SELECT',
  'the whole privilege surface on units: staff read it, the definer owner adds one, and NOBODY '
  'holds UPDATE or DELETE — Part C provides no rename and no delete path');

select is(
  (select coalesce(string_agg(distinct cmd, ',' order by cmd), '')
     from pg_policies
    where schemaname = 'public' and tablename = 'units'
      and roles::text like '%authenticated%'),
  'SELECT',
  'and there is no write policy for a client to reach even if a grant appeared');

select is((select count(*)::int from public.units), 8,
  'not one refused attempt changed the set of units');

-- ---------------------------------------------------------------------------
-- A Director creates one
-- ---------------------------------------------------------------------------
select tests.acting_as('d0000000-0000-0000-0000-000000000001'::uuid);   -- Director

select is(
  (api.admin_add_unit('drum', 'ngoma', 'unit-key-1') ->> 'reason'),
  'added',
  'a Director creates a counting unit');

select is(
  (select label_sw from public.units where label_en = 'drum'),
  'ngoma',
  'both languages are stored on the row, because a unit created this morning cannot wait for a build');

select is(
  (select is_active from public.units where label_en = 'drum'),
  true,
  'a newly created unit is available immediately');

select is(
  (select created_by::text from public.units where label_en = 'drum'),
  'd0000000-0000-0000-0000-000000000001',
  'the acting Director is recorded from the session, not from an argument');

select isnt(
  (select id from public.units where label_en = 'drum'),
  null,
  'the server owns the identifier: the caller never supplied one');

select is(
  (select count(*)::int from public.audit_events
    where action = 'unit_added'
      and actor_id = 'd0000000-0000-0000-0000-000000000001'
      and actor_role = 'director'
      and not is_system_actor),
  1,
  'creating a counting unit is audited to the Director who did it');

-- ---------------------------------------------------------------------------
-- Blank and duplicate labels
-- ---------------------------------------------------------------------------
select is(
  (api.admin_add_unit('   ', 'ngoma', 'unit-key-blank-en') ->> 'reason'),
  'label_required',
  'a blank English label is refused');

select is(
  (api.admin_add_unit('drum', E'\t ', 'unit-key-blank-sw') ->> 'reason'),
  'label_required',
  'and so is a blank Swahili one: a unit with no Swahili name is unusable to half the yard');

select is(
  (api.admin_add_unit('  DRUM  ', 'kitu kingine', 'unit-key-dup-1') ->> 'reason'),
  'unit_exists',
  'the same label in different capitalisation and padding is the same unit');

select is(
  (api.admin_add_unit('dru  m', 'ngoma', 'unit-key-dup-2') ->> 'reason'),
  'unit_exists',
  'a duplicate SWAHILI label is refused too, so no two units read alike in either language');

select is((select count(*)::int from public.units where label_en ilike '%drum%'), 1,
  'exactly one drum exists, however it was typed');

-- The legacy rows are inactive, so their labels are free to be used again. This is deliberate:
-- uniqueness is among the units a Director can actually choose.
select is(
  (api.admin_add_unit('20-litre bucket', 'ndoo ya lita 20', 'unit-key-legacy') ->> 'reason'),
  'added',
  'a retired label may be reused, because uniqueness is about what is offered, not what was');

-- ---------------------------------------------------------------------------
-- Idempotency, on the same terms as every other command
-- ---------------------------------------------------------------------------
select is(
  (api.admin_add_unit('drum', 'ngoma', 'unit-key-1') ->> 'reason'),
  'replayed',
  'an exact retry replays the original result rather than creating a second unit');

select is((select count(*)::int from public.units where label_en = 'drum'), 1,
  'and the replay created nothing');

select is(
  (api.admin_add_unit('barrel', 'pipa', 'unit-key-1') ->> 'reason'),
  'idempotency_key_conflict',
  'the same key with different labels is a conflict, never a replay');

select is((select count(*)::int from public.units where label_en = 'barrel'), 0,
  'and the refusal created nothing');

select tests.acting_as('d0000000-0000-0000-0000-000000000004'::uuid);   -- the other Director

select is(
  (api.admin_add_unit('drum', 'ngoma', 'unit-key-1') ->> 'reason'),
  'idempotency_key_conflict',
  'a key claimed by one Director is not replayable by the other, even for the identical request');

select tests.acting_as('d0000000-0000-0000-0000-000000000001'::uuid);

-- ---------------------------------------------------------------------------
-- Content, and what it does to product identity
-- ---------------------------------------------------------------------------
select is(
  (api.admin_add_product('Test Cement', null, 'bag', 'content-key-1', '50 kg') ->> 'reason'),
  'added',
  'a Director records what one counted unit contains');

select is(
  (select unit_content from public.products where name = 'Test Cement'),
  '50 kg',
  'and it is stored as entered, in the canonical display form');

select is(
  (api.admin_add_product('Test Cement', null, 'bag', 'content-key-2', '25 kg') ->> 'reason'),
  'added',
  'the same name in a different size is a DIFFERENT product (product.md §6.2)');

select is((select count(*)::int from public.products where name = 'Test Cement'), 2,
  'so both exist, ready to be stocked and priced separately');

select is(
  (api.admin_add_product('test cement', null, 'bag', 'content-key-3', '  50   KG  ') ->> 'reason'),
  'product_exists',
  'the same content typed differently is the same product');

select is(
  (api.admin_add_product('Test Plank', null, 'piece', 'content-key-4', null) ->> 'reason'),
  'added',
  'content is optional: a product may simply have none');

select is(
  (api.admin_add_product('Test Plank', null, 'piece', 'content-key-5', '   ') ->> 'reason'),
  'product_exists',
  'blank content and no content are the same answer, not two identities');

select is(
  (select count(*)::int from public.products where name = 'Test Plank' and unit_content is null),
  1,
  'and the absence is stored as null rather than as an empty string');

-- ---------------------------------------------------------------------------
-- A new product cannot be counted in a retired unit
-- ---------------------------------------------------------------------------
select is(
  (api.admin_add_product('Test Legacy', null, 'bag_50kg', 'content-key-6', null) ->> 'reason'),
  'unknown_unit',
  'a package-specific unit is not offered to a new product, and is refused if asked for');

select is((select count(*)::int from public.products where name = 'Test Legacy'), 0,
  'and no product was created against it');

-- ---------------------------------------------------------------------------
-- The old four-argument call still resolves, because the deployed application uses it
-- ---------------------------------------------------------------------------
select is(
  (api.admin_add_product('Test No Content', 'Grade C', 'sheet', 'content-key-7') ->> 'reason'),
  'added',
  'omitting content entirely is a valid call: the parameter defaults, so a running deployment '
  'keeps working between the migration and its own release');

select is(
  (select unit_content from public.products where name = 'Test No Content'),
  null,
  'and the product it creates simply has no content');

select * from finish();
rollback;
