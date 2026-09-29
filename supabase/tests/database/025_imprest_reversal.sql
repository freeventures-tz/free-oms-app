-- Issue #71 · Imprest: a Director approves the reversal and repost of a verified expense or loss
--
-- The claims under test, each traceable to issue #71's acceptance criteria:
--
--   1   A live Cashier (their own payment) or Manager requests a reversal of one verified expense or
--       unexplained loss, with a correct amount of 0 or more and a reason of 3 to 500 characters.
--       One open request per posting. A posting already reversed cannot be reversed again; its
--       replacement can.
--   2   Only a Director approves or rejects, with a reason on rejection. Version-checked and
--       idempotent. The approving Director is permanently identified.
--   3   Approval posts the reversal and the replacement together, both immutable and linked to the
--       original posting and the request. Nothing earlier is changed or deleted.
--   4   Posted balance, Free to approve and expected cash include reversals and replacements. A
--       replacement unexplained loss still waits for a Director's decision.
--   5   A reversal that would take the posted balance below what is set aside is refused.
--   6   Every success and committed refusal is on the audit trail.
--   7   Who reads: Directors and the Manager every request, the proposing Cashier their own.

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

select tests.mk_user('e8000000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('e8000000-0000-0000-0000-000000000002'::uuid);  -- Second Director
select tests.mk_user('e8000000-0000-0000-0000-000000000003'::uuid);  -- Manager
select tests.mk_user('e8000000-0000-0000-0000-000000000004'::uuid);  -- Cashier A
select tests.mk_user('e8000000-0000-0000-0000-000000000005'::uuid);  -- Sales Representative
select tests.mk_user('e8000000-0000-0000-0000-000000000006'::uuid);  -- Disabled Director
select tests.mk_user('e8000000-0000-0000-0000-000000000007'::uuid);  -- Cashier B

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('e8000000-0000-0000-0000-000000000001', 'Reversal Director', '+255700008001', true,  false),
  ('e8000000-0000-0000-0000-000000000002', 'Second Director',   '+255700008002', true,  false),
  ('e8000000-0000-0000-0000-000000000003', 'Reversal Manager',  '+255700008003', true,  false),
  ('e8000000-0000-0000-0000-000000000004', 'Reversal Cashier',  '+255700008004', true,  false),
  ('e8000000-0000-0000-0000-000000000005', 'Reversal Rep',      '+255700008005', true,  false),
  ('e8000000-0000-0000-0000-000000000006', 'Gone Director',     '+255700008006', false, false),
  ('e8000000-0000-0000-0000-000000000007', 'Other Cashier',     '+255700008007', true,  false);

insert into public.user_roles (user_id, role) values
  ('e8000000-0000-0000-0000-000000000001', 'director'),
  ('e8000000-0000-0000-0000-000000000002', 'director'),
  ('e8000000-0000-0000-0000-000000000003', 'manager'),
  ('e8000000-0000-0000-0000-000000000004', 'cashier'),
  ('e8000000-0000-0000-0000-000000000005', 'sales_rep'),
  ('e8000000-0000-0000-0000-000000000006', 'director'),
  ('e8000000-0000-0000-0000-000000000007', 'cashier');

create or replace function tests.director() returns void language sql as $$
  select tests.acting_as('e8000000-0000-0000-0000-000000000001'::uuid); $$;
create or replace function tests.manager() returns void language sql as $$
  select tests.acting_as('e8000000-0000-0000-0000-000000000003'::uuid); $$;
create or replace function tests.cashier() returns void language sql as $$
  select tests.acting_as('e8000000-0000-0000-0000-000000000004'::uuid); $$;
create or replace function tests.rep() returns void language sql as $$
  select tests.acting_as('e8000000-0000-0000-0000-000000000005'::uuid); $$;
create or replace function tests.cashier_b() returns void language sql as $$
  select tests.acting_as('e8000000-0000-0000-0000-000000000007'::uuid); $$;

create temp table r (name text primary key, res jsonb not null);
grant all on r to public;
create or replace function tests.keep(p_name text, p_res jsonb) returns text language sql as $$
  insert into r values (p_name, p_res) returning res ->> 'reason';
$$;
create or replace function tests.did(p_name text) returns uuid language sql as $$
  select (res -> 'disbursement' ->> 'id')::uuid from r where name = p_name; $$;
create or replace function tests.rvid(p_name text) returns uuid language sql as $$
  select (res -> 'reversal' ->> 'id')::uuid from r where name = p_name; $$;
create or replace function tests.sid(p_id uuid) returns uuid language sql security definer as $$
  select id from public.imprest_settlements where disbursement_id = p_id order by cycle desc limit 1; $$;
-- The original posting of a kind, as verification wrote it.
create or replace function tests.pid(p_id uuid, p_kind text) returns uuid language sql
  security definer as $$
  select id from public.imprest_postings
   where disbursement_id = p_id and kind::text = p_kind and entry = 'original'; $$;
-- The posting a decided request wrote, by entry.
create or replace function tests.made(p_reversal uuid, p_entry text) returns uuid language sql
  security definer as $$
  select id from public.imprest_postings where reversal_id = p_reversal and entry::text = p_entry; $$;
create or replace function tests.rver(p_id uuid) returns integer language sql
  security definer as $$ select version from public.imprest_posting_reversals where id = p_id; $$;
-- posted funding / posted balance / set aside / free to approve / awaiting verification
create or replace function tests.figures() returns text language sql security definer as $$
  select s.posted_funding_tzs || '/' || s.posted_balance_tzs || '/' || s.set_aside_tzs || '/'
         || s.free_to_approve_tzs || '/' || private.imprest_awaiting_verification_tzs(f.id)
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active; $$;
create or replace function tests.line(p_amount bigint, p_purpose text) returns jsonb language sql as $$
  select jsonb_build_object('amount_tzs', p_amount, 'purpose', p_purpose, 'receipt_id', null,
                            'no_receipt_reason', 'transport_fare', 'no_receipt_note', null); $$;
create or replace function tests.req(p_posting uuid, p_correct bigint, p_reason text, p_key text)
returns text language sql as $$
  select api.staff_request_imprest_reversal(p_posting, p_correct, p_reason, p_key) ->> 'reason'; $$;
create or replace function tests.dec(p_reversal uuid, p_version integer, p_approve boolean,
                                     p_reason text, p_key text) returns text language sql as $$
  select api.admin_decide_imprest_reversal(p_reversal, p_version, p_approve, p_reason, p_key)
           ->> 'reason'; $$;
create or replace function tests.dec_context(p_reversal uuid, p_version integer, p_key text)
returns text language sql as $$
  select (v ->> 'free_to_approve_tzs') || '/' || (v ->> 'amount_tzs')
    from api.admin_decide_imprest_reversal(p_reversal, p_version, true, null, p_key) v; $$;

-- ---------------------------------------------------------------------------
-- The shape: one request table no client writes, two commands, the Director takes no amount
-- ---------------------------------------------------------------------------
select ok(
  not has_table_privilege('authenticated', 'public.imprest_posting_reversals', 'insert')
  and not has_table_privilege('authenticated', 'public.imprest_posting_reversals', 'update')
  and not has_table_privilege('authenticated', 'public.imprest_posting_reversals', 'delete')
  and has_table_privilege('authenticated', 'public.imprest_posting_reversals', 'select')
  and not has_table_privilege('service_role', 'public.imprest_posting_reversals', 'select')
  and not has_table_privilege('anon', 'public.imprest_posting_reversals', 'select')
  and not has_table_privilege('fv_definer_owner', 'public.imprest_posting_reversals', 'delete')
  and not has_table_privilege('fv_definer_owner', 'public.imprest_postings', 'update')
  and not has_table_privilege('fv_definer_owner', 'public.imprest_postings', 'delete'),
  'no role writes a request except through the commands, and postings are still insert-only');

select ok((select relrowsecurity from pg_class
            where oid = 'public.imprest_posting_reversals'::regclass),
          'the requests table has row-level security');

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     join pg_roles o on o.oid = p.proowner
    where n.nspname = 'api'
      and p.proname in ('staff_request_imprest_reversal', 'admin_decide_imprest_reversal')
      and p.prosecdef and o.rolname = 'fv_definer_owner'
      and has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('service_role', p.oid, 'execute')),
  2,
  'the two commands are security definer, owned by fv_definer_owner, callable by staff sessions only');

select ok(
  not exists (select 1 from information_schema.parameters
               where specific_schema = 'api'
                 and specific_name like 'admin_decide_imprest_reversal%'
                 and (parameter_name like '%amount%' or parameter_name like '%tzs%')),
  'the Director approves the correct amount as asked: deciding takes no amount');

-- ---------------------------------------------------------------------------
-- TZS 200,000 posted, a verified trip and an approved levy
-- ---------------------------------------------------------------------------
set local role fv_definer_owner;
insert into public.imprest_funds (id, opened_by) values
  ('e8000000-0000-0000-0000-00000000f001', 'e8000000-0000-0000-0000-000000000003');
insert into public.imprest_fundings (id, funding_no, fund_id, requested_amount_tzs, reason,
                                     requested_by)
values ('e8000000-0000-0000-0000-00000000f101', 'FV-IMP-TEST-8001',
        'e8000000-0000-0000-0000-00000000f001', 200000, 'Opening float',
        'e8000000-0000-0000-0000-000000000003');
insert into public.imprest_funding_handovers (id, funding_id, cycle, amount_tzs, provided_by)
values ('e8000000-0000-0000-0000-00000000f201', 'e8000000-0000-0000-0000-00000000f101', 1, 200000,
        'e8000000-0000-0000-0000-000000000001');
update public.imprest_fundings
   set status = 'received', version = version + 1,
       received_handover_id = 'e8000000-0000-0000-0000-00000000f201',
       received_amount_tzs = 200000, received_by = 'e8000000-0000-0000-0000-000000000003',
       received_at = now()
 where id = 'e8000000-0000-0000-0000-00000000f101';
reset role;

-- The trip: 60,000, settled as Used 47,000, Returned 10,000, Not accounted for 3,000, verified.
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
select tests.keep('s-trip', api.staff_settle_imprest_disbursement(
  tests.did('trip'), 3, jsonb_build_array(tests.line(47000, 'Fare')), 10000,
  'Change lost on the road', 's-trip'));
select tests.manager();
select is(tests.keep('v-trip', api.staff_verify_imprest_disbursement(
            tests.did('trip'), 4, tests.sid(tests.did('trip')), 'v-trip')),
          'verified', 'the trip is verified: a 47,000 expense and a 3,000 loss post');

select is(tests.figures(), '200000/150000/10000/140000/0',
          'before any reversal: balance 150,000, set aside the levy''s 10,000, Free 140,000');

-- ---------------------------------------------------------------------------
-- Criterion 1 · Who may request, of what, and for what
-- ---------------------------------------------------------------------------
select tests.director();
select throws_ok(
  format($$ select tests.req(%L, 45000, 'Receipt shows 45,000', 'q-dir') $$,
         tests.pid(tests.did('trip'), 'expense')),
  '42501', null, 'a Director decides and does not request');
select tests.rep();
select throws_ok(
  format($$ select tests.req(%L, 45000, 'Receipt shows 45,000', 'q-rep') $$,
         tests.pid(tests.did('trip'), 'expense')),
  '42501', null, 'a Sales Representative cannot request');

select tests.cashier_b();
select is(tests.req(tests.pid(tests.did('trip'), 'expense'), 45000, 'Receipt shows 45,000', 'q-other'),
          'no_posting', 'another Cashier''s posting is answered as missing');

select tests.cashier();
select is(tests.req(gen_random_uuid(), 45000, 'Receipt shows 45,000', 'q-none'),
          'no_posting', 'a posting that does not exist is refused');
select is(tests.req(tests.pid(tests.did('trip'), 'expense'), -1, 'Receipt shows 45,000', 'q-neg'),
          'amount_invalid', 'a negative correct amount is refused');
select is(tests.req(tests.pid(tests.did('trip'), 'expense'), null, 'Receipt shows 45,000', 'q-null'),
          'amount_invalid', 'so is a missing one');
select is(tests.req(tests.pid(tests.did('trip'), 'expense'), 100000001, 'Receipt shows 45,000', 'q-huge'),
          'amount_invalid', 'and one above the 100,000,000 ceiling');
select is(tests.req(tests.pid(tests.did('trip'), 'expense'), 47000, 'Receipt shows 47,000', 'q-same'),
          'amount_unchanged', 'a correct amount equal to what was posted changes nothing and is refused');
select is(tests.req(tests.pid(tests.did('trip'), 'expense'), 45000, null, 'q-noreason'),
          'reason_required', 'a request without a reason is refused');
select is(tests.req(tests.pid(tests.did('trip'), 'expense'), 45000, 'no', 'q-short'),
          'reason_required', 'so is a reason under 3 characters');
select is(tests.req(tests.pid(tests.did('trip'), 'expense'), 45000, repeat('x', 501), 'q-long'),
          'reason_required', 'and one over 500');
select is(tests.req(tests.pid(tests.did('trip'), 'expense'), 47000 + 140001, 'Receipt was higher', 'q-deep'),
          'below_set_aside', 'criterion 5: a correct amount that would leave less than is set aside is refused');
select ok(exists (select 1 from public.audit_events
                   where action = 'command_refused'
                     and entity_type = 'imprest_posting'
                     and entity_id = tests.pid(tests.did('trip'), 'expense')
                     and source_operation = 'api.staff_request_imprest_reversal'
                     and actor_id = 'e8000000-0000-0000-0000-000000000004'
                     and actor_role = 'cashier'
                     and after_state ->> 'reason' = 'reason_required'
                     and correlation_id is not null and occurred_at is not null),
          'criterion 6: the refusal is committed with actor, live role, operation, reason, entity, '
          'time and correlation id');
select is((select count(*)::int from public.imprest_posting_reversals), 0,
          'no refusal wrote a request');

-- The Cashier asks: the expense should have been 45,000.
select is(tests.keep('rq-exp', api.staff_request_imprest_reversal(
            tests.pid(tests.did('trip'), 'expense'), 45000, '  Receipt   shows   45,000  ', 'q-exp')),
          'requested', 'the proposing Cashier requests a reversal of the verified expense');
select results_eq(
  format($$ select status::text, original_tzs, correct_tzs, reason, requested_by::text,
                   requested_role::text, version, disbursement_id::text
              from public.imprest_posting_reversals where id = %L $$, tests.rvid('rq-exp')),
  format($$ values ('requested'::text, 47000::bigint, 45000::bigint, 'Receipt shows 45,000'::text,
                    'e8000000-0000-0000-0000-000000000004'::text, 'cashier'::text, 1, %L::text) $$,
         tests.did('trip')),
  'the request keeps what was posted, the correct amount, the tidied reason, who asked and their role');
select is(tests.figures(), '200000/150000/10000/140000/0', 'a request posts nothing');
select is(tests.req(tests.pid(tests.did('trip'), 'expense'), 44000, 'Another figure', 'q-exp-2'),
          'reversal_open', 'one open request per posting');
select is(tests.keep('rq-exp-again', api.staff_request_imprest_reversal(
            tests.pid(tests.did('trip'), 'expense'), 45000, '  Receipt   shows   45,000  ', 'q-exp')),
          'replayed', 'a retry of the same request replays it');
select is(tests.rvid('rq-exp-again'), tests.rvid('rq-exp'), 'and answers with the same request');
select is(tests.req(tests.pid(tests.did('trip'), 'expense'), 46000, 'Receipt shows 45,000', 'q-exp'),
          'idempotency_key_conflict', 'the same key with another amount is a conflict');
select ok(exists (select 1 from public.audit_events
                   where action = 'imprest_reversal_requested'
                     and entity_type = 'imprest_posting_reversal' and entity_id = tests.rvid('rq-exp')
                     and actor_role = 'cashier' and correlation_id is not null
                     and after_state ->> 'correct_tzs' = '45000'
                     and after_state ->> 'posting_id' = tests.pid(tests.did('trip'), 'expense')::text),
          'criterion 6: the request is on the audit trail');
select ok((select public.imprest_disbursement_reversal_requested_at(d) is not null
             from public.imprest_disbursements d where d.id = tests.did('trip')),
          'the payment reads as waiting for a reversal decision');

-- The Manager asks: the loss was 2,000, not 3,000.
select tests.manager();
select is(tests.keep('rq-loss', api.staff_request_imprest_reversal(
            tests.pid(tests.did('trip'), 'unexplained_loss'), 2000, 'Found 1,000 in the van', 'q-loss')),
          'requested', 'the Manager requests a reversal of the verified unexplained loss');
select is((select requested_role::text from public.imprest_posting_reversals where id = tests.rvid('rq-loss')),
          'manager', 'the request names the Manager''s live role');

-- ---------------------------------------------------------------------------
-- Criterion 2 · Only a Director decides
-- ---------------------------------------------------------------------------
select throws_ok(
  format($$ select tests.dec(%L, 1, true, null, 'd-mgr') $$, tests.rvid('rq-exp')),
  '42501', null, 'the Manager does not decide');
select tests.cashier();
select throws_ok(
  format($$ select tests.dec(%L, 1, true, null, 'd-cash') $$, tests.rvid('rq-exp')),
  '42501', null, 'the Cashier does not decide');
select tests.rep();
select throws_ok(
  format($$ select tests.dec(%L, 1, true, null, 'd-rep') $$, tests.rvid('rq-exp')),
  '42501', null, 'a Sales Representative cannot');
select tests.acting_as('e8000000-0000-0000-0000-000000000006'::uuid);
select throws_ok(
  format($$ select tests.dec(%L, 1, true, null, 'd-gone') $$, tests.rvid('rq-exp')),
  '42501', null, 'nor can a disabled Director');

select tests.director();
select is(tests.dec(tests.rvid('rq-exp'), 2, true, null, 'd-stale'),
          'stale', 'a decision against another version is refused');
select is(tests.dec(gen_random_uuid(), 1, true, null, 'd-nosuch'),
          'no_reversal', 'a request that does not exist is refused');
select is(tests.dec(tests.rvid('rq-exp'), 1, null, null, 'd-undecided'),
          'decision_required', 'a decision must say approve or reject');
select is(tests.dec(tests.rvid('rq-exp'), 1, false, null, 'd-noreason'),
          'reason_required', 'a rejection needs a reason');
select is(tests.dec(tests.rvid('rq-exp'), 1, false, 'no', 'd-shortreason'),
          'reason_required', 'of 3 to 500 characters');
select ok(exists (select 1 from public.audit_events
                   where action = 'command_refused' and entity_type = 'imprest_posting_reversal'
                     and entity_id = tests.rvid('rq-exp')
                     and source_operation = 'api.admin_decide_imprest_reversal'
                     and actor_role = 'director' and after_state ->> 'reason' = 'stale'),
          'criterion 6: a Director''s refused decision is committed too');

-- ---------------------------------------------------------------------------
-- Criterion 3 · Approval posts the reversal and the replacement
-- ---------------------------------------------------------------------------
select is(tests.keep('ap-exp', api.admin_decide_imprest_reversal(
            tests.rvid('rq-exp'), 1, true, null, 'd-exp')),
          'approved', 'the Director approves the expense reversal');
select results_eq(
  format($$ select status::text, decided_by::text, version, rejection_reason
              from public.imprest_posting_reversals where id = %L $$, tests.rvid('rq-exp')),
  $$ values ('approved'::text, 'e8000000-0000-0000-0000-000000000001'::text, 2, null::text) $$,
  'the request is approved, names the approving Director, and moves one version');
select results_eq(
  format($$ select entry::text, kind::text, amount_tzs, corrects_posting_id::text,
                   needs_director_decision, verification_id is not distinct from
                     (select verification_id from public.imprest_postings where id = %L)
              from public.imprest_postings where reversal_id = %L order by entry $$,
         tests.pid(tests.did('trip'), 'expense'), tests.rvid('rq-exp')),
  format($$ values ('replacement'::text, 'expense'::text, 45000::bigint, %L::text, false, true),
                   ('reversal'::text, 'expense'::text, 47000::bigint, %L::text, false, true) $$,
         tests.pid(tests.did('trip'), 'expense'), tests.pid(tests.did('trip'), 'expense')),
  'a reversal cancels the 47,000 in full and a replacement posts 45,000, both linked to the '
  'original posting and the request');
select results_eq(
  format($$ select kind::text, amount_tzs, entry::text from public.imprest_postings
             where disbursement_id = %L and entry = 'original' order by kind $$, tests.did('trip')),
  $$ values ('expense'::text, 47000::bigint, 'original'::text),
            ('unexplained_loss'::text, 3000::bigint, 'original'::text) $$,
  'nothing earlier is changed: the original postings stand as verified');
select is(tests.figures(), '200000/152000/10000/142000/0',
          'criterion 4: the posted balance moves by the difference, 2,000, and so does Free to approve');
select ok((select public.imprest_disbursement_reversal_requested_at(d) is null
             from public.imprest_disbursements d where d.id = tests.did('trip'))
          = false,
          'the loss request still waits, so the payment still reads as waiting');
select is(tests.keep('ap-exp-again', api.admin_decide_imprest_reversal(
            tests.rvid('rq-exp'), 1, true, null, 'd-exp')),
          'replayed', 'a retry of the approval replays it');
select is((select count(*)::int from public.imprest_postings where reversal_id = tests.rvid('rq-exp')), 2,
          'and posts nothing twice');
select is(tests.dec(tests.rvid('rq-exp'), 2, false, 'Changed my mind', 'd-exp-late'),
          'not_awaiting_decision', 'a decided request cannot be decided again');
select ok(exists (select 1 from public.audit_events
                   where action = 'imprest_reversal_approved'
                     and entity_type = 'imprest_posting_reversal' and entity_id = tests.rvid('rq-exp')
                     and actor_id = 'e8000000-0000-0000-0000-000000000001' and actor_role = 'director'
                     and correlation_id is not null
                     and after_state ->> 'reversal_posting_id' = tests.made(tests.rvid('rq-exp'), 'reversal')::text
                     and after_state ->> 'replacement_posting_id' = tests.made(tests.rvid('rq-exp'), 'replacement')::text
                     and after_state ->> 'posted_balance_tzs' = '152000'),
          'criterion 6: the approval is on the audit trail with both postings and the new balance');

-- A posting already reversed cannot be reversed again; its replacement can; a reversal cannot.
select tests.cashier();
select is(tests.req(tests.pid(tests.did('trip'), 'expense'), 44000, 'Once more', 'q-again'),
          'already_reversed', 'criterion 1: the reversed original cannot be reversed again');
select is(tests.req(tests.made(tests.rvid('rq-exp'), 'reversal'), 0, 'Undo the undo', 'q-rev'),
          'not_reversible', 'a reversal posting is not itself reversed');

-- The loss: 3,000 becomes 2,000, and the replacement still waits for a Director's decision.
select tests.director();
select is(tests.keep('ap-loss', api.admin_decide_imprest_reversal(
            tests.rvid('rq-loss'), 1, true, null, 'd-loss')),
          'approved', 'the Director approves the loss reversal');
select results_eq(
  format($$ select entry::text, amount_tzs, needs_director_decision from public.imprest_postings
             where reversal_id = %L order by entry $$, tests.rvid('rq-loss')),
  $$ values ('replacement'::text, 2000::bigint, true), ('reversal'::text, 3000::bigint, false) $$,
  'criterion 4: the replacement unexplained loss still waits for a Director''s decision');
select is(tests.figures(), '200000/153000/10000/143000/0',
          'the balance moves by the loss''s difference, 1,000');
select ok((select public.imprest_disbursement_reversal_requested_at(d) is null
             from public.imprest_disbursements d where d.id = tests.did('trip')),
          'with nothing open, the payment no longer reads as waiting');

-- ---------------------------------------------------------------------------
-- Criterion 5 · A replacement is reversed in turn, and the set-aside floor holds at approval
-- ---------------------------------------------------------------------------
select tests.cashier();
select is(tests.keep('rq-up', api.staff_request_imprest_reversal(
            tests.made(tests.rvid('rq-exp'), 'replacement'), 100000, 'Second receipt found', 'q-up')),
          'requested', 'criterion 1: the replacement can be reversed');

-- Meanwhile the Manager approves a 100,000 payment: set aside 110,000, Free 43,000.
select tests.cashier_b();
select tests.keep('big', api.staff_propose_imprest_disbursement(
  100000, 'fees_and_charges', 'Quarry fee', 'p-big'));
select tests.manager();
select tests.keep('a-big', api.staff_decide_imprest_disbursement(tests.did('big'), 1, true, null, 'a-big'));
select is(tests.figures(), '200000/153000/110000/43000/0', 'Free to approve is now 43,000');

select tests.director();
select is(tests.dec(tests.rvid('rq-up'), 1, true, null, 'd-up'),
          'below_set_aside', 'criterion 5: an approval that would take the balance below set aside is refused');
select is(tests.dec_context(tests.rvid('rq-up'), 1, 'd-up-2'), '43000/55000',
          'and names what is free and how far the balance would fall');
select is(tests.figures(), '200000/153000/110000/43000/0', 'the refusal posted nothing');
select is(tests.keep('rj-up', api.admin_decide_imprest_reversal(
            tests.rvid('rq-up'), 1, false, '  Not enough cash  to cover it ', 'd-up-reject')),
          'rejected', 'criterion 2: the Director rejects it with a reason');
select results_eq(
  format($$ select status::text, decided_by::text, rejection_reason, version
              from public.imprest_posting_reversals where id = %L $$, tests.rvid('rq-up')),
  $$ values ('rejected'::text, 'e8000000-0000-0000-0000-000000000001'::text,
             'Not enough cash to cover it'::text, 2) $$,
  'the rejection keeps the Director and the tidied reason');
select is((select count(*)::int from public.imprest_postings where reversal_id = tests.rvid('rq-up')), 0,
          'a rejection posts nothing');
select ok(exists (select 1 from public.audit_events
                   where action = 'imprest_reversal_rejected' and entity_id = tests.rvid('rq-up')
                     and actor_role = 'director' and after_state ->> 'reason' = 'Not enough cash to cover it'),
          'criterion 6: the rejection is on the audit trail');

-- A correct amount of 0 is a pure undo: the replacement loss is reversed and nothing replaces it.
select tests.manager();
select is(tests.keep('rq-undo', api.staff_request_imprest_reversal(
            tests.made(tests.rvid('rq-loss'), 'replacement'), 0, 'The cash was in the safe', 'q-undo')),
          'requested', 'a correct amount of 0 may be asked for');
select tests.acting_as('e8000000-0000-0000-0000-000000000002'::uuid);
select is(tests.keep('ap-undo', api.admin_decide_imprest_reversal(
            tests.rvid('rq-undo'), 1, true, null, 'd-undo')),
          'approved', 'the second Director approves it');
select results_eq(
  format($$ select entry::text, amount_tzs, corrects_posting_id::text from public.imprest_postings
             where reversal_id = %L $$, tests.rvid('rq-undo')),
  format($$ values ('reversal'::text, 2000::bigint, %L::text) $$, tests.made(tests.rvid('rq-loss'), 'replacement')),
  'a pure undo posts the reversal alone');
select is((select decided_by::text from public.imprest_posting_reversals where id = tests.rvid('rq-undo')),
          'e8000000-0000-0000-0000-000000000002', 'the approving Director is the one who decided');
select is(tests.figures(), '200000/155000/110000/45000/0',
          'the balance rises by the 2,000 undone');

-- ---------------------------------------------------------------------------
-- Append-only, whoever writes
-- ---------------------------------------------------------------------------
set local role fv_definer_owner;
select throws_ok(
  format($$ insert into public.imprest_postings (verification_id, disbursement_id, settlement_id,
                                                 fund_id, kind, amount_tzs, needs_director_decision,
                                                 entry, reversal_id, corrects_posting_id)
            select verification_id, disbursement_id, settlement_id, fund_id, kind, 1, false,
                   'reversal', %L, id
              from public.imprest_postings where id = %L $$,
         tests.rvid('rq-up'), tests.made(tests.rvid('rq-exp'), 'replacement')),
  '23514', null, 'a reversal posting needs an approved request for that posting, at its amount');
select throws_ok(
  format($$ insert into public.imprest_posting_reversals (posting_id, disbursement_id, fund_id,
                                                          original_tzs, correct_tzs, reason,
                                                          requested_by, requested_role)
            select id, disbursement_id, fund_id, amount_tzs, 1, 'Direct write',
                   'e8000000-0000-0000-0000-000000000003', 'manager'
              from public.imprest_postings where id = %L $$,
         tests.pid(tests.did('trip'), 'expense')),
  '23514', null, 'a request for a posting already reversed is refused whoever writes it');
reset role;
select throws_ok(
  format($$ update public.imprest_posting_reversals set correct_tzs = 1 where id = %L $$, tests.rvid('rq-exp')),
  '23001', null, 'a request keeps what was asked and decided');
select throws_ok(
  format($$ update public.imprest_posting_reversals set status = 'requested' where id = %L $$, tests.rvid('rq-up')),
  '23001', null, 'and never goes back');
select throws_ok($$ delete from public.imprest_posting_reversals $$, '23001', null, 'none is deleted');
-- TRUNCATE cannot run here while this transaction holds deferred checks, so the guard is named.
select has_trigger('public', 'imprest_posting_reversals', 'imprest_posting_reversals_no_truncate',
                   'or truncated: a statement trigger refuses TRUNCATE');
select throws_ok($$ delete from public.imprest_postings $$, '23001', null, 'postings are never deleted');

-- ---------------------------------------------------------------------------
-- Criterion 7 · Who reads
-- ---------------------------------------------------------------------------
set local role authenticated;
select tests.director();
select is((select count(*)::int from public.imprest_posting_reversals), 4, 'a Director reads every request');
select tests.manager();
select is((select count(*)::int from public.imprest_posting_reversals), 4, 'so does the Manager');
select tests.cashier();
select is((select count(*)::int from public.imprest_posting_reversals), 4,
          'the proposing Cashier reads every request on their own payment, the Manager''s included');
select is((select count(*)::int from public.imprest_postings where disbursement_id = tests.did('trip')), 7,
          'and every posting of it: two originals, two reversals with replacements, and the undo');
select tests.cashier_b();
select is((select count(*)::int from public.imprest_posting_reversals), 0, 'another Cashier reads none');
select tests.rep();
select is((select count(*)::int from public.imprest_posting_reversals), 0, 'a Sales Representative reads none');
reset role;

select * from finish();
rollback;
