-- Stage 10D · Suppliers, the inventory ledger, receiving, opening stock, transfers, adjustments
--
-- The claims under test, each traceable to product.md rather than to a preference:
--
--   §9.1  Stock increases ONLY after Manager approval, and entry is never approval.
--   §9.1  Every shortage stays documented, however small, and is never netted against an excess.
--   §4.1  Who may enter and who may approve, per operation — and nobody else, refused by the
--         database rather than by a hidden button.
--   §4.2  A Manager who entered a receipt may still approve it, as a separate recorded action.
--   §4.3  A rejection records NO approver and is never treated as an approval.
--   §8    Damaged goods are unsellable and never reach a balance.
--   §10   Balances change only on transfer approval, and the source is checked at that moment.
--   §16   A movement, once written, cannot be edited or deleted by anybody.
--   AC-82 No silent stock change: every ledger row names its cause, its actor and its authoriser.
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

select tests.mk_user('e0000000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('e0000000-0000-0000-0000-000000000002'::uuid);  -- Manager
select tests.mk_user('e0000000-0000-0000-0000-000000000003'::uuid);  -- Cashier
select tests.mk_user('e0000000-0000-0000-0000-000000000004'::uuid);  -- Sales Representative

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('e0000000-0000-0000-0000-000000000001', 'Stock Director', '+255700000091', true, false),
  ('e0000000-0000-0000-0000-000000000002', 'Stock Manager',  '+255700000092', true, false),
  ('e0000000-0000-0000-0000-000000000003', 'Stock Cashier',  '+255700000093', true, false),
  ('e0000000-0000-0000-0000-000000000004', 'Stock Rep',      '+255700000094', true, false);

insert into public.user_roles (user_id, role) values
  ('e0000000-0000-0000-0000-000000000001', 'director'),
  ('e0000000-0000-0000-0000-000000000002', 'manager'),
  ('e0000000-0000-0000-0000-000000000003', 'cashier'),
  ('e0000000-0000-0000-0000-000000000004', 'sales_rep');

-- Two seeded products, referenced by name so the test breaks loudly if the catalogue seed changes.
create or replace function tests.product(p_name text) returns uuid language sql stable as $$
  select id from public.products where name = p_name limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Suppliers · only a Director registers one
-- ---------------------------------------------------------------------------
select tests.acting_as('e0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select throws_ok(
  $$ select api.admin_add_supplier('Twiga Cement', 'sup-key-manager') $$,
  '42501', null,
  'a Manager cannot register a supplier');

select tests.acting_as('e0000000-0000-0000-0000-000000000004'::uuid);   -- Sales Rep

select throws_ok(
  $$ select api.admin_add_supplier('Twiga Cement', 'sup-key-rep') $$,
  '42501', null,
  'neither can a Sales Representative');

select is((select count(*)::int from public.suppliers), 0,
  'and not one refused attempt created a supplier');

select tests.acting_as('e0000000-0000-0000-0000-000000000001'::uuid);   -- Director

select is(
  (api.admin_add_supplier('Twiga Cement', 'sup-key-1') ->> 'reason'),
  'added',
  'a Director registers a supplier');

select is(
  (select created_by::text from public.suppliers where name = 'Twiga Cement'),
  'e0000000-0000-0000-0000-000000000001',
  'the acting Director is recorded from the session, not from an argument');

select is(
  (select is_active from public.suppliers where name = 'Twiga Cement'),
  true,
  'a new supplier is available immediately');

select is(
  (api.admin_add_supplier('  twiga   CEMENT ', 'sup-key-dup') ->> 'reason'),
  'supplier_exists',
  'the same name in different capitalisation and spacing is the same supplier');

select is(
  (api.admin_add_supplier('   ', 'sup-key-blank') ->> 'reason'),
  'supplier_name_required',
  'a blank supplier name is refused');

select is(
  (api.admin_add_supplier('Twiga Cement', 'sup-key-1') ->> 'reason'),
  'replayed',
  'an exact retry replays rather than creating a second supplier');

select is(
  (api.admin_add_supplier('Simba Sand', 'sup-key-1') ->> 'reason'),
  'idempotency_key_conflict',
  'the same key for a different supplier is a conflict, never a replay');

select is((select count(*)::int from public.suppliers), 1,
  'exactly one supplier exists after every duplicate, refusal and replay');

select is(
  (api.admin_add_supplier('Simba Sand', 'sup-key-2') ->> 'reason'),
  'added',
  'a second, genuinely different supplier is accepted');

-- Deactivation, and the absence of a rename or a delete
select is(
  (api.admin_set_supplier_active(
     (select id from public.suppliers where name = 'Simba Sand'), false, 'sup-key-off')
   ->> 'reason'),
  'deactivated',
  'a Director switches a supplier off');

select is(
  (api.admin_set_supplier_active(
     (select id from public.suppliers where name = 'Simba Sand'), false, 'sup-key-off-again')
   ->> 'reason'),
  'supplier_unchanged',
  'setting a supplier to the state it already holds is not a change, and is not recorded as one');

select is(
  (select coalesce(string_agg(grantee || ':' || privilege_type, ', '
                              order by grantee || ':' || privilege_type), '')
     from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'suppliers'
      and grantee in ('anon', 'authenticated', 'service_role')),
  'authenticated:SELECT',
  'staff may READ suppliers and nothing more: no client holds INSERT, UPDATE or DELETE');

-- ---------------------------------------------------------------------------
-- Opening stock · Director-only, once per product and location
-- ---------------------------------------------------------------------------
select tests.acting_as('e0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select throws_ok(
  $$ select api.admin_record_opening_stock(
       tests.product('Dangote Cement 42R'), 'store', 40, null, 'open-key-manager') $$,
  '42501', null,
  'a Manager cannot record opening stock');

select tests.acting_as('e0000000-0000-0000-0000-000000000001'::uuid);   -- Director

select is(
  (api.admin_record_opening_stock(
     tests.product('Dangote Cement 42R'), 'store', 40, 'counted at handover', 'open-key-1')
   ->> 'reason'),
  'recorded',
  'a Director records what the store started with');

select is(
  (select private.stock_on_hand(tests.product('Dangote Cement 42R'), 'store', 'available')),
  40::bigint,
  'and the balance is 40 bags, which is the sum of the ledger and not a stored number');

select is(
  (select approved_by::text from public.inventory_ledger
    where movement_kind = 'opening_stock'),
  'e0000000-0000-0000-0000-000000000001',
  'the movement names its authoriser, because no stock moves on nobody authority (AC-82)');

select is(
  (select actor_id = approved_by from public.inventory_ledger
    where movement_kind = 'opening_stock'),
  true,
  'on opening stock the Director is both the enterer and the authority, recorded as both (§4.2)');

select is(
  (api.admin_record_opening_stock(
     tests.product('Dangote Cement 42R'), 'store', 10, null, 'open-key-2')
   ->> 'reason'),
  'opening_stock_exists',
  'opening stock is entered ONCE per product and location');

select is(
  (select private.stock_on_hand(tests.product('Dangote Cement 42R'), 'store', 'available')),
  40::bigint,
  'and the refused second entry changed nothing');

select is(
  (api.admin_record_opening_stock(tests.product('Sand'), 'yard', 0, 'none in the yard', 'open-key-3')
   ->> 'reason'),
  'recorded',
  'a quantity of zero is a real answer: we looked, and there is none');

select is(
  (select count(*)::int from public.inventory_ledger
    where product_id = tests.product('Sand') and location_code = 'yard'),
  0,
  'and it writes no movement, because nothing moved -- the entry itself is the record');

select is(
  (api.admin_record_opening_stock(tests.product('Sand'), 'nowhere', 5, null, 'open-key-4')
   ->> 'reason'),
  'no_location',
  'an unknown location is refused');

-- ---------------------------------------------------------------------------
-- Supplier receiving · who may enter (§9.1, §4.1)
-- ---------------------------------------------------------------------------
select tests.acting_as('e0000000-0000-0000-0000-000000000001'::uuid);   -- Director

-- §4.1 names the Manager, the Cashier and the Sales Representative as enterers of a supplier
-- receipt. It does not name the Director, and seniority is not a licence to infer one.
select throws_ok(
  $$ select api.staff_enter_stock_receipt(
       (select id from public.suppliers where name = 'Twiga Cement'),
       'store', current_date, 'DN-001',
       jsonb_build_array(jsonb_build_object(
         'product_id', tests.product('Dangote Cement 42R'),
         'expected_quantity', 100, 'received_quantity', 100)),
       'rcv-key-director') $$,
  '42501', null,
  'a Director is not an enterer of supplier receipts -- product.md §4.1 names three roles and '
  'the Director is not one of them');

select tests.acting_as('e0000000-0000-0000-0000-000000000003'::uuid);   -- Cashier

select is(
  (api.staff_enter_stock_receipt(
     (select id from public.suppliers where name = 'Twiga Cement'),
     'store', current_date, 'DN-001',
     jsonb_build_array(jsonb_build_object(
       'product_id', tests.product('Dangote Cement 42R'),
       'expected_quantity', 100, 'received_quantity', 96, 'damaged_quantity', 2,
       'damage_note', 'two bags split in transit')),
     'rcv-key-1') ->> 'reason'),
  'entered',
  'entry is delegable to a Cashier (§9.1)');

select is(
  (select count(*)::int from public.inventory_ledger where movement_kind = 'supplier_receipt'),
  0,
  'and entering a receipt moves NO stock: entry is not approval (§9.1)');

select is(
  (select status::text from public.approval_requests
    where entity_type = 'stock_receipt' and approval_type = 'supplier_receipt'),
  'pending',
  'it records that a decision is owed');

select is(
  (select required_role::text from public.approval_requests
    where entity_type = 'stock_receipt' and approval_type = 'supplier_receipt'),
  'manager',
  'and that the Manager owes it (§4.1: Manager approval is always required)');

-- The calculated quantities, which no screen offers a field for (§5.2, AC-27, AC-28)
select is(
  (select short_quantity from public.stock_receipt_lines),
  4::bigint,
  'a shortage of four is calculated from expected minus received, never typed');

select is(
  (select excess_quantity from public.stock_receipt_lines),
  0::bigint,
  'and the excess is separately zero -- the two are different columns, so one cannot net the other');

select is(
  (select accepted_quantity from public.stock_receipt_lines),
  94::bigint,
  'what may become stock is received minus damaged: 96 arrived, 2 were broken');

select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'stock_receipt_lines'
      and column_name in ('short_quantity', 'excess_quantity', 'accepted_quantity')
      and is_generated <> 'ALWAYS'),
  0,
  'all three are GENERATED columns: there is nowhere to type them and nothing to override');

-- ---------------------------------------------------------------------------
-- Supplier receiving · who may approve
-- ---------------------------------------------------------------------------
select tests.acting_as('e0000000-0000-0000-0000-000000000003'::uuid);   -- Cashier

select throws_ok(
  $$ select api.staff_approve_stock_receipt(
       (select id from public.stock_receipts limit 1), 'rcv-approve-cashier') $$,
  '42501', null,
  'the Cashier who entered the receipt cannot approve it');

select tests.acting_as('e0000000-0000-0000-0000-000000000001'::uuid);   -- Director

select throws_ok(
  $$ select api.staff_approve_stock_receipt(
       (select id from public.stock_receipts limit 1), 'rcv-approve-director') $$,
  '42501', null,
  'and neither can a Director: §4.1 says Manager, and names no alternate');

select is((select count(*)::int from public.inventory_ledger
            where movement_kind = 'supplier_receipt'), 0,
  'no refused approval moved anything');

select tests.acting_as('e0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select is(
  (api.staff_approve_stock_receipt(
     (select id from public.stock_receipts limit 1), 'rcv-approve-1') ->> 'reason'),
  'approved',
  'the Manager approves it');

select is(
  (select private.stock_on_hand(tests.product('Dangote Cement 42R'), 'store', 'available')),
  134::bigint,
  'and stock rises by the ACCEPTED quantity: 40 opening plus 94 accepted, not 96 received');

select is(
  (select count(*)::int from public.inventory_ledger
    where movement_kind = 'supplier_receipt'
      and actor_id   = 'e0000000-0000-0000-0000-000000000003'      -- the Cashier who entered it
      and approved_by = 'e0000000-0000-0000-0000-000000000002'),   -- the Manager who approved it
  1,
  'the movement records the enterer and the approver separately (§4.2)');

select is(
  (select approved_by::text from public.approval_requests
    where entity_type = 'stock_receipt'),
  'e0000000-0000-0000-0000-000000000002',
  'an approved outcome records its approver');

select is(
  (select count(*)::int from public.approval_decisions d
     join public.approval_requests r on r.id = d.request_id
    where r.entity_type = 'stock_receipt' and d.outcome = 'approved'),
  1,
  'and the decision itself is in append-only history (§4.3)');

select is(
  (select short_quantity from public.stock_receipt_lines),
  4::bigint,
  'the shortage is STILL recorded after approval -- approving a delivery does not forgive it (§9.1)');

select is(
  (api.staff_approve_stock_receipt(
     (select id from public.stock_receipts limit 1), 'rcv-approve-2') ->> 'reason'),
  'already_settled',
  'a decision that has been made is not made again');

select is(
  (select private.stock_on_hand(tests.product('Dangote Cement 42R'), 'store', 'available')),
  134::bigint,
  'and the second approval added no second helping of stock');

select is(
  (api.staff_approve_stock_receipt(
     (select id from public.stock_receipts limit 1), 'rcv-approve-1') ->> 'reason'),
  'replayed',
  'while the SAME key replays, as every other command in this system does');

-- ---------------------------------------------------------------------------
-- Supplier receiving · rejection is a decision, not an approval (§4.3)
-- ---------------------------------------------------------------------------
select tests.acting_as('e0000000-0000-0000-0000-000000000004'::uuid);   -- Sales Rep

select is(
  (api.staff_enter_stock_receipt(
     (select id from public.suppliers where name = 'Twiga Cement'),
     'warehouse', current_date, 'DN-002',
     jsonb_build_array(jsonb_build_object(
       'product_id', tests.product('Dangote Cement 42R'),
       'expected_quantity', 50, 'received_quantity', 50)),
     'rcv-key-2') ->> 'reason'),
  'entered',
  'entry is delegable to a Sales Representative too (§9.1)');

select tests.acting_as('e0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select is(
  (api.staff_reject_stock_receipt(
     (select id from public.stock_receipts where delivery_note_ref = 'DN-002'),
     'wrong cement grade delivered', 'rcv-reject-1') ->> 'reason'),
  'rejected',
  'the Manager rejects a delivery');

select is(
  (select approved_by from public.approval_requests r
     join public.stock_receipts s on s.id = r.entity_id
    where s.delivery_note_ref = 'DN-002'),
  null,
  'a rejection records NO approver (§4.3, AC-84)');

select is(
  (select d.decided_by::text from public.approval_decisions d
     join public.approval_requests r on r.id = d.request_id
     join public.stock_receipts s on s.id = r.entity_id
    where s.delivery_note_ref = 'DN-002'),
  'e0000000-0000-0000-0000-000000000002',
  'the deciding Manager is recorded as the REJECTOR, in append-only decision history');

select is(
  (select private.stock_on_hand(tests.product('Dangote Cement 42R'), 'warehouse', 'available')),
  0::bigint,
  'and a rejected delivery adds nothing to the warehouse');

select is(
  (api.staff_approve_stock_receipt(
     (select id from public.stock_receipts where delivery_note_ref = 'DN-002'),
     'rcv-reject-then-approve') ->> 'reason'),
  'already_settled',
  'a rejected receipt cannot then be approved: a later decision never overwrites an earlier one');

-- ---------------------------------------------------------------------------
-- Supplier receiving · what the entry form refuses
-- ---------------------------------------------------------------------------
select tests.acting_as('e0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select is(
  (api.staff_enter_stock_receipt(
     (select id from public.suppliers where name = 'Twiga Cement'),
     'store', current_date + 1, 'DN-003',
     jsonb_build_array(jsonb_build_object(
       'product_id', tests.product('Sand'), 'expected_quantity', 1, 'received_quantity', 1)),
     'rcv-key-future') ->> 'reason'),
  'delivery_date_future',
  'a delivery cannot have arrived tomorrow');

select is(
  (api.staff_enter_stock_receipt(
     (select id from public.suppliers where name = 'Twiga Cement'),
     'store', current_date, 'DN-004',
     jsonb_build_array(jsonb_build_object(
       'product_id', tests.product('Sand'),
       'expected_quantity', 10, 'received_quantity', 5, 'damaged_quantity', 9)),
     'rcv-key-damaged') ->> 'reason'),
  'damaged_exceeds_received',
  'more damaged than arrived is not a delivery, it is a typing mistake');

select is(
  (api.staff_enter_stock_receipt(
     (select id from public.suppliers where name = 'Twiga Cement'),
     'store', current_date, 'DN-005',
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Sand'),
                          'expected_quantity', 10, 'received_quantity', 10),
       jsonb_build_object('product_id', tests.product('Sand'),
                          'expected_quantity', 5, 'received_quantity', 5)),
     'rcv-key-dup-line') ->> 'reason'),
  'duplicate_product_line',
  'one line per product, so two lines cannot disagree about the same delivery');

select is(
  (api.staff_enter_stock_receipt(
     (select id from public.suppliers where name = 'Twiga Cement'),
     'store', current_date, 'DN-006',
     jsonb_build_array(jsonb_build_object(
       'product_id', tests.product('Sand'), 'expected_quantity', 10, 'received_quantity', 2.5)),
     'rcv-key-fraction') ->> 'reason'),
  'quantity_not_whole',
  'half a bucket is not a quantity a counting unit can express (§6.1 rule 1)');

select is(
  (api.staff_enter_stock_receipt(
     (select id from public.suppliers where name = 'Twiga Cement'),
     'store', current_date, '   ',
     jsonb_build_array(jsonb_build_object(
       'product_id', tests.product('Sand'), 'expected_quantity', 10, 'received_quantity', 10)),
     'rcv-key-nonote') ->> 'reason'),
  'delivery_note_required',
  'supporting delivery information is required (§9), and required data cannot be skipped (§5.3)');

select is(
  (api.staff_enter_stock_receipt(
     (select id from public.suppliers where name = 'Twiga Cement'),
     'store', current_date, 'DN-007', '[]'::jsonb, 'rcv-key-nolines') ->> 'reason'),
  'lines_required',
  'a receipt with no lines records nothing and is refused');

select is(
  (api.staff_enter_stock_receipt(
     (select id from public.suppliers where name = 'Simba Sand'),
     'store', current_date, 'DN-008',
     jsonb_build_array(jsonb_build_object(
       'product_id', tests.product('Sand'), 'expected_quantity', 10, 'received_quantity', 10)),
     'rcv-key-inactive-supplier') ->> 'reason'),
  'no_supplier',
  'a switched-off supplier cannot be used for a new delivery');

select is((select count(*)::int from public.stock_receipts), 2,
  'and not one of those seven refusals created a receipt');

-- ---------------------------------------------------------------------------
-- Internal transfers (§10)
-- ---------------------------------------------------------------------------
select tests.acting_as('e0000000-0000-0000-0000-000000000003'::uuid);   -- Cashier

select throws_ok(
  $$ select api.staff_enter_stock_transfer('store', 'yard', null,
       jsonb_build_array(jsonb_build_object(
         'product_id', tests.product('Dangote Cement 42R'), 'quantity', 10)),
       'tr-key-cashier') $$,
  '42501', null,
  'a Cashier cannot enter an internal transfer -- §4.1 gives it to the Manager');

select tests.acting_as('e0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select is(
  (api.staff_enter_stock_transfer('store', 'store', null,
     jsonb_build_array(jsonb_build_object(
       'product_id', tests.product('Dangote Cement 42R'), 'quantity', 10)),
     'tr-key-same') ->> 'reason'),
  'same_location',
  'a transfer from a place to itself is not a transfer');

select is(
  (api.staff_enter_stock_transfer('store', 'yard', 'for the morning pour',
     jsonb_build_array(jsonb_build_object(
       'product_id', tests.product('Dangote Cement 42R'), 'quantity', 30)),
     'tr-key-1') ->> 'reason'),
  'entered',
  'the Manager enters a transfer');

select is(
  (select private.stock_on_hand(tests.product('Dangote Cement 42R'), 'store', 'available')),
  134::bigint,
  'and entering it moves nothing: balances change only on approval (§10)');

select is(
  (api.staff_approve_stock_transfer(
     (select id from public.stock_transfers limit 1), 'tr-approve-1') ->> 'reason'),
  'approved',
  'the Manager approves it -- §4.1 puts entry and approval on the same role, and §4.2 makes them '
  'two separate acts');

select is(
  (select private.stock_on_hand(tests.product('Dangote Cement 42R'), 'store', 'available')),
  104::bigint,
  'the store falls by thirty');

select is(
  (select private.stock_on_hand(tests.product('Dangote Cement 42R'), 'yard', 'available')),
  30::bigint,
  'and the yard rises by thirty -- one movement out, one movement in, both permanent');

select is(
  (select count(*)::int from public.inventory_ledger
    where movement_kind in ('transfer_out', 'transfer_in')),
  2,
  'a transfer is two ledger rows, not one row that moved');

-- Insufficient stock, checked at approval rather than at entry
select is(
  (api.staff_enter_stock_transfer('yard', 'warehouse', null,
     jsonb_build_array(jsonb_build_object(
       'product_id', tests.product('Dangote Cement 42R'), 'quantity', 500)),
     'tr-key-2') ->> 'reason'),
  'entered',
  'a transfer larger than the source holds may be ENTERED: stock can change before it is approved');

select is(
  (api.staff_approve_stock_transfer(
     (select id from public.stock_transfers where from_location = 'yard'), 'tr-approve-2')
   ->> 'reason'),
  'insufficient_stock_at_location',
  'and is refused at APPROVAL, which is the moment that decides anything -- by the LOCATION rule, '
  'because a transfer takes nothing out of the business and cannot consume a promise (issue #7)');

select is(
  (select private.stock_on_hand(tests.product('Dangote Cement 42R'), 'yard', 'available')),
  30::bigint,
  'the yard is untouched by the refusal');

select is(
  (select status::text from public.approval_requests r
     join public.stock_transfers t on t.id = r.entity_id
    where t.from_location = 'yard'),
  'pending',
  'and the transfer is still pending, not rejected -- nobody has decided anything about it');

select is(
  (api.staff_reject_stock_transfer(
     (select id from public.stock_transfers where from_location = 'yard'),
     'not enough cement in the yard', 'tr-reject-1') ->> 'reason'),
  'rejected',
  'the Manager can then reject it deliberately');

select is(
  (select approved_by from public.approval_requests r
     join public.stock_transfers t on t.id = r.entity_id
    where t.from_location = 'yard'),
  null,
  'and that rejection records no approver either (§4.3)');

-- ---------------------------------------------------------------------------
-- Manual stock adjustment (§4.1: Manager enters, Director approves)
-- ---------------------------------------------------------------------------
select tests.acting_as('e0000000-0000-0000-0000-000000000001'::uuid);   -- Director

select throws_ok(
  $$ select api.staff_enter_stock_adjustment(
       tests.product('Dangote Cement 42R'), 'yard', -5, 'four bags missing at count',
       'adj-key-director') $$,
  '42501', null,
  'a Director does not ENTER an adjustment -- §4.1 gives entry to the Manager');

select tests.acting_as('e0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select is(
  (api.staff_enter_stock_adjustment(
     tests.product('Dangote Cement 42R'), 'yard', -5, 'five bags missing at count', 'adj-key-1')
   ->> 'reason'),
  'entered',
  'the Manager records an unexplained loss');

select is(
  (select private.stock_on_hand(tests.product('Dangote Cement 42R'), 'yard', 'available')),
  30::bigint,
  'and nothing changes until it is approved');

select throws_ok(
  $$ select api.admin_approve_stock_adjustment(
       (select id from public.stock_adjustments limit 1), 'adj-approve-manager') $$,
  '42501', null,
  'the Manager who entered it cannot approve it -- §4.1 gives approval to the Director');

select tests.acting_as('e0000000-0000-0000-0000-000000000001'::uuid);   -- Director

select is(
  (api.admin_approve_stock_adjustment(
     (select id from public.stock_adjustments limit 1), 'adj-approve-1') ->> 'reason'),
  'approved',
  'the Director approves it');

select is(
  (select private.stock_on_hand(tests.product('Dangote Cement 42R'), 'yard', 'available')),
  25::bigint,
  'and only then does the yard fall by five');

select tests.acting_as('e0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select is(
  (api.staff_enter_stock_adjustment(
     tests.product('Dangote Cement 42R'), 'yard', -900, 'everything gone', 'adj-key-2')
   ->> 'reason'),
  'entered',
  'an adjustment bigger than the balance may be entered');

select tests.acting_as('e0000000-0000-0000-0000-000000000001'::uuid);   -- Director

select is(
  (api.admin_approve_stock_adjustment(
     (select id from public.stock_adjustments where quantity_delta = -900), 'adj-approve-2')
   ->> 'reason'),
  'insufficient_stock',
  'and is refused at approval: a location cannot hold less than nothing');

select is(
  (select private.stock_on_hand(tests.product('Dangote Cement 42R'), 'yard', 'available')),
  25::bigint,
  'the yard is unchanged by the refusal');

-- ---------------------------------------------------------------------------
-- The ledger cannot be rewritten, by anybody (§16)
--
-- These statements run as the TABLE OWNER, the one role a GRANT does not constrain — which is
-- exactly why the refusal has to come from a trigger rather than from a privilege.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ update public.inventory_ledger set quantity_delta = 1 $$,
  '23001', null,
  'no role can UPDATE a movement, the table owner included');

select throws_ok(
  $$ delete from public.inventory_ledger $$,
  '23001', null,
  'and no role can DELETE one');

select is(
  (select coalesce(string_agg(distinct privilege_type, ', ' order by privilege_type), '')
     from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'inventory_ledger'
      and grantee in ('anon', 'authenticated', 'service_role')),
  'SELECT',
  'and no client holds anything but SELECT on it in the first place');

select is(
  (select count(*)::int from information_schema.table_privileges
    where grantee = 'service_role' and table_schema = 'public'
      and table_name in ('suppliers', 'inventory_ledger', 'stock_receipts',
                         'stock_receipt_lines', 'stock_transfers', 'stock_transfer_lines',
                         'stock_adjustments', 'opening_stock_entries')),
  0,
  'a leaked secret key reaches none of the stock tables: service_role holds no privilege at all');

-- ---------------------------------------------------------------------------
-- current_stock · the view agrees with the ledger, and keeps a zero
-- ---------------------------------------------------------------------------
select is(
  (select quantity from public.current_stock
    where product_id = tests.product('Dangote Cement 42R')
      and location_code = 'yard' and stock_state = 'available'),
  25::bigint,
  'the view is the sum of the ledger and holds no number of its own');

select is(
  (select count(*)::int from public.current_stock
    where product_id = tests.product('Dangote Cement 42R') and location_code = 'warehouse'),
  0,
  'a location that never received a product has no row, which is different from holding none');

-- Prove the zero case is kept rather than filtered away: move the whole yard out and look again.
select tests.acting_as('e0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select is(
  (api.staff_enter_stock_transfer('yard', 'warehouse', 'emptying the yard',
     jsonb_build_array(jsonb_build_object(
       'product_id', tests.product('Dangote Cement 42R'), 'quantity', 25)),
     'tr-key-3') ->> 'reason'),
  'entered',
  'the Manager moves the whole yard to the warehouse');

-- Selected by its note, because the earlier refused-then-rejected transfer was also yard to
-- warehouse and there is deliberately no rule stopping two transfers sharing a route.
select is(
  (api.staff_approve_stock_transfer(
     (select id from public.stock_transfers where note = 'emptying the yard'), 'tr-approve-3')
   ->> 'reason'),
  'approved',
  'and approves it');

select is(
  (select quantity from public.current_stock
    where product_id = tests.product('Dangote Cement 42R')
      and location_code = 'yard' and stock_state = 'available'),
  0::bigint,
  'the yard now reads ZERO rather than disappearing: "there is none left" and "it was never here" '
  'are different answers and must not look alike');

-- ---------------------------------------------------------------------------
-- Every movement is traceable back to the document that justifies it (§1)
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from public.inventory_ledger l
    where not exists (
      select 1 from public.opening_stock_entries e
       where l.source_type = 'opening_stock_entry' and e.id = l.source_id)
      and not exists (
      select 1 from public.stock_receipts r
       where l.source_type = 'stock_receipt' and r.id = l.source_id)
      and not exists (
      select 1 from public.stock_transfers t
       where l.source_type = 'stock_transfer' and t.id = l.source_id)
      and not exists (
      select 1 from public.stock_adjustments a
       where l.source_type = 'stock_adjustment' and a.id = l.source_id)),
  0,
  'not one movement in the ledger points at a document that does not exist');

select is(
  (select count(*)::int from public.inventory_ledger where approved_by is null),
  0,
  'and not one moved without an authoriser (AC-82)');

select * from finish();
rollback;
