-- v0.0.6 · Migration chain, step 11: a POPULATED v0.0.5 database, built by the real commands
--
-- Runs against a database reset to `20260822001200_production_api` — the 34th and last released
-- migration, and exactly the shape production is in before v0.0.6 applies. Everything below then
-- happens through the released `api` commands under real sessions, so what is captured afterwards
-- is what the product actually produces: real numbering, real attribution, real approval records,
-- a real ledger and — new at this boundary — real brick production.
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
  -- The v0.0.6 boundary, not the v0.0.4 one. Brick production MUST already be here — this fixture
  -- exists to carry it across the upgrade — and the issue #7 objects must NOT be, or the
  -- before-state would already contain what the comparison is meant to detect the arrival of.
  if to_regclass('public.production_batches') is null then
    raise exception
      'the database is not at the v0.0.5 boundary: public.production_batches is missing. Reset '
      'to version 20260822001200 before running this fixture';
  end if;

  -- The ONE exception is the v0.1.0 phase added by issue #51, which builds this same ground on the
  -- released v0.1.0 database and says so first by writing `migration_chain.boundary` in
  -- `14_mark_v010_boundary.sql` — after asserting that the database really is at v0.1.0. Without
  -- that marker the guard below is exactly what it was.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'private' and p.proname = 'claim_unpromised_stock')
     and to_regclass('migration_chain.boundary') is null then
    raise exception
      'the database is already past migration 35: private.claim_unpromised_stock exists. Reset '
      'to version 20260822001200 before running this fixture, or it proves nothing';
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
          'created', 'creating the third order') -> 'order' ->> 'id')::uuid
union all
-- PAID AND THEN REVERSED. §4.1 and AC-21 make a reversal a Director's decision written as a NEW
-- negative row pointing at the one it undoes, and `payments.reverses_id` is the whole of that
-- linkage. Without a real reversal in this fixture, the preservation query's reversal column is
-- never populated and the gate is proved against a case that does not occur.
select 'reversed'::text,
       (migration_chain.expect(
          api.staff_create_order(
            (select id from migration_chain.customer),
            jsonb_build_array(jsonb_build_object(
              'product_id', migration_chain.product('Tofali 6"'), 'quantity', 4)),
            'chain-order-4'),
          'created', 'creating the fourth order') -> 'order' ->> 'id')::uuid;

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

select migration_chain.expect(
  api.staff_confirm_order((select id from migration_chain.orders where label = 'reversed'),
                          'chain-confirm-4'),
  'confirmed', 'confirming the fourth order');

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

-- Paid in full, and asked back. The request reverses nothing by itself: §4.1 puts a Director
-- between a Cashier and money leaving the till, and that decision is recorded below.
select migration_chain.expect(
  api.staff_record_payment(
    (select id from migration_chain.invoices where label = 'reversed'),
    'cash',
    (select total_tzs from migration_chain.invoices where label = 'reversed'),
    'chain-payment-3'),
  'recorded', 'paying the fourth invoice in full');

create table migration_chain.reversed_payment as
select p.id
  from public.payments p
 where p.invoice_id = (select id from migration_chain.invoices where label = 'reversed')
   and p.reverses_id is null;

select migration_chain.expect(
  api.staff_request_payment_reversal(
    (select id from migration_chain.reversed_payment),
    'the customer paid twice and the second one is being returned',
    'chain-reversal-request'),
  'requested', 'asking a Director to reverse a payment');

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
-- The Director: money going back out, which is the only decision a Director makes with money
--
-- Written as a NEW negative payment carrying `reverses_id`; the original stays exactly as it was
-- recorded, because what was counted at the till must still read the same afterwards (§4.1, AC-21).
-- ---------------------------------------------------------------------------
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000001');

select migration_chain.expect(
  api.admin_approve_payment_reversal(
    (select id from migration_chain.reversed_payment), 'chain-reversal-approve'),
  'reversed', 'the Director approving the reversal');

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

  if v_orders < 4 or v_invoices < 4 or v_payments < 4 or v_allocations < 4
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

  -- A REAL REVERSAL, LINKED. The preservation query compares `payments.reverses_id`, and a column
  -- that is null in every row is a column no comparison has ever exercised.
  if not exists (
    select 1 from public.payments p
     where p.reverses_id is not null and p.amount_tzs < 0
       and exists (select 1 from public.payments o where o.id = p.reverses_id)
  ) then
    raise exception 'the v0.0.4 fixture has no linked payment reversal, so the reversal linkage '
                    'this release must preserve is never compared';
  end if;

  -- …decided by a Director through the shared approval record, rather than written by hand.
  if not exists (
    select 1 from public.approval_requests r
     where r.approval_type = 'payment_reversal' and r.status = 'approved'
       and r.approved_role = 'director'
  ) then
    raise exception 'the payment reversal in the fixture was not approved by a Director, so it is '
                    'not the record the released command produces';
  end if;

  -- SETTLEMENT ATTRIBUTION. §12.6 step 7 is what lets goods be handed over, and the invoice digest
  -- compares who confirmed it — which proves nothing on a database where nobody has.
  if not exists (select 1 from public.invoices i where i.settlement_approved_by is not null) then
    raise exception 'no invoice in the fixture carries a settlement approver, so the attribution '
                    'the upgrade must preserve is never compared';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- Brick production, which is what v0.0.5 added and what this boundary must carry
--
-- A batch entered by the Manager, approved so the yard is really consumed, cured, and inspected
-- so some bricks became sellable and some did not (§11.1, §11.4, AC-38, AC-44, AC-45). Every one
-- of those is a row the two v0.0.6 migrations must leave exactly as they found it, and migration
-- 36 re-issues the very commands that wrote them.
-- ---------------------------------------------------------------------------
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');   -- Manager

-- Materials to consume. Opening stock is a Director's (§4.1), so the Manager's own receipt is the
-- honest route -- and it is the route the yard really uses.
do $$
declare
  v_supplier uuid;
  v_receipt  jsonb;
  v_batch    jsonb;
  v_inputs   jsonb;
begin
  select id into v_supplier from public.suppliers order by created_at limit 1;

  v_receipt := api.staff_enter_stock_receipt(
    v_supplier, 'yard', current_date, 'CHAIN-PROD-1',
    (select jsonb_agg(jsonb_build_object(
              'product_id', r.product_id,
              'expected_quantity', 200,
              'received_quantity', 200,
              'damaged_quantity', 0))
       from public.production_recipe_inputs r),
    'chain-prod-receipt');

  if not (v_receipt ->> 'ok')::boolean then
    raise exception 'the production fixture could not receive materials: %', v_receipt;
  end if;

  if not (api.staff_approve_stock_receipt(
            ((v_receipt -> 'receipt') ->> 'id')::uuid,
            'chain-prod-receipt-approve') ->> 'ok')::boolean then
    raise exception 'the production fixture could not approve its own delivery';
  end if;

  -- The recipe in full, because AC-39 requires every input to be accounted for. The standard
  -- quantity is used, so the batch is an ordinary one rather than a variance case.
  select jsonb_agg(jsonb_build_object('product_id', r.product_id,
                                     'actual_quantity', r.standard_quantity))
    into v_inputs
    from public.production_recipe_inputs r;

  v_batch := api.staff_enter_production_batch(
    'yard', now() - interval '5 days', v_inputs,
    jsonb_build_array(jsonb_build_object(
      'product_id', (select id from public.products where name = 'Tofali 6"' limit 1),
      'quantity_moulded', 22, 'rejected_quantity', 2, 'reject_reason', 'broken')),
    null, 'chain-batch-1');

  if not (v_batch ->> 'ok')::boolean then
    raise exception 'the production fixture could not enter a batch: %', v_batch;
  end if;

  -- Approval is the moment the yard is consumed (§11.1, AC-38), so the ledger rows this writes
  -- are part of what the upgrade must preserve.
  if not (api.staff_approve_production_batch(
            ((v_batch -> 'batch') ->> 'id')::uuid,
            'chain-batch-1-approve') ->> 'ok')::boolean then
    raise exception 'the production fixture could not approve its batch';
  end if;
end
$$;

-- §11.4 gives curing 72 hours and this fixture cannot wait. The moulding time was set five days
-- back above; the lot's clock is moved with it so the inspection below is a real one rather than
-- a refusal, and the elapsed-time rule is left exactly as it is.
update public.production_lots
   set curing_started_at = now() - interval '4 days';

do $$
declare v_lot uuid;
begin
  select id into v_lot from public.production_lots order by id limit 1;

  -- Some accepted, some rejected: AC-45 makes only the accepted quantity sellable, and a lot where
  -- everything passed would never compare the rejection columns at all.
  if not (api.staff_inspect_curing_lot(v_lot, 18, 2, 'cracked', 'chain-inspect-1')
          ->> 'ok')::boolean then
    raise exception 'the production fixture could not inspect its cured lot';
  end if;
end
$$;

-- Asserted rather than assumed, for the reason every other guard in this file exists: a fixture
-- that silently built nothing would let the comparison downstream pass while proving nothing.
do $$
begin
  if not exists (select 1 from public.production_batches where status = 'approved') then
    raise exception 'the fixture has no approved batch, so the consumption v0.0.6 changes is '
                    'never carried across the upgrade';
  end if;

  if not exists (select 1 from public.production_lots where inspected_at is not null
                                                       and accepted_quantity > 0) then
    raise exception 'the fixture has no inspected lot, so curing and inspection are never '
                    'compared across the upgrade';
  end if;

  if not exists (select 1 from public.inventory_ledger where movement_kind = 'production_input') then
    raise exception 'the fixture consumed nothing, so the ledger rows the batch wrote are never '
                    'compared';
  end if;

  -- The replay ledger is the other thing migration 36 could break, and an empty one would compare
  -- equal to nothing.
  if (select count(*) from public.idempotency_keys) = 0 then
    raise exception 'the fixture recorded no idempotency keys, so a replay that stopped being '
                    'recognised would not be detected';
  end if;
end
$$;

commit;

\echo 'migration-chain: built a populated v0.0.5 database through the released commands'
