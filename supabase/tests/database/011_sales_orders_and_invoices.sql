-- Stage 11 · Orders, proformas, invoices, discounts and reservations
--
-- The claims under test, each traceable to product.md:
--
--   §12.1  A draft order produces a proforma automatically, and a proforma is NOT a bill: no debt,
--          no receivable, no inventory change.
--   §12.1  Revising a proforma issues a new version and overwrites nothing.
--   AC-8   Customer confirmation produces EXACTLY ONE final invoice — enforced by the schema, not
--          by the care of whoever writes the next command.
--   §12.2  Invoice numbers are FV-INV-YYYYMMDD-####, on the Tanzania business date, and unique.
--   AC-12  Final invoice values are immutable; only a cancellation may be recorded (AC-11).
--   §8.1   Available = physical − reserved − committed, and confirming moves NO physical stock.
--   §4     A Manager may approve up to 5%, and only above TZS 1,000,000. Anything else is a
--          Director's (AC-17, AC-18).
--   §12.4  The Cash Customer path creates no invoice, no unpaid balance and no reservation at
--          confirmation (AC-86, AC-87).
create extension if not exists pgtap with schema extensions;

begin;
select plan(94);

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

select tests.mk_user('a0000000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('a0000000-0000-0000-0000-000000000002'::uuid);  -- Manager
select tests.mk_user('a0000000-0000-0000-0000-000000000003'::uuid);  -- Cashier
select tests.mk_user('a0000000-0000-0000-0000-000000000004'::uuid);  -- Sales Representative
select tests.mk_user('a0000000-0000-0000-0000-000000000005'::uuid);  -- a SECOND Sales Rep
select tests.mk_user('a0000000-0000-0000-0000-000000000006'::uuid);  -- signed in, holding no role

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('a0000000-0000-0000-0000-000000000001', 'Sales Director', '+255700000101', true, false),
  ('a0000000-0000-0000-0000-000000000002', 'Sales Manager',  '+255700000102', true, false),
  ('a0000000-0000-0000-0000-000000000003', 'Sales Cashier',  '+255700000103', true, false),
  ('a0000000-0000-0000-0000-000000000004', 'The Rep',        '+255700000104', true, false),
  ('a0000000-0000-0000-0000-000000000005', 'The Other Rep',  '+255700000105', true, false),
  ('a0000000-0000-0000-0000-000000000006', 'No Role At All', '+255700000106', true, false);

insert into public.user_roles (user_id, role) values
  ('a0000000-0000-0000-0000-000000000001', 'director'),
  ('a0000000-0000-0000-0000-000000000002', 'manager'),
  ('a0000000-0000-0000-0000-000000000003', 'cashier'),
  ('a0000000-0000-0000-0000-000000000004', 'sales_rep'),
  ('a0000000-0000-0000-0000-000000000005', 'sales_rep');

create or replace function tests.product(p_name text) returns uuid language sql stable as $$
  select id from public.products where name = p_name limit 1;
$$;

create or replace function tests.order_by_no(p_no text) returns uuid language sql stable as $$
  select id from public.orders where order_no = p_no limit 1;
$$;

-- Prices and stock, so an order has something to sell. Both go through the real commands.
select tests.acting_as('a0000000-0000-0000-0000-000000000001'::uuid);   -- Director

select is(
  (api.admin_set_product_price(tests.product('Marine 18 mm'), 40000, 'opening price', 'p-key-1')
   ->> 'reason'),
  'set',
  'a Director prices a product, so there is something to sell it at');

select is(
  (api.admin_set_product_price(tests.product('Marine 12 mm'), 25000, 'opening price', 'p-key-2')
   ->> 'reason'),
  'set',
  'and a second one');

select is(
  (api.admin_record_opening_stock(tests.product('Marine 18 mm'), 'store', 100, null, 'os-key-1')
   ->> 'reason'),
  'recorded',
  'and puts a hundred of the first into the store');

-- ---------------------------------------------------------------------------
-- The Cash Customer, seeded and singular
-- ---------------------------------------------------------------------------
select is((select count(*)::int from public.customers where is_cash_customer), 1,
  'exactly one Cash Customer exists, seeded by migration (product.md §12.4)');

select is((select name from public.customers where is_cash_customer), 'Cash Customer',
  'and it is named so a Sales Representative can find it in one tap');

-- ---------------------------------------------------------------------------
-- Creating an order produces a proforma, and nothing else
-- ---------------------------------------------------------------------------
select tests.acting_as('a0000000-0000-0000-0000-000000000003'::uuid);   -- Cashier

select throws_ok(
  $$ select api.staff_add_customer('Should Not Exist', 'cust-key-cashier') $$,
  '42501', null,
  'a Cashier does not register customers -- they settle orders, they do not create them');

select tests.acting_as('a0000000-0000-0000-0000-000000000004'::uuid);   -- Sales Rep

select is(
  (api.staff_add_customer('Juma Builders', 'cust-key-1') ->> 'reason'),
  'added',
  'a Sales Representative registers a customer, because a walk-in cannot wait for a Director');

select is(
  (api.staff_add_customer('  juma   BUILDERS ', 'cust-key-dup') ->> 'reason'),
  'customer_exists',
  'the same name in different capitalisation and spacing is the same customer');

select is(
  (select is_cash_customer from public.customers where name = 'Juma Builders'),
  false,
  'and a registered customer is never the Cash Customer: the flag is not a parameter');

select is(
  (api.staff_create_order(
     (select id from public.customers where name = 'Juma Builders'),
     jsonb_build_array(jsonb_build_object('product_id', tests.product('Marine 18 mm'),
                                          'quantity', 10)),
     'ord-key-1') ->> 'reason'),
  'created',
  'a Sales Representative creates an order');

select is((select count(*)::int from public.orders), 1,
  'one order exists');

select is(
  (select status::text from public.orders limit 1),
  'proforma',
  'and it is at the proforma stage: the customer has not accepted anything yet');

select is((select count(*)::int from public.proformas), 1,
  'a proforma was generated automatically -- nobody asked for one (§12.1 point 2, AC-5)');

select is((select version from public.proformas), 1,
  'at version 1');

select is(
  (select total_tzs from public.proformas),
  400000::bigint,
  'and its total is calculated: ten sheets at forty thousand, typed by nobody (§5.2)');

select is((select count(*)::int from public.invoices), 0,
  'NO invoice exists: a proforma is a quotation, not a bill (§12.1 point 3, AC-6)');

select is((select count(*)::int from public.stock_allocations), 0,
  'and NO stock is reserved: a proforma creates no inventory change (AC-6)');

select is(
  (select available_quantity from public.product_availability
    where product_id = tests.product('Marine 18 mm')),
  100::bigint,
  'availability is untouched -- all hundred sheets are still sellable');

select is(
  (select proforma_no ~ '^FV-PRO-\d{8}-\d{4}$' from public.proformas),
  true,
  'the proforma carries its own consistently formatted number (§12.2)');

-- ---------------------------------------------------------------------------
-- Who wrote it (design.md §7.3, §4.2)
--
-- Every live role may read an order, so every live role may be told who wrote it. `profiles` is
-- not the way: it holds the phone number an account signs in with, and admits a Manager and a
-- Director alone. The command answers that one question and refuses everyone else outright.
-- ---------------------------------------------------------------------------
select tests.acting_as('a0000000-0000-0000-0000-000000000003'::uuid);   -- Cashier

select is(
  api.staff_order_creator_name((select id from public.orders limit 1)),
  'The Rep',
  'a Cashier is told who wrote the order');

select tests.acting_as('a0000000-0000-0000-0000-000000000005'::uuid);   -- the OTHER Sales Rep

select is(
  api.staff_order_creator_name((select id from public.orders limit 1)),
  'The Rep',
  'and so is a Sales Representative who did not write it');

select tests.acting_as('a0000000-0000-0000-0000-000000000006'::uuid);   -- no role at all

select is(
  api.staff_order_creator_name((select id from public.orders limit 1)),
  null::text,
  'somebody signed in with no live role is told nothing, name included');

select tests.acting_as('a0000000-0000-0000-0000-000000000004'::uuid);   -- back to the Sales Rep

-- ---------------------------------------------------------------------------
-- What an order refuses
-- ---------------------------------------------------------------------------
select is(
  (api.staff_create_order(
     (select id from public.customers where name = 'Juma Builders'),
     jsonb_build_array(jsonb_build_object('product_id', tests.product('Tofali 5"'),
                                          'quantity', 5)),
     'ord-key-noprice') ->> 'reason'),
  'product_has_no_price',
  'a product no Director has priced cannot be sold: nothing is quoted at a figure nobody approved');

select is(
  (api.staff_create_order(
     (select id from public.customers where name = 'Juma Builders'),
     jsonb_build_array(jsonb_build_object('product_id', tests.product('Marine 18 mm'),
                                          'quantity', 2.5)),
     'ord-key-fraction') ->> 'reason'),
  'quantity_not_whole',
  'half a sheet is not a quantity a counting unit can express (§6.1 rule 1)');

select is(
  (api.staff_create_order(
     (select id from public.customers where name = 'Juma Builders'),
     '[]'::jsonb, 'ord-key-nolines') ->> 'reason'),
  'lines_required',
  'an order with no lines sells nothing and is refused');

select is((select count(*)::int from public.orders), 1,
  'and not one of those three refusals created an order');

-- ---------------------------------------------------------------------------
-- Revising a proforma overwrites nothing (§12.1 point 4)
-- ---------------------------------------------------------------------------
select is(
  (api.staff_revise_proforma(
     (select id from public.orders limit 1),
     jsonb_build_array(jsonb_build_object('product_id', tests.product('Marine 18 mm'),
                                          'quantity', 12)),
     'rev-key-1') ->> 'reason'),
  'revised',
  'the Sales Representative revises the quotation');

select is((select count(*)::int from public.proformas), 2,
  'a second version exists');

select is(
  (select count(*)::int from public.proformas where superseded_at is not null),
  1,
  'and the first is marked superseded rather than deleted');

select is(
  (select total_tzs from public.proformas where version = 1),
  400000::bigint,
  'version 1 still says exactly what the customer was first quoted');

select is(
  (select total_tzs from public.proformas where version = 2),
  480000::bigint,
  'and version 2 says what they are quoted now');

select is(
  (select count(*)::int from public.proforma_lines pl
     join public.proformas p on p.id = pl.proforma_id where p.version = 1),
  1,
  'the superseded version keeps its own line snapshot, so it can still be read as issued');

-- ---------------------------------------------------------------------------
-- Discounts, and the two limits of product.md §4
-- ---------------------------------------------------------------------------
-- The order stands at 12 × 40 000 = 480 000, which is at or below TZS 1 000 000 — so ANY discount
-- on it is a Director's decision (AC-18).
select is(
  (api.staff_request_discount((select id from public.orders limit 1), 3, 'regular customer',
                              'disc-key-1') ->> 'required_role'),
  'director',
  'any discount on an order of TZS 1 000 000 or below is a Director''s, however small (AC-18)');

select is(
  (select discount_percent from public.orders limit 1),
  0::numeric,
  'and requesting one applies nothing: the percentage waits on the approval');

select tests.acting_as('a0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select is(
  (api.staff_approve_discount((select id from public.orders limit 1), 'disc-approve-manager')
   ->> 'reason'),
  'director_approval_required',
  'a Manager is refused BY THE DATABASE, not merely by a disabled button (AC-18)');

select is(
  (select discount_percent from public.orders limit 1),
  0::numeric,
  'and the refusal applied nothing');

-- §4.3 makes a rejection a COMPLETED DECISION that closes the request. A Manager who could refuse
-- a discount only a Director may approve would be deciding it either way: the customer gets
-- nothing, the request is closed, and no Director ever sees it.
select is(
  (api.staff_reject_discount((select id from public.orders limit 1), 'too generous for this order',
                             'disc-reject-manager') ->> 'reason'),
  'director_approval_required',
  'and the same Manager is refused the REJECTION, because refusing it is deciding it (§4, §4.3)');

select is(
  (select status::text from public.approval_requests
    where entity_type = 'order' and approval_type = 'discount'),
  'pending',
  'so the request is still waiting for the Director it was always waiting for');

select is((select count(*)::int from public.approval_decisions), 0,
  'and nothing was written to decision history by either refusal');

-- §12.6 lets ANY of the three order roles confirm ANY order, so the undecided discount has to stop
-- all of them. Whose request it is changes nothing.
select tests.acting_as('a0000000-0000-0000-0000-000000000005'::uuid);   -- a SECOND Sales Rep

select is(
  (api.staff_confirm_order((select id from public.orders limit 1), 'conf-key-other-rep')
   ->> 'reason'),
  'discount_pending',
  'a DIFFERENT Sales Representative is refused the confirmation too, by the database');

select is((select count(*)::int from public.invoices), 0,
  'and that refusal generated no invoice either');

select tests.acting_as('a0000000-0000-0000-0000-000000000001'::uuid);   -- Director

select is(
  (api.staff_approve_discount((select id from public.orders limit 1), 'disc-approve-director')
   ->> 'reason'),
  'approved',
  'the Director approves it');

select is(
  (select discount_percent from public.orders limit 1),
  3::numeric,
  'and only now does the order carry the discount');

select is((select count(*)::int from public.proformas), 3,
  'approving it issues a NEW proforma version, because what the customer is quoted has changed');

select is(
  (select total_tzs from public.proformas where version = 3),
  465600::bigint,
  'at 480 000 less 3 per cent, calculated and rounded to the whole shilling (§5.2)');

select is(
  (select approved_by::text from public.approval_requests
    where entity_type = 'order' and approval_type = 'discount'),
  'a0000000-0000-0000-0000-000000000001',
  'an approved outcome records its approver (§4.3)');

-- ---------------------------------------------------------------------------
-- Confirmation: exactly one invoice, and stock claimed but not moved
-- ---------------------------------------------------------------------------
select tests.acting_as('a0000000-0000-0000-0000-000000000004'::uuid);   -- Sales Rep

select is(
  (api.staff_confirm_order((select id from public.orders limit 1), 'conf-key-1') ->> 'reason'),
  'confirmed',
  'the customer confirms and the order becomes a commitment');

select is((select count(*)::int from public.invoices), 1,
  'EXACTLY ONE final invoice was generated (§12.1 point 6, AC-8)');

select is(
  (select invoice_no ~ '^FV-INV-\d{8}-\d{4}$' from public.invoices),
  true,
  'numbered FV-INV-YYYYMMDD-#### exactly as §12.2 writes it');

select is(
  (select business_date from public.invoices),
  (now() at time zone 'Africa/Dar_es_Salaam')::date,
  'on the Tanzania business date, not the server''s (§15.3)');

select is(
  (select total_tzs from public.invoices),
  465600::bigint,
  'and for the amount the accepted proforma stated');

select is(
  (select count(*)::int from public.invoice_lines),
  1,
  'with its own line snapshot, so a later product rename cannot rewrite the bill');

select is(
  (select reserved_quantity from public.product_availability
    where product_id = tests.product('Marine 18 mm')),
  12::bigint,
  'twelve sheets are reserved');

select is(
  (select physical_quantity from public.product_availability
    where product_id = tests.product('Marine 18 mm')),
  100::bigint,
  'the hundred are all still PHYSICALLY there: confirming moved no stock (AC-34)');

select is(
  (select available_quantity from public.product_availability
    where product_id = tests.product('Marine 18 mm')),
  88::bigint,
  'and available is physical minus the claim, which is §8.1 exactly');

select is(
  (select count(*)::int from public.inventory_ledger where movement_kind = 'sale_release'),
  0,
  'nothing left the ledger: stock leaves only at signed release (§12.6 step 14)');

-- ---------------------------------------------------------------------------
-- An invoice is an immutable snapshot (AC-11, AC-12)
--
-- These run as the TABLE OWNER, the one role a GRANT does not constrain — which is why the refusal
-- has to come from a trigger.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ update public.invoices set total_tzs = 1 $$,
  '23001', null,
  'no role can change what an invoice says, the table owner included');

select throws_ok(
  $$ update public.invoices set invoice_no = 'FV-INV-19700101-0001' $$,
  '23001', null,
  'and no role can renumber one');

select throws_ok(
  $$ delete from public.invoices $$,
  '23001', null,
  'nor delete one: a correction is a cancellation and a replacement');

select throws_ok(
  $$ update public.invoice_lines set quantity = 1 $$,
  '23001', null,
  'the lines are the invoice, and they cannot be edited either');

select throws_ok(
  $$ insert into public.invoices (invoice_no, order_id, customer_id, subtotal_tzs, discount_tzs,
                                  total_tzs, business_date)
     select 'FV-INV-19700101-0002', order_id, customer_id, 1, 0, 1, current_date
       from public.invoices limit 1 $$,
  '23505', null,
  'and a SECOND invoice for the same order is impossible: order_id is unique (AC-8)');

-- ---------------------------------------------------------------------------
-- Confirmation is refused when it would be wrong
-- ---------------------------------------------------------------------------
select is(
  (api.staff_confirm_order((select id from public.orders limit 1), 'conf-key-2') ->> 'reason'),
  'order_not_confirmable',
  'an order already confirmed is not confirmed again');

select is(
  (api.staff_revise_proforma(
     (select id from public.orders limit 1),
     jsonb_build_array(jsonb_build_object('product_id', tests.product('Marine 18 mm'),
                                          'quantity', 1)),
     'rev-key-late') ->> 'reason'),
  'order_not_revisable',
  'and a confirmed order cannot be quietly re-quoted: an invoice exists, and it is immutable');

-- Not enough stock: the claim is checked against §8.1 availability, not against physical stock.
select is(
  (api.staff_create_order(
     (select id from public.customers where name = 'Juma Builders'),
     jsonb_build_array(jsonb_build_object('product_id', tests.product('Marine 18 mm'),
                                          'quantity', 95)),
     'ord-key-2') ->> 'reason'),
  'created',
  'a second order for 95 sheets may be CREATED -- a proforma reserves nothing');

select is(
  (api.staff_confirm_order(
     (select id from public.orders where order_no <> (select order_no from public.invoices i
        join public.orders o on o.id = i.order_id limit 1) limit 1),
     'conf-key-3') ->> 'reason'),
  'insufficient_stock',
  'and is refused at CONFIRMATION, because twelve are already claimed by somebody else (AC-33)');

select is((select count(*)::int from public.invoices), 1,
  'the refusal generated no invoice');

-- ---------------------------------------------------------------------------
-- The Cash Customer path (§12.4, AC-86, AC-87)
-- ---------------------------------------------------------------------------
select is(
  (api.staff_create_order(
     (select id from public.customers where is_cash_customer),
     jsonb_build_array(jsonb_build_object('product_id', tests.product('Marine 18 mm'),
                                          'quantity', 2)),
     'cash-key-1') ->> 'reason'),
  'created',
  'a walk-in order is created the same way as any other');

-- Selected through the customer rather than through the newest audit row: every event written in
-- one transaction carries the identical `now()`, so "the latest order_created" is not a question
-- this test can ask.
select is(
  (select bool_and(o.is_cash_sale) from public.orders o
     join public.customers c on c.id = o.customer_id
    where c.is_cash_customer),
  true,
  'and it is snapshotted as a cash sale, so the rule cannot change under it');

select is(
  (api.staff_confirm_order(
     (select o.id from public.orders o
        join public.customers c on c.id = o.customer_id
       where c.is_cash_customer and o.status = 'proforma' limit 1),
     'cash-conf-1') ->> 'reason'),
  'confirmed_cash_sale',
  'confirming it is a different outcome, named as one');

select is((select count(*)::int from public.invoices), 1,
  'NO final invoice was created (§12.4 point 2, AC-86)');

select is(
  (select count(*)::int from public.stock_allocations a
     join public.orders o on o.id = a.order_id
     join public.customers c on c.id = o.customer_id
    where c.is_cash_customer),
  0,
  'and NO stock allocation exists at all: before payment there is nothing (§12.4 point 3, AC-87)');

select is(
  (select available_quantity from public.product_availability
    where product_id = tests.product('Marine 18 mm')),
  88::bigint,
  'availability is not reduced by one for the walk-in order (AC-87)');

-- ---------------------------------------------------------------------------
-- Cancelling releases the claim and keeps the invoice number (§4.3, AC-11)
-- ---------------------------------------------------------------------------
select is(
  (api.staff_cancel_order(
     (select order_id from public.invoices limit 1), 'customer changed their mind', 'cancel-key-1')
   ->> 'reason'),
  'cancelled',
  'the order is cancelled');

select is(
  (select available_quantity from public.product_availability
    where product_id = tests.product('Marine 18 mm')),
  100::bigint,
  'and every sheet is sellable again, because the claim was released');

select is(
  (select count(*)::int from public.invoices where cancelled_at is not null),
  1,
  'the invoice is cancelled');

select is(
  (select invoice_no ~ '^FV-INV-' from public.invoices),
  true,
  'and it KEEPS its number and its history (AC-11): it is not deleted and not renumbered');

select is(
  (select count(*)::int from public.approval_requests
    where entity_type = 'order' and status = 'pending'),
  0,
  'no decision is left hanging on a cancelled order');

-- ---------------------------------------------------------------------------
-- Cancelling BEFORE confirmation: nothing was owed, so nothing is kept (§12.1 point 3)
-- ---------------------------------------------------------------------------
select is(
  (api.staff_add_customer('Mwenge Hardware', 'cust-key-2') ->> 'reason'),
  'added',
  'a second customer is registered, so the withdrawn quotation belongs to nobody else');

select is(
  (api.staff_create_order(
     (select id from public.customers where name = 'Mwenge Hardware'),
     jsonb_build_array(jsonb_build_object('product_id', tests.product('Marine 18 mm'),
                                          'quantity', 4)),
     'ord-key-3') ->> 'reason'),
  'created',
  'and is quoted four sheets');

-- A discount is asked for and nobody decides it, so the cancellation has something to withdraw.
select is(
  (api.staff_request_discount(
     (select o.id from public.orders o
        join public.customers c on c.id = o.customer_id
       where c.name = 'Mwenge Hardware' limit 1),
     2, 'they came to the yard themselves', 'disc-key-mwenge') ->> 'required_role'),
  'director',
  'a discount is asked for on it and left undecided');

select is(
  (api.staff_cancel_order(
     (select o.id from public.orders o
        join public.customers c on c.id = o.customer_id
       where c.name = 'Mwenge Hardware' limit 1),
     'no', 'cancel-key-short') ->> 'reason'),
  'reason_required',
  'a cancellation with no real reason is refused: §16 keeps WHY, not merely that it happened');

select is(
  (select o.status::text from public.orders o
     join public.customers c on c.id = o.customer_id
    where c.name = 'Mwenge Hardware'),
  'proforma',
  'and that refusal changed nothing');

select is(
  (api.staff_cancel_order(
     (select o.id from public.orders o
        join public.customers c on c.id = o.customer_id
       where c.name = 'Mwenge Hardware' limit 1),
     'quoted the wrong site', 'cancel-key-2') ->> 'reason'),
  'cancelled',
  'with a reason, the quotation is withdrawn');

select is(
  (select count(*)::int from public.invoices i
     join public.orders o on o.id = i.order_id
     join public.customers c on c.id = o.customer_id
    where c.name = 'Mwenge Hardware'),
  0,
  'and NO invoice is left behind: a quotation nobody accepted was never a bill (§12.1 point 3)');

select is(
  (select available_quantity from public.product_availability
    where product_id = tests.product('Marine 18 mm')),
  100::bigint,
  'availability is exactly where it was, because a proforma held nothing to release (AC-6)');

-- ---------------------------------------------------------------------------
-- What a cancellation RECORDS (§4.3, §16)
--
-- The projection moving is not the record. §4.3 requires every decision — approval, rejection,
-- cancellation, expiry, supersession, withdrawal — to record its actor, role, timestamp, reason and
-- outcome in append-only history, and only an approved outcome to record an approver.
-- ---------------------------------------------------------------------------
select is(
  (select r.status::text from public.approval_requests r
     join public.orders o on o.id = r.entity_id
     join public.customers c on c.id = o.customer_id
    where c.name = 'Mwenge Hardware'),
  'cancelled',
  'the undecided discount is withdrawn with the order it belonged to');

select is(
  (select count(*)::int from public.approval_decisions d
     join public.approval_requests r on r.id = d.request_id
     join public.orders o on o.id = r.entity_id
     join public.customers c on c.id = o.customer_id
    where c.name = 'Mwenge Hardware' and d.outcome = 'cancelled'),
  1,
  'and it is withdrawn AS A DECISION -- one row in append-only history, not a status moved by hand');

select is(
  (select d.decided_by::text from public.approval_decisions d
     join public.approval_requests r on r.id = d.request_id
     join public.orders o on o.id = r.entity_id
     join public.customers c on c.id = o.customer_id
    where c.name = 'Mwenge Hardware'),
  'a0000000-0000-0000-0000-000000000004',
  'naming the person who cancelled the order');

select is(
  (select d.note from public.approval_decisions d
     join public.approval_requests r on r.id = d.request_id
     join public.orders o on o.id = r.entity_id
     join public.customers c on c.id = o.customer_id
    where c.name = 'Mwenge Hardware'),
  'quoted the wrong site',
  'and the reason they gave for it');

select is(
  (select r.approved_by::text from public.approval_requests r
     join public.orders o on o.id = r.entity_id
     join public.customers c on c.id = o.customer_id
    where c.name = 'Mwenge Hardware'),
  null::text,
  'and NO approver, because a cancellation is not an approval (§4.3, AC-84)');

select is(
  (select a.before_state ->> 'status' from public.audit_events a
     join public.orders o on o.id = a.entity_id
     join public.customers c on c.id = o.customer_id
    where c.name = 'Mwenge Hardware' and a.action = 'order_cancelled'),
  'proforma',
  'the audit record says the order was a QUOTATION when it was cancelled');

select is(
  (select a.before_state ->> 'status' from public.audit_events a
    where a.action = 'order_cancelled'
      and a.entity_id = (select order_id from public.invoices limit 1)),
  'confirmed',
  'and the confirmed one says confirmed -- the state is read from the order, never assumed');

-- ---------------------------------------------------------------------------
-- Numbering is unique, whatever else happens
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from (
     select invoice_no from public.invoices group by invoice_no having count(*) > 1) d),
  0,
  'no invoice number is ever issued twice (§12.2, AC-91)');

select is(
  (select count(*)::int from (
     select proforma_no from public.proformas group by proforma_no having count(*) > 1) d),
  0,
  'and neither is a proforma number');

select * from finish();
rollback;
