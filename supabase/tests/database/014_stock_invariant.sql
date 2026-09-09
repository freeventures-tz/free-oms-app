-- Issue #7 · One stock-availability rule across inventory, sales, production and release
--
-- The defect this file exists to prevent coming back: production consumption and negative
-- corrections read the PHYSICAL balance of one location and nothing else. Stock a customer has
-- already been promised is physically present, so a batch could grind up goods that were sold, and
-- the dispatch that followed found an empty yard.
--
-- The rule, stated once and enforced everywhere below:
--
--   1. UNPROMISED STOCK. A command that takes stock OUT of the business must leave
--        available = physical − outstanding reserved − outstanding committed
--      at or above zero. That is product.md §8.1, applied to consumption rather than only to sale.
--
--   2. LOCATION STOCK. A command that names a location must ALSO find the quantity physically
--      there. The two are separate requirements and are refused separately, because
--      "the business owns enough but not here" and "the business does not own enough" are
--      different problems with different answers.
--
--   3. ONE LOCK ORDER. A command that takes both keys takes `stock:<product>` before
--      `<location>:<product>`, in ascending product order — and not every command takes both.
--      Reservation and the walk-in sale take the product key alone; production and downward
--      corrections take the product key and then the location key; release takes the location key
--      alone, and needs no more because it moves no availability. Both keys already existed; what
--      was missing was that inventory and production took only the location key while sales took
--      only the product key, so a reservation and a batch approval never met. They meet now.
--
--   4. A REFUSAL IS RECORDED. It commits, so it can be audited, and it is: actor, live role,
--      operation, reason, entity and correlation id (architecture.md §14.2).
--
--   5. WHOLE COUNTING UNITS. Every quantity in this ground is a whole count of the product's
--      counting unit (product.md §6.1). There is no fractional column to hold half a bag.
--
-- SCOPE. By owner decision this ticket re-issues the inventory and production commands only.
-- Reservation and the walk-in sale already lock `stock:<product>` and already check §8.1; release
-- locks only `<location>:<product>` and checks only the location, which is all it needs — a release
-- does not move the §8.1 figure, because the ledger falls by what left and the claim that covered
-- it falls with it. So the flows below exercise all three unchanged, and what this file proves
-- about them is that they still work AFTER a refusal — the point of protecting the promise at all.
-- Stage 12B adopts the shared helpers when it re-issues those three.
create extension if not exists pgtap with schema extensions;

begin;
select plan(81);

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

select tests.mk_user('a1000000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('a1000000-0000-0000-0000-000000000002'::uuid);  -- Manager
select tests.mk_user('a1000000-0000-0000-0000-000000000003'::uuid);  -- Cashier
select tests.mk_user('a1000000-0000-0000-0000-000000000004'::uuid);  -- Sales Representative

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('a1000000-0000-0000-0000-000000000001', 'Invariant Director', '+255700000151', true, false),
  ('a1000000-0000-0000-0000-000000000002', 'Invariant Manager',  '+255700000152', true, false),
  ('a1000000-0000-0000-0000-000000000003', 'Invariant Cashier',  '+255700000153', true, false),
  ('a1000000-0000-0000-0000-000000000004', 'Invariant Rep',      '+255700000154', true, false);

insert into public.user_roles (user_id, role) values
  ('a1000000-0000-0000-0000-000000000001', 'director'),
  ('a1000000-0000-0000-0000-000000000002', 'manager'),
  ('a1000000-0000-0000-0000-000000000003', 'cashier'),
  ('a1000000-0000-0000-0000-000000000004', 'sales_rep');

create or replace function tests.product(p_name text) returns uuid language sql stable as $$
  select id from public.products where name = p_name limit 1;
$$;

create or replace function tests.cement() returns uuid language sql stable as $$
  select tests.product('Dangote Cement 42R');
$$;

/**
 * A batch input list that confirms EVERY recipe input, with only the cement carrying a quantity.
 *
 * `api.staff_enter_production_batch` refuses `incomplete_recipe_inputs` unless every input in the
 * recipe is answered for (AC-39: the actual usage is recorded before a batch can be completed), and
 * confirming ZERO is an answer — it is a real one in the yard, and the released command accepts it.
 * So the sand and the aggregate are confirmed at zero and the cement carries the whole quantity,
 * which keeps every assertion in this file about the one product the promise is made on.
 */
create or replace function tests.batch_inputs(p_cement bigint) returns jsonb language sql stable as $$
  select jsonb_build_array(
    jsonb_build_object('product_id', tests.cement(), 'actual_quantity', p_cement),
    jsonb_build_object('product_id', tests.product('Sand'), 'actual_quantity', 0),
    jsonb_build_object('product_id', tests.product('Aggregate'), 'actual_quantity', 0));
$$;

/**
 * The last refusal recorded for one operation, as the audit trail holds it.
 *
 * Asserted through this rather than by reading the returned jsonb, because the point of the rule is
 * that the refusal SURVIVES the transaction. A function that returned the right numbers and wrote
 * nothing would pass every other test in this file.
 */
create or replace function tests.last_refusal(p_operation text)
returns public.audit_events language sql stable as $$
  select * from public.audit_events
   where action = 'command_refused'
     and source_operation = p_operation
   order by occurred_at desc, id desc
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Cement: a product a customer buys AND a batch consumes
--
-- The whole defect lives in that overlap, so the fixture is built on it deliberately. §11.1 makes
-- cement a recipe input and §6 sells it by the bag.
-- ---------------------------------------------------------------------------
select tests.acting_as('a1000000-0000-0000-0000-000000000001'::uuid);   -- Director

select is(
  (api.admin_set_product_price(tests.cement(), 20000, 'opening', 'inv-price-1') ->> 'reason'),
  'set', 'a Director prices the cement, because nothing is sold at a figure nobody approved');

select is(
  (api.admin_record_opening_stock(tests.cement(), 'yard', 100, null, 'inv-open-1') ->> 'reason'),
  'recorded', 'and the yard starts with one hundred bags');

select is(
  (select available_quantity from public.product_availability where product_id = tests.cement()),
  100::bigint,
  'all hundred can be sold: nothing is promised to anybody yet');

-- ---------------------------------------------------------------------------
-- Eighty bags are promised to a customer
-- ---------------------------------------------------------------------------
select tests.acting_as('a1000000-0000-0000-0000-000000000004'::uuid);   -- Sales Rep

select is(
  (api.staff_add_customer('Invariant Builders', 'inv-cust-1') ->> 'reason'),
  'added', 'a customer exists to promise stock to');

select is(
  (api.staff_create_order(
     (select id from public.customers where name = 'Invariant Builders'),
     jsonb_build_array(jsonb_build_object('product_id', tests.cement(), 'quantity', 80)),
     'inv-order-1') ->> 'reason'),
  'created', 'and orders eighty bags');

select is(
  (api.staff_confirm_order(
     (select id from public.orders where id in
        (select order_id from public.order_lines where quantity = 80)),
     'inv-confirm-1') ->> 'reason'),
  'confirmed', 'confirmation reserves them (§8.1, AC-34)');

select is(
  (select available_quantity from public.product_availability where product_id = tests.cement()),
  20::bigint,
  'twenty are left to sell, though a hundred are still physically in the yard');

select is(
  (select private.stock_on_hand(tests.cement(), 'yard', 'available')),
  100::bigint,
  'which is exactly the trap: the LOCATION still reads a hundred');

-- ---------------------------------------------------------------------------
-- THE DEFECT · Production may not consume what a customer has been promised
-- ---------------------------------------------------------------------------
select tests.acting_as('a1000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select is(
  (api.staff_enter_production_batch(
     'yard', now(),
     tests.batch_inputs(50),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 22)),
     null, 'inv-batch-1') ->> 'reason'),
  'entered',
  'a batch claiming fifty bags may be ENTERED: entry decides nothing (§11.1, AC-39)');

select is(
  (api.staff_approve_production_batch(
     (select batch_id from public.production_batch_inputs where actual_quantity = 50),
     'inv-batch-approve-1') ->> 'reason'),
  'insufficient_stock',
  'and is REFUSED at approval: fifty of the hundred are already somebody else''s');

select is(
  (api.staff_approve_production_batch(
     (select batch_id from public.production_batch_inputs where actual_quantity = 50),
     'inv-batch-approve-1b') -> 'available')::text,
  '20',
  'the refusal says how much may actually be taken');

select is(
  (api.staff_approve_production_batch(
     (select batch_id from public.production_batch_inputs where actual_quantity = 50),
     'inv-batch-approve-1c') -> 'promised')::text,
  '80',
  'and how much is promised, which is the sentence the interface has to be able to write');

select is(
  (api.staff_approve_production_batch(
     (select batch_id from public.production_batch_inputs where actual_quantity = 50),
     'inv-batch-approve-1d') -> 'requested')::text,
  '50',
  'beside what was asked for');

select is(
  (api.staff_approve_production_batch(
     (select batch_id from public.production_batch_inputs where actual_quantity = 50),
     'inv-batch-approve-1e') -> 'physical')::text,
  '100',
  'and what is physically there, so nobody thinks the yard has been miscounted');

select is(
  (select private.stock_on_hand(tests.cement(), 'yard', 'available')),
  100::bigint,
  'the yard is untouched by five refusals');

select is(
  (select status::text from public.production_batches
    where id = (select batch_id from public.production_batch_inputs where actual_quantity = 50)),
  'draft',
  'and the batch is still a draft, not half-approved');

-- The refusal is on the record, not merely on the screen (architecture.md §14.2).
select isnt(
  (select id from tests.last_refusal('api.staff_approve_production_batch')),
  null,
  'the refusal is written to the audit trail, because it committed');

select is(
  (select actor_id::text from tests.last_refusal('api.staff_approve_production_batch')),
  'a1000000-0000-0000-0000-000000000002',
  'naming the person who attempted it');

select is(
  (select actor_role::text from tests.last_refusal('api.staff_approve_production_batch')),
  'manager',
  'and the live role they held at the time');

select is(
  (select after_state ->> 'reason' from tests.last_refusal('api.staff_approve_production_batch')),
  'insufficient_stock',
  'and why it was refused');

select is(
  (select after_state ->> 'available' from tests.last_refusal('api.staff_approve_production_batch')),
  '20',
  'with the numbers, so the trail says what was refused and not merely that something was');

select is(
  (select after_state ->> 'outcome' from tests.last_refusal('api.staff_approve_production_batch')),
  'refused',
  'marked as a refusal rather than left to be inferred from the action name');

select is(
  (select entity_type from tests.last_refusal('api.staff_approve_production_batch')),
  'production_batch',
  'against the entity it was refused on');

select isnt(
  (select correlation_id from tests.last_refusal('api.staff_approve_production_batch')),
  null,
  'with a correlation identifier, generated by the database because no api function accepts one');

select isnt(
  (select occurred_at from tests.last_refusal('api.staff_approve_production_batch')),
  null,
  'and the moment it happened');

-- ---------------------------------------------------------------------------
-- THE DEFECT, second door · a negative correction may not take promised stock either
-- ---------------------------------------------------------------------------
select is(
  (api.staff_enter_stock_adjustment(tests.cement(), 'yard', -50, 'stolen overnight', 'inv-adj-1')
   ->> 'reason'),
  'entered',
  'a Manager may enter a correction of minus fifty');

select tests.acting_as('a1000000-0000-0000-0000-000000000001'::uuid);   -- Director

select is(
  (api.admin_approve_stock_adjustment(
     (select id from public.stock_adjustments where quantity_delta = -50), 'inv-adj-approve-1')
   ->> 'reason'),
  'insufficient_stock',
  'and a Director approving it is refused for the same reason: eighty are spoken for');

select is(
  (api.admin_approve_stock_adjustment(
     (select id from public.stock_adjustments where quantity_delta = -50), 'inv-adj-approve-1b')
   -> 'promised')::text,
  '80',
  'the correction refusal carries the promised figure too');

select is(
  (select private.stock_on_hand(tests.cement(), 'yard', 'available')),
  100::bigint,
  'and nothing was written off');

select is(
  (select after_state ->> 'reason' from tests.last_refusal('api.admin_approve_stock_adjustment')),
  'insufficient_stock',
  'the refused correction is audited under its own operation name');

-- A correction that fits inside the unpromised twenty is a different matter and goes through.
select tests.acting_as('a1000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select is(
  (api.staff_enter_stock_adjustment(tests.cement(), 'yard', -5, 'five bags split', 'inv-adj-2')
   ->> 'reason'),
  'entered', 'a smaller correction is entered');

select tests.acting_as('a1000000-0000-0000-0000-000000000001'::uuid);   -- Director

select is(
  (api.admin_approve_stock_adjustment(
     (select id from public.stock_adjustments where quantity_delta = -5), 'inv-adj-approve-2')
   ->> 'reason'),
  'approved',
  'because five is inside the twenty nobody has been promised');

select is(
  (select available_quantity from public.product_availability where product_id = tests.cement()),
  15::bigint,
  'leaving fifteen unpromised');

-- ---------------------------------------------------------------------------
-- The location check is a SEPARATE requirement, and stays one
--
-- The store holds no cement at all. The business owns fifteen unpromised bags, so the promise
-- check passes and the LOCATION check is what refuses — a different answer, needing a different
-- sentence on the screen.
-- ---------------------------------------------------------------------------
select tests.acting_as('a1000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select is(
  (api.staff_enter_production_batch(
     'store', now(),
     tests.batch_inputs(10),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 22)),
     null, 'inv-batch-2') ->> 'reason'),
  'entered', 'a batch at the store may be entered');

select is(
  (api.staff_approve_production_batch(
     (select batch_id from public.production_batch_inputs where actual_quantity = 10),
     'inv-batch-approve-2') ->> 'reason'),
  'insufficient_stock_at_location',
  'and is refused because the STORE holds none, not because the business owns none');

select is(
  (api.staff_approve_production_batch(
     (select batch_id from public.production_batch_inputs where actual_quantity = 10),
     'inv-batch-approve-2b') ->> 'location'),
  'store',
  'the refusal names the location it looked in');

-- A transfer is judged by the location alone: it takes nothing out of the business, so it cannot
-- consume a promise however large the promise is.
select is(
  (api.staff_enter_stock_transfer('yard', 'store', null,
     jsonb_build_array(jsonb_build_object('product_id', tests.cement(), 'quantity', 95)),
     'inv-tr-1') ->> 'reason'),
  'entered', 'a transfer of ninety-five bags is entered');

select is(
  (api.staff_approve_stock_transfer(
     (select id from public.stock_transfers where from_location = 'yard'), 'inv-tr-approve-1')
   ->> 'reason'),
  'approved',
  'and approved: moving promised stock between our own places does not consume it');

select is(
  (select available_quantity from public.product_availability where product_id = tests.cement()),
  15::bigint,
  'availability is unchanged by the move, because the business still owns the same bags');

select is(
  (select private.stock_on_hand(tests.cement(), 'yard', 'available')),
  0::bigint,
  'the yard is now empty');

select is(
  (api.staff_enter_stock_transfer('yard', 'store', null,
     jsonb_build_array(jsonb_build_object('product_id', tests.cement(), 'quantity', 1)),
     'inv-tr-2') ->> 'reason'),
  'entered', 'one more bag is asked for from the empty yard');

-- Selected by its LINE, not by `order by entered_at desc`. Both transfers were entered in this one
-- transaction, so `now()` gives them the identical timestamp and the ordering picks arbitrarily —
-- the same trap `inventory_ledger.entry_seq` exists to avoid, met again in a test.
select is(
  (api.staff_approve_stock_transfer(
     (select transfer_id from public.stock_transfer_lines where quantity = 1),
     'inv-tr-approve-2') ->> 'reason'),
  'insufficient_stock_at_location',
  'and the location refusal is the one that fires');

select is(
  (select after_state ->> 'reason' from tests.last_refusal('api.staff_approve_stock_transfer')),
  'insufficient_stock_at_location',
  'audited under the transfer operation');

-- ---------------------------------------------------------------------------
-- AC · After a refused batch and a refused correction, the customer still gets their goods
--
-- This is the point of the whole rule. The promise was protected so that this can happen.
-- ---------------------------------------------------------------------------
select tests.acting_as('a1000000-0000-0000-0000-000000000003'::uuid);   -- Cashier

select is(
  (api.staff_record_payment(
     (select id from public.invoices limit 1), 'cash', 1600000, 'inv-pay-1') ->> 'reason'),
  'recorded', 'the customer pays for their eighty bags in full');

select is(
  (api.staff_approve_settlement((select id from public.invoices limit 1), 'inv-settle-1')
   ->> 'reason'),
  'approved', 'the Cashier settles the invoice');

-- ---------------------------------------------------------------------------
-- COMMITTED stock is protected exactly as RESERVED stock was
--
-- §8.1 lists reserved and committed as two states of one promise, and both are subtracted. Every
-- refusal above happened while the claim was RESERVED — an order confirmed and not yet paid. Once
-- the customer has paid and the Cashier has settled, the claim becomes COMMITTED, the goods are
-- still standing in the store, and they are MORE spoken for than before, not less: §8 says paid
-- items remain physically present until signature and cannot be sold again.
--
-- So the same two commands are asked again here, against the same bags in the same place, and must
-- be refused for the same reason. A rule that protected a reservation and released its grip the
-- moment money changed hands would fail at the only point that actually matters.
-- ---------------------------------------------------------------------------
select is(
  (select reserved_quantity from public.product_availability where product_id = tests.cement()),
  0::bigint,
  'settlement moved the claim out of reserved');

select is(
  (select committed_quantity from public.product_availability where product_id = tests.cement()),
  80::bigint,
  'and into committed, where §8.1 subtracts it just the same');

select is(
  (select available_quantity from public.product_availability where product_id = tests.cement()),
  15::bigint,
  'so fifteen of the ninety-five bags are still the only ones anybody may take');

select tests.acting_as('a1000000-0000-0000-0000-000000000002'::uuid);   -- Manager

-- Twenty: more than the fifteen available, far less than the ninety-five physically at the store.
-- The location can supply it and the business cannot, which is the whole distinction.
select is(
  (api.staff_enter_production_batch(
     'store', now(), tests.batch_inputs(20),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 22)),
     null, 'inv-batch-committed') ->> 'reason'),
  'entered', 'a batch for twenty bags is entered while eighty are paid for');

select is(
  (api.staff_approve_production_batch(
     (select batch_id from public.production_batch_inputs where actual_quantity = 20),
     'inv-batch-committed-approve') ->> 'reason'),
  'insufficient_stock',
  'and refused: COMMITTED stock is somebody else''s, not merely reserved');

select is(
  (api.staff_approve_production_batch(
     (select batch_id from public.production_batch_inputs where actual_quantity = 20),
     'inv-batch-committed-approve-b') -> 'promised')::text,
  '80',
  'the refusal names the eighty that were paid for');

select is(
  (api.staff_approve_production_batch(
     (select batch_id from public.production_batch_inputs where actual_quantity = 20),
     'inv-batch-committed-approve-c') -> 'available')::text,
  '15',
  'beside the fifteen that are genuinely free');

select is(
  (select after_state ->> 'reason' from tests.last_refusal('api.staff_approve_production_batch')),
  'insufficient_stock',
  'and the committed-stock refusal is audited like any other');

select is(
  (api.staff_enter_stock_adjustment(tests.cement(), 'store', -20, 'damp damage', 'inv-adj-committed')
   ->> 'reason'),
  'entered', 'a correction writing off twenty is entered against the same bags');

select tests.acting_as('a1000000-0000-0000-0000-000000000001'::uuid);   -- Director

select is(
  (api.admin_approve_stock_adjustment(
     (select id from public.stock_adjustments where quantity_delta = -20),
     'inv-adj-committed-approve') ->> 'reason'),
  'insufficient_stock',
  'and a Director approving it is refused too: writing off paid goods is the same loss');

select is(
  (api.admin_approve_stock_adjustment(
     (select id from public.stock_adjustments where quantity_delta = -20),
     'inv-adj-committed-approve-b') -> 'promised')::text,
  '80',
  'with the same promised figure behind it');

select is(
  (select after_state ->> 'reason' from tests.last_refusal('api.admin_approve_stock_adjustment')),
  'insufficient_stock',
  'audited under the correction operation');

-- Neither refusal moved anything. This is the assertion that makes the two above worth making.
select is(
  (select private.stock_on_hand(tests.cement(), 'store', 'available')),
  95::bigint,
  'the store still holds all ninety-five bags');

select is(
  (select available_quantity from public.product_availability where product_id = tests.cement()),
  15::bigint,
  'and availability is untouched by two refusals');

select is(
  (select status::text from public.production_batches
    where id = (select batch_id from public.production_batch_inputs where actual_quantity = 20)),
  'draft',
  'the refused batch is still a draft');

select tests.acting_as('a1000000-0000-0000-0000-000000000001'::uuid);   -- Director

select is(
  (api.admin_add_storekeeper('Neema Kileo', '0713000151', current_date, null, 'inv-sk-1')
   ->> 'reason'),
  'added', 'a storekeeper receives the goods out');

select tests.acting_as('a1000000-0000-0000-0000-000000000003'::uuid);   -- Cashier

select is(
  (api.staff_assign_dispatch(
     (select id from public.invoices limit 1),
     (select id from public.storekeepers where full_name = 'Neema Kileo'),
     'store',
     jsonb_build_array(jsonb_build_object(
       'allocation_id', (select id from public.stock_allocations limit 1),
       'quantity', 80)),
     'inv-dsk-1') ->> 'reason'),
  'assigned', 'the dispatch is assigned against the store, where the bags now are');

select tests.acting_as('a1000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select is(
  (api.staff_record_dispatch_note(
     (select id from public.dispatches limit 1), 'DN-INV-0001', 'inv-note-1') ->> 'reason'),
  'recorded', 'the physical note number is written down');

select is(
  (api.staff_confirm_release((select id from public.dispatches limit 1), 'inv-release-1')
   ->> 'reason'),
  'released',
  'and the release completes normally, which the refusals above are what made possible');

select is(
  (select private.stock_on_hand(tests.cement(), 'store', 'available')),
  15::bigint,
  'the store falls by the eighty that were handed over');

select is(
  (select available_quantity from public.product_availability where product_id = tests.cement()),
  15::bigint,
  'and the fifteen unpromised bags are still sellable, counted once');

-- Now that nothing is promised, the same batch quantity the yard refused earlier is allowed.
select is(
  (api.staff_enter_production_batch(
     'store', now(),
     tests.batch_inputs(15),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 22)),
     null, 'inv-batch-3') ->> 'reason'),
  'entered', 'a batch for the whole remaining balance is entered');

select is(
  (api.staff_approve_production_batch(
     (select batch_id from public.production_batch_inputs where actual_quantity = 15),
     'inv-batch-approve-3') ->> 'reason'),
  'approved',
  'and approved, because the promise it would have broken has been discharged');

select is(
  (select available_quantity from public.product_availability where product_id = tests.cement()),
  0::bigint,
  'the cement is gone, and availability reached zero without ever passing through a negative');

-- ---------------------------------------------------------------------------
-- The invariant is enforced by the DATABASE, not only by the commands
--
-- Every command above remembers to check. The next command somebody writes might not, so the
-- constraint runs for every writer including the table owner.
-- ---------------------------------------------------------------------------
select tests.acting_as('a1000000-0000-0000-0000-000000000004'::uuid);   -- Sales Rep

select is(
  (api.staff_create_order(
     (select id from public.customers where name = 'Invariant Builders'),
     jsonb_build_array(jsonb_build_object('product_id', tests.cement(), 'quantity', 5)),
     'inv-order-2') ->> 'reason'),
  'created',
  'a second order for five bags is WRITTEN without complaint: §12.6 reserves nothing until '
  'confirmation, so an order may be taken for stock that still has to be bought');

-- The claim is written STRAIGHT INTO THE TABLE, past every command, as the table owner — the one
-- role a GRANT does not constrain. `set constraints all immediate` is what makes the deferred
-- trigger fire here rather than at a commit this test never reaches.
select throws_ok(
  $$
    do $inner$
    begin
      insert into public.stock_allocations (order_id, order_line_id, product_id, quantity, state)
      select l.order_id, l.id, l.product_id, l.quantity, 'reserved'
        from public.order_lines l
       where l.quantity = 5 and l.product_id = tests.cement();

      execute 'set constraints all immediate';
    end
    $inner$
  $$,
  '23514', null,
  'but the claim itself is refused: there is no stock left to promise, and the rule holds for '
  'whoever writes the row');

select is(
  (select available_quantity from public.product_availability where product_id = tests.cement()),
  0::bigint,
  'and availability never went negative');

-- ---------------------------------------------------------------------------
-- Role boundaries this ticket must not have loosened
-- ---------------------------------------------------------------------------
select tests.acting_as('a1000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select throws_ok(
  $$ select api.admin_add_supplier('Manager Cement Ltd', 'inv-sup-mgr') $$,
  '42501', null,
  'registering a supplier is still a Director''s, and a Manager is refused');

select throws_ok(
  $$ select api.admin_record_opening_stock(
       tests.product('Sand'), 'yard', 10, null, 'inv-open-mgr') $$,
  '42501', null,
  'and so is opening stock, which creates inventory no delivery note justifies');

select tests.acting_as('a1000000-0000-0000-0000-000000000001'::uuid);   -- Director

select is(
  (api.admin_add_supplier('Invariant Cement Ltd', 'inv-sup-1') ->> 'reason'),
  'added', 'a Director registers the supplier');

select tests.acting_as('a1000000-0000-0000-0000-000000000003'::uuid);   -- Cashier

select is(
  (api.staff_enter_stock_receipt(
     (select id from public.suppliers where name = 'Invariant Cement Ltd'),
     'yard', current_date, 'DN-INV-77',
     jsonb_build_array(jsonb_build_object(
       'product_id', tests.cement(), 'expected_quantity', 40,
       'received_quantity', 40, 'damaged_quantity', 0)),
     'inv-rec-1') ->> 'reason'),
  'entered',
  'a Cashier may still ENTER a receipt: §9.1 delegates entry and keeps approval separate');

select is(
  (select private.stock_on_hand(tests.cement(), 'yard', 'available')),
  0::bigint,
  'and entry moved nothing, because the two transitions remain separate');

select throws_ok(
  $$ select api.staff_approve_stock_receipt(
       (select id from public.stock_receipts where delivery_note_ref = 'DN-INV-77'),
       'inv-rec-approve-cashier') $$,
  '42501', null,
  'the same Cashier cannot approve it -- approval is the Manager''s (§9.1)');

select tests.acting_as('a1000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select is(
  (api.staff_approve_stock_receipt(
     (select id from public.stock_receipts where delivery_note_ref = 'DN-INV-77'),
     'inv-rec-approve-1') ->> 'reason'),
  'approved', 'the Manager approves, and only now does stock arrive');

select is(
  (select available_quantity from public.product_availability where product_id = tests.cement()),
  40::bigint,
  'forty bags, every one of them sellable because nobody has been promised any');

-- ---------------------------------------------------------------------------
-- Whole counting units (product.md §6.1)
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int
     from information_schema.columns
    where table_schema = 'public'
      and table_name in ('inventory_ledger', 'stock_allocations', 'stock_adjustments',
                         'stock_transfer_lines', 'stock_receipt_lines', 'opening_stock_entries',
                         'production_batch_inputs', 'production_lots')
      and data_type in ('numeric', 'real', 'double precision')),
  0,
  'not one quantity in stock or production is held in a type that can hold half a bag');

select finish();
rollback;
