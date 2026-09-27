-- Issue #62 · Imprest spending, part 2a: hand the cash out, then settle it
--
-- The claims under test, each traceable to issue #62's acceptance criteria:
--
--   1, 4   Only the proposing Cashier hands out, only while approved, and always the full amount.
--   2      A handed-out disbursement can no longer be cancelled.
--   3 to 6 Every settlement explains the approval: Approved = Used + Returned + Not accounted for.
--          Used plus Returned above Approved is refused (AC-100). A remainder needs an
--          explanation. Every line has a receipt or a No-receipt reason, never both, never neither.
--   9, 10  Receipts live in a private bucket. The command checks every file it is given.
--   12, 13 Hand-out and settlement keep the full amount set aside; Awaiting verification counts
--          the cash that has left the fund and not come back.
--   16     The hand-out, the settlement and its lines are append-only.
--   17, 18 Live roles, committed refusals, replays and changed retries.
--
-- The receipt files themselves are rows in `storage.objects` here, written the way the Storage
-- API writes them: under the caller's own role. The integration suite repeats the storage claims
-- through the real Storage API.

create extension if not exists pgtap with schema extensions;

begin;
select plan(111);

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

select tests.mk_user('e6200000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('e6200000-0000-0000-0000-000000000003'::uuid);  -- Manager
select tests.mk_user('e6200000-0000-0000-0000-000000000004'::uuid);  -- Cashier A
select tests.mk_user('e6200000-0000-0000-0000-000000000005'::uuid);  -- Sales Representative
select tests.mk_user('e6200000-0000-0000-0000-000000000006'::uuid);  -- Disabled Cashier
select tests.mk_user('e6200000-0000-0000-0000-000000000007'::uuid);  -- Cashier B

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('e6200000-0000-0000-0000-000000000001', 'Settle Director',  '+255700006201', true,  false),
  ('e6200000-0000-0000-0000-000000000003', 'Settle Manager',   '+255700006203', true,  false),
  ('e6200000-0000-0000-0000-000000000004', 'Settle Cashier A', '+255700006204', true,  false),
  ('e6200000-0000-0000-0000-000000000005', 'Settle Rep',       '+255700006205', true,  false),
  ('e6200000-0000-0000-0000-000000000006', 'Gone Cashier',     '+255700006206', false, false),
  ('e6200000-0000-0000-0000-000000000007', 'Settle Cashier B', '+255700006207', true,  false);

insert into public.user_roles (user_id, role) values
  ('e6200000-0000-0000-0000-000000000001', 'director'),
  ('e6200000-0000-0000-0000-000000000003', 'manager'),
  ('e6200000-0000-0000-0000-000000000004', 'cashier'),
  ('e6200000-0000-0000-0000-000000000005', 'sales_rep'),
  ('e6200000-0000-0000-0000-000000000006', 'cashier'),
  ('e6200000-0000-0000-0000-000000000007', 'cashier');

create or replace function tests.director() returns void language sql as $$
  select tests.acting_as('e6200000-0000-0000-0000-000000000001'::uuid); $$;
create or replace function tests.manager() returns void language sql as $$
  select tests.acting_as('e6200000-0000-0000-0000-000000000003'::uuid); $$;
create or replace function tests.cashier() returns void language sql as $$
  select tests.acting_as('e6200000-0000-0000-0000-000000000004'::uuid); $$;
create or replace function tests.rep() returns void language sql as $$
  select tests.acting_as('e6200000-0000-0000-0000-000000000005'::uuid); $$;
create or replace function tests.cashier_b() returns void language sql as $$
  select tests.acting_as('e6200000-0000-0000-0000-000000000007'::uuid); $$;

create temp table r (name text primary key, res jsonb not null);
grant all on r to public;
create or replace function tests.keep(p_name text, p_res jsonb) returns text language sql as $$
  insert into r values (p_name, p_res) returning res ->> 'reason';
$$;
create or replace function tests.did(p_name text) returns uuid language sql as $$
  select (res -> 'disbursement' ->> 'id')::uuid from r where name = p_name; $$;
create or replace function tests.rid(p_name text) returns uuid language sql as $$
  select (res -> 'receipt' ->> 'id')::uuid from r where name = p_name; $$;
create or replace function tests.rpath(p_name text) returns text language sql as $$
  select res -> 'receipt' ->> 'object_path' from r where name = p_name; $$;
create or replace function tests.ver(p_id uuid) returns integer language sql
  security definer as $$ select version from public.imprest_disbursements where id = p_id; $$;
create or replace function tests.status(p_id uuid) returns text language sql
  security definer as $$ select status::text from public.imprest_disbursements where id = p_id; $$;
create or replace function tests.figures() returns text language sql security definer as $$
  select s.posted_funding_tzs || '/' || s.set_aside_tzs || '/' || s.free_to_approve_tzs
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active; $$;
create or replace function tests.awaiting() returns bigint language sql security definer as $$
  select private.imprest_awaiting_verification_tzs(f.id) from public.imprest_funds f
   where f.is_active; $$;
-- One settlement line, in the shape the command takes.
create or replace function tests.line(p_amount bigint, p_purpose text, p_receipt uuid,
                                      p_reason text default null, p_note text default null)
returns jsonb language sql as $$
  select jsonb_build_object('amount_tzs', p_amount, 'purpose', p_purpose, 'receipt_id', p_receipt,
                            'no_receipt_reason', p_reason, 'no_receipt_note', p_note); $$;
-- A file landing in the bucket, written under the caller's own role as the Storage API writes it.
create or replace function tests.upload(p_path text, p_owner uuid) returns void language sql as $$
  insert into storage.objects (bucket_id, name, owner, owner_id, metadata)
  values ('imprest-evidence', p_path, p_owner, p_owner::text,
          jsonb_build_object('size', 1024, 'mimetype', 'application/octet-stream')); $$;
create or replace function tests.visible_objects() returns integer language sql as $$
  select count(*)::int from storage.objects where bucket_id = 'imprest-evidence'; $$;

-- ---------------------------------------------------------------------------
-- The shape: four append-only tables no client writes, and a private bucket
-- ---------------------------------------------------------------------------
select ok(
  (select bool_and(not has_table_privilege('authenticated', 'public.' || t, 'insert')
                   and not has_table_privilege('authenticated', 'public.' || t, 'update')
                   and not has_table_privilege('authenticated', 'public.' || t, 'delete')
                   and not has_table_privilege('service_role', 'public.' || t, 'select')
                   and not has_table_privilege('service_role', 'public.' || t, 'insert')
                   and not has_table_privilege('anon', 'public.' || t, 'select'))
     from unnest(array['imprest_disbursement_handouts', 'imprest_receipts',
                       'imprest_settlements', 'imprest_settlement_lines']) t),
  'no client writes the hand-out, receipt or settlement tables, and anon and the service role read none');

select ok(
  (select bool_and(c.relrowsecurity) from pg_class c
    where c.oid in ('public.imprest_disbursement_handouts'::regclass,
                    'public.imprest_receipts'::regclass, 'public.imprest_settlements'::regclass,
                    'public.imprest_settlement_lines'::regclass)),
  'all four tables have row-level security');

select ok(
  has_column_privilege('authenticated', 'public.imprest_receipts', 'file_name', 'select')
  and not has_column_privilege('authenticated', 'public.imprest_receipts', 'encryption_key', 'select'),
  'a client may read a receipt''s name but never its encryption key');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     join pg_roles o on o.oid = p.proowner
    where n.nspname = 'api'
      and p.proname in ('staff_hand_out_imprest_disbursement', 'staff_register_imprest_receipt',
                        'staff_open_imprest_receipt', 'staff_settle_imprest_disbursement')
      and p.prosecdef and o.rolname = 'fv_definer_owner'
      and has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('service_role', p.oid, 'execute')),
  4,
  'four new commands, security definer, owned by fv_definer_owner, callable by staff sessions only');

select results_eq(
  $$ select public, file_size_limit, allowed_mime_types from storage.buckets
      where id = 'imprest-evidence' $$,
  $$ values (false, 15728668::bigint, array['application/octet-stream']::text[]) $$,
  'the imprest-evidence bucket is private and takes only encrypted files up to 15 MiB of content');

-- ---------------------------------------------------------------------------
-- A fund with TZS 200,000 posted, built directly as its owner would
-- ---------------------------------------------------------------------------
set local role fv_definer_owner;
insert into public.imprest_funds (id, opened_by) values
  ('e6200000-0000-0000-0000-00000000f001', 'e6200000-0000-0000-0000-000000000003');
insert into public.imprest_fundings (id, funding_no, fund_id, requested_amount_tzs, reason,
                                     requested_by)
values ('e6200000-0000-0000-0000-00000000f101', 'FV-IMP-TEST-6201',
        'e6200000-0000-0000-0000-00000000f001', 200000, 'Opening float',
        'e6200000-0000-0000-0000-000000000003');
insert into public.imprest_funding_handovers (id, funding_id, cycle, amount_tzs, provided_by)
values ('e6200000-0000-0000-0000-00000000f201', 'e6200000-0000-0000-0000-00000000f101', 1, 200000,
        'e6200000-0000-0000-0000-000000000001');
update public.imprest_fundings
   set status = 'received', version = version + 1,
       received_handover_id = 'e6200000-0000-0000-0000-00000000f201',
       received_amount_tzs = 200000, received_by = 'e6200000-0000-0000-0000-000000000003',
       received_at = now()
 where id = 'e6200000-0000-0000-0000-00000000f101';
reset role;

-- Three approved disbursements: the trip allowance, a second trip, and a casual worker.
select tests.cashier();
select tests.keep('trip', api.staff_propose_imprest_disbursement(
  60000, 'transport_and_delivery', 'Trip allowance, Dar to Kibaha', 'p-trip'));
select tests.keep('trip2', api.staff_propose_imprest_disbursement(
  60000, 'transport_and_delivery', 'Trip allowance, Dar to Bagamoyo', 'p-trip2'));
select tests.keep('worker', api.staff_propose_imprest_disbursement(
  20000, 'labour_and_casual_workers', 'Offloading cement', 'p-worker'));
select tests.cashier_b();
select tests.keep('b', api.staff_propose_imprest_disbursement(
  10000, 'fees_and_charges', 'Council levy', 'p-b'));
select tests.manager();
select tests.keep('a-trip', api.staff_decide_imprest_disbursement(
  tests.did('trip'), 1, true, null, 'a-trip'));
select tests.keep('a-trip2', api.staff_decide_imprest_disbursement(
  tests.did('trip2'), 1, true, null, 'a-trip2'));
select tests.keep('a-worker', api.staff_decide_imprest_disbursement(
  tests.did('worker'), 1, true, null, 'a-worker'));
select tests.keep('a-b', api.staff_decide_imprest_disbursement(
  tests.did('b'), 1, true, null, 'a-b'));

select is(tests.figures(), '200000/150000/50000', 'four approvals set TZS 150,000 aside');
select is(tests.awaiting(), 0::bigint, 'nothing has left the fund yet');

-- ---------------------------------------------------------------------------
-- Criterion 1 · Hand out
-- ---------------------------------------------------------------------------
select tests.manager();
select throws_ok(
  $$ select api.staff_hand_out_imprest_disbursement(tests.did('trip'), 2, 'Juma', 'h-mgr') $$,
  '42501', null, 'a Manager cannot hand out');
select tests.acting_as('e6200000-0000-0000-0000-000000000006'::uuid);
select throws_ok(
  $$ select api.staff_hand_out_imprest_disbursement(tests.did('trip'), 2, 'Juma', 'h-gone') $$,
  '42501', null, 'nor can a disabled Cashier');

select tests.cashier_b();
select is(api.staff_hand_out_imprest_disbursement(tests.did('trip'), 2, 'Juma', 'h-b') ->> 'reason',
          'no_disbursement', 'another Cashier''s disbursement is answered as missing');

select tests.cashier();
select is(api.staff_hand_out_imprest_disbursement(tests.did('trip'), 1, 'Juma', 'h-stale')
            ->> 'reason', 'stale', 'a hand-out against an older version is refused');
select is(api.staff_hand_out_imprest_disbursement(tests.did('trip'), 2, ' J ', 'h-short')
            ->> 'reason', 'recipient_invalid', 'a recipient under two characters is refused');
select is(api.staff_hand_out_imprest_disbursement(tests.did('trip'), 2, repeat('x', 121), 'h-long')
            ->> 'reason', 'recipient_invalid', 'a recipient over 120 characters is refused');
select ok(
  not exists (select 1 from information_schema.parameters
               where specific_schema = 'api'
                 and specific_name like 'staff_hand_out_imprest_disbursement%'
                 and parameter_name like '%amount%'),
  'the hand-out has no amount parameter: the approved amount is always what goes out');

select is(tests.keep('h-trip', api.staff_hand_out_imprest_disbursement(
            tests.did('trip'), 2, '  Juma   the driver ', 'h-trip')),
          'handed_out', 'the proposing Cashier hands the trip allowance out');
select is(tests.status(tests.did('trip')), 'handed_out', 'the disbursement is handed out');
select results_eq(
  format($$ select recipient, amount_tzs, handed_out_by::text from public.imprest_disbursement_handouts
             where disbursement_id = %L $$, tests.did('trip')),
  $$ values ('Juma the driver'::text, 60000::bigint,
             'e6200000-0000-0000-0000-000000000004'::text) $$,
  'the hand-out row records the tidied recipient, the full approved amount and who handed it out');
select is(tests.figures(), '200000/150000/50000',
          'handing out keeps the full amount set aside, so Free to approve is unchanged (AC-102)');
select is(tests.awaiting(), 60000::bigint, 'the cash out with the driver is Awaiting verification');

select is(api.staff_hand_out_imprest_disbursement(tests.did('trip'), 2, 'Juma the driver', 'h-trip')
            ->> 'reason', 'replayed', 'the same request replays');
select is(api.staff_hand_out_imprest_disbursement(tests.did('trip'), 2, 'Hamisi', 'h-trip')
            ->> 'reason', 'idempotency_key_conflict', 'a changed retry on the same key is a conflict');
select is(api.staff_hand_out_imprest_disbursement(tests.did('trip'), 3, 'Hamisi', 'h-trip-again')
            ->> 'reason', 'not_approved', 'a second hand-out is refused');
select is((select count(*)::int from public.imprest_disbursement_handouts
            where disbursement_id = tests.did('trip')), 1, 'and there is still one hand-out');

-- ---------------------------------------------------------------------------
-- Criterion 2 · No cancelling after hand-out
-- ---------------------------------------------------------------------------
select tests.manager();
select is(api.staff_cancel_imprest_disbursement(tests.did('trip'), 3, 'Trip called off', 'c-trip')
            ->> 'reason', 'not_approved', 'the Manager cannot cancel a handed-out disbursement');
select is(tests.status(tests.did('trip')), 'handed_out', 'and it stays handed out');
select ok(exists (select 1 from public.audit_events
                   where action = 'command_refused' and entity_id = tests.did('trip')
                     and source_operation = 'api.staff_cancel_imprest_disbursement'
                     and after_state ->> 'status' = 'handed_out'),
          'the refused cancellation is on the audit trail with the status it met');

-- The other two are handed out for the settlements below.
select tests.cashier();
select tests.keep('h-trip2', api.staff_hand_out_imprest_disbursement(
  tests.did('trip2'), 2, 'Said the driver', 'h-trip2'));
select tests.keep('h-worker', api.staff_hand_out_imprest_disbursement(
  tests.did('worker'), 2, 'Casual worker Ali', 'h-worker'));
select tests.cashier_b();
select tests.keep('h-b', api.staff_hand_out_imprest_disbursement(tests.did('b'), 2, 'Council', 'h-b'));
select is(tests.awaiting(), 150000::bigint, 'four hand-outs put TZS 150,000 Awaiting verification');

-- ---------------------------------------------------------------------------
-- Criterion 9 · Registering a receipt, and the bucket's own rules
-- ---------------------------------------------------------------------------
select tests.cashier();
select is(api.staff_register_imprest_receipt(tests.did('trip'), 'receipt.txt', 'text/plain', 1000,
                                             'rr-type') ->> 'reason',
          'receipt_type_invalid', 'only JPEG, PNG, WebP, HEIC and PDF are accepted');
select is(api.staff_register_imprest_receipt(tests.did('trip'), 'huge.jpg', 'image/jpeg', 15728641,
                                             'rr-size') ->> 'reason',
          'receipt_too_large', 'a file over 15 MiB is refused');
select tests.cashier_b();
select is(api.staff_register_imprest_receipt(tests.did('trip'), 'petrol.jpg', 'image/jpeg', 3000000,
                                             'rr-b') ->> 'reason',
          'no_disbursement', 'another Cashier cannot file a receipt on this disbursement');

select tests.cashier();
select is(tests.keep('r1', api.staff_register_imprest_receipt(
            tests.did('trip'), 'petrol.jpg', 'image/jpeg', 3000000, 'rr-1')),
          'registered', 'the Cashier registers the petrol receipt');
select ok(tests.rpath('r1') = 'imprest/' || tests.did('trip') || '/' || tests.rid('r1'),
          'its path is tied to the disbursement and the receipt');
select is(length(decode((select res -> 'receipt' ->> 'key' from r where name = 'r1'), 'base64')), 32,
          'and it comes with its own 256-bit encryption key');
select is((api.staff_register_imprest_receipt(tests.did('trip'), 'petrol.jpg', 'image/jpeg', 3000000,
                                              'rr-1') -> 'receipt' ->> 'key'),
          (select res -> 'receipt' ->> 'key' from r where name = 'r1'),
          'a retry replays the same receipt and key, so a lost answer loses nothing');
select tests.keep('r2', api.staff_register_imprest_receipt(
  tests.did('trip'), 'parking.png', 'image/png', 200000, 'rr-2'));
select tests.keep('r3', api.staff_register_imprest_receipt(
  tests.did('trip'), 'fine.pdf', 'application/pdf', 400000, 'rr-3'));
select tests.keep('r-never', api.staff_register_imprest_receipt(
  tests.did('trip'), 'never.heic', 'image/heic', 2500000, 'rr-never'));
select tests.keep('r-other', api.staff_register_imprest_receipt(
  tests.did('trip2'), 'other.webp', 'image/webp', 100000, 'rr-other'));

set local role authenticated;
select lives_ok(format($$ select tests.upload(%L, %L) $$, tests.rpath('r1'),
                       'e6200000-0000-0000-0000-000000000004'),
                'the Cashier uploads the petrol receipt to its registered path');
select tests.upload(tests.rpath('r2'), 'e6200000-0000-0000-0000-000000000004');
select tests.upload(tests.rpath('r3'), 'e6200000-0000-0000-0000-000000000004');
select tests.upload(tests.rpath('r-other'), 'e6200000-0000-0000-0000-000000000004');
select throws_ok(format($$ select tests.upload(%L, %L) $$,
                        'imprest/' || tests.did('trip') || '/made-up',
                        'e6200000-0000-0000-0000-000000000004'),
                 '42501', null, 'a path nobody registered cannot be uploaded to');
-- No update or delete policy exists, so a signed-in person's attempt reaches no row at all.
update storage.objects set metadata = '{}' where bucket_id = 'imprest-evidence';
select is((select count(*)::int from storage.objects
            where bucket_id = 'imprest-evidence' and metadata = '{}'), 0,
          'a signed-in person cannot change a stored receipt');
select throws_ok($$ delete from storage.objects where bucket_id = 'imprest-evidence' $$,
                 null, null, 'nor delete one');
select tests.cashier_b();
select throws_ok(format($$ select tests.upload(%L, %L) $$, tests.rpath('r-never'),
                        'e6200000-0000-0000-0000-000000000007'),
                 '42501', null, 'another Cashier cannot upload to this Cashier''s receipt path');
select is(tests.visible_objects(), 0, 'another Cashier opens none of this Cashier''s receipts');
select tests.cashier();
select is(tests.visible_objects(), 4, 'the Cashier opens their own four receipts');
select tests.manager();
select is(tests.visible_objects(), 4, 'the Manager opens every receipt');
select tests.director();
select is(tests.visible_objects(), 4, 'so does a Director');
select tests.rep();
select is(tests.visible_objects(), 0, 'a Sales Representative opens none');
reset role;
set local role anon;
select is(tests.visible_objects(), 0, 'anon opens none');
reset role;
set local role service_role;
select throws_ok(format($$ select tests.upload(%L, %L) $$,
                        'imprest/' || tests.did('trip') || '/by-secret-key',
                        'e6200000-0000-0000-0000-000000000004'),
                 '42501', null, 'the secret key cannot put a file in the bucket');
select throws_ok($$ update storage.objects set metadata = '{}' where bucket_id = 'imprest-evidence' $$,
                 '42501', null, 'nor change one, though it passes row-level security');
-- Storage lets its own API delete by setting this flag; the bucket's trigger still refuses.
select set_config('storage.allow_delete_query', 'true', true);
select throws_ok($$ delete from storage.objects where bucket_id = 'imprest-evidence' $$,
                 '42501', null, 'nor delete one, even the way the Storage API deletes');
select set_config('storage.allow_delete_query', 'false', true);
reset role;

select tests.manager();
select is(api.staff_open_imprest_receipt(tests.rid('r1')) -> 'receipt' ->> 'key',
          (select res -> 'receipt' ->> 'key' from r where name = 'r1'),
          'the Manager is given the key to open a receipt');
select tests.cashier_b();
select is(api.staff_open_imprest_receipt(tests.rid('r1')) ->> 'reason', 'no_receipt',
          'another Cashier is not given it');
select tests.rep();
select throws_ok(format($$ select api.staff_open_imprest_receipt(%L) $$, tests.rid('r1')),
                 '42501', null, 'nor is a Sales Representative');

-- ---------------------------------------------------------------------------
-- Criteria 3 to 6 and 10 · The settlement refusals. Nothing changes on any of them.
-- ---------------------------------------------------------------------------
select tests.cashier();

select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 3,
            jsonb_build_array(tests.line(35000, 'Petrol', tests.rid('r1')),
                              tests.line(10000, 'Parking', tests.rid('r2')),
                              tests.line(10000, 'Traffic fine', tests.rid('r3'))),
            13000, null, 's-over') ->> 'reason',
          'over_approval', 'Used 55,000 plus Returned 13,000 against 60,000 is refused (AC-100)');
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 3,
            jsonb_build_array(tests.line(35000, 'Petrol', null)), 25000, null, 's-neither')
            ->> 'reason',
          'line_evidence_required', 'a line with neither a receipt nor a reason is refused (AC-55)');
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 3,
            jsonb_build_array(tests.line(35000, 'Petrol', tests.rid('r1'), 'transport_fare')),
            25000, null, 's-both') ->> 'reason',
          'line_evidence_both', 'a line with both a receipt and a reason is refused');
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 3,
            jsonb_build_array(tests.line(35000, 'Petrol', null, 'receipt_lost_or_damaged')),
            25000, null, 's-lost') ->> 'reason',
          'no_receipt_note_required', '"Receipt lost or damaged" without an explanation is refused');
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 3,
            jsonb_build_array(tests.line(35000, 'Petrol', null, 'other', 'x')),
            25000, null, 's-other') ->> 'reason',
          'no_receipt_note_required', '"Other" with an explanation under three characters is refused');
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 3,
            jsonb_build_array(tests.line(35000, 'Petrol', null, 'forgot')),
            25000, null, 's-reason') ->> 'reason',
          'no_receipt_reason_invalid', 'a reason outside the six is refused');
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 3,
            jsonb_build_array(tests.line(0, 'Petrol', tests.rid('r1'))), 60000, null, 's-zero')
            ->> 'reason',
          'line_amount_invalid', 'a line of zero shillings is refused');
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 3,
            jsonb_build_array(tests.line(35000, 'P', tests.rid('r1'))), 25000, null, 's-purpose')
            ->> 'reason',
          'line_purpose_invalid', 'a line purpose under two characters is refused');
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 3,
            (select jsonb_agg(tests.line(100, 'Tea', null, 'vendor_did_not_issue'))
               from generate_series(1, 21)),
            57900, null, 's-many') ->> 'reason',
          'too_many_lines', 'more than twenty lines are refused');
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 3, '[]'::jsonb, -1, null,
                                                's-negative') ->> 'reason',
          'returned_invalid', 'negative returned cash is refused');
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 3,
            jsonb_build_array(tests.line(35000, 'Petrol', tests.rid('r-never'))), 25000, null,
            's-missing') ->> 'reason',
          'receipt_not_uploaded', 'a receipt with no file behind it is refused');
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 3,
            jsonb_build_array(tests.line(35000, 'Petrol', tests.rid('r-other'))), 25000, null,
            's-elsewhere') ->> 'reason',
          'receipt_wrong_disbursement', 'a receipt filed under another disbursement is refused');
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 3,
            jsonb_build_array(tests.line(20000, 'Petrol', tests.rid('r1')),
                              tests.line(15000, 'Petrol again', tests.rid('r1'))),
            25000, null, 's-twice') ->> 'reason',
          'receipt_cited_twice', 'one file cited on two lines is refused');
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 3,
            jsonb_build_array(tests.line(35000, 'Petrol', gen_random_uuid())), 25000, null,
            's-nothing') ->> 'reason',
          'receipt_not_found', 'a receipt that was never registered is refused');
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 3,
            jsonb_build_array(tests.line(35000, 'Petrol', tests.rid('r1'))), 20000, null,
            's-unexplained') ->> 'reason',
          'explanation_required', 'a remainder with no explanation is refused');
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 3,
            jsonb_build_array(tests.line(35000, 'Petrol', tests.rid('r1'))), 25000,
            'Nothing is missing', 's-extra') ->> 'reason',
          'explanation_not_needed', 'an explanation with nothing unexplained is refused');
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 2,
            jsonb_build_array(tests.line(35000, 'Petrol', tests.rid('r1'))), 25000, null,
            's-stale') ->> 'reason',
          'stale', 'a settlement against an older version is refused');
select tests.cashier_b();
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 3, '[]'::jsonb, 60000, null,
                                                's-b') ->> 'reason',
          'no_disbursement', 'another Cashier cannot settle it');

-- A receipt uploaded by somebody other than the settling Cashier, built directly. No command lets
-- this arise; the check is what makes sure it could never count if it did.
reset role;
set local role fv_definer_owner;
insert into public.imprest_receipts (id, disbursement_id, object_path, file_name, content_type,
                                     byte_size, encryption_key, uploaded_by)
values ('e6200000-0000-0000-0000-00000000aaaa', tests.did('trip'),
        'imprest/' || tests.did('trip') || '/e6200000-0000-0000-0000-00000000aaaa', 'planted.jpg',
        'image/jpeg', 1000, extensions.gen_random_bytes(32), 'e6200000-0000-0000-0000-000000000007');
reset role;
select tests.cashier();
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 3,
            jsonb_build_array(tests.line(35000, 'Petrol',
                                         'e6200000-0000-0000-0000-00000000aaaa'::uuid)),
            25000, null, 's-planted') ->> 'reason',
          'receipt_not_yours', 'a receipt another person uploaded is refused');

select is(tests.status(tests.did('trip')), 'handed_out', 'after every refusal it is still handed out');
select is((select count(*)::int from public.imprest_settlements
            where disbursement_id = tests.did('trip')), 0, 'and no settlement was written');
select ok((select count(*) from public.audit_events
            where action = 'command_refused' and entity_id = tests.did('trip')
              and source_operation = 'api.staff_settle_imprest_disbursement') >= 15,
          'every refused settlement is on the audit trail');

-- ---------------------------------------------------------------------------
-- The trip allowance: three receipts and TZS 13,000 of change
-- ---------------------------------------------------------------------------
select is(tests.keep('s-trip', api.staff_settle_imprest_disbursement(tests.did('trip'), 3,
            jsonb_build_array(tests.line(35000, 'Petrol, Dar to Kibaha', tests.rid('r1')),
                              tests.line(2000, 'Parking', tests.rid('r2')),
                              tests.line(10000, 'Traffic fine', tests.rid('r3'))),
            13000, null, 's-trip')),
          'settled', 'the Cashier settles three receipts and TZS 13,000 returned');
select results_eq(
  format($$ select cycle, approved_tzs, used_tzs, returned_tzs, unaccounted_tzs, line_count,
                   no_receipt_lines
              from public.imprest_settlements where disbursement_id = %L $$, tests.did('trip')),
  $$ values (1, 60000::bigint, 47000::bigint, 13000::bigint, 0::bigint, 3, 0) $$,
  'cycle 1: Approved 60,000 = Used 47,000 + Returned 13,000 + Not accounted for 0');
select is(tests.status(tests.did('trip')), 'settled', 'the disbursement is settled');
select is(tests.figures(), '200000/150000/50000',
          'settling keeps the full amount set aside until the Manager verifies (AC-102)');
select is(tests.awaiting(), 137000::bigint,
          'the TZS 13,000 returned is back in the fund, so Awaiting verification drops by it');
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 3,
            jsonb_build_array(tests.line(35000, 'Petrol, Dar to Kibaha', tests.rid('r1')),
                              tests.line(2000, 'Parking', tests.rid('r2')),
                              tests.line(10000, 'Traffic fine', tests.rid('r3'))),
            13000, null, 's-trip') ->> 'reason',
          'replayed', 'the same settlement replays');
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 3,
            jsonb_build_array(tests.line(35000, 'Petrol, Dar to Kibaha', tests.rid('r1')),
                              tests.line(2000, 'Parking', tests.rid('r2')),
                              tests.line(10000, 'Traffic fine', tests.rid('r3'))),
            12000, 'One thousand short', 's-trip') ->> 'reason',
          'idempotency_key_conflict', 'a changed retry on the same key is a conflict, not a replay');
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 4, '[]'::jsonb, 60000, null,
                                                's-trip-again') ->> 'reason',
          'not_handed_out', 'a settled disbursement cannot be settled again in this release');
select is(api.staff_register_imprest_receipt(tests.did('trip'), 'late.jpg', 'image/jpeg', 1000,
                                             'rr-late') ->> 'reason',
          'not_handed_out', 'and no receipt can be added to it afterwards');
select is((select count(*)::int from public.imprest_settlements
            where disbursement_id = tests.did('trip')), 1, 'there is one settlement');

-- ---------------------------------------------------------------------------
-- Change goes missing: TZS 3,000 Not accounted for, with its explanation
-- ---------------------------------------------------------------------------
select is(tests.keep('s-trip2', api.staff_settle_imprest_disbursement(tests.did('trip2'), 3,
            jsonb_build_array(tests.line(35000, 'Petrol', null, 'vendor_did_not_issue'),
                              tests.line(2000, 'Parking', null, 'informal_or_casual_labour'),
                              tests.line(10000, 'Traffic fine', null, 'emergency_purchase')),
            10000, '  Driver says the change   was short ', 's-trip2')),
          'settled', 'a settlement with a remainder goes through with an explanation');
select results_eq(
  format($$ select used_tzs, returned_tzs, unaccounted_tzs, unaccounted_explanation, no_receipt_lines
              from public.imprest_settlements where disbursement_id = %L $$, tests.did('trip2')),
  $$ values (47000::bigint, 10000::bigint, 3000::bigint, 'Driver says the change was short'::text, 3) $$,
  'Not accounted for is calculated as TZS 3,000 and the explanation is kept');
select is(tests.awaiting(), 127000::bigint,
          'Awaiting verification counts the used and the unexplained cash: 47,000 + 50,000 + 30,000');

-- ---------------------------------------------------------------------------
-- A casual worker, no receipt; and the trip that was called off
-- ---------------------------------------------------------------------------
select is(tests.keep('s-worker', api.staff_settle_imprest_disbursement(tests.did('worker'), 3,
            jsonb_build_array(tests.line(20000, 'Offloading cement', null,
                                         'informal_or_casual_labour')),
            0, null, 's-worker')),
          'settled', 'a casual worker is settled on one No-receipt line');

select tests.cashier_b();
select is(tests.keep('s-b', api.staff_settle_imprest_disbursement(tests.did('b'), 3, '[]'::jsonb,
            10000, null, 's-b-full')),
          'settled', 'a disbursement that did not happen is settled with no lines, all returned');
select results_eq(
  format($$ select used_tzs, returned_tzs, unaccounted_tzs, line_count from public.imprest_settlements
             where disbursement_id = %L $$, tests.did('b')),
  $$ values (0::bigint, 10000::bigint, 0::bigint, 0) $$,
  'Used is zero and the whole amount came back');
select is(tests.awaiting(), 117000::bigint, 'and its TZS 10,000 leaves Awaiting verification');
select is(tests.figures(), '200000/150000/50000', 'while all four stay set aside');

-- Every No-receipt reason, the two that need one with an explanation.
select tests.cashier();
select tests.keep('six', api.staff_propose_imprest_disbursement(
  6000, 'other', 'Six small payments', 'p-six'));
select tests.manager();
select tests.keep('a-six', api.staff_decide_imprest_disbursement(tests.did('six'), 1, true, null, 'a-six'));
select tests.cashier();
select tests.keep('h-six', api.staff_hand_out_imprest_disbursement(tests.did('six'), 2, 'Shop', 'h-six'));
select is(api.staff_settle_imprest_disbursement(tests.did('six'), 3,
            jsonb_build_array(tests.line(1000, 'Nails', null, 'vendor_did_not_issue'),
                              tests.line(1000, 'Carrying', null, 'informal_or_casual_labour'),
                              tests.line(1000, 'Bajaji', null, 'transport_fare'),
                              tests.line(1000, 'Fuse', null, 'emergency_purchase'),
                              tests.line(1000, 'Rope', null, 'receipt_lost_or_damaged',
                                         'Receipt fell in the mixer'),
                              tests.line(1000, 'Tip', null, 'other', 'Paid the guard')),
            0, null, 's-six') ->> 'reason',
          'settled', 'each of the six No-receipt reasons is accepted');

-- ---------------------------------------------------------------------------
-- Criterion 7 and 8 · Who reads the breakdown
-- ---------------------------------------------------------------------------
set local role authenticated;
select tests.cashier();
select is((select count(*)::int from public.imprest_settlements), 4,
          'the Cashier reads their own four settlements');
select is((select count(*)::int from public.imprest_settlement_lines), 13, 'and their thirteen lines');
select tests.cashier_b();
select is((select count(*)::int from public.imprest_settlements), 1,
          'another Cashier reads only their own settlement');
select is((select count(*)::int from public.imprest_receipts), 0, 'and none of the first Cashier''s receipts');
select tests.manager();
select is((select count(*)::int from public.imprest_settlements), 5, 'the Manager reads every settlement');
select is((select count(*)::int from public.imprest_disbursement_handouts), 5, 'and every hand-out');
select tests.director();
select is((select count(*)::int from public.imprest_settlement_lines), 13, 'a Director reads every line');
select tests.rep();
select is((select count(*)::int from public.imprest_settlements)
          + (select count(*)::int from public.imprest_disbursement_handouts)
          + (select count(*)::int from public.imprest_receipts), 0,
          'a Sales Representative reads none of it');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 13 · The fourth figure, and who is sent it
-- ---------------------------------------------------------------------------
set local role authenticated;
select tests.manager();
select is((select awaiting_verification_tzs from api.staff_imprest_spending_position()), 123000::bigint,
          'the Manager is sent Awaiting verification');
select tests.director();
select is((select awaiting_verification_tzs from api.staff_imprest_spending_position()), 123000::bigint,
          'so is a Director');
select tests.cashier();
select results_eq(
  $$ select posted_funding_tzs, set_aside_tzs, awaiting_verification_tzs, free_to_approve_tzs
       from api.staff_imprest_spending_position() $$,
  $$ values (null::bigint, null::bigint, null::bigint, 44000::bigint) $$,
  'the Cashier is still sent Free to approve alone');
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 16 · Nothing is overwritten
-- ---------------------------------------------------------------------------
-- The commands' own role holds no update or delete on these tables at all. The table owner holds
-- every privilege, so as the owner only the append-only triggers stand in the way.
select ok(
  (select bool_and(not has_table_privilege('fv_definer_owner', 'public.' || t, 'update')
                   and not has_table_privilege('fv_definer_owner', 'public.' || t, 'delete'))
     from unnest(array['imprest_disbursement_handouts', 'imprest_receipts',
                       'imprest_settlements', 'imprest_settlement_lines']) t),
  'not even the commands'' own role may update or delete a hand-out, receipt or settlement');
select throws_ok($$ update public.imprest_disbursement_handouts set recipient = 'Somebody else' $$,
                 '23001', null, 'a hand-out cannot be changed');
select throws_ok($$ update public.imprest_settlements set returned_tzs = returned_tzs + 1 $$,
                 '23001', null, 'a settlement cannot be changed');
select throws_ok($$ delete from public.imprest_settlement_lines $$,
                 '23001', null, 'nor can its lines be deleted');
select throws_ok($$ update public.imprest_receipts set file_name = 'other.jpg' $$,
                 '23001', null, 'nor a receipt record');
select throws_ok(
  format($$ update public.imprest_disbursements set status = 'approved', version = version + 1
             where id = %L $$, tests.did('trip')),
  '23001', null, 'a settled disbursement cannot go back to approved');
select throws_ok(
  $$ insert into public.imprest_settlements (disbursement_id, cycle, approved_tzs, used_tzs,
                                             returned_tzs, unaccounted_tzs, line_count,
                                             no_receipt_lines, settled_by)
     select id, 2, 60000, 0, 60000, 0, 0, 0, proposed_by from public.imprest_disbursements
      where disbursement_no is not null and id = (select (res -> 'disbursement' ->> 'id')::uuid
                                                     from r where name = 'trip') $$,
  '23514', null, 'a settlement cannot be written for a disbursement that is not handed out');
reset role;

-- A settlement whose Used disagrees with its lines, written directly. The check waits for commit
-- so a row and its lines can be written in either order; asked to check now, it refuses.
select tests.cashier();
select tests.keep('seven', api.staff_propose_imprest_disbursement(
  7000, 'other', 'Seventh payment', 'p-seven'));
select tests.manager();
select tests.keep('a-seven', api.staff_decide_imprest_disbursement(
  tests.did('seven'), 1, true, null, 'a-seven'));
select tests.cashier();
select tests.keep('h-seven', api.staff_hand_out_imprest_disbursement(
  tests.did('seven'), 2, 'Shop', 'h-seven'));
set constraints all immediate;
select throws_ok(
  format($$ insert into public.imprest_settlements (disbursement_id, cycle, approved_tzs, used_tzs,
                                                    returned_tzs, unaccounted_tzs, line_count,
                                                    no_receipt_lines, settled_by)
            values (%L, 1, 7000, 7000, 0, 0, 0, 0, 'e6200000-0000-0000-0000-000000000004') $$,
         tests.did('seven')),
  '23514', null, 'a settlement claiming TZS 7,000 used with no lines behind it is refused');
set constraints all deferred;

select * from finish();
rollback;
