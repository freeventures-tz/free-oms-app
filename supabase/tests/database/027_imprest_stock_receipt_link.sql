-- Issue #73 · Imprest: link a supplier delivery paid from imprest to its disbursement
--
-- The claims under test, each traceable to issue #73's acceptance criteria:
--
--   1   The picker lists only disbursements of the active fund that are handed out, settled, sent
--       back or verified, newest first, with number, payee, category and approved amount. The
--       Manager sees all of them and a Cashier their own.
--   2   A stock receipt links to at most one disbursement; a disbursement may pay for several.
--   3   The link is recorded with the receipt, append-only, with who made it and their role.
--       Changing it after entry is refused.
--   4   The receipt shows its disbursement and the disbursement lists its receipts, for everyone
--       who can read either.
--   5   Linking changes no imprest figure and no stock figure. Stock still increases only on
--       Manager approval.
--   6   Every success and committed refusal is on the audit trail.

create extension if not exists pgtap with schema extensions;

begin;
select * from no_plan();

create schema if not exists tests;
grant usage on schema tests to public;

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

select tests.mk_user('ea000000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('ea000000-0000-0000-0000-000000000002'::uuid);  -- Manager
select tests.mk_user('ea000000-0000-0000-0000-000000000003'::uuid);  -- Cashier
select tests.mk_user('ea000000-0000-0000-0000-000000000004'::uuid);  -- Second Cashier
select tests.mk_user('ea000000-0000-0000-0000-000000000005'::uuid);  -- Sales Representative

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('ea000000-0000-0000-0000-000000000001', 'Link Director', '+255700010001', true, false),
  ('ea000000-0000-0000-0000-000000000002', 'Link Manager',  '+255700010002', true, false),
  ('ea000000-0000-0000-0000-000000000003', 'Link Cashier',  '+255700010003', true, false),
  ('ea000000-0000-0000-0000-000000000004', 'Other Cashier', '+255700010004', true, false),
  ('ea000000-0000-0000-0000-000000000005', 'Link Rep',      '+255700010005', true, false);

insert into public.user_roles (user_id, role) values
  ('ea000000-0000-0000-0000-000000000001', 'director'),
  ('ea000000-0000-0000-0000-000000000002', 'manager'),
  ('ea000000-0000-0000-0000-000000000003', 'cashier'),
  ('ea000000-0000-0000-0000-000000000004', 'cashier'),
  ('ea000000-0000-0000-0000-000000000005', 'sales_rep');

create or replace function tests.director() returns void language sql as $$
  select tests.acting_as('ea000000-0000-0000-0000-000000000001'::uuid); $$;
create or replace function tests.manager() returns void language sql as $$
  select tests.acting_as('ea000000-0000-0000-0000-000000000002'::uuid); $$;
create or replace function tests.cashier() returns void language sql as $$
  select tests.acting_as('ea000000-0000-0000-0000-000000000003'::uuid); $$;
create or replace function tests.cashier_b() returns void language sql as $$
  select tests.acting_as('ea000000-0000-0000-0000-000000000004'::uuid); $$;
create or replace function tests.rep() returns void language sql as $$
  select tests.acting_as('ea000000-0000-0000-0000-000000000005'::uuid); $$;

create temp table r (name text primary key, res jsonb not null);
grant all on r to public;
create or replace function tests.keep(p_name text, p_res jsonb) returns text language sql as $$
  insert into r values (p_name, p_res) on conflict (name) do nothing;
  select p_res ->> 'reason';
$$;
create or replace function tests.res(p_name text) returns jsonb language sql as $$
  select res from r where name = p_name; $$;
create or replace function tests.did(p_name text) returns uuid language sql as $$
  select (res -> 'disbursement' ->> 'id')::uuid from r where name = p_name; $$;
create or replace function tests.rcpt(p_name text) returns uuid language sql as $$
  select (res -> 'receipt' ->> 'id')::uuid from r where name = p_name; $$;
create or replace function tests.fid(p_name text) returns uuid language sql as $$
  select (res -> 'funding' ->> 'id')::uuid from r where name = p_name; $$;
create or replace function tests.dver(p_id uuid) returns integer language sql security definer as $$
  select version from public.imprest_disbursements where id = p_id; $$;
create or replace function tests.sid(p_id uuid) returns uuid language sql security definer as $$
  select id from public.imprest_settlements where disbursement_id = p_id order by cycle desc limit 1; $$;
create or replace function tests.line(p_amount bigint, p_purpose text) returns jsonb language sql as $$
  select jsonb_build_object('amount_tzs', p_amount, 'purpose', p_purpose, 'receipt_id', null,
                            'no_receipt_reason', 'transport_fare', 'no_receipt_note', null); $$;
-- posted funding / posted balance / set aside / free to approve / awaiting verification
create or replace function tests.figures() returns text language sql security definer as $$
  select s.posted_funding_tzs || '/' || s.posted_balance_tzs || '/' || s.set_aside_tzs || '/'
         || s.free_to_approve_tzs || '/' || private.imprest_awaiting_verification_tzs(f.id)
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active; $$;
create or replace function tests.stock() returns bigint language sql security definer as $$
  select coalesce(sum(quantity_delta), 0)::bigint from public.inventory_ledger; $$;
create or replace function tests.product() returns uuid language sql stable security definer as $$
  select id from public.products where is_active order by name limit 1; $$;
create or replace function tests.supplier() returns uuid language sql stable security definer as $$
  select id from public.suppliers where name = 'Link Hardware'; $$;
-- A receipt of 10 expected, 10 received, entered by whoever is acting, optionally paid from imprest.
create or replace function tests.enter(p_note text, p_disbursement uuid, p_key text) returns text
language sql as $$
  select tests.keep(p_key, api.staff_enter_stock_receipt(
    tests.supplier(), 'store', (now() at time zone 'Africa/Dar_es_Salaam')::date, p_note,
    jsonb_build_array(jsonb_build_object('product_id', tests.product(),
                                         'expected_quantity', 10, 'received_quantity', 10)),
    p_disbursement, p_key)); $$;
create or replace function tests.fund(p_amount bigint, p_key text) returns void language plpgsql as $$
declare v_id uuid;
begin
  perform tests.manager();
  perform tests.keep(p_key, api.staff_request_imprest_funding(p_amount, 'Top up', p_key));
  v_id := tests.fid(p_key);
  perform tests.director();
  perform api.admin_decide_imprest_funding(v_id, 1, true, p_amount, null, p_key || '-a');
  perform api.admin_record_imprest_provided(v_id, 2, p_amount, p_key || '-p');
  perform tests.manager();
  perform api.staff_confirm_imprest_received(v_id, 3,
    (select handover_id from public.imprest_funding_summaries where id = v_id), p_key || '-r');
end $$;
-- Proposed by the acting Cashier, approved, and (unless p_stop says otherwise) handed out.
create or replace function tests.pay(p_who text, p_name text, p_amount bigint, p_category text,
                                     p_recipient text, p_stop text) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  execute format('select tests.%I()', p_who);
  perform tests.keep(p_name, api.staff_propose_imprest_disbursement(p_amount, p_category,
                                                                    p_name || ' purpose', 'p-' || p_name));
  v_id := tests.did(p_name);
  if p_stop = 'proposed' then return v_id; end if;
  perform tests.manager();
  perform api.staff_decide_imprest_disbursement(v_id, 1, true, null, 'a-' || p_name);
  if p_stop = 'approved' then return v_id; end if;
  execute format('select tests.%I()', p_who);
  perform api.staff_hand_out_imprest_disbursement(v_id, 2, p_recipient, 'h-' || p_name);
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- The shape
-- ---------------------------------------------------------------------------
select ok(
  not has_table_privilege('authenticated', 'public.stock_receipt_imprest_links', 'insert')
  and not has_table_privilege('authenticated', 'public.stock_receipt_imprest_links', 'update')
  and not has_table_privilege('authenticated', 'public.stock_receipt_imprest_links', 'delete')
  and has_table_privilege('authenticated', 'public.stock_receipt_imprest_links', 'select')
  and not has_table_privilege('anon', 'public.stock_receipt_imprest_links', 'select')
  and not has_table_privilege('service_role', 'public.stock_receipt_imprest_links', 'select')
  and not has_table_privilege('fv_definer_owner', 'public.stock_receipt_imprest_links', 'update')
  and not has_table_privilege('fv_definer_owner', 'public.stock_receipt_imprest_links', 'delete'),
  'no role writes a link except through the command, and nobody changes one');

select ok((select relrowsecurity from pg_class
            where oid = 'public.stock_receipt_imprest_links'::regclass),
          'the links table has row-level security');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     join pg_roles o on o.oid = p.proowner
    where n.nspname = 'api'
      and p.proname in ('staff_enter_stock_receipt', 'staff_imprest_receipt_payment_options',
                        'staff_stock_receipt_imprest_links',
                        'staff_imprest_disbursement_stock_receipts')
      and p.prosecdef and o.rolname = 'fv_definer_owner'
      and has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('service_role', p.oid, 'execute')),
  5,
  'both forms of the command and the three reads are security definer, owned by fv_definer_owner, '
  'staff only');

select ok(
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'private' and p.proname = 'impl_staff_enter_stock_receipt'
                 and p.pronargs = 6),
  'the six-argument body is gone: one body enters every receipt');

-- ---------------------------------------------------------------------------
-- A supplier, TZS 300,000 posted, and payments at every step
-- ---------------------------------------------------------------------------
select tests.director();
select api.admin_add_supplier('Link Hardware', 'sup-link');

set local role fv_definer_owner;
insert into public.imprest_funds (id, opened_by) values
  ('ea000000-0000-0000-0000-00000000f001', 'ea000000-0000-0000-0000-000000000002');
reset role;
select tests.fund(300000, 'f-open');

-- Handed out first, so it is the oldest hand-out: bricks bought for the yard.
select tests.pay('cashier', 'sand', 40000, 'materials_and_supplies', 'Simba Sand Ltd', 'handed_out');
-- Handed out, settled, sent back.
select tests.pay('cashier', 'bolts', 12000, 'repairs_and_maintenance', 'Kariakoo Bolts', 'handed_out');
select tests.cashier();
select api.staff_settle_imprest_disbursement(tests.did('bolts'), 3,
  jsonb_build_array(tests.line(12000, 'Bolts')), 0, null, 's-bolts');
select tests.manager();
select api.staff_send_back_imprest_settlement(tests.did('bolts'), 4, tests.sid(tests.did('bolts')),
  'Photo is blurred', 'b-bolts');
-- Handed out, settled, verified.
select tests.pay('cashier', 'cement', 30000, 'materials_and_supplies', 'Twiga Depot', 'handed_out');
select tests.cashier();
select api.staff_settle_imprest_disbursement(tests.did('cement'), 3,
  jsonb_build_array(tests.line(30000, 'Cement')), 0, null, 's-cement');
select tests.manager();
select api.staff_verify_imprest_disbursement(tests.did('cement'), 4,
  tests.sid(tests.did('cement')), 'v-cement');
-- Handed out and settled, waiting for the Manager.
select tests.pay('cashier', 'paint', 8000, 'materials_and_supplies', 'Rangi Shop', 'handed_out');
select tests.cashier();
select api.staff_settle_imprest_disbursement(tests.did('paint'), 3,
  jsonb_build_array(tests.line(8000, 'Paint')), 0, null, 's-paint');
-- Not paid out: proposed, approved, and approved then cancelled.
select tests.pay('cashier', 'fuel', 5000, 'fuel_and_lubricants', null, 'proposed');
select tests.pay('cashier', 'levy', 6000, 'fees_and_charges', null, 'approved');
select tests.pay('cashier', 'tea', 3000, 'meals_and_staff_welfare', null, 'approved');
select tests.manager();
select api.staff_cancel_imprest_disbursement(tests.did('tea'), 2, 'Not needed now', 'c-tea');
-- The other Cashier's payment, handed out last, and raised by 2,000.
select tests.pay('cashier_b', 'nails', 9000, 'materials_and_supplies', 'Mbezi Nails', 'handed_out');
select tests.cashier_b();
select api.staff_request_imprest_raise(tests.did('nails'), 3, 2000, 'Price went up', 'rq-nails');
select tests.manager();
select api.staff_decide_imprest_raise(tests.did('nails'), tests.dver(tests.did('nails')),
  (select id from public.imprest_approval_raises where disbursement_id = tests.did('nails')),
  true, null, 'rd-nails');

-- ---------------------------------------------------------------------------
-- Criterion 1 · The picker
-- ---------------------------------------------------------------------------
select tests.manager();
select is(
  (select string_agg(o ->> 'disbursement_no', ',' order by ord)
     from jsonb_array_elements(api.staff_imprest_receipt_payment_options()) with ordinality t(o, ord)),
  (select string_agg(disbursement_no, ',' order by h.handed_out_at desc, d.id)
     from public.imprest_disbursements d
     join public.imprest_disbursement_handouts h on h.disbursement_id = d.id
    where d.id in (tests.did('nails'), tests.did('paint'), tests.did('cement'), tests.did('bolts'),
                   tests.did('sand'))),
  'the Manager is offered the five paid-out disbursements, newest hand-out first');

select is(
  (select count(*)::int from jsonb_array_elements(api.staff_imprest_receipt_payment_options()) o
    where (o ->> 'id')::uuid in (tests.did('fuel'), tests.did('levy'), tests.did('tea'))),
  0,
  'a proposal, an approval not yet handed out and a cancelled approval are not offered');

select is(
  (select o - 'handed_out_at' - 'id'
     from jsonb_array_elements(api.staff_imprest_receipt_payment_options()) o
    where (o ->> 'id')::uuid = tests.did('nails')),
  jsonb_build_object('disbursement_no', (select disbursement_no from public.imprest_disbursements
                                          where id = tests.did('nails')),
                     'status', 'handed_out', 'category', 'materials_and_supplies',
                     'recipient', 'Mbezi Nails', 'approved_tzs', 11000),
  'each shows its number, payee, category and approved amount, raises included');

select tests.cashier();
select is(
  (select count(*)::int from jsonb_array_elements(api.staff_imprest_receipt_payment_options())),
  4,
  'a Cashier is offered only their own payments');
select tests.cashier_b();
select is(
  (select (o ->> 'id')::uuid from jsonb_array_elements(api.staff_imprest_receipt_payment_options()) o),
  tests.did('nails'),
  'and the other Cashier only theirs');

select tests.rep();
select throws_ok($$ select api.staff_imprest_receipt_payment_options() $$, '42501', null,
                 'a Sales Representative is offered none');
select tests.director();
select throws_ok($$ select api.staff_imprest_receipt_payment_options() $$, '42501', null,
                 'nor is a Director, who does not enter receipts');

-- ---------------------------------------------------------------------------
-- Criteria 2 and 3 · Entering a receipt paid from imprest
-- ---------------------------------------------------------------------------
create temp table before_figures as select tests.figures() as f, tests.stock() as s;
grant all on before_figures to public;

select tests.rep();
select is(tests.enter('DN-REP', tests.did('sand'), 'rc-rep'), 'imprest_link_not_permitted',
          'a Sales Representative cannot mark a receipt paid from imprest');
select is(tests.enter('DN-REP-2', null, 'rc-rep-2'), 'entered',
          'but still enters a receipt without it');

select tests.cashier();
select is(tests.enter('DN-FUEL', tests.did('fuel'), 'rc-fuel'), 'disbursement_not_paid',
          'a proposal paid for nothing');
select is(tests.enter('DN-LEVY', tests.did('levy'), 'rc-levy'), 'disbursement_not_paid',
          'nor an approval not yet handed out');
select is(tests.enter('DN-TEA', tests.did('tea'), 'rc-tea'), 'disbursement_not_paid',
          'nor a cancelled one');
select is(tests.enter('DN-NAILS', tests.did('nails'), 'rc-nails'), 'no_disbursement',
          'a Cashier cannot pick another Cashier''s payment');
select is(tests.enter('DN-NONE', 'ea000000-0000-0000-0000-0000000000ff', 'rc-none'),
          'no_disbursement', 'nor one that does not exist');
select is((select count(*)::int from public.stock_receipts where delivery_note_ref in
             ('DN-REP', 'DN-FUEL', 'DN-LEVY', 'DN-TEA', 'DN-NAILS', 'DN-NONE')),
          0, 'and no refused entry left a receipt behind');

select is(tests.enter('DN-SAND-1', tests.did('sand'), 'rc-sand-1'), 'entered',
          'the Cashier enters a receipt paid from their handed-out payment');
select is((tests.res('rc-sand-1') -> 'imprest_link' ->> 'disbursement_id')::uuid, tests.did('sand'),
          'the entry returns its link');
select is(tests.enter('DN-SAND-1', tests.did('sand'), 'rc-sand-1'), 'replayed',
          'a retry under the same key replays');
select is(api.staff_enter_stock_receipt(tests.supplier(), 'store',
            (now() at time zone 'Africa/Dar_es_Salaam')::date, 'DN-SAND-1',
            jsonb_build_array(jsonb_build_object('product_id', tests.product(),
                                                 'expected_quantity', 10, 'received_quantity', 10)),
            tests.did('bolts'), 'rc-sand-1') ->> 'reason',
          'idempotency_key_conflict', 'and the same key naming another payment is a conflict');
select is(tests.enter('DN-SAND-2', tests.did('sand'), 'rc-sand-2'), 'entered',
          'one payment may pay for a second receipt');
select is(tests.enter('DN-BOLTS', tests.did('bolts'), 'rc-bolts'), 'entered',
          'a sent-back payment can be picked');
select is(tests.enter('DN-PAINT', tests.did('paint'), 'rc-paint'), 'entered',
          'so can a settled one');

select tests.manager();
select is(tests.enter('DN-CEMENT', tests.did('cement'), 'rc-cement'), 'entered',
          'the Manager links a verified payment');
select is(tests.enter('DN-NAILS-M', tests.did('nails'), 'rc-nails-m'), 'entered',
          'and any Cashier''s payment');
select is(tests.enter('DN-PLAIN', null, 'rc-plain'), 'entered',
          'a receipt need not be paid from imprest');
select is(api.staff_enter_stock_receipt(tests.supplier(), 'store',
            (now() at time zone 'Africa/Dar_es_Salaam')::date, 'DN-SIX',
            jsonb_build_array(jsonb_build_object('product_id', tests.product(),
                                                 'expected_quantity', 1, 'received_quantity', 1)),
            'rc-six') ->> 'reason',
          'entered', 'the six-argument form still enters a receipt, with no link');

select is(
  (select linked_by::text || '/' || linked_role::text || '/' || disbursement_id::text
     from public.stock_receipt_imprest_links where receipt_id = tests.rcpt('rc-sand-1')),
  'ea000000-0000-0000-0000-000000000003/cashier/' || tests.did('sand'),
  'the link records who made it and in what role');
select is(
  (select linked_role::text from public.stock_receipt_imprest_links
    where receipt_id = tests.rcpt('rc-cement')),
  'manager', 'the Manager''s link records the Manager');
select is((select count(*)::int from public.stock_receipt_imprest_links
            where disbursement_id = tests.did('sand')), 2,
          'a disbursement may pay for several receipts');
select is((select count(*)::int from public.stock_receipt_imprest_links
            where receipt_id in (tests.rcpt('rc-plain'), tests.rcpt('rc-rep-2'))), 0,
          'a receipt entered without it has no link');

-- Changing it after entry is refused, for every writer.
-- The owner of the tables, beyond the grants, meets the trigger.
select throws_ok(
  $$ update public.stock_receipt_imprest_links set disbursement_id = tests.did('bolts')
      where receipt_id = tests.rcpt('rc-sand-1') $$,
  '23001', null, 'a link cannot be changed');
select throws_ok(
  $$ delete from public.stock_receipt_imprest_links where receipt_id = tests.rcpt('rc-sand-1') $$,
  '23001', null, 'nor removed');
set local role fv_definer_owner;
select throws_ok(
  $$ update public.stock_receipt_imprest_links set disbursement_id = tests.did('bolts')
      where receipt_id = tests.rcpt('rc-sand-1') $$,
  '42501', null, 'and the commands'' owner holds no grant to change one');
select throws_ok(
  $$ insert into public.stock_receipt_imprest_links
       (receipt_id, disbursement_id, fund_id, linked_by, linked_role, correlation_id)
     values (tests.rcpt('rc-sand-1'), tests.did('bolts'), 'ea000000-0000-0000-0000-00000000f001',
             'ea000000-0000-0000-0000-000000000003', 'cashier', gen_random_uuid()) $$,
  '23505', null, 'a receipt links to at most one disbursement');
select throws_ok(
  $$ insert into public.stock_receipt_imprest_links
       (receipt_id, disbursement_id, fund_id, linked_by, linked_role, correlation_id, linked_at)
     values (tests.rcpt('rc-plain'), tests.did('cement'), 'ea000000-0000-0000-0000-00000000f001',
             'ea000000-0000-0000-0000-000000000002', 'manager', gen_random_uuid(),
             clock_timestamp() + interval '1 minute') $$,
  '23001', null, 'a receipt entered without a link cannot gain one afterwards');
select throws_ok(
  $$ insert into public.stock_receipt_imprest_links
       (receipt_id, disbursement_id, fund_id, linked_by, linked_role, correlation_id)
     values (tests.rcpt('rc-rep-2'), tests.did('cement'), 'ea000000-0000-0000-0000-00000000f001',
             'ea000000-0000-0000-0000-000000000002', 'manager', gen_random_uuid()) $$,
  '23001', null, 'nor from somebody who did not enter it');
select throws_ok(
  $$ truncate public.stock_receipt_imprest_links $$, '42501', null, 'nor emptied');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 5 · Nothing moves
-- ---------------------------------------------------------------------------
select is(tests.figures(), (select f from before_figures),
          'linking changed no imprest figure: posted, set aside, free and awaiting are as they were');
select is(tests.stock(), (select s from before_figures), 'and no stock moved');
select is((select count(*)::int from public.approval_requests
            where entity_type = 'stock_receipt' and entity_id = tests.rcpt('rc-sand-1')
              and status = 'pending'), 1,
          'the linked receipt waits for the Manager like any other');

select tests.manager();
select is(api.staff_approve_stock_receipt(tests.rcpt('rc-sand-1'), 'ap-sand-1') ->> 'reason',
          'approved', 'the Manager approves it');
select is(tests.stock() - (select s from before_figures), 10::bigint,
          'and only then does stock increase, by what was accepted');
select is(tests.figures(), (select f from before_figures),
          'approval moves no imprest figure either');
select is((select disbursement_id from public.stock_receipt_imprest_links
            where receipt_id = tests.rcpt('rc-sand-1')), tests.did('sand'),
          'and the link stands after approval');

-- ---------------------------------------------------------------------------
-- Criterion 4 · Read from both sides
-- ---------------------------------------------------------------------------
select tests.cashier();
select is(
  (select l -> 'disbursement' ->> 'recipient'
     from jsonb_array_elements(api.staff_stock_receipt_imprest_links(
            array[tests.rcpt('rc-sand-1')])) l),
  'Simba Sand Ltd', 'the Cashier reads the disbursement of the receipt they entered');
select is(
  jsonb_array_length(api.staff_stock_receipt_imprest_links(array[tests.rcpt('rc-cement')])),
  0, 'but not of a receipt the Manager entered');
select is(
  (select string_agg(x ->> 'delivery_note_ref', ',' order by x ->> 'delivery_note_ref')
     from jsonb_array_elements(api.staff_imprest_disbursement_stock_receipts(tests.did('sand'))) x),
  'DN-SAND-1,DN-SAND-2', 'the Cashier reads the receipts their payment paid for');
select is(
  (select x ->> 'approval_status'
     from jsonb_array_elements(api.staff_imprest_disbursement_stock_receipts(tests.did('sand'))) x
    where x ->> 'delivery_note_ref' = 'DN-SAND-1'),
  'approved', 'with whether the Manager approved each');

select tests.cashier_b();
select is(
  (select x ->> 'entered_by'
     from jsonb_array_elements(api.staff_imprest_disbursement_stock_receipts(tests.did('nails'))) x),
  'Link Manager', 'a Cashier reads a receipt the Manager linked to their payment');
select ok(api.staff_imprest_disbursement_stock_receipts(tests.did('sand')) is null,
          'but reads nothing of another Cashier''s payment');
set local role authenticated;
select is((select count(*)::int from public.stock_receipt_imprest_links), 1,
          'and row-level security shows them only the link to their own payment');
reset role;

select tests.director();
select is(
  jsonb_array_length(api.staff_stock_receipt_imprest_links(array[tests.rcpt('rc-sand-1'),
    tests.rcpt('rc-cement'), tests.rcpt('rc-plain')])),
  2, 'a Director reads the disbursement of every linked receipt');
select is(
  (select l -> 'disbursement' ->> 'approved_tzs'
     from jsonb_array_elements(api.staff_stock_receipt_imprest_links(
            array[tests.rcpt('rc-nails-m')])) l),
  '11000', 'with its approved amount');
select is(
  jsonb_array_length(api.staff_imprest_disbursement_stock_receipts(tests.did('cement'))),
  1, 'and the receipts of every disbursement');
set local role authenticated;
select is((select count(*)::int from public.stock_receipt_imprest_links), 6,
          'row-level security shows Directors every link');
reset role;

select tests.rep();
select is(
  jsonb_array_length(api.staff_stock_receipt_imprest_links(array[tests.rcpt('rc-rep-2'),
    tests.rcpt('rc-sand-1')])),
  0, 'a Sales Representative reads no link they did not make');
select throws_ok($$ select api.staff_imprest_disbursement_stock_receipts(tests.did('sand')) $$,
                 '42501', null, 'and no disbursement');
set local role authenticated;
select is((select count(*)::int from public.stock_receipt_imprest_links), 0,
          'row-level security shows them none');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 6 · The audit trail
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from public.audit_events a
     join public.audit_events e on e.correlation_id = a.correlation_id
                                and e.action = 'stock_receipt_entered'
    where a.action = 'stock_receipt_paid_from_imprest'
      and a.entity_type = 'stock_receipt' and a.entity_id = tests.rcpt('rc-sand-1')
      and a.actor_id = 'ea000000-0000-0000-0000-000000000003' and a.actor_role = 'cashier'
      and a.source_operation = 'api.staff_enter_stock_receipt'
      and (a.after_state ->> 'disbursement_id')::uuid = tests.did('sand')),
  1, 'the link is audited with its actor, live role and operation, under the entry''s correlation');
select is((select count(*)::int from public.audit_events
            where action = 'stock_receipt_paid_from_imprest'), 6,
          'once for every linked receipt, and not for a replay');
select is(
  (select string_agg(after_state ->> 'reason', ',' order by after_state ->> 'reason')
     from public.audit_events
    where action = 'command_refused' and source_operation = 'api.staff_enter_stock_receipt'
      and entity_type = 'imprest_disbursement'),
  'disbursement_not_paid,disbursement_not_paid,disbursement_not_paid,imprest_link_not_permitted,'
  'no_disbursement,no_disbursement',
  'every refused link is audited with its reason, against the disbursement');
select is(
  (select count(*)::int from public.audit_events
    where action = 'command_refused' and source_operation = 'api.staff_enter_stock_receipt'
      and entity_type = 'supplier' and after_state ->> 'reason' = 'idempotency_key_conflict'),
  1, 'and a conflicting retry against the supplier');

-- ---------------------------------------------------------------------------
-- Every paid-out payment is offered, however many the fund holds
-- ---------------------------------------------------------------------------
do $$
begin
  for i in 1..51 loop
    perform tests.pay('cashier_b', 'bulk-' || i, 100, 'other', 'Bulk ' || i, 'handed_out');
  end loop;
end $$;
select tests.manager();
select is(jsonb_array_length(api.staff_imprest_receipt_payment_options()), 56,
          'the picker is not cut short: all 56 paid-out payments are offered, the oldest included');
select ok(
  exists (select 1 from jsonb_array_elements(api.staff_imprest_receipt_payment_options()) o
           where (o ->> 'id')::uuid = tests.did('sand')),
  'the first payment handed out is still there');

-- ---------------------------------------------------------------------------
-- The active fund only
-- ---------------------------------------------------------------------------
-- The fund is retired and the next one opened, directly: retirement itself is proved in 026.
set local session_replication_role = replica;
update public.imprest_funds set is_active = false, retired_at = now()
 where id = 'ea000000-0000-0000-0000-00000000f001';
insert into public.imprest_funds (id, opened_by) values
  ('ea000000-0000-0000-0000-00000000f002', 'ea000000-0000-0000-0000-000000000002');
set local session_replication_role = origin;

select tests.manager();
select is(jsonb_array_length(api.staff_imprest_receipt_payment_options()), 0,
          'a retired fund''s payments are no longer offered');
select is(tests.enter('DN-OLD', tests.did('cement'), 'rc-old'), 'disbursement_fund_retired',
          'nor can one be picked');
select is(
  (select l -> 'disbursement' ->> 'id'
     from jsonb_array_elements(api.staff_stock_receipt_imprest_links(
            array[tests.rcpt('rc-cement')])) l)::uuid,
  tests.did('cement'), 'a link already made still reads');

select * from finish();
rollback;
