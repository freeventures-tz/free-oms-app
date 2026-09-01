-- Stage 12 · Payments, credit, dispatch, and stock actually leaving
--
-- The claims under test, each traceable to product.md:
--
--   §12.5  Six tenders record money. CREDIT IS NOT ONE OF THEM and records no payment (AC-92).
--   §12.3  Invoice status is calculated from money received, never chosen (AC-14). A fully
--          credited invoice is UNPAID (AC-93).
--   §4     A Manager may approve an unpaid balance up to TZS 500,000; beyond that it is a
--          Director's (AC-17).
--   §12.6  Stock leaves ONLY after a Manager confirms a customer-signed note, and only when a
--          dispatch-note number already exists (AC-34, AC-35).
--   §14    One OMS record per physical dispatch note (AC-36), and the OMS generates none (AC-37).
--   §12.4  The walk-in sale is atomic: everything at payment, or nothing at all (AC-88, AC-89).
--   §4.1   A payment reversal is requested by a Cashier or Manager and approved by a Director
--          (AC-21), as a new negative row rather than an edit.
create extension if not exists pgtap with schema extensions;

begin;
select plan(99);

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

select tests.mk_user('b0000000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('b0000000-0000-0000-0000-000000000002'::uuid);  -- Manager
select tests.mk_user('b0000000-0000-0000-0000-000000000003'::uuid);  -- Cashier
select tests.mk_user('b0000000-0000-0000-0000-000000000004'::uuid);  -- Sales Representative

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('b0000000-0000-0000-0000-000000000001', 'Pay Director', '+255700000111', true, false),
  ('b0000000-0000-0000-0000-000000000002', 'Pay Manager',  '+255700000112', true, false),
  ('b0000000-0000-0000-0000-000000000003', 'Pay Cashier',  '+255700000113', true, false),
  ('b0000000-0000-0000-0000-000000000004', 'Pay Rep',      '+255700000114', true, false);

insert into public.user_roles (user_id, role) values
  ('b0000000-0000-0000-0000-000000000001', 'director'),
  ('b0000000-0000-0000-0000-000000000002', 'manager'),
  ('b0000000-0000-0000-0000-000000000003', 'cashier'),
  ('b0000000-0000-0000-0000-000000000004', 'sales_rep');

create or replace function tests.product(p_name text) returns uuid language sql stable as $$
  select id from public.products where name = p_name limit 1;
$$;

create or replace function tests.invoice_of(p_order uuid) returns uuid language sql stable as $$
  select id from public.invoices where order_id = p_order limit 1;
$$;

create or replace function tests.status_of(p_invoice uuid) returns text language sql stable as $$
  select status from public.invoice_settlement where invoice_id = p_invoice;
$$;

-- ---------------------------------------------------------------------------
-- A priced, stocked product and a confirmed order to settle
-- ---------------------------------------------------------------------------
select tests.acting_as('b0000000-0000-0000-0000-000000000001'::uuid);   -- Director

select is(
  (api.admin_set_product_price(tests.product('Marine 18 mm'), 100000, 'opening', 'pk-1')
   ->> 'reason'),
  'set', 'a Director prices what will be sold');

select is(
  (api.admin_record_opening_stock(tests.product('Marine 18 mm'), 'store', 200, null, 'ok-1')
   ->> 'reason'),
  'recorded', 'and stocks the store with two hundred');

select tests.acting_as('b0000000-0000-0000-0000-000000000004'::uuid);   -- Sales Rep

select is(
  (api.staff_add_customer('Settlement Co', 'ck-1') ->> 'reason'),
  'added', 'a customer exists to sell to');

select is(
  (api.staff_create_order(
     (select id from public.customers where name = 'Settlement Co'),
     jsonb_build_array(jsonb_build_object('product_id', tests.product('Marine 18 mm'),
                                          'quantity', 4)),
     'ordk-1') ->> 'reason'),
  'created', 'and an order for four sheets at a hundred thousand each');

select is(
  (api.staff_confirm_order((select id from public.orders limit 1), 'confk-1') ->> 'reason'),
  'confirmed', 'the customer confirms, so an invoice exists');

-- ---------------------------------------------------------------------------
-- Invoice status is CALCULATED, and nobody can choose it (§12.3, AC-14)
--
-- Read as the Cashier, because settlement facts are Cashier, Manager and Director work and the
-- views refuse everybody else. That refusal is asserted at the end of this file.
-- ---------------------------------------------------------------------------
select tests.acting_as('b0000000-0000-0000-0000-000000000003'::uuid);   -- Cashier

select is(
  tests.status_of(tests.invoice_of((select id from public.orders limit 1))),
  'unpaid',
  'a fresh invoice is Unpaid, because no money has been received');

select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'invoices' and column_name = 'status'),
  0,
  'there is no status COLUMN on invoices for anybody to write to (AC-14)');

-- ---------------------------------------------------------------------------
-- Who may take money (§12.6 step 6)
-- ---------------------------------------------------------------------------
select tests.acting_as('b0000000-0000-0000-0000-000000000004'::uuid);   -- Sales Rep

select throws_ok(
  $$ select api.staff_record_payment(
       (select id from public.invoices limit 1), 'cash', 1000, 'payk-rep') $$,
  '42501', null,
  'a Sales Representative does not take money -- they write the order');

select tests.acting_as('b0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select throws_ok(
  $$ select api.staff_record_payment(
       (select id from public.invoices limit 1), 'cash', 1000, 'payk-mgr') $$,
  '42501', null,
  'and neither does a Manager: §12.6 step 6 gives settlement to the Cashier');

select is((select count(*)::int from public.payments), 0,
  'not one refused attempt recorded a shilling');

-- ---------------------------------------------------------------------------
-- A partial payment (§12.3, AC-13)
-- ---------------------------------------------------------------------------
select tests.acting_as('b0000000-0000-0000-0000-000000000003'::uuid);   -- Cashier

select is(
  (api.staff_record_payment(
     (select id from public.invoices limit 1), 'cash', 150000, 'payk-1') ->> 'status'),
  'partially_paid',
  'a hundred and fifty thousand against four hundred thousand is Partially paid');

select is(
  (select outstanding_tzs from public.invoice_settlement),
  250000::bigint,
  'and the balance recalculates itself (AC-13)');

select is(
  (api.staff_record_payment(
     (select id from public.invoices limit 1), 'mixx_by_yas', 500000, 'payk-over') ->> 'reason'),
  'payment_exceeds_balance',
  'taking more than is owed is not a payment, it is a mistake with somebody''s money in it');

select is((select count(*)::int from public.payments), 1,
  'and the refusal recorded nothing');

-- ---------------------------------------------------------------------------
-- Credit is NOT a tender (§12.5, AC-92, AC-93)
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_enum e
     join pg_type t on t.oid = e.enumtypid
    where t.typname = 'payment_method' and e.enumlabel ilike '%credit%'),
  0,
  'credit is not one of the payment methods -- putting it there would count money nobody received');

select is(
  (select count(*)::int from pg_enum e
     join pg_type t on t.oid = e.enumtypid where t.typname = 'payment_method'),
  6,
  'there are exactly the six tenders of §12.5');

select is(
  (api.staff_request_credit(
     (select id from public.invoices limit 1), 250000, 'regular customer, pays monthly', 'crk-1')
   ->> 'required_role'),
  'manager',
  'an unpaid balance of 250 000 is inside a Manager''s TZS 500 000 limit (§4)');

select is(
  tests.status_of((select id from public.invoices limit 1)),
  'partially_paid',
  'and ASKING for credit changes no status: it records no payment (AC-92)');

select tests.acting_as('b0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select is(
  (api.staff_approve_credit(
     (select id from public.credit_authorisations limit 1), 'crk-approve') ->> 'reason'),
  'approved',
  'the Manager approves it, being inside their authority');

select is(
  (select amount_paid_tzs from public.invoice_settlement),
  150000::bigint,
  'money received is STILL a hundred and fifty thousand: approving credit paid nothing (AC-92)');

select is(
  tests.status_of((select id from public.invoices limit 1)),
  'partially_paid',
  'and the status still reflects the money, not the authorisation (§12.3)');

select is(
  (select approved_credit_tzs from public.invoice_settlement),
  250000::bigint,
  'the approved balance sits BESIDE the payment figures, separately (§12.5)');

-- design.md §7.8: what the customer already owes on approved credit, which the per-invoice limit
-- of §4 cannot see. 250 000 approved against 250 000 still owed.
select is(
  (select exposure_tzs from public.customer_credit_exposure
    where customer_id = (select id from public.customers where name = 'Settlement Co')),
  250000::bigint,
  'the customer''s credit exposure is what is approved AND still owed');

-- ---------------------------------------------------------------------------
-- Settlement approval is a separate act (§4.1, §4.2, §12.6 step 7)
-- ---------------------------------------------------------------------------
select tests.acting_as('b0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select throws_ok(
  $$ select api.staff_approve_settlement((select id from public.invoices limit 1), 'setk-mgr') $$,
  '42501', null,
  'a Manager does not approve a settled invoice -- §4.1 gives that to the Cashier');

select tests.acting_as('b0000000-0000-0000-0000-000000000003'::uuid);   -- Cashier

select is(
  (select count(*)::int from public.stock_allocations where state = 'committed'),
  0,
  'nothing is committed before the Cashier confirms the settlement');

select is(
  (api.staff_approve_settlement((select id from public.invoices limit 1), 'setk-1') ->> 'reason'),
  'approved',
  'the Cashier confirms it: money plus approved credit covers the bill');

select is(
  (select count(*)::int from public.stock_allocations where state = 'committed'),
  1,
  'and the claim becomes COMMITTED -- §8''s paid-but-unreleased');

select is(
  (select physical_quantity from public.product_availability
    where product_id = tests.product('Marine 18 mm')),
  200::bigint,
  'while every sheet is still PHYSICALLY in the store: nothing moved (AC-34)');

select is(
  (select releasable from public.invoice_settlement),
  true,
  'the invoice may now be dispatched');

-- ---------------------------------------------------------------------------
-- Storekeepers (§3.2)
-- ---------------------------------------------------------------------------
select tests.acting_as('b0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select throws_ok(
  $$ select api.admin_add_storekeeper('Juma', null, current_date, null, 'skk-mgr') $$,
  '42501', null,
  'a Manager cannot register a storekeeper -- §3.2 gives that to a Director');

select tests.acting_as('b0000000-0000-0000-0000-000000000001'::uuid);   -- Director

select is(
  (api.admin_add_storekeeper('Juma Mwenda', '0712345678', current_date, 'yard side', 'skk-1')
   ->> 'reason'),
  'added',
  'a Director registers a storekeeper');

select is(
  (select storekeeper_code ~ '^SK-\d{4}$' from public.storekeepers),
  true,
  'and the code is generated by the server, so there is nothing to mistype (§3.2)');

select is(
  (select count(*)::int from information_schema.role_table_grants
    where table_name = 'storekeepers' and grantee = 'authenticated'
      and privilege_type <> 'SELECT'),
  0,
  'a storekeeper record is readable and nothing more: they have no login and no permissions');

-- ---------------------------------------------------------------------------
-- Dispatch: each step unlocks the next, and none may be skipped (§12.6, design.md §6.3)
-- ---------------------------------------------------------------------------
select tests.acting_as('b0000000-0000-0000-0000-000000000003'::uuid);   -- Cashier

select is(
  (api.staff_assign_dispatch(
     (select id from public.invoices limit 1),
     (select id from public.storekeepers limit 1),
     'store',
     jsonb_build_array(jsonb_build_object(
       'allocation_id', (select id from public.stock_allocations limit 1),
       'quantity', 3)),
     'dsk-1') ->> 'reason'),
  'assigned',
  'the Cashier assigns a storekeeper to fetch three of the four');

select is(
  (select count(*)::int from public.inventory_ledger where movement_kind = 'sale_release'),
  0,
  'and ASSIGNING moves no stock at all (§12.6 step 9)');

select tests.acting_as('b0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select is(
  (api.staff_confirm_release((select id from public.dispatches limit 1), 'relk-early')
   ->> 'reason'),
  'dispatch_note_missing',
  'release is REFUSED before a dispatch-note number exists (design.md §6.3)');

select is(
  (select count(*)::int from public.inventory_ledger where movement_kind = 'sale_release'),
  0,
  'and the refusal moved nothing');

select is(
  (api.staff_record_dispatch_note((select id from public.dispatches limit 1), 'DN-BOOK-0001',
                                  'notek-1') ->> 'reason'),
  'recorded',
  'the Manager types the number in from the physical carbon book (§14)');

select is(
  (select count(*)::int from public.inventory_ledger where movement_kind = 'sale_release'),
  0,
  'recording the number moves no stock either (§12.6 step 11)');

-- ---------------------------------------------------------------------------
-- Release: the one place stock leaves (§12.6 step 14, AC-35)
-- ---------------------------------------------------------------------------
select tests.acting_as('b0000000-0000-0000-0000-000000000003'::uuid);   -- Cashier

select throws_ok(
  $$ select api.staff_confirm_release((select id from public.dispatches limit 1), 'relk-cashier') $$,
  '42501', null,
  'a Cashier cannot confirm the release -- §12.6 step 13 gives that to the Manager');

select tests.acting_as('b0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select is(
  (api.staff_confirm_release((select id from public.dispatches limit 1), 'relk-1') ->> 'reason'),
  'released',
  'the Manager confirms the customer signed, and only now does stock leave');

select is(
  (select private.stock_on_hand(tests.product('Marine 18 mm'), 'store', 'available')),
  197::bigint,
  'the store falls by the three that were handed over');

select is(
  (select count(*)::int from public.inventory_ledger
    where movement_kind = 'sale_release' and quantity_delta = -3),
  1,
  'as one permanent ledger movement');

select is(
  (select approved_by::text from public.inventory_ledger where movement_kind = 'sale_release'),
  'b0000000-0000-0000-0000-000000000002',
  'authorised by the Manager who confirmed the signature (AC-82)');

select is(
  (select released_quantity from public.stock_allocations limit 1),
  3::bigint,
  'three of the four are released');

select is(
  (select state::text from public.stock_allocations limit 1),
  'committed',
  'and the claim stays COMMITTED, because one sheet is still owed to the customer');

select is(
  (select outstanding_quantity from public.paid_but_unreleased),
  1::bigint,
  'the remainder shows in paid-but-unreleased, which is what stops it being forgotten');

select is(
  (select available_quantity from public.product_availability
    where product_id = tests.product('Marine 18 mm')),
  196::bigint,
  'available is 197 physical minus the one still claimed -- the released three are not '
  'subtracted twice');

-- ---------------------------------------------------------------------------
-- What a dispatch refuses
-- ---------------------------------------------------------------------------
select is(
  (api.staff_confirm_release((select id from public.dispatches limit 1), 'relk-2') ->> 'reason'),
  'already_settled',
  'a released dispatch is not released again');

select is(
  (select private.stock_on_hand(tests.product('Marine 18 mm'), 'store', 'available')),
  197::bigint,
  'and the second attempt handed over nothing');

select tests.acting_as('b0000000-0000-0000-0000-000000000003'::uuid);   -- Cashier

select is(
  (api.staff_assign_dispatch(
     (select id from public.invoices limit 1),
     (select id from public.storekeepers limit 1),
     'store',
     jsonb_build_array(jsonb_build_object(
       'allocation_id', (select id from public.stock_allocations limit 1),
       'quantity', 5)),
     'dsk-over') ->> 'reason'),
  'exceeds_outstanding',
  'a second dispatch cannot hand over more than is still owed');

select tests.acting_as('b0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select is(
  (api.staff_record_dispatch_note(
     (select id from public.dispatches limit 1), 'DN-BOOK-0002', 'notek-2') ->> 'reason'),
  'dispatch_not_assignable',
  'and a released dispatch cannot be given a second note number');

-- ---------------------------------------------------------------------------
-- One OMS record per physical note (§14, AC-36)
-- ---------------------------------------------------------------------------
select tests.acting_as('b0000000-0000-0000-0000-000000000003'::uuid);   -- Cashier

select is(
  (api.staff_assign_dispatch(
     (select id from public.invoices limit 1),
     (select id from public.storekeepers limit 1),
     'store',
     jsonb_build_array(jsonb_build_object(
       'allocation_id', (select id from public.stock_allocations limit 1),
       'quantity', 1)),
     'dsk-2') ->> 'reason'),
  'assigned',
  'the last sheet is assigned on a second dispatch');

select tests.acting_as('b0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select is(
  (api.staff_record_dispatch_note(
     (select id from public.dispatches where status = 'assigned'), 'DN-BOOK-0001', 'notek-dup')
   ->> 'reason'),
  'dispatch_note_in_use',
  'a dispatch-note number already in the system cannot be used again (AC-36)');

select is(
  (api.staff_record_dispatch_note(
     (select id from public.dispatches where status = 'assigned'), 'DN-BOOK-0003', 'notek-3')
   ->> 'reason'),
  'recorded',
  'a fresh number is accepted');

select is(
  (api.staff_confirm_release(
     (select id from public.dispatches where status = 'note_recorded'), 'relk-3') ->> 'reason'),
  'released',
  'and the last sheet is handed over');

select is(
  (select state::text from public.stock_allocations limit 1),
  'released',
  'the claim is now fully released');

select is(
  (select count(*)::int from public.paid_but_unreleased),
  0,
  'and nothing is left waiting');

-- ---------------------------------------------------------------------------
-- A payment cannot be rewritten, by anybody (§16)
--
-- These run as the TABLE OWNER, the one role a GRANT does not constrain.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ update public.payments set amount_tzs = 1 $$,
  '23001', null,
  'no role can change what was counted at the till, the table owner included');

select throws_ok(
  $$ delete from public.payments $$,
  '23001', null,
  'and no role can delete a payment');

-- ---------------------------------------------------------------------------
-- Payment reversal: Cashier or Manager asks, a DIRECTOR decides (§4.1, AC-21)
-- ---------------------------------------------------------------------------
select tests.acting_as('b0000000-0000-0000-0000-000000000003'::uuid);   -- Cashier

select is(
  (api.staff_request_payment_reversal(
     (select id from public.payments limit 1), 'paid against the wrong invoice', 'revk-1')
   ->> 'reason'),
  'requested',
  'a Cashier asks for a reversal');

select is(
  (select amount_paid_tzs from public.invoice_settlement),
  150000::bigint,
  'and asking reverses nothing: the money stays recorded until a Director decides');

select tests.acting_as('b0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select throws_ok(
  $$ select api.admin_approve_payment_reversal(
       (select id from public.payments limit 1), 'revk-mgr') $$,
  '42501', null,
  'a Manager cannot approve one, however senior to the Cashier who asked (§4.1)');

select tests.acting_as('b0000000-0000-0000-0000-000000000001'::uuid);   -- Director

select is(
  (api.admin_approve_payment_reversal((select id from public.payments where reverses_id is null
                                        limit 1), 'revk-approve') ->> 'reason'),
  'reversed',
  'a Director approves it');

select is((select count(*)::int from public.payments), 2,
  'and the reversal is a NEW row: the original was not edited');

select is(
  (select amount_tzs from public.payments where reverses_id is not null),
  -150000::bigint,
  'a negative one, for exactly what came in');

select is(
  (select amount_paid_tzs from public.invoice_settlement),
  0::bigint,
  'so money received falls to zero by arithmetic rather than by an edit');

select is(
  tests.status_of((select id from public.invoices limit 1)),
  'unpaid',
  'and the calculated status follows it back to Unpaid (§12.3)');

-- ---------------------------------------------------------------------------
-- The walk-in sale is atomic (§12.4, AC-88, AC-89, AC-90)
-- ---------------------------------------------------------------------------
select tests.acting_as('b0000000-0000-0000-0000-000000000004'::uuid);   -- Sales Rep

select is(
  (api.staff_create_order(
     (select id from public.customers where is_cash_customer),
     jsonb_build_array(jsonb_build_object('product_id', tests.product('Marine 18 mm'),
                                          'quantity', 2)),
     'cashord-1') ->> 'reason'),
  'created', 'a walk-in order is written');

select is(
  (api.staff_confirm_order(
     (select o.id from public.orders o join public.customers c on c.id = o.customer_id
       where c.is_cash_customer limit 1), 'cashconf-1') ->> 'reason'),
  'confirmed_cash_sale',
  'and confirmed, creating nothing');

select tests.acting_as('b0000000-0000-0000-0000-000000000003'::uuid);   -- Cashier

select is(
  (api.staff_take_cash_payment(
     (select o.id from public.orders o join public.customers c on c.id = o.customer_id
       where c.is_cash_customer limit 1), 'cash', 100000, 'cashpay-short') ->> 'reason'),
  'cash_sale_must_be_paid_in_full',
  'a walk-in sale cannot be part-paid: §12.4 permits it only for a FULLY paid sale (AC-16)');

select is(
  (select count(*)::int from public.invoices), 1,
  'and the refusal left no invoice behind (AC-89)');

select is(
  (api.staff_take_cash_payment(
     (select o.id from public.orders o join public.customers c on c.id = o.customer_id
       where c.is_cash_customer limit 1), 'cash', 200000, 'cashpay-1') ->> 'reason'),
  'paid',
  'paid in full, the whole sale happens at once');

select is((select count(*)::int from public.invoices), 2,
  'an invoice now exists — created at PAYMENT, not at confirmation (§12.4 point 4)');

select is(
  (select s.status from public.invoice_settlement s
     join public.invoices i on i.id = s.invoice_id
     join public.orders o on o.id = i.order_id
     join public.customers c on c.id = o.customer_id
    where c.is_cash_customer),
  'paid',
  'and it is Paid, because the money really was received');

select is(
  (select count(*)::int from public.stock_allocations a
     join public.orders o on o.id = a.order_id
     join public.customers c on c.id = o.customer_id
    where c.is_cash_customer and a.state = 'committed'),
  1,
  'the stock is COMMITTED — sold but unreleased, never an unpaid reservation (AC-90)');

select is(
  (select private.stock_on_hand(tests.product('Marine 18 mm'), 'store', 'available')),
  196::bigint,
  'and nothing has physically left: a walk-in customer still signs for their goods');

-- ---------------------------------------------------------------------------
-- A balance beyond a Manager's authority cannot be DECIDED by a Manager, either way
--
-- product.md §4.3: a rejection is a COMPLETED DECISION, not the absence of one. A Manager able to
-- refuse what only a Director may approve would settle it either way — the customer gets nothing,
-- the request is closed, and no Director ever sees it.
-- ---------------------------------------------------------------------------
select tests.acting_as('b0000000-0000-0000-0000-000000000004'::uuid);   -- Sales Representative

select is(
  (api.staff_add_customer('Credit Limit Co', 'fx-cust') ->> 'reason'),
  'added', 'a second customer, to test the authority limit against');

select is(
  (api.staff_create_order(
     (select id from public.customers where name = 'Credit Limit Co'),
     jsonb_build_array(jsonb_build_object('product_id', tests.product('Marine 18 mm'),
                                          'quantity', 8)),
     'fx-order') ->> 'reason'),
  'created', 'and an order for eight sheets: eight hundred thousand');

select is(
  (api.staff_confirm_order(
     (select id from public.orders o
       where o.customer_id = (select id from public.customers where name = 'Credit Limit Co')),
     'fx-confirm') ->> 'reason'),
  'confirmed', 'confirmed, so there is an invoice to carry on credit');

select tests.acting_as('b0000000-0000-0000-0000-000000000003'::uuid);   -- Cashier

select is(
  (api.staff_request_credit(
     (select i.id from public.invoices i
        join public.orders o on o.id = i.order_id
       where o.customer_id = (select id from public.customers where name = 'Credit Limit Co')),
     800000, 'large customer, agreed terms', 'fx-credit')
   ->> 'required_role'),
  'director',
  'eight hundred thousand is beyond a Manager''s TZS 500 000 limit (§4)');

select tests.acting_as('b0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select is(
  (api.staff_approve_credit(
     (select id from public.credit_authorisations
       where reason = 'large customer, agreed terms'), 'fx-mgr-approve')
   ->> 'reason'),
  'director_approval_required',
  'a Manager cannot APPROVE it, and is told which limit was crossed');

select is(
  (api.staff_reject_credit(
     (select id from public.credit_authorisations
       where reason = 'large customer, agreed terms'), 'too much', 'fx-mgr-reject')
   ->> 'reason'),
  'director_approval_required',
  'and cannot REJECT it either, because §4.3 makes a rejection a completed decision');

select is(
  (select status::text from public.approval_requests
    where entity_type = 'credit_authorisation'
      and entity_id = (select id from public.credit_authorisations
                        where reason = 'large customer, agreed terms')),
  'pending',
  'so the request is still waiting for the Director it belongs to');

select tests.acting_as('b0000000-0000-0000-0000-000000000001'::uuid);   -- Director

select is(
  (api.staff_approve_credit(
     (select id from public.credit_authorisations
       where reason = 'large customer, agreed terms'), 'fx-dir-approve')
   ->> 'reason'),
  'approved',
  'the Director approves it');

select is(
  (select exposure_tzs from public.customer_credit_exposure
    where customer_id = (select id from public.customers where name = 'Credit Limit Co')),
  800000::bigint,
  'and the whole eight hundred thousand is now exposure: none of it has been paid');

select tests.acting_as('b0000000-0000-0000-0000-000000000003'::uuid);   -- Cashier

select is(
  (api.staff_record_payment(
     (select i.id from public.invoices i
        join public.orders o on o.id = i.order_id
       where o.customer_id = (select id from public.customers where name = 'Credit Limit Co')),
     'cash', 300000, 'fx-part-pay') ->> 'reason'),
  'recorded',
  'the customer pays three hundred thousand of it');

-- EXPOSURE IS MONEY OUT, NOT THE SUM OF THE APPROVALS. The approval still says 800 000; what is
-- still owed is 500 000, and that is what the business is exposed for.
select is(
  (select exposure_tzs from public.customer_credit_exposure
    where customer_id = (select id from public.customers where name = 'Credit Limit Co')),
  500000::bigint,
  'exposure falls as they pay: least(approved, outstanding), never the approval alone');

select is(
  (select count(*)::int from public.customer_credit_exposure e
     join public.customers c on c.id = e.customer_id
    where c.is_cash_customer),
  0,
  'a customer with no approved credit has no exposure row at all');

-- ---------------------------------------------------------------------------
-- The approved role boundary (design.md §4.2, Owner decision on the v0.0.4 review)
--
-- A Sales Representative reads orders and invoices. They do not read the money against them, who
-- carried a balance, which storekeeper fetched what, or what is sitting in the yard.
--
-- The two settlement VIEWS refuse rather than report zero, which is the difference between an
-- honest refusal and a confident false statement: `invoice_settlement` LEFT JOINs the payments a
-- Sales Representative can no longer see, so without the guard it would call every invoice in the
-- business unpaid.
-- ---------------------------------------------------------------------------
select tests.acting_as('b0000000-0000-0000-0000-000000000004'::uuid);   -- Sales Representative

select is(
  api.staff_settlement_readable(), false,
  'a Sales Representative may not read settlement facts');

select is(
  (select count(*)::int from public.invoice_settlement), 0,
  'so invoice_settlement answers them with nothing, rather than with zero money');

select is(
  (select count(*)::int from public.paid_but_unreleased), 0,
  'and paid_but_unreleased shows them nothing');

select is(
  (select count(*)::int from public.customer_credit_exposure), 0,
  'and neither does the exposure total');

select tests.acting_as('b0000000-0000-0000-0000-000000000003'::uuid);   -- Cashier

select is(
  api.staff_settlement_readable(), true,
  'a Cashier may, because settling invoices is their work (§12.6 step 6)');

select isnt(
  (select count(*)::int from public.invoice_settlement), 0,
  'and the same view answers them normally');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public'
      and tablename in ('payments', 'credit_authorisations', 'dispatches', 'dispatch_lines',
                        'storekeepers')
      and qual like '%sales_rep%'),
  0,
  'no policy on a settlement table names a Sales Representative');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public'
      and tablename in ('payments', 'credit_authorisations', 'dispatches', 'dispatch_lines',
                        'storekeepers')
      and cmd = 'SELECT' and roles::text like '%authenticated%'),
  5,
  'and each of the five still has exactly one read policy for the roles that do need it');

-- ---------------------------------------------------------------------------
-- The privilege surface
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from information_schema.table_privileges
    where grantee = 'service_role' and table_schema = 'public'
      and table_name in ('payments', 'credit_authorisations', 'dispatches', 'dispatch_lines',
                         'storekeepers')),
  0,
  'a leaked secret key reaches none of the settlement tables');

select is(
  (select coalesce(string_agg(distinct privilege_type, ', ' order by privilege_type), '')
     from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'payments'
      and grantee in ('anon', 'authenticated')),
  'SELECT',
  'and no client holds anything but SELECT on payments');

select * from finish();
rollback;
