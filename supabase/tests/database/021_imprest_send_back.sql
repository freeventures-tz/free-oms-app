-- Issue #65 · Imprest spending, part 2b-2: the Manager sends a settlement back, the Cashier settles again
--
-- The claims under test, each traceable to issue #65's acceptance criteria:
--
--   1   Only a live Manager sends back, only a settled disbursement, only its latest cycle, with a
--       reason of 3 to 500 characters, at the version they were shown, idempotently. Directors, the
--       Cashier and a Sales Representative cannot.
--   2   The return is its own append-only record tied to the cycle it returns. The disbursement reads
--       as sent back.
--   3   Only the proposing Cashier resubmits, only while sent back, as the next cycle, held to every
--       check of the first settlement. Nothing earlier changes.
--   4   A receipt may be cited again in a later cycle. New receipts are registered and uploaded while
--       sent back; the bucket still refuses a secret-key plant, a replacement and a delete.
--   5   Money stays set aside through every cycle, Awaiting verification counts the latest submitted
--       cycle, and nothing posts until a cycle is verified.
--   6   Verification takes the latest cycle only; a returned cycle can never be verified.
--   7   Every success and committed refusal is on the audit trail.

create extension if not exists pgtap with schema extensions;

begin;
select plan(100);

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

select tests.mk_user('e6500000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('e6500000-0000-0000-0000-000000000003'::uuid);  -- Manager
select tests.mk_user('e6500000-0000-0000-0000-000000000004'::uuid);  -- Cashier A
select tests.mk_user('e6500000-0000-0000-0000-000000000005'::uuid);  -- Sales Representative
select tests.mk_user('e6500000-0000-0000-0000-000000000006'::uuid);  -- Disabled Manager
select tests.mk_user('e6500000-0000-0000-0000-000000000007'::uuid);  -- Cashier B

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('e6500000-0000-0000-0000-000000000001', 'Return Director',  '+255700006501', true,  false),
  ('e6500000-0000-0000-0000-000000000003', 'Return Manager',   '+255700006503', true,  false),
  ('e6500000-0000-0000-0000-000000000004', 'Return Cashier A', '+255700006504', true,  false),
  ('e6500000-0000-0000-0000-000000000005', 'Return Rep',       '+255700006505', true,  false),
  ('e6500000-0000-0000-0000-000000000006', 'Gone Manager',     '+255700006506', false, false),
  ('e6500000-0000-0000-0000-000000000007', 'Return Cashier B', '+255700006507', true,  false);

insert into public.user_roles (user_id, role) values
  ('e6500000-0000-0000-0000-000000000001', 'director'),
  ('e6500000-0000-0000-0000-000000000003', 'manager'),
  ('e6500000-0000-0000-0000-000000000004', 'cashier'),
  ('e6500000-0000-0000-0000-000000000005', 'sales_rep'),
  ('e6500000-0000-0000-0000-000000000006', 'manager'),
  ('e6500000-0000-0000-0000-000000000007', 'cashier');

create or replace function tests.director() returns void language sql as $$
  select tests.acting_as('e6500000-0000-0000-0000-000000000001'::uuid); $$;
create or replace function tests.manager() returns void language sql as $$
  select tests.acting_as('e6500000-0000-0000-0000-000000000003'::uuid); $$;
create or replace function tests.cashier() returns void language sql as $$
  select tests.acting_as('e6500000-0000-0000-0000-000000000004'::uuid); $$;
create or replace function tests.rep() returns void language sql as $$
  select tests.acting_as('e6500000-0000-0000-0000-000000000005'::uuid); $$;
create or replace function tests.cashier_b() returns void language sql as $$
  select tests.acting_as('e6500000-0000-0000-0000-000000000007'::uuid); $$;

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
create or replace function tests.sid(p_id uuid, p_cycle integer default null) returns uuid
language sql security definer as $$
  select id from public.imprest_settlements
   where disbursement_id = p_id and (p_cycle is null or cycle = p_cycle)
   order by cycle desc limit 1; $$;
-- posted funding / posted balance / set aside / free to approve / awaiting verification
create or replace function tests.figures() returns text language sql security definer as $$
  select s.posted_funding_tzs || '/' || s.posted_balance_tzs || '/' || s.set_aside_tzs || '/'
         || s.free_to_approve_tzs || '/' || private.imprest_awaiting_verification_tzs(f.id)
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active; $$;
-- Everything recorded about one cycle, so a later cycle can be shown to have changed none of it.
create or replace function tests.cycle_digest(p_id uuid, p_cycle integer) returns text
language sql security definer as $$
  select md5(to_jsonb(s)::text || coalesce((select string_agg(to_jsonb(l)::text, '|' order by l.line_no)
                                               from public.imprest_settlement_lines l
                                              where l.settlement_id = s.id), ''))
    from public.imprest_settlements s where s.disbursement_id = p_id and s.cycle = p_cycle; $$;
create or replace function tests.line(p_amount bigint, p_purpose text, p_receipt uuid,
                                      p_reason text default null, p_note text default null)
returns jsonb language sql as $$
  select jsonb_build_object('amount_tzs', p_amount, 'purpose', p_purpose, 'receipt_id', p_receipt,
                            'no_receipt_reason', p_reason, 'no_receipt_note', p_note); $$;
create or replace function tests.upload(p_path text, p_owner uuid) returns void language sql as $$
  insert into storage.objects (bucket_id, name, owner, owner_id, metadata)
  values ('imprest-evidence', p_path, p_owner, p_owner::text,
          jsonb_build_object('size', 1024, 'mimetype', 'application/octet-stream')); $$;
create or replace function tests.send_back(p_id uuid, p_version integer, p_settlement uuid,
                                           p_reason text, p_key text) returns text
language sql as $$
  select api.staff_send_back_imprest_settlement(p_id, p_version, p_settlement, p_reason, p_key)
           ->> 'reason'; $$;

-- ---------------------------------------------------------------------------
-- The shape: one append-only table no client writes, one command, one new status
-- ---------------------------------------------------------------------------
select ok(
  not has_table_privilege('authenticated', 'public.imprest_settlement_returns', 'insert')
  and not has_table_privilege('authenticated', 'public.imprest_settlement_returns', 'update')
  and not has_table_privilege('authenticated', 'public.imprest_settlement_returns', 'delete')
  and has_table_privilege('authenticated', 'public.imprest_settlement_returns', 'select')
  and not has_table_privilege('service_role', 'public.imprest_settlement_returns', 'select')
  and not has_table_privilege('service_role', 'public.imprest_settlement_returns', 'insert')
  and not has_table_privilege('anon', 'public.imprest_settlement_returns', 'select')
  and not has_table_privilege('fv_definer_owner', 'public.imprest_settlement_returns', 'update')
  and not has_table_privilege('fv_definer_owner', 'public.imprest_settlement_returns', 'delete'),
  'no role writes a return except by insert through the command; anon and the service role read none');

select ok((select relrowsecurity from pg_class
            where oid = 'public.imprest_settlement_returns'::regclass),
          'the returns table has row-level security');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     join pg_roles o on o.oid = p.proowner
    where n.nspname = 'api' and p.proname = 'staff_send_back_imprest_settlement'
      and p.prosecdef and o.rolname = 'fv_definer_owner'
      and has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('service_role', p.oid, 'execute')),
  1,
  'the send-back command is security definer, owned by fv_definer_owner, callable by staff sessions only');

select ok(
  not exists (select 1 from information_schema.parameters
               where specific_schema = 'api'
                 and specific_name like 'staff_send_back_imprest_settlement%'
                 and (parameter_name like '%amount%' or parameter_name like '%tzs%')),
  'the Manager never corrects a figure: sending back takes no amount');

select is(
  (select string_agg(enumlabel, ',' order by enumsortorder) from pg_enum
    where enumtypid = 'public.imprest_disbursement_status'::regtype),
  'proposed,approved,handed_out,settled,sent_back,verified,rejected,withdrawn,cancelled',
  'sent back comes after settled');

-- ---------------------------------------------------------------------------
-- TZS 200,000 posted, built directly as its owner would
-- ---------------------------------------------------------------------------
set local role fv_definer_owner;
insert into public.imprest_funds (id, opened_by) values
  ('e6500000-0000-0000-0000-00000000f001', 'e6500000-0000-0000-0000-000000000003');
insert into public.imprest_fundings (id, funding_no, fund_id, requested_amount_tzs, reason,
                                     requested_by)
values ('e6500000-0000-0000-0000-00000000f101', 'FV-IMP-TEST-6501',
        'e6500000-0000-0000-0000-00000000f001', 200000, 'Opening float',
        'e6500000-0000-0000-0000-000000000003');
insert into public.imprest_funding_handovers (id, funding_id, cycle, amount_tzs, provided_by)
values ('e6500000-0000-0000-0000-00000000f201', 'e6500000-0000-0000-0000-00000000f101', 1, 200000,
        'e6500000-0000-0000-0000-000000000001');
update public.imprest_fundings
   set status = 'received', version = version + 1,
       received_handover_id = 'e6500000-0000-0000-0000-00000000f201',
       received_amount_tzs = 200000, received_by = 'e6500000-0000-0000-0000-000000000003',
       received_at = now()
 where id = 'e6500000-0000-0000-0000-00000000f101';
reset role;

-- The trip: 60,000, handed out and settled as Used 47,000 (a receipted 40,000 and a 7,000 fare
-- with no receipt), Returned 10,000 and 3,000 Not accounted for. The levy: Cashier B's, handed out.
select tests.cashier();
select tests.keep('trip', api.staff_propose_imprest_disbursement(
  60000, 'transport_and_delivery', 'Trip allowance, Dar to Kibaha', 'p-trip'));
select tests.cashier_b();
select tests.keep('levy', api.staff_propose_imprest_disbursement(
  10000, 'fees_and_charges', 'Council levy', 'p-levy'));
select tests.manager();
select tests.keep('a-trip', api.staff_decide_imprest_disbursement(tests.did('trip'), 1, true, null, 'a-trip'));
select tests.keep('a-levy', api.staff_decide_imprest_disbursement(tests.did('levy'), 1, true, null, 'a-levy'));
select tests.cashier();
select tests.keep('h-trip', api.staff_hand_out_imprest_disbursement(tests.did('trip'), 2, 'Juma', 'h-trip'));
select tests.keep('r1', api.staff_register_imprest_receipt(
  tests.did('trip'), 'fuel.jpg', 'image/jpeg', 300000, 'rr-1'));
select tests.cashier_b();
select tests.keep('h-levy', api.staff_hand_out_imprest_disbursement(tests.did('levy'), 2, 'Council', 'h-levy'));
select tests.keep('r-levy', api.staff_register_imprest_receipt(
  tests.did('levy'), 'levy.pdf', 'application/pdf', 50000, 'rr-levy'));
set local role authenticated;
select tests.cashier();
select tests.upload(tests.rpath('r1'), 'e6500000-0000-0000-0000-000000000004');
select tests.cashier_b();
select tests.upload(tests.rpath('r-levy'), 'e6500000-0000-0000-0000-000000000007');
reset role;

select tests.cashier();
select is(tests.keep('s-trip', api.staff_settle_imprest_disbursement(
            tests.did('trip'), 3,
            jsonb_build_array(tests.line(40000, 'Fuel', tests.rid('r1')),
                              tests.line(7000, 'Tolls', null, 'transport_fare')),
            10000, 'Driver cannot say where three thousand went', 's-trip')),
          'settled', 'the trip is settled as cycle 1');
select is(tests.figures(), '200000/200000/70000/130000/60000',
          'set aside 70,000; Awaiting verification is the trip''s 50,000 and the levy''s 10,000');

create temp table cycle1 as select tests.cycle_digest(tests.did('trip'), 1) as digest;
grant all on cycle1 to public;

-- ---------------------------------------------------------------------------
-- Criterion 1 · Who may send back, and what
-- ---------------------------------------------------------------------------
select tests.director();
select throws_ok(
  format($$ select tests.send_back(%L, 4, %L, 'The fuel receipt is unreadable', 'b-dir') $$,
         tests.did('trip'), tests.sid(tests.did('trip'))),
  '42501', null, 'a Director reads and does not send back');
select tests.cashier();
select throws_ok(
  format($$ select tests.send_back(%L, 4, %L, 'The fuel receipt is unreadable', 'b-cash') $$,
         tests.did('trip'), tests.sid(tests.did('trip'))),
  '42501', null, 'the Cashier cannot send back their own settlement');
select tests.rep();
select throws_ok(
  format($$ select tests.send_back(%L, 4, %L, 'The fuel receipt is unreadable', 'b-rep') $$,
         tests.did('trip'), tests.sid(tests.did('trip'))),
  '42501', null, 'a Sales Representative cannot send back');
select tests.acting_as('e6500000-0000-0000-0000-000000000006'::uuid);
select throws_ok(
  format($$ select tests.send_back(%L, 4, %L, 'The fuel receipt is unreadable', 'b-gone') $$,
         tests.did('trip'), tests.sid(tests.did('trip'))),
  '42501', null, 'nor can a disabled Manager');

select tests.manager();
select is(tests.send_back(gen_random_uuid(), 1, gen_random_uuid(), 'Unreadable receipt', 'b-none'),
          'no_disbursement', 'a disbursement that does not exist is refused');
select is(tests.send_back(tests.did('trip'), 3, tests.sid(tests.did('trip')), 'Unreadable receipt', 'b-stale'),
          'stale', 'a send-back against an older version is refused');
select is(tests.send_back(tests.did('trip'), 4, tests.sid(tests.did('trip')), null, 'b-null'),
          'reason_required', 'a send-back without a reason is refused');
select is(tests.send_back(tests.did('trip'), 4, tests.sid(tests.did('trip')), '   ', 'b-blank'),
          'reason_required', 'so is one whose reason is only spaces');
select is(tests.send_back(tests.did('trip'), 4, tests.sid(tests.did('trip')), 'no', 'b-short'),
          'reason_required', 'so is a reason under 3 characters');
select is(tests.send_back(tests.did('trip'), 4, tests.sid(tests.did('trip')), repeat('x', 501), 'b-long'),
          'reason_required', 'and one over 500');
select ok(exists (select 1 from public.audit_events
                   where action = 'command_refused' and entity_id = tests.did('trip')
                     and entity_type = 'imprest_disbursement'
                     and source_operation = 'api.staff_send_back_imprest_settlement'
                     and actor_id = 'e6500000-0000-0000-0000-000000000003'
                     and actor_role = 'manager'
                     and after_state ->> 'reason' = 'reason_required'
                     and correlation_id is not null and occurred_at is not null),
          'criterion 7: the refusal is committed with actor, live role, operation, reason, entity, '
          'time and correlation id');
select is(tests.send_back(tests.did('levy'), 3, tests.sid(tests.did('trip')), 'Unreadable receipt', 'b-out'),
          'not_settled', 'a handed-out disbursement cannot be sent back');
select is(tests.send_back(tests.did('trip'), 4, null, 'Unreadable receipt', 'b-nosettle'),
          'settlement_not_latest', 'a send-back must name the cycle it was shown');
select is(tests.send_back(tests.did('trip'), 4, gen_random_uuid(), 'Unreadable receipt', 'b-other'),
          'settlement_not_latest', 'and only the disbursement''s own latest cycle');
select is(tests.status(tests.did('trip')), 'settled', 'no refusal moved the trip');

-- ---------------------------------------------------------------------------
-- Criteria 1 and 2 · The send-back
-- ---------------------------------------------------------------------------
select is(tests.keep('b-trip', api.staff_send_back_imprest_settlement(
            tests.did('trip'), 4, tests.sid(tests.did('trip')),
            '  The fuel   receipt is unreadable; the tolls need a receipt  ', 'b-trip')),
          'sent_back', 'the Manager sends the trip back with a reason');
select is(tests.status(tests.did('trip')), 'sent_back', 'the trip reads as sent back');
select is(tests.ver(tests.did('trip')), 5, 'at the next version');
select results_eq(
  format($$ select x.settlement_id, x.reason, x.returned_by::text
              from public.imprest_settlement_returns x where x.disbursement_id = %L $$,
         tests.did('trip')),
  format($$ values (%L::uuid, 'The fuel receipt is unreadable; the tolls need a receipt'::text,
                    'e6500000-0000-0000-0000-000000000003'::text) $$, tests.sid(tests.did('trip'), 1)),
  'criterion 2: the return names the cycle it returns, the tidied reason and the Manager');
select ok(exists (select 1 from public.audit_events
                   where action = 'imprest_settlement_sent_back' and entity_id = tests.did('trip')
                     and entity_type = 'imprest_disbursement'
                     and actor_id = 'e6500000-0000-0000-0000-000000000003'
                     and actor_role = 'manager'
                     and source_operation = 'api.staff_send_back_imprest_settlement'
                     and correlation_id is not null
                     and before_state ->> 'status' = 'settled'
                     and after_state ->> 'status' = 'sent_back'
                     and (after_state ->> 'cycle')::int = 1
                     and after_state ->> 'reason' like 'The fuel receipt%'),
          'criterion 7: the send-back is on the audit trail with the cycle and the reason');

select is(tests.send_back(tests.did('trip'), 4, tests.sid(tests.did('trip'), 1),
                          'The fuel receipt is unreadable; the tolls need a receipt', 'b-trip'),
          'replayed', 'the same request replays');
select is(tests.send_back(tests.did('trip'), 4, tests.sid(tests.did('trip'), 1),
                          'Something else entirely', 'b-trip'),
          'idempotency_key_conflict', 'a changed retry on the same key is a conflict');
select is(tests.send_back(tests.did('trip'), 5, tests.sid(tests.did('trip'), 1),
                          'And again', 'b-trip-again'),
          'not_settled', 'a sent-back settlement cannot be sent back again');
select is((select count(*)::int from public.imprest_settlement_returns
            where disbursement_id = tests.did('trip')), 1, 'there is exactly one return');

-- Criterion 5 · still set aside, still awaiting the same, nothing posted.
select is(tests.figures(), '200000/200000/70000/130000/60000',
          'criterion 5: sending back moves no figure; Awaiting verification still counts cycle 1');
select is((select count(*)::int from public.imprest_postings), 0, 'and nothing is posted');

-- Criterion 6 · the returned cycle cannot be verified.
select is(api.staff_verify_imprest_disbursement(tests.did('trip'), 5, tests.sid(tests.did('trip'), 1),
                                                'v-returned') ->> 'reason',
          'not_settled', 'a sent-back disbursement cannot be verified');

-- ---------------------------------------------------------------------------
-- Criterion 4 · New receipts while sent back, and the bucket's rules
-- ---------------------------------------------------------------------------
select tests.cashier();
select is(tests.keep('r2', api.staff_register_imprest_receipt(
            tests.did('trip'), 'tolls.jpg', 'image/jpeg', 250000, 'rr-2')),
          'registered', 'the Cashier registers a new receipt while the trip is sent back');
select tests.keep('r-never', api.staff_register_imprest_receipt(
  tests.did('trip'), 'never.jpg', 'image/jpeg', 250000, 'rr-never'));
select tests.cashier_b();
select is(api.staff_register_imprest_receipt(tests.did('trip'), 'mine.jpg', 'image/jpeg', 1000, 'rr-b')
            ->> 'reason', 'no_disbursement', 'another Cashier cannot file a receipt on it');

set local role authenticated;
select tests.cashier();
select lives_ok(format($$ select tests.upload(%L, %L) $$, tests.rpath('r2'),
                       'e6500000-0000-0000-0000-000000000004'),
                'the Cashier uploads the new receipt while the trip is sent back');
select tests.cashier_b();
select throws_ok(format($$ select tests.upload(%L, %L) $$, tests.rpath('r-never'),
                        'e6500000-0000-0000-0000-000000000007'),
                 '42501', null, 'another Cashier cannot upload to its path');
select tests.cashier();
select throws_ok(format($$ select tests.upload(%L, %L) $$,
                        'imprest/' || tests.did('trip') || '/made-up',
                        'e6500000-0000-0000-0000-000000000004'),
                 '42501', null, 'a path nobody registered cannot be uploaded to');
reset role;
set local role service_role;
select throws_ok(format($$ insert into storage.objects (bucket_id, name, metadata)
                            values ('imprest-evidence', %L, '{}') $$, tests.rpath('r-never')),
                 '42501', null, 'the secret key cannot plant a file at a registered path while sent back');
select throws_ok(format($$ update storage.objects set metadata = '{}' where name = %L $$,
                        tests.rpath('r2')),
                 '42501', null, 'nor replace a receipt uploaded while sent back');
select set_config('storage.allow_delete_query', 'true', true);
select throws_ok(format($$ delete from storage.objects where name = %L $$, tests.rpath('r1')),
                 '42501', null, 'nor delete one');
select set_config('storage.allow_delete_query', 'false', true);
reset role;

-- ---------------------------------------------------------------------------
-- Criterion 3 · Settling again, with every check of the first settlement
-- ---------------------------------------------------------------------------
select tests.manager();
select throws_ok(
  format($$ select api.staff_settle_imprest_disbursement(%L, 5, '[]'::jsonb, 60000, null, 'rs-mgr') $$,
         tests.did('trip')),
  '42501', null, 'the Manager cannot settle it for the Cashier');
select tests.cashier_b();
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 5, '[]'::jsonb, 60000, null, 'rs-b')
            ->> 'reason', 'no_disbursement', 'another Cashier cannot resubmit it');

select tests.cashier();
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 4, '[]'::jsonb, 60000, null, 'rs-stale')
            ->> 'reason', 'stale', 'a resubmission against the version before the send-back is stale');
select is(api.staff_settle_imprest_disbursement(
            tests.did('trip'), 5,
            jsonb_build_array(tests.line(40000, 'Fuel', tests.rid('r1')),
                              tests.line(15000, 'Tolls', tests.rid('r2'))),
            10000, null, 'rs-over') ->> 'reason',
          'over_approval', 'Used plus Returned above Approved is refused');
select is(api.staff_settle_imprest_disbursement(
            tests.did('trip'), 5,
            jsonb_build_array(tests.line(40000, 'Fuel', tests.rid('r2')),
                              tests.line(8000, 'Tolls', tests.rid('r2'))),
            11000, 'Driver lost a thousand', 'rs-twice') ->> 'reason',
          'receipt_cited_twice', 'a receipt cited twice in the one cycle is refused');
select is(api.staff_settle_imprest_disbursement(
            tests.did('trip'), 5,
            jsonb_build_array(tests.line(40000, 'Fuel', tests.rid('r-levy'))),
            20000, null, 'rs-wrong') ->> 'reason',
          'receipt_wrong_disbursement', 'a receipt filed under another disbursement is refused');
select is(api.staff_settle_imprest_disbursement(
            tests.did('trip'), 5,
            jsonb_build_array(tests.line(40000, 'Fuel', tests.rid('r-never'))),
            20000, null, 'rs-missing') ->> 'reason',
          'receipt_not_uploaded', 'a receipt whose file never arrived is refused');
select is(api.staff_settle_imprest_disbursement(
            tests.did('trip'), 5,
            jsonb_build_array(tests.line(40000, 'Fuel', null)),
            20000, null, 'rs-evidence') ->> 'reason',
          'line_evidence_required', 'a line with neither a receipt nor a reason is refused');
select is(api.staff_settle_imprest_disbursement(
            tests.did('trip'), 5,
            jsonb_build_array(tests.line(40000, 'Fuel', tests.rid('r1')),
                              tests.line(8000, 'Tolls', tests.rid('r2'))),
            11000, null, 'rs-unexplained') ->> 'reason',
          'explanation_required', 'a remainder without an explanation is refused');
select is(api.staff_settle_imprest_disbursement(
            tests.did('trip'), 5, '[]'::jsonb, 60000, 'Nothing to explain', 'rs-extra') ->> 'reason',
          'explanation_not_needed', 'an explanation with no remainder is refused');
select ok(exists (select 1 from public.audit_events
                   where action = 'command_refused' and entity_id = tests.did('trip')
                     and source_operation = 'api.staff_settle_imprest_disbursement'
                     and actor_role = 'cashier'
                     and after_state ->> 'reason' = 'receipt_cited_twice'),
          'criterion 7: a refused resubmission is committed to the audit trail');
select is(tests.status(tests.did('trip')), 'sent_back', 'no refusal moved the trip');

-- The resubmission: the fuel receipt cited again from cycle 1, and the new tolls receipt.
select is(tests.keep('s2-trip', api.staff_settle_imprest_disbursement(
            tests.did('trip'), 5,
            jsonb_build_array(tests.line(40000, 'Fuel', tests.rid('r1')),
                              tests.line(8000, 'Tolls', tests.rid('r2'))),
            11000, 'Driver lost a thousand shillings', 's2-trip')),
          'settled', 'the Cashier settles again, citing a cycle-1 receipt and a new one');
select is(tests.status(tests.did('trip')), 'settled', 'the trip waits for the Manager again');
select is(tests.ver(tests.did('trip')), 6, 'at the next version');
select results_eq(
  format($$ select cycle, used_tzs, returned_tzs, unaccounted_tzs, line_count, no_receipt_lines
              from public.imprest_settlements where disbursement_id = %L order by cycle $$,
         tests.did('trip')),
  $$ values (1, 47000::bigint, 10000::bigint, 3000::bigint, 2, 1),
            (2, 48000::bigint, 11000::bigint, 1000::bigint, 2, 0) $$,
  'criterion 3: the resubmission is cycle 2, beside cycle 1');
select is(tests.cycle_digest(tests.did('trip'), 1), (select digest from cycle1),
          'criterion 3: nothing recorded about cycle 1 changed');
select is((select count(*)::int from public.imprest_settlement_lines l
             join public.imprest_settlements s on s.id = l.settlement_id
            where s.disbursement_id = tests.did('trip') and l.receipt_id = tests.rid('r1')),
          2, 'criterion 4: the fuel receipt is cited once in each cycle');
select is((select count(*)::int from public.imprest_settlement_returns
            where disbursement_id = tests.did('trip')), 1, 'the return is still on record');
select ok(exists (select 1 from public.audit_events
                   where action = 'imprest_disbursement_settled' and entity_id = tests.did('trip')
                     and source_operation = 'api.staff_settle_imprest_disbursement'
                     and actor_role = 'cashier'
                     and before_state ->> 'status' = 'sent_back'
                     and after_state ->> 'status' = 'settled'
                     and (after_state ->> 'cycle')::int = 2
                     and (after_state ->> 'used_tzs')::bigint = 48000),
          'criterion 7: the resubmission is on the audit trail as cycle 2');
select is(api.staff_settle_imprest_disbursement(
            tests.did('trip'), 5,
            jsonb_build_array(tests.line(40000, 'Fuel', tests.rid('r1')),
                              tests.line(8000, 'Tolls', tests.rid('r2'))),
            11000, 'Driver lost a thousand shillings', 's2-trip') ->> 'reason',
          'replayed', 'the same resubmission replays');
select is(api.staff_settle_imprest_disbursement(tests.did('trip'), 6, '[]'::jsonb, 60000, null, 's3-early')
            ->> 'reason', 'not_handed_out', 'a settled trip cannot be settled again until it is sent back');
select tests.cashier();
select is(api.staff_register_imprest_receipt(tests.did('trip'), 'late.jpg', 'image/jpeg', 1000, 'rr-late')
            ->> 'reason', 'not_handed_out', 'nor can a receipt be filed while it waits for the Manager');

select is(tests.figures(), '200000/200000/70000/130000/59000',
          'criterion 5: still set aside; Awaiting verification now counts cycle 2''s 49,000');
select is((select count(*)::int from public.imprest_postings), 0, 'and still nothing is posted');

-- ---------------------------------------------------------------------------
-- Criterion 6 · Only the latest cycle is verified
-- ---------------------------------------------------------------------------
select tests.manager();
select is(api.staff_verify_imprest_disbursement(tests.did('trip'), 6, tests.sid(tests.did('trip'), 1),
                                                'v-cycle1') ->> 'reason',
          'settlement_not_latest', 'criterion 6: the returned cycle 1 can never be verified');
select is(tests.send_back(tests.did('trip'), 6, tests.sid(tests.did('trip'), 1), 'Old cycle', 'b-old'),
          'settlement_not_latest', 'nor sent back again');
select is(tests.keep('v-trip', api.staff_verify_imprest_disbursement(
            tests.did('trip'), 6, tests.sid(tests.did('trip'), 2), 'v-trip')),
          'verified', 'the Manager verifies cycle 2');
select results_eq(
  format($$ select kind::text, amount_tzs, settlement_id from public.imprest_postings
             where disbursement_id = %L order by kind $$, tests.did('trip')),
  format($$ values ('expense'::text, 48000::bigint, %1$L::uuid),
                   ('unexplained_loss'::text, 1000::bigint, %1$L::uuid) $$,
         tests.sid(tests.did('trip'), 2)),
  'cycle 2''s Used and Not accounted for post, and nothing of cycle 1');
select is(tests.figures(), '200000/151000/10000/141000/10000',
          'the trip leaves set aside and Awaiting; the posted balance falls by 49,000');

-- ---------------------------------------------------------------------------
-- Criterion 2 · Nobody changes or removes a return, and the states hold
-- ---------------------------------------------------------------------------
-- A second disbursement, sent back and left so, for the direct-write checks.
select tests.cashier();
select tests.keep('pad', api.staff_propose_imprest_disbursement(5000, 'other', 'Padlock', 'p-pad'));
select tests.manager();
select tests.keep('a-pad', api.staff_decide_imprest_disbursement(tests.did('pad'), 1, true, null, 'a-pad'));
select tests.cashier();
select tests.keep('h-pad', api.staff_hand_out_imprest_disbursement(tests.did('pad'), 2, 'Shop', 'h-pad'));
select tests.keep('s-pad', api.staff_settle_imprest_disbursement(
  tests.did('pad'), 3, jsonb_build_array(tests.line(5000, 'Padlock', null, 'vendor_did_not_issue')),
  0, null, 's-pad'));
select tests.manager();
select is(tests.keep('b-pad', api.staff_send_back_imprest_settlement(
            tests.did('pad'), 4, tests.sid(tests.did('pad')), 'Which shop?', 'b-pad')),
          'sent_back', 'the padlock is sent back');

set local role fv_definer_owner;
select throws_ok($$ update public.imprest_settlement_returns set reason = 'changed' $$,
                 '42501', null, 'the commands'' own role cannot change a return');
select throws_ok($$ delete from public.imprest_settlement_returns $$,
                 '42501', null, 'nor delete one');
select throws_ok(
  format($$ update public.imprest_disbursements set status = 'settled', version = version + 1
             where id = %L $$, tests.did('pad')),
  '23001', null, 'a sent-back disbursement cannot go back to settled without a new cycle');
select throws_ok(
  format($$ update public.imprest_disbursements set status = 'cancelled', version = version + 1,
                  cancelled_by = approved_by, cancelled_at = now(), cancellation_reason = 'late'
             where id = %L $$, tests.did('pad')),
  '23001', null, 'nor be cancelled');
select throws_ok(
  format($$ update public.imprest_disbursements set status = 'sent_back', version = version + 1
             where id = %L $$, tests.did('levy')),
  '23001', null, 'a disbursement cannot be marked sent back without a return');
select throws_ok(
  format($$ insert into public.imprest_settlement_returns (disbursement_id, settlement_id, reason,
                                                           returned_by)
            values (%L, %L, 'Late', 'e6500000-0000-0000-0000-000000000003') $$,
         tests.did('trip'), tests.sid(tests.did('trip'), 1)),
  '23514', null, 'a return cannot be written for a cycle that is not the latest of a settled disbursement');
select throws_ok(
  format($$ insert into public.imprest_settlements (disbursement_id, cycle, approved_tzs, used_tzs,
                                                    returned_tzs, unaccounted_tzs, line_count,
                                                    no_receipt_lines, settled_by)
            values (%L, 3, 60000, 0, 60000, 0, 0, 0, 'e6500000-0000-0000-0000-000000000004') $$,
         tests.did('trip')),
  '23514', null, 'a new cycle cannot be written for a disbursement that is not sent back');
select throws_ok(
  format($$ insert into public.imprest_settlements (disbursement_id, cycle, approved_tzs, used_tzs,
                                                    returned_tzs, unaccounted_tzs, line_count,
                                                    no_receipt_lines, settled_by)
            values (%L, 5, 5000, 0, 5000, 0, 0, 0, 'e6500000-0000-0000-0000-000000000004') $$,
         tests.did('pad')),
  '23514', null, 'and a new cycle is numbered straight after the last');
select throws_ok(
  format($$ insert into public.imprest_verifications (disbursement_id, settlement_id, fund_id,
                                                      verified_by)
            values (%L, %L, 'e6500000-0000-0000-0000-00000000f001',
                    'e6500000-0000-0000-0000-000000000003') $$,
         tests.did('pad'), tests.sid(tests.did('pad'))),
  '23514', null, 'criterion 6: a verification cannot be written for a returned cycle');
reset role;
select throws_ok($$ update public.imprest_settlement_returns set reason = 'changed' $$,
                 '23001', null, 'even the owner cannot change a return');
-- The deferred checks of this transaction run first, or PostgreSQL refuses the truncate itself.
set constraints all immediate;
select throws_ok($$ truncate public.imprest_settlement_returns cascade $$,
                 '23001', null, 'or empty the table');
set constraints all deferred;

-- ---------------------------------------------------------------------------
-- Who reads what
-- ---------------------------------------------------------------------------
set local role authenticated;
select tests.manager();
select is((select string_agg(id::text, ',') from public.imprest_disbursements where status = 'sent_back'),
          tests.did('pad')::text, 'the Manager''s sent-back list holds the padlock');
select ok((select public.imprest_disbursement_sent_back_at(d) is not null
             from public.imprest_disbursements d where d.id = tests.did('pad')),
          'with the moment it was sent back, to show how long it has waited');
select is((select count(*)::int from public.imprest_settlement_returns), 2, 'the Manager reads both returns');
select tests.director();
select is((select count(*)::int from public.imprest_settlement_returns), 2, 'so does a Director');
select tests.cashier();
select is((select reason from public.imprest_settlement_returns where disbursement_id = tests.did('pad')),
          'Which shop?', 'the Cashier reads the reason on their own disbursement');
select tests.cashier_b();
select is((select count(*)::int from public.imprest_settlement_returns), 0, 'another Cashier reads none');
select tests.rep();
select is((select count(*)::int from public.imprest_settlement_returns), 0, 'a Sales Representative reads none');
reset role;

select tests.cashier();
select results_eq(
  $$ select posted_funding_tzs, set_aside_tzs, awaiting_verification_tzs
       from api.staff_imprest_spending_position() $$,
  $$ values (null::bigint, null::bigint, null::bigint) $$,
  'a Cashier is still sent Free to approve alone');
select tests.manager();
select is((select awaiting_verification_tzs from api.staff_imprest_spending_position()), 15000::bigint,
          'the padlock''s 5,000 stays awaiting while sent back, beside the levy''s 10,000');
select is((select set_aside_tzs from api.staff_imprest_spending_position()), 15000::bigint,
          'and stays set aside');

-- ---------------------------------------------------------------------------
-- A third cycle, for good measure: the padlock resettled, sent back again, resettled
-- ---------------------------------------------------------------------------
select tests.cashier();
select is(tests.keep('s2-pad', api.staff_settle_imprest_disbursement(
            tests.did('pad'), 5, jsonb_build_array(tests.line(5000, 'Padlock, Kariakoo hardware', null,
                                                              'vendor_did_not_issue')),
            0, null, 's2-pad')), 'settled', 'the padlock is settled again as cycle 2');
select tests.manager();
select is(tests.send_back(tests.did('pad'), 6, tests.sid(tests.did('pad')), 'Still no shop name', 'b2-pad'),
          'sent_back', 'and sent back a second time');
select tests.cashier();
select is(tests.keep('s3-pad', api.staff_settle_imprest_disbursement(
            tests.did('pad'), 7, '[]'::jsonb, 5000, null, 's3-pad')),
          'settled', 'the Cashier settles a third time, returning everything');
select is((select string_agg(cycle::text, ',' order by cycle) from public.imprest_settlements
            where disbursement_id = tests.did('pad')), '1,2,3', 'three cycles, in order');
select is((select count(*)::int from public.imprest_settlement_returns
            where disbursement_id = tests.did('pad')), 2, 'each return tied to the cycle it returned');

-- The deferred check: a return that leaves its disbursement settled is refused at commit.
set local role fv_definer_owner;
set constraints all immediate;
select throws_ok(
  format($$ insert into public.imprest_settlement_returns (disbursement_id, settlement_id, reason,
                                                           returned_by)
            values (%L, %L, 'Quietly returned', 'e6500000-0000-0000-0000-000000000003') $$,
         tests.did('pad'), tests.sid(tests.did('pad'))),
  '23514', null, 'a return that does not send its disbursement back is refused');
set constraints all deferred;
reset role;

select * from finish();
rollback;
