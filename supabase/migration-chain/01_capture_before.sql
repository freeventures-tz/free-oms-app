-- Stage 10 Part C · Migration chain, step 1: photograph the database as Part B left it
--
-- Runs against a database reset to migration 21 (`20260814000300_catalogue_seed`), BEFORE Part C's
-- migration 22 exists. Everything it captures is compared again in 02_assert_after.sql once
-- migration 22 has applied through the ordinary migration mechanism.
--
-- Why this exists at all. Migration 22 carries its own snapshot-and-abort checks, and those protect
-- the real hosted apply — but they are the migration marking its own homework. pgTAP cannot check
-- it either: pgTAP runs after every migration has already applied, so there is no before-state left
-- to compare against. This harness is the independent witness, and it runs against a genuine Part B
-- database with a genuine, non-empty price history.
--
-- The snapshot lives in its own schema, not in `public`. A table in `public` without RLS is exactly
-- what the database advisors refuse, and a test fixture must not be able to fail an unrelated check.
--
-- This file makes the database ONLY. It writes no price, because the harness runs it twice: once
-- with a real price row written on top of it by 01b_write_price.sql, and once with none at all.
-- Production currently holds zero prices, so the empty case is the one the release gate will
-- actually meet, and a gate proved only against a non-empty table is a gate proved against the
-- wrong database.

begin;

create schema if not exists migration_chain;

comment on schema migration_chain is
  'Pre-migration snapshot for the Part C migration-chain harness. Created by a test, destroyed by '
  'the full `supabase db reset` that ends the run. Never part of a real database.';

-- ---------------------------------------------------------------------------
-- A Director, so the price below is written by the REAL command
--
-- The row could have been inserted directly as the table owner, and it would have been a fiction:
-- `product_prices` has no INSERT grant for anybody but the definer owner, and `set_by` is a
-- foreign key to a real profile. Creating the actor and going through `api.admin_set_product_price`
-- produces the row the product actually produces, with real attribution and a real audit event
-- behind it.
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
values (
  'e0000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated',
  'migration-chain-director@test.local',
  extensions.crypt('x', extensions.gen_salt('bf')),
  now(), now()
);

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password)
values ('e0000000-0000-0000-0000-000000000001', 'Migration Chain Director', '+255700000071', true, false);

insert into public.user_roles (user_id, role)
values ('e0000000-0000-0000-0000-000000000001', 'director');

-- ---------------------------------------------------------------------------
-- The snapshot
-- ---------------------------------------------------------------------------
create table migration_chain.products_before as
  select id, name, specification, unit_code from public.products;

create table migration_chain.units_before as
  select code, sort_order from public.units;

-- Asserted here rather than assumed: if the partial reset stopped at the wrong migration, every
-- comparison downstream would be meaningless, and it would look like a passing test.
do $$
declare
  v_products integer;
  v_units    integer;
  v_has_content boolean;
begin
  select count(*) into v_products from migration_chain.products_before;
  select count(*) into v_units    from migration_chain.units_before;

  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'products' and column_name = 'unit_content'
  ) into v_has_content;

  if v_has_content then
    raise exception
      'the database is already past migration 22: products.unit_content exists. Reset to version '
      '20260814000300 before running this harness, or it proves nothing';
  end if;

  if v_products <> 21 then
    raise exception 'expected the 21 seeded Part B products before migration 22, found %', v_products;
  end if;

  if v_units <> 6 then
    raise exception 'expected the 6 Part B units before migration 22, found %', v_units;
  end if;
end
$$;

commit;

\echo 'migration-chain: captured 21 products and 6 units before migration 22'
