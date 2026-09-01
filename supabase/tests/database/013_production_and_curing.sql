-- Stage 13 · Brick production, curing and inspection
--
-- The claims under test, each traceable to product.md rather than to a preference:
--
--   §11.1  The recipe is the EXPECTED standard, never the deduction. Approval consumes the
--          confirmed ACTUAL quantity, and the variance is recorded rather than used to pull the
--          deduction back toward the recipe (AC-38).
--   §11.1  Recording a batch deducts nothing. The Manager's approval is what consumes the yard
--          (AC-39).
--   §11.1  Content is never a quantity: one bag is one, not fifty (AC-120). Stage 10 Part C
--          separated the counting unit from what it contains for exactly this moment.
--   §11.2  Output outside the approved range is FLAGGED and EXPLAINED, never blocked (AC-41).
--   §11.4  Two brick sizes from one batch are two lots with two clocks, even sharing a timestamp.
--   §11.4  Moulded bricks enter CURING, not available stock. Reaching 72 hours makes a lot ready
--          for INSPECTION and nothing more (AC-44).
--   §11.4  ONLY the Manager-accepted quantity becomes sellable (AC-45).
--   §11.5  Reject reasons come from the four preset values and are never typed (AC-3, AC-45).
--   §4.1   A Manager enters and approves a batch. Nobody else touches one, refused by the database.
--   §4.3   A rejection is a completed decision that is NOT an approval: it consumes nothing.
--   §16    A movement, once written, cannot be edited or deleted by anybody.
--   AC-82  No silent stock change: every ledger row names its cause, its actor and its authoriser.
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

select tests.mk_user('f0000000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('f0000000-0000-0000-0000-000000000002'::uuid);  -- Manager
select tests.mk_user('f0000000-0000-0000-0000-000000000003'::uuid);  -- Cashier
select tests.mk_user('f0000000-0000-0000-0000-000000000004'::uuid);  -- Sales Representative

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('f0000000-0000-0000-0000-000000000001', 'Yard Director', '+255700000081', true, false),
  ('f0000000-0000-0000-0000-000000000002', 'Yard Manager',  '+255700000082', true, false),
  ('f0000000-0000-0000-0000-000000000003', 'Yard Cashier',  '+255700000083', true, false),
  ('f0000000-0000-0000-0000-000000000004', 'Yard Rep',      '+255700000084', true, false);

insert into public.user_roles (user_id, role) values
  ('f0000000-0000-0000-0000-000000000001', 'director'),
  ('f0000000-0000-0000-0000-000000000002', 'manager'),
  ('f0000000-0000-0000-0000-000000000003', 'cashier'),
  ('f0000000-0000-0000-0000-000000000004', 'sales_rep');

-- Referenced by name so the test breaks loudly if the catalogue seed changes underneath it.
create or replace function tests.product(p_name text) returns uuid language sql stable as $$
  select id from public.products where name = p_name limit 1;
$$;

-- ---------------------------------------------------------------------------
-- The standard recipe and the expected yield are reference data, fixed by product.md
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from public.production_recipe_inputs),
  3,
  'the standard recipe holds the three inputs of §11.1 -- water is absent, being a utility cost');

select is(
  (select standard_quantity from public.production_recipe_inputs
    where product_id = tests.product('Dangote Cement 42R')),
  1::bigint,
  'one bag of cement per batch, as §11.1 writes it');

select is(
  (select count(*)::int from public.production_yield_ranges),
  2,
  'and the expected yield covers the two brick sizes of §11.2');

-- ---------------------------------------------------------------------------
-- The yard is stocked, so a batch has something to consume
-- ---------------------------------------------------------------------------
select tests.acting_as('f0000000-0000-0000-0000-000000000001'::uuid);   -- Director

select is(
  (api.admin_record_opening_stock(
     tests.product('Dangote Cement 42R'), 'yard', 20, 'opening count', 'prod-open-1')
   ->> 'reason'),
  'recorded',
  'the Director records the opening cement in the yard');

select is(
  (api.admin_record_opening_stock(tests.product('Sand'), 'yard', 60, 'opening count', 'prod-open-2')
   ->> 'reason'),
  'recorded',
  'the opening sand');

select is(
  (api.admin_record_opening_stock(
     tests.product('Aggregate'), 'yard', 60, 'opening count', 'prod-open-3')
   ->> 'reason'),
  'recorded',
  'and the opening aggregate');

-- ---------------------------------------------------------------------------
-- §4.1 · A Manager runs production. Nobody else, and the refusal comes from the database
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select api.staff_enter_production_batch(
       'yard', now(),
       jsonb_build_array(jsonb_build_object(
         'product_id', tests.product('Sand'), 'actual_quantity', 5)),
       jsonb_build_array(jsonb_build_object(
         'product_id', tests.product('Tofali 6"'), 'quantity_moulded', 22)),
       null, 'prod-batch-director') $$,
  '42501', null,
  'a Director does not enter a batch -- §4.1 gives production to the Manager');

select tests.acting_as('f0000000-0000-0000-0000-000000000003'::uuid);   -- Cashier

select throws_ok(
  $$ select api.staff_enter_production_batch(
       'yard', now(),
       jsonb_build_array(jsonb_build_object(
         'product_id', tests.product('Sand'), 'actual_quantity', 5)),
       jsonb_build_array(jsonb_build_object(
         'product_id', tests.product('Tofali 6"'), 'quantity_moulded', 22)),
       null, 'prod-batch-cashier') $$,
  '42501', null,
  'nor does a Cashier');

select tests.acting_as('f0000000-0000-0000-0000-000000000004'::uuid);   -- Sales Rep

select throws_ok(
  $$ select api.staff_enter_production_batch(
       'yard', now(),
       jsonb_build_array(jsonb_build_object(
         'product_id', tests.product('Sand'), 'actual_quantity', 5)),
       jsonb_build_array(jsonb_build_object(
         'product_id', tests.product('Tofali 6"'), 'quantity_moulded', 22)),
       null, 'prod-batch-rep') $$,
  '42501', null,
  'nor a Sales Representative');

select is((select count(*)::int from public.production_batches), 0,
  'and not one refused attempt created a batch');

-- ---------------------------------------------------------------------------
-- Entry · what a batch used and produced, recorded without moving anything
--
-- The actual sand is SIX against a standard of five. That one difference is what the whole of
-- §11.1 turns on, and it is carried deliberately through every assertion below.
-- ---------------------------------------------------------------------------
select tests.acting_as('f0000000-0000-0000-0000-000000000002'::uuid);   -- Manager

select is(
  (api.staff_enter_production_batch(
     'yard', now(),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Dangote Cement 42R'), 'actual_quantity', 1),
       jsonb_build_object('product_id', tests.product('Sand'), 'actual_quantity', 6),
       jsonb_build_object('product_id', tests.product('Aggregate'), 'actual_quantity', 5)),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 22,
                          'rejected_quantity', 2, 'reject_reason', 'broken'),
       jsonb_build_object('product_id', tests.product('Tofali 5"'), 'quantity_moulded', 27)),
     null, 'prod-batch-1')
   ->> 'reason'),
  'entered',
  'the Manager records a batch: what it actually used, and what came out of the mould');

select is(
  (select status::text from public.production_batches where batch_no like 'FV-BAT-%'),
  'draft',
  'it lands as a draft -- recording is not approving (§11.1, AC-39)');

select is(
  (select private.stock_on_hand(tests.product('Sand'), 'yard', 'available')),
  60::bigint,
  'and NOTHING has left the yard: the sand is untouched');

select is(
  (select private.stock_on_hand(tests.product('Tofali 6"'), 'yard', 'curing')),
  0::bigint,
  'nothing is curing either -- a draft produces as little as it consumes');

-- ---------------------------------------------------------------------------
-- §11.1 · The standard, the actual and the variance are three separate facts
-- ---------------------------------------------------------------------------
select is(
  (select standard_quantity from public.production_batch_inputs
    where product_id = tests.product('Sand')),
  5::bigint,
  'the standard is SNAPSHOTTED onto the batch, so a later recipe change cannot rewrite history');

select is(
  (select actual_quantity from public.production_batch_inputs
    where product_id = tests.product('Sand')),
  6::bigint,
  'beside the actual the Manager confirmed');

select is(
  (select variance_quantity from public.production_batch_inputs
    where product_id = tests.product('Sand')),
  1::bigint,
  'and the variance between them is CALCULATED (§5.2) -- there is no field to type it into');

select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'production_batch_inputs'
      and column_name = 'variance_quantity' and is_generated = 'ALWAYS'),
  1,
  'a generated column, which is what makes "never typed" true rather than a convention');

-- ---------------------------------------------------------------------------
-- §11.4 · Two sizes from one batch are two lots with two clocks
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from public.production_lots),
  2,
  'the two brick sizes became two separate lots (§11.4)');

select is(
  (select count(distinct curing_started_at)::int from public.production_lots),
  1,
  'sharing one moulding time, which §11.4 explicitly permits -- they are still two lots');

-- ---------------------------------------------------------------------------
-- Approval · the moment the yard is consumed, and by the ACTUAL (AC-38)
--
-- This is the assertion the whole slice exists for. Deducting the standard would take five sand
-- and leave the sixth unaccounted for, and §11.1 forbids exactly that.
-- ---------------------------------------------------------------------------
select is(
  (api.staff_approve_production_batch(
     (select id from public.production_batches limit 1), 'prod-approve-1') ->> 'reason'),
  'approved',
  'the Manager approves the batch');

select is(
  (select private.stock_on_hand(tests.product('Sand'), 'yard', 'available')),
  54::bigint,
  'the yard falls by the ACTUAL SIX, not the standard five (§11.1, AC-38)');

select is(
  (select private.stock_on_hand(tests.product('Aggregate'), 'yard', 'available')),
  55::bigint,
  'an input used exactly to standard falls by exactly the standard');

-- ---------------------------------------------------------------------------
-- AC-120 · Content is never deducted
-- ---------------------------------------------------------------------------
select is(
  (select private.stock_on_hand(tests.product('Dangote Cement 42R'), 'yard', 'available')),
  19::bigint,
  'one bag of cement deducts ONE, not the fifty kilograms inside it (§11.1, AC-120)');

select isnt(
  (select unit_content from public.products where id = tests.product('Dangote Cement 42R')),
  null,
  'though the bag does carry a content -- it simply is not a quantity');

-- ---------------------------------------------------------------------------
-- §11.4, AC-44 · Moulded bricks enter CURING. They are not sellable, and saying so is the point
-- ---------------------------------------------------------------------------
select is(
  (select private.stock_on_hand(tests.product('Tofali 6"'), 'yard', 'curing')),
  20::bigint,
  'twenty bricks entered curing: twenty-two moulded, less the two broken at the mould');

select is(
  (select private.stock_on_hand(tests.product('Tofali 6"'), 'yard', 'available')),
  0::bigint,
  'and NOT ONE is available for sale (§11.4, AC-44)');

select is(
  (select private.stock_on_hand(tests.product('Tofali 5"'), 'yard', 'curing')),
  27::bigint,
  'the second lot cures on its own count');

select is(
  (select count(*)::int from public.inventory_ledger
    where movement_kind = 'production_output' and stock_state = 'available'),
  0,
  'no production output reached available stock by any path at all');

-- ---------------------------------------------------------------------------
-- AC-82 · Every movement names its cause, its actor and its authoriser
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from public.inventory_ledger
    where movement_kind in ('production_input', 'production_output') and approved_by is null),
  0,
  'not one production movement lacks an authoriser (AC-82)');

select is(
  (select distinct approved_by::text from public.inventory_ledger
    where movement_kind = 'production_input'),
  'f0000000-0000-0000-0000-000000000002',
  'and the authoriser is the Manager who approved, taken from the session');

select is(
  (select count(*)::int from public.inventory_ledger
    where movement_kind = 'production_input' and quantity_delta > 0),
  0,
  'inputs only ever leave the yard');

-- ---------------------------------------------------------------------------
-- §4.3 · Approving twice is refused, and the second call is not a second deduction
-- ---------------------------------------------------------------------------
select is(
  (api.staff_approve_production_batch(
     (select id from public.production_batches limit 1), 'prod-approve-again') ->> 'reason'),
  'already_settled',
  'an approved batch cannot be approved again');

select is(
  (select private.stock_on_hand(tests.product('Sand'), 'yard', 'available')),
  54::bigint,
  'and the refusal took no further sand');

-- ---------------------------------------------------------------------------
-- §11.4, AC-44 · 72 hours is a gate on INSPECTION, and inspection is a decision
-- ---------------------------------------------------------------------------
select is(
  (api.staff_inspect_curing_lot(
     (select id from public.production_lots where product_id = tests.product('Tofali 6"')),
     18, 2, 'cracked', 'prod-inspect-early') ->> 'reason'),
  'still_curing',
  'a lot moulded moments ago cannot be inspected -- the 72 hours of §11.4 are real');

select is(
  (select private.stock_on_hand(tests.product('Tofali 6"'), 'yard', 'available')),
  0::bigint,
  'and the refused inspection made nothing sellable');

-- Time passes. The lot is aged rather than the clock moved, because the rule under test is
-- "72 hours have elapsed", and that is a property of the lot.
update public.production_lots
   set curing_started_at = now() - interval '4 days'
 where product_id = tests.product('Tofali 6"');

select is(
  (select ready_for_inspection from public.curing_lots
    where product_id = tests.product('Tofali 6"')),
  true,
  'after 72 hours the lot reports itself READY FOR INSPECTION');

select is(
  (select private.stock_on_hand(tests.product('Tofali 6"'), 'yard', 'available')),
  0::bigint,
  'which by itself makes NOTHING sellable (AC-44) -- the countdown grants nothing');

-- ---------------------------------------------------------------------------
-- Inspection · everything that cured must be accounted for
-- ---------------------------------------------------------------------------
select is(
  (api.staff_inspect_curing_lot(
     (select id from public.production_lots where product_id = tests.product('Tofali 6"')),
     18, 0, null, 'prod-inspect-short') ->> 'reason'),
  'inspection_must_account_for_all',
  'accepting eighteen of twenty and rejecting nothing loses two bricks, and is refused');

select is(
  (api.staff_inspect_curing_lot(
     (select id from public.production_lots where product_id = tests.product('Tofali 6"')),
     18, 2, null, 'prod-inspect-noreason') ->> 'reason'),
  'reject_reason_required',
  'a reject count with no reason is a number nobody can act on (§11.5, AC-45)');

select is(
  (api.staff_inspect_curing_lot(
     (select id from public.production_lots where product_id = tests.product('Tofali 6"')),
     18, 2, 'looked wrong to me', 'prod-inspect-freetext') ->> 'reason'),
  'reject_reason_invalid',
  'and the reason comes from the four preset values, never typed (AC-3)');

select is(
  (api.staff_inspect_curing_lot(
     (select id from public.production_lots where product_id = tests.product('Tofali 6"')),
     20, 0, 'broken', 'prod-inspect-reason-no-rejects') ->> 'reason'),
  'reject_reason_without_rejects',
  'a reason with nothing to explain is a claim about nothing');

-- ---------------------------------------------------------------------------
-- §11.4, AC-45 · ONLY the accepted quantity becomes sellable
-- ---------------------------------------------------------------------------
select is(
  (api.staff_inspect_curing_lot(
     (select id from public.production_lots where product_id = tests.product('Tofali 6"')),
     18, 2, 'cracked', 'prod-inspect-1') ->> 'reason'),
  'inspected',
  'the Manager inspects the lot: eighteen accepted, two cracked');

select is(
  (select private.stock_on_hand(tests.product('Tofali 6"'), 'yard', 'available')),
  18::bigint,
  'EIGHTEEN become available -- only what was accepted (§11.4, AC-45)');

select is(
  (select private.stock_on_hand(tests.product('Tofali 6"'), 'yard', 'curing')),
  0::bigint,
  'and the whole lot left curing: a balance outliving its inspection would be stock nobody can find');

select is(
  (select rejected_at_inspection from public.production_lots
    where product_id = tests.product('Tofali 6"')),
  2::bigint,
  'the two rejects are recorded on the lot');

select is(
  (select count(*)::int from public.inventory_ledger
    where product_id = tests.product('Tofali 6"') and stock_state = 'available'
      and quantity_delta = 2),
  0,
  'and never enter a balance anywhere -- a reject is unsellable, not stock (§8)');

select is(
  (api.staff_inspect_curing_lot(
     (select id from public.production_lots where product_id = tests.product('Tofali 6"')),
     18, 2, 'cracked', 'prod-inspect-twice') ->> 'reason'),
  'already_inspected',
  'a lot is inspected once');

select is(
  (select private.stock_on_hand(tests.product('Tofali 6"'), 'yard', 'available')),
  18::bigint,
  'so a repeated inspection cannot double the sellable bricks');

-- The second lot never left curing, which is the proof the two clocks are independent.
select is(
  (select private.stock_on_hand(tests.product('Tofali 5"'), 'yard', 'curing')),
  27::bigint,
  'inspecting one lot did nothing to the other, though they share a batch and a timestamp');

-- ---------------------------------------------------------------------------
-- §11.2, AC-41 · Output outside the expected range is flagged and explained, never blocked
-- ---------------------------------------------------------------------------
select is(
  (api.staff_enter_production_batch(
     'yard', now(),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Dangote Cement 42R'), 'actual_quantity', 1),
       jsonb_build_object('product_id', tests.product('Sand'), 'actual_quantity', 5),
       jsonb_build_object('product_id', tests.product('Aggregate'), 'actual_quantity', 5)),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 15)),
     null, 'prod-batch-low-nonote')
   ->> 'reason'),
  'yield_explanation_required',
  'fifteen bricks against an expected twenty needs an explanation (§11.2, AC-41)');

select is(
  (api.staff_enter_production_batch(
     'yard', now(),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Dangote Cement 42R'), 'actual_quantity', 1),
       jsonb_build_object('product_id', tests.product('Sand'), 'actual_quantity', 5),
       jsonb_build_object('product_id', tests.product('Aggregate'), 'actual_quantity', 5)),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 15)),
     'the mix was too wet and a tray collapsed', 'prod-batch-low')
   ->> 'reason'),
  'entered',
  'and with one it is RECORDED, not refused -- a short batch is a fact about the yard');

select is(
  ((api.staff_enter_production_batch(
      'yard', now(),
      jsonb_build_array(
        jsonb_build_object('product_id', tests.product('Dangote Cement 42R'), 'actual_quantity', 1),
        jsonb_build_object('product_id', tests.product('Sand'), 'actual_quantity', 5),
        jsonb_build_object('product_id', tests.product('Aggregate'), 'actual_quantity', 5)),
      jsonb_build_array(
        jsonb_build_object('product_id', tests.product('Tofali 5"'), 'quantity_moulded', 40)),
      'the mould was run twice before anyone counted', 'prod-batch-high')
    -> 'yield_outside_range')::text),
  'true',
  'an over-run is flagged the same way, and equally not blocked');

select is(
  (api.staff_enter_production_batch(
     'yard', now(),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Dangote Cement 42R'), 'actual_quantity', 1),
       jsonb_build_object('product_id', tests.product('Sand'), 'actual_quantity', 5),
       jsonb_build_object('product_id', tests.product('Aggregate'), 'actual_quantity', 5)),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 22)),
     'nothing unusual happened', 'prod-batch-note-in-range')
   ->> 'reason'),
  'yield_within_range',
  'and an explanation for a normal batch is refused, so an explanation always means something');

-- ---------------------------------------------------------------------------
-- What a batch may consist of
-- ---------------------------------------------------------------------------
select is(
  (api.staff_enter_production_batch(
     'yard', now(),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Nondo 12 mm'), 'actual_quantity', 5)),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 22)),
     null, 'prod-batch-offrecipe')
   ->> 'reason'),
  'not_a_recipe_input',
  'an input outside the recipe has no standard to be measured against, so it is refused (§11.1)');

select is(
  (api.staff_enter_production_batch(
     'yard', now(),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Dangote Cement 42R'), 'actual_quantity', 1),
       jsonb_build_object('product_id', tests.product('Sand'), 'actual_quantity', 5),
       jsonb_build_object('product_id', tests.product('Aggregate'), 'actual_quantity', 5)),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Sand'), 'quantity_moulded', 22)),
     null, 'prod-batch-offoutput')
   ->> 'reason'),
  'not_a_produced_product',
  'and a batch that produced sand is not a brick batch (§11.2)');

select is(
  (api.staff_enter_production_batch(
     'yard', now(),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Sand'), 'actual_quantity', 2.5)),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 22)),
     null, 'prod-batch-fraction')
   ->> 'reason'),
  'quantity_not_whole',
  'half a bucket is refused rather than rounded -- a product is counted in whole units (§6)');

select is(
  (api.staff_enter_production_batch(
     'yard', now() + interval '2 hours',
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Dangote Cement 42R'), 'actual_quantity', 1),
       jsonb_build_object('product_id', tests.product('Sand'), 'actual_quantity', 5),
       jsonb_build_object('product_id', tests.product('Aggregate'), 'actual_quantity', 5)),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 22)),
     null, 'prod-batch-future')
   ->> 'reason'),
  'moulded_at_invalid',
  'and a moulding time in the future would start a countdown that has not begun (§11.4)');

select is(
  (api.staff_enter_production_batch(
     'yard', now(),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Dangote Cement 42R'), 'actual_quantity', 1),
       jsonb_build_object('product_id', tests.product('Sand'), 'actual_quantity', 5),
       jsonb_build_object('product_id', tests.product('Aggregate'), 'actual_quantity', 5)),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 22,
                          'rejected_quantity', 30, 'reject_reason', 'broken')),
     null, 'prod-batch-overreject')
   ->> 'reason'),
  'rejects_exceed_output',
  'more rejects than bricks is arithmetic nobody can act on');

-- ---------------------------------------------------------------------------
-- Approval is checked against the yard AT THE MOMENT OF APPROVAL, not at entry
-- ---------------------------------------------------------------------------
select is(
  (api.staff_enter_production_batch(
     'yard', now(),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Dangote Cement 42R'), 'actual_quantity', 1),
       jsonb_build_object('product_id', tests.product('Sand'), 'actual_quantity', 9000),
       jsonb_build_object('product_id', tests.product('Aggregate'), 'actual_quantity', 5)),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 22)),
     null, 'prod-batch-toobig')
   ->> 'reason'),
  'entered',
  'a batch claiming more sand than the yard holds may be ENTERED');

select is(
  (api.staff_approve_production_batch(
     (select id from public.production_batches
       where id in (select batch_id from public.production_batch_inputs
                     where actual_quantity = 9000)),
     'prod-approve-toobig') ->> 'reason'),
  'insufficient_stock',
  'and is refused at APPROVAL, when the yard is actually read (§10, the same rule as a transfer)');

select is(
  (select private.stock_on_hand(tests.product('Sand'), 'yard', 'available')),
  54::bigint,
  'the yard is unchanged by the refusal');

-- ---------------------------------------------------------------------------
-- §4.3 · A rejection is a completed decision that consumes nothing
-- ---------------------------------------------------------------------------
select is(
  (api.staff_reject_production_batch(
     (select id from public.production_batches
       where id in (select batch_id from public.production_batch_inputs
                     where actual_quantity = 9000)),
     'the sand figure was written down wrong', 'prod-reject-1') ->> 'reason'),
  'rejected',
  'the Manager rejects the batch with a reason (§4.3)');

select isnt(
  (select decision_reason from public.production_batches
    where id in (select batch_id from public.production_batch_inputs
                  where actual_quantity = 9000)),
  null,
  'the reason is kept -- §4.3 requires one on every rejection');

select is(
  (select count(*)::int from public.inventory_ledger
    where source_id in (select batch_id from public.production_batch_inputs
                         where actual_quantity = 9000)),
  0,
  'and a rejected batch moved nothing: a rejection is NOT an approval');

select is(
  (api.staff_approve_production_batch(
     (select id from public.production_batches
       where id in (select batch_id from public.production_batch_inputs
                     where actual_quantity = 9000)),
     'prod-approve-after-reject') ->> 'reason'),
  'already_settled',
  'and a rejected batch cannot be approved afterwards');

select is(
  (api.staff_reject_production_batch(
     (select id from public.production_batches where batch_no like 'FV-BAT-%' limit 1),
     'no', 'prod-reject-short') ->> 'reason'),
  'reason_required',
  'a rejection without a real reason is refused');

-- ---------------------------------------------------------------------------
-- §16 · The ledger written by production is as immutable as any other
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ update public.inventory_ledger set quantity_delta = 1
      where movement_kind = 'production_input' $$,
  '23001', null,
  'no role can rewrite a production movement, the table owner included (§16)');

select throws_ok(
  $$ delete from public.inventory_ledger where movement_kind = 'production_output' $$,
  '23001', null,
  'and none can delete one');

-- ---------------------------------------------------------------------------
-- The grant surface: reads for oversight, writes through the commands only
-- ---------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(distinct privilege_type, ', ' order by privilege_type), '')
     from information_schema.table_privileges
    where table_schema = 'public'
      and table_name in ('production_batches', 'production_batch_inputs', 'production_lots',
                         'production_recipe_inputs', 'production_yield_ranges')
      and grantee in ('anon', 'authenticated', 'service_role')),
  'SELECT',
  'no client holds anything but SELECT on a production table');

select is(
  (select count(*)::int from information_schema.table_privileges
    where grantee = 'service_role' and table_schema = 'public'
      and table_name in ('production_batches', 'production_batch_inputs', 'production_lots')),
  0,
  'a leaked secret key reaches none of them: service_role holds no privilege at all');

select is(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api' and p.proname like '%production%'
      and pg_get_function_identity_arguments(p.oid) ilike '%actor%'),
  0,
  'and no production command accepts an actor: the database derives who is acting, from the JWT');

select is(
  (select count(*)::int from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname like 'production%' and not c.relrowsecurity),
  0,
  'every production table carries row-level security');


-- ---------------------------------------------------------------------------
-- AC-39 · Actual usage is CONFIRMED for every material, and confirming zero is an answer
--
-- "A batch cannot be completed until actual usage is recorded or confirmed." A payload carrying two
-- of the three materials is not a confirmation of the third: it is silence about it, and silence
-- stored as a batch that used no cement is a variance nobody entered.
-- ---------------------------------------------------------------------------
select is(
  (api.staff_enter_production_batch(
     'yard', now(),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Dangote Cement 42R'), 'actual_quantity', 1),
       jsonb_build_object('product_id', tests.product('Sand'), 'actual_quantity', 5)),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 22)),
     null, 'prod-batch-partial')
   ->> 'reason'),
  'incomplete_recipe_inputs',
  'a batch that confirmed two of the three materials said nothing about the third, and is refused');

select is(
  (select count(*)::int from public.idempotency_keys where key = 'prod-batch-partial'),
  0,
  'and the refusal claimed no idempotency key: the same key may be sent again with a whole recipe');

select is(
  (api.staff_enter_production_batch(
     'yard', now(),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Dangote Cement 42R'), 'actual_quantity', 1),
       jsonb_build_object('product_id', tests.product('Sand'), 'actual_quantity', 5),
       jsonb_build_object('product_id', tests.product('Sand'), 'actual_quantity', 5),
       jsonb_build_object('product_id', tests.product('Aggregate'), 'actual_quantity', 5)),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 22)),
     null, 'prod-batch-dup-input')
   ->> 'reason'),
  'duplicate_product_line',
  'one material confirmed twice is two answers to one question, and is refused');

select is(
  (api.staff_enter_production_batch(
     'yard', now(),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Dangote Cement 42R'), 'actual_quantity', 1),
       jsonb_build_object('product_id', tests.product('Sand'), 'actual_quantity', 0),
       jsonb_build_object('product_id', tests.product('Aggregate'), 'actual_quantity', 5)),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 22)),
     null, 'prod-batch-zero-sand')
   ->> 'reason'),
  'entered',
  'confirming ZERO of a material is an answer, not a gap, and is recorded');

select is(
  (select i.variance_quantity
     from public.production_batch_inputs i
    where i.batch_id = (select result_ref from public.idempotency_keys
                         where key = 'prod-batch-zero-sand')
      and i.product_id = tests.product('Sand')),
  -5::bigint,
  'and its variance is recorded at full size -- §15.1 never suppresses one, in either direction');

-- ---------------------------------------------------------------------------
-- Malformed payloads are refused AT THE DATABASE BOUNDARY, with nothing half-written
-- ---------------------------------------------------------------------------
select is(
  (api.staff_enter_production_batch(
     'yard', now(),
     jsonb_build_array(to_jsonb('not a line at all'::text)),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 22)),
     null, 'prod-batch-notobject')
   ->> 'reason'),
  'line_invalid',
  'an input line that is not an object is refused rather than read past');

select is(
  (api.staff_enter_production_batch(
     'yard', now(),
     jsonb_build_array(
       jsonb_build_object('product_id', 'not-a-uuid', 'actual_quantity', 1)),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 22)),
     null, 'prod-batch-baduuid')
   ->> 'reason'),
  'line_invalid',
  'a product id that is not a uuid is a refusal, not a raised cast the client meets as a 500');

select is(
  (api.staff_enter_production_batch(
     'yard', now(),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Dangote Cement 42R'), 'actual_quantity', 1),
       jsonb_build_object('product_id', tests.product('Sand'), 'actual_quantity', 'five'),
       jsonb_build_object('product_id', tests.product('Aggregate'), 'actual_quantity', 5)),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 22)),
     null, 'prod-batch-text-quantity')
   ->> 'reason'),
  'line_invalid',
  'and a quantity written as a word is refused before anything is inserted');

select is(
  (api.staff_enter_production_batch(
     'yard', now(),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Dangote Cement 42R'), 'actual_quantity', 1),
       jsonb_build_object('product_id', tests.product('Sand'), 'actual_quantity', 5),
       jsonb_build_object('product_id', tests.product('Aggregate'), 'actual_quantity', 5)),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 22,
                          'rejected_quantity', 0, 'reject_reason', 'broken')),
     null, 'prod-batch-reason-no-rejects')
   ->> 'reason'),
  'reject_reason_without_rejects',
  'a reject reason at the mould with nothing rejected is a claim about nothing (§11.5)');

select is(
  (select count(*)::int from public.idempotency_keys
    where key in ('prod-batch-partial', 'prod-batch-dup-input', 'prod-batch-notobject',
                  'prod-batch-baduuid', 'prod-batch-text-quantity',
                  'prod-batch-reason-no-rejects')),
  0,
  'not one malformed payload left a partial record or a claimed key behind');

-- ---------------------------------------------------------------------------
-- Retry identity covers EVERY business-significant input, the explanation included
--
-- The explanation is the Manager's account of an out-of-range batch and is kept permanently. A key
-- that ignored it would replay the first batch while quietly accepting a different story.
-- ---------------------------------------------------------------------------
select is(
  (api.staff_enter_production_batch(
     'yard', now(),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Dangote Cement 42R'), 'actual_quantity', 1),
       jsonb_build_object('product_id', tests.product('Sand'), 'actual_quantity', 5),
       jsonb_build_object('product_id', tests.product('Aggregate'), 'actual_quantity', 5)),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 15)),
     'a tray collapsed', 'prod-batch-note-identity')
   ->> 'reason'),
  'entered',
  'an out-of-range batch is recorded with its explanation');

select is(
  (api.staff_enter_production_batch(
     'yard', now(),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Dangote Cement 42R'), 'actual_quantity', 1),
       jsonb_build_object('product_id', tests.product('Sand'), 'actual_quantity', 5),
       jsonb_build_object('product_id', tests.product('Aggregate'), 'actual_quantity', 5)),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 15)),
     'a tray collapsed', 'prod-batch-note-identity')
   ->> 'reason'),
  'replayed',
  'the identical request under the same key replays the first batch rather than making a second');

select is(
  (api.staff_enter_production_batch(
     'yard', now(),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Dangote Cement 42R'), 'actual_quantity', 1),
       jsonb_build_object('product_id', tests.product('Sand'), 'actual_quantity', 5),
       jsonb_build_object('product_id', tests.product('Aggregate'), 'actual_quantity', 5)),
     jsonb_build_array(
       jsonb_build_object('product_id', tests.product('Tofali 6"'), 'quantity_moulded', 15)),
     'the sand was wet', 'prod-batch-note-identity')
   ->> 'reason'),
  'idempotency_key_conflict',
  'and a CHANGED EXPLANATION under the same key is a conflict, not a silent replay of the first');

-- ---------------------------------------------------------------------------
-- §4.2, AC-82 · A decision records the role held AT THE MOMENT it was made
-- ---------------------------------------------------------------------------
select is(
  (select decided_role::text from public.production_batches
    where id = (select result_ref from public.idempotency_keys where key = 'prod-batch-1')),
  'manager',
  'the approval kept the role its actor held when they approved, not the one they hold now');

select is(
  (select inspected_role::text from public.production_lots
    where product_id = tests.product('Tofali 6"')
      and batch_id = (select result_ref from public.idempotency_keys where key = 'prod-batch-1')),
  'manager',
  'and so did the inspection (§4.2)');

-- ---------------------------------------------------------------------------
-- AC-45 · A lot in which NOTHING was accepted, which is a real outcome
--
-- The whole lot still leaves curing, nothing becomes sellable, and no ledger row of zero is written
-- to say so: a movement of nothing is not a movement, and a balance would be reading it as one.
-- ---------------------------------------------------------------------------
update public.production_lots
   set curing_started_at = now() - interval '4 days'
 where product_id = tests.product('Tofali 5"')
   and batch_id = (select result_ref from public.idempotency_keys where key = 'prod-batch-1');

select is(
  (api.staff_inspect_curing_lot(
     (select id from public.production_lots
       where product_id = tests.product('Tofali 5"')
         and batch_id = (select result_ref from public.idempotency_keys where key = 'prod-batch-1')),
     0, 27, 'weak', 'prod-inspect-all-rejected') ->> 'reason'),
  'inspected',
  'a Manager may accept nothing at all: twenty-seven weak bricks is an outcome, not an error');

select is(
  (select private.stock_on_hand(tests.product('Tofali 5"'), 'yard', 'available')),
  0::bigint,
  'nothing became sellable (AC-45)');

select is(
  (select private.stock_on_hand(tests.product('Tofali 5"'), 'yard', 'curing')),
  0::bigint,
  'and the whole lot left curing anyway -- a rejected brick is not stock kept somewhere else (§8)');

select is(
  (select count(*)::int from public.inventory_ledger where quantity_delta = 0),
  0,
  'no ledger row records a movement of nothing, on this lot or any other');

-- ---------------------------------------------------------------------------
-- The protection migration 33 installs, asserted on the objects themselves
--
-- pgTAP runs after every migration, so it cannot watch the intermediate state; the migration-chain
-- harness does that by resetting to migration 33 exactly. What is asserted here is that the
-- protection EXISTS and has the shape the release claims.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from information_schema.table_privileges
    where table_schema = 'public'
      and table_name in ('production_batches', 'production_batch_inputs', 'production_lots',
                         'production_recipe_inputs', 'production_yield_ranges')
      and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  0,
  'no client role may write to a production table by any privilege at all');

select is(
  (select count(*)::int from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'curing_lots'
      and c.reloptions @> array['security_invoker=true']),
  1,
  'and `curing_lots` runs as its caller, so the view is not a way around row-level security');

select is(
  (select count(*)::int from pg_policy p
     join pg_class c on c.oid = p.polrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname like 'production%'),
  15,
  'every production table carries its policies: five reader policies and ten for the owner');

select is(
  (select bool_and(has_function_privilege('authenticated', p.oid, 'execute'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api' and p.proname in (
      'staff_enter_production_batch', 'staff_approve_production_batch',
      'staff_reject_production_batch', 'staff_inspect_curing_lot')),
  true,
  'a signed-in member of staff may call all four production commands');

select is(
  (select bool_or(has_function_privilege(who, p.oid, 'execute'))
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     cross join unnest(array['anon', 'service_role', 'public']) as who
    where n.nspname = 'api' and p.proname in (
      'staff_enter_production_batch', 'staff_approve_production_batch',
      'staff_reject_production_batch', 'staff_inspect_curing_lot')),
  false,
  'and PUBLIC, anon and a leaked secret key may call none of them');

-- ---------------------------------------------------------------------------
-- The batch numbering kind was ADDED, and the three released kinds are still permitted
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int
     from unnest(array['order', 'proforma', 'invoice', 'batch']) as kind
    where (select pg_get_constraintdef(c.oid)
             from pg_constraint c
             join pg_class t     on t.oid = c.conrelid
             join pg_namespace n on n.oid = t.relnamespace
            where n.nspname = 'public'
              and t.relname = 'document_sequences'
              and c.conname = 'document_sequences_kind_check')
          like '%''' || kind || '''%'),
  4,
  'the daily counter permits all four kinds: the three that were released, plus batch');

select matches(
  (select batch_no from public.production_batches
    where id = (select result_ref from public.idempotency_keys where key = 'prod-batch-1')),
  '^FV-BAT-[0-9]{8}-[0-9]{4}$',
  'and a batch number takes the shape §12.2 fixes for a daily document');

select finish();
rollback;
