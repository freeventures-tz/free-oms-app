-- v0.0.5 · Migration chain, step 3: a POPULATED v0.0.4 database, built by the real commands
--
-- Runs against a database reset to `20260822001000_dispatch_api` — the last released migration, and
-- exactly the shape production is in before this release applies. Everything below then happens
-- through the released `api` commands under real sessions, so what is captured afterwards is what
-- the product actually produces: real numbering, real attribution, real approval records and a real
-- ledger.
--
-- WHY A POPULATED FIXTURE AT ALL. The Part C harness starts at Part B and proves the catalogue
-- survives. That is a genuine proof and it is not this one: production today holds customers,
-- orders, invoices, reservations, money, credit and dispatches, and no existing check has ever
-- watched those cross a migration. A migration that dropped a constraint the sales code depends on,
-- or renumbered a counter, would pass every gate this repository had before this file.
--
-- The snapshot lives in its own schema, not in `public`: a table in `public` without RLS is exactly
-- what the database advisors refuse, and a test fixture must not fail an unrelated check.

begin;

create schema if not exists migration_chain;

comment on schema migration_chain is
  'Pre-migration snapshot for the migration-chain harness. Created by a test, destroyed by the '
  'full `supabase db reset` that ends the run. Never part of a real database.';

-- Asserted rather than assumed: a partial reset that stopped at the wrong migration would make
-- every comparison downstream meaningless, and it would look like a passing test.
do $$
begin
  if to_regclass('public.production_batches') is not null then
    raise exception
      'the database is already past migration 33: public.production_batches exists. Reset to '
      'version 20260822001000 before running this fixture, or it proves nothing';
  end if;

  if to_regclass('public.dispatches') is null then
    raise exception
      'the database is not at the v0.0.4 boundary: public.dispatches is missing. Reset to version '
      '20260822001000 before running this fixture';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Four real people, one per role, because every command below derives its actor from a session
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
values
  ('c0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'chain-director@test.local',
   extensions.crypt('x', extensions.gen_salt('bf')), now(), now()),
  ('c0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'chain-manager@test.local',
   extensions.crypt('x', extensions.gen_salt('bf')), now(), now()),
  ('c0000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'chain-cashier@test.local',
   extensions.crypt('x', extensions.gen_salt('bf')), now(), now()),
  ('c0000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'chain-rep@test.local',
   extensions.crypt('x', extensions.gen_salt('bf')), now(), now());

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('c0000000-0000-0000-0000-000000000001', 'Chain Director', '+255700000091', true, false),
  ('c0000000-0000-0000-0000-000000000002', 'Chain Manager',  '+255700000092', true, false),
  ('c0000000-0000-0000-0000-000000000003', 'Chain Cashier',  '+255700000093', true, false),
  ('c0000000-0000-0000-0000-000000000004', 'Chain Rep',      '+255700000094', true, false);

insert into public.user_roles (user_id, role) values
  ('c0000000-0000-0000-0000-000000000001', 'director'),
  ('c0000000-0000-0000-0000-000000000002', 'manager'),
  ('c0000000-0000-0000-0000-000000000003', 'cashier'),
  ('c0000000-0000-0000-0000-000000000004', 'sales_rep');

create or replace function migration_chain.acting_as(p_id uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_id::text, 'role', 'authenticated')::text, true);
$$;

create or replace function migration_chain.product(p_name text) returns uuid language sql stable as $$
  select id from public.products where name = p_name limit 1;
$$;

/* Every command below is checked, so a fixture that half-worked fails here rather than producing a
   thin snapshot that compares equal to itself afterwards. */
create or replace function migration_chain.expect(p_result jsonb, p_reason text, p_what text)
returns jsonb language plpgsql as $$
begin
  if coalesce(p_result ->> 'reason', '') <> p_reason then
    raise exception '% expected "%", got %', p_what, p_reason, p_result;
  end if;
  return p_result;
end
$$;

-- ---------------------------------------------------------------------------
-- The Director: a selling price, a supplier, a storekeeper and the opening yard
-- ---------------------------------------------------------------------------
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000001');

select migration_chain.expect(
  api.admin_set_product_price(
    migration_chain.product('Tofali 6"'), 900, 'opening price before the v0.0.5 upgrade',
    'chain-price-1'),
  'set', 'setting the brick price');

create table migration_chain.supplier as
select (migration_chain.expect(
          api.admin_add_supplier('Chain Hardware', 'chain-supplier-1'),
          'added', 'adding a supplier') -> 'supplier' ->> 'id')::uuid as id;

create table migration_chain.storekeeper as
select (migration_chain.expect(
          api.admin_add_storekeeper('Chain Storekeeper', '+255700000095', current_date, null,
                                    'chain-storekeeper-1'),
          'added', 'registering a storekeeper') -> 'storekeeper' ->> 'id')::uuid as id;

select migration_chain.expect(
  api.admin_record_opening_stock(
    migration_chain.product('Tofali 6"'), 'yard', 120, 'opening count', 'chain-open-1'),
  'recorded', 'the opening bricks');

select migration_chain.expect(
  api.admin_record_opening_stock(
    migration_chain.product('Dangote Cement 42R'), 'yard', 40, 'opening count', 'chain-open-2'),
  'recorded', 'the opening cement');

select migration_chain.expect(
  api.admin_record_opening_stock(
    migration_chain.product('Sand'), 'yard', 80, 'opening count', 'chain-open-3'),
  'recorded', 'the opening sand');

-- ---------------------------------------------------------------------------
-- The Manager: a supplier delivery, entered and approved, and an internal transfer
-- ---------------------------------------------------------------------------
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');

create table migration_chain.receipt as
select (migration_chain.expect(
          api.staff_enter_stock_receipt(
            (select id from migration_chain.supplier), 'store', current_date, 'DN-CHAIN-1',
            jsonb_build_array(jsonb_build_object(
              'product_id', migration_chain.product('Dangote Cement 42R'),
              'expected_quantity', 20, 'received_quantity', 20,
              'damaged_quantity', 0, 'damage_note', null)),
            'chain-receipt-1'),
          'entered', 'entering a delivery') -> 'receipt' ->> 'id')::uuid as id;

select migration_chain.expect(
  api.staff_approve_stock_receipt((select id from migration_chain.receipt), 'chain-receipt-approve'),
  'approved', 'approving the delivery');

create table migration_chain.transfer as
select (migration_chain.expect(
          api.staff_enter_stock_transfer(
            'store', 'yard', 'moving cement to the yard',
            jsonb_build_array(jsonb_build_object(
              'product_id', migration_chain.product('Dangote Cement 42R'), 'quantity', 5)),
            'chain-transfer-1'),
          'entered', 'entering a transfer') -> 'transfer' ->> 'id')::uuid as id;

select migration_chain.expect(
  api.staff_approve_stock_transfer((select id from migration_chain.transfer),
                                   'chain-transfer-approve'),
  'approved', 'approving the transfer');

-- ---------------------------------------------------------------------------
-- The Sales Representative: a customer, and two orders confirmed into two invoices
-- ---------------------------------------------------------------------------
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000004');

create table migration_chain.customer as
select (migration_chain.expect(
          api.staff_add_customer('Chain Builders', 'chain-customer-1'),
          'added', 'adding a customer') -> 'customer' ->> 'id')::uuid as id;

create table migration_chain.orders as
select 'settled'::text as label,
       (migration_chain.expect(
          api.staff_create_order(
            (select id from migration_chain.customer),
            jsonb_build_array(jsonb_build_object(
              'product_id', migration_chain.product('Tofali 6"'), 'quantity', 10)),
            'chain-order-1'),
          'created', 'creating the first order') -> 'order' ->> 'id')::uuid as id
union all
select 'credited'::text,
       (migration_chain.expect(
          api.staff_create_order(
            (select id from migration_chain.customer),
            jsonb_build_array(jsonb_build_object(
              'product_id', migration_chain.product('Tofali 6"'), 'quantity', 5)),
            'chain-order-2'),
          'created', 'creating the second order') -> 'order' ->> 'id')::uuid
union all
-- Left UNPAID on purpose. After the upgrade the Cashier settles it through the released command,
-- which is the only way to show that the v0.0.4 money path still works on a database the v0.0.5
-- migrations have already touched.
select 'unpaid'::text,
       (migration_chain.expect(
          api.staff_create_order(
            (select id from migration_chain.customer),
            jsonb_build_array(jsonb_build_object(
              'product_id', migration_chain.product('Tofali 6"'), 'quantity', 3)),
            'chain-order-3'),
          'created', 'creating the third order') -> 'order' ->> 'id')::uuid;

select migration_chain.expect(
  api.staff_confirm_order((select id from migration_chain.orders where label = 'settled'),
                          'chain-confirm-1'),
  'confirmed', 'confirming the first order');

select migration_chain.expect(
  api.staff_confirm_order((select id from migration_chain.orders where label = 'credited'),
                          'chain-confirm-2'),
  'confirmed', 'confirming the second order');

select migration_chain.expect(
  api.staff_confirm_order((select id from migration_chain.orders where label = 'unpaid'),
                          'chain-confirm-3'),
  'confirmed', 'confirming the third order');

create table migration_chain.invoices as
select o.label, i.id, i.total_tzs
  from migration_chain.orders o
  join public.invoices i on i.order_id = o.id;

-- ---------------------------------------------------------------------------
-- The Cashier: money on one invoice, and credit requested on the other
-- ---------------------------------------------------------------------------
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');

select migration_chain.expect(
  api.staff_record_payment(
    (select id from migration_chain.invoices where label = 'settled'),
    'cash',
    (select total_tzs from migration_chain.invoices where label = 'settled'),
    'chain-payment-1'),
  'recorded', 'paying the first invoice in full');

select migration_chain.expect(
  api.staff_record_payment(
    (select id from migration_chain.invoices where label = 'credited'),
    'mixx_by_yas',
    (select total_tzs / 2 from migration_chain.invoices where label = 'credited'),
    'chain-payment-2'),
  'recorded', 'paying half of the second invoice');

create table migration_chain.credit as
select (migration_chain.expect(
          api.staff_request_credit(
            (select id from migration_chain.invoices where label = 'credited'),
            (select total_tzs - total_tzs / 2 from migration_chain.invoices where label = 'credited'),
            'the customer settles at the end of the month',
            'chain-credit-1'),
          'requested', 'requesting credit') ->> 'credit_id')::uuid as id;

-- ---------------------------------------------------------------------------
-- The Manager approves the credit; the Cashier assigns a dispatch; the Manager releases it
-- ---------------------------------------------------------------------------
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');

select migration_chain.expect(
  api.staff_approve_credit((select id from migration_chain.credit), 'chain-credit-approve'),
  'approved', 'approving the credit');

select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');

-- §12.6 step 7: the Cashier confirms the invoice is settled, and only then may anything be
-- put on a storekeeper's list to hand over.
select migration_chain.expect(
  api.staff_approve_settlement(
    (select id from migration_chain.invoices where label = 'settled'),
    'chain-settlement-1'),
  'approved', 'confirming the invoice is settled');

create table migration_chain.dispatch as
select (migration_chain.expect(
          api.staff_assign_dispatch(
            (select id from migration_chain.invoices where label = 'settled'),
            (select id from migration_chain.storekeeper),
            'yard',
            (select jsonb_agg(jsonb_build_object('allocation_id', a.id,
                                                'quantity', a.quantity))
               from public.stock_allocations a
              where a.order_id = (select id from migration_chain.orders
                                   where label = 'settled')),
            'chain-dispatch-1'),
          'assigned', 'assigning a dispatch') -> 'dispatch' ->> 'id')::uuid as id;

select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');

select migration_chain.expect(
  api.staff_record_dispatch_note((select id from migration_chain.dispatch), 'DN-REL-CHAIN-1',
                                 'chain-dispatch-note'),
  'recorded', 'recording the physical dispatch note');

select migration_chain.expect(
  api.staff_confirm_release((select id from migration_chain.dispatch), 'chain-dispatch-release'),
  'released', 'confirming the signed release');

-- ---------------------------------------------------------------------------
-- The released surface itself, photographed
--
-- Filenames prove which migrations ran; they do not prove that a command still behaves the way it
-- did. So the api schema's definitions, owners and grants are captured here and compared after the
-- upgrade, along with every table privilege and every policy a client is judged by.
-- ---------------------------------------------------------------------------
create table migration_chain.api_before as
select p.proname                                     as name,
       pg_get_function_identity_arguments(p.oid)     as args,
       md5(pg_get_functiondef(p.oid))                as definition,
       pg_catalog.pg_get_userbyid(p.proowner)        as owner,
       coalesce(array_to_string(p.proacl::text[], ','), '') as acl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'api';

create table migration_chain.grants_before as
select table_name, grantee, privilege_type
  from information_schema.table_privileges
 where table_schema = 'public'
   and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC');

create table migration_chain.policies_before as
select tablename, policyname, cmd, roles::text as roles,
       coalesce(qual, '') as using_clause, coalesce(with_check, '') as check_clause
  from pg_policies
 where schemaname = 'public';

-- ---------------------------------------------------------------------------
-- What the fixture must actually contain, asserted before anything is compared
--
-- A snapshot of an empty database compares equal to itself perfectly, and proves nothing about a
-- migration. These are the facts the upgrade is being asked to preserve.
-- ---------------------------------------------------------------------------
do $$
declare
  v_orders      integer;
  v_invoices    integer;
  v_payments    integer;
  v_allocations integer;
  v_dispatches  integer;
  v_ledger      integer;
  v_counters    integer;
begin
  select count(*) into v_orders      from public.orders;
  select count(*) into v_invoices    from public.invoices;
  select count(*) into v_payments    from public.payments;
  select count(*) into v_allocations from public.stock_allocations;
  select count(*) into v_dispatches  from public.dispatches;
  select count(*) into v_ledger      from public.inventory_ledger;
  select count(*) into v_counters    from public.document_sequences;

  if v_orders < 3 or v_invoices < 3 or v_payments < 2 or v_allocations < 3
     or v_dispatches < 1 or v_ledger < 5 or v_counters < 1 then
    raise exception
      'the v0.0.4 fixture is too thin to prove anything: % orders, % invoices, % payments, '
      '% allocations, % dispatches, % ledger rows, % counters',
      v_orders, v_invoices, v_payments, v_allocations, v_dispatches, v_ledger, v_counters;
  end if;

  if (select count(*) from public.credit_authorisations) < 1 then
    raise exception 'the v0.0.4 fixture recorded no credit, and credit is one of the things the '
                    'upgrade must preserve';
  end if;
end
$$;

commit;

\echo 'migration-chain: built a populated v0.0.4 database through the released commands'
