-- Issue #48 · Imprest funding: request, approval, provision, receipt and the discrepancy cycle
--
-- The claims under test, each traceable to product.md §13.2 and the ticket's approved exceptions:
--
--   AC-46  A Manager requests; a Director approves or rejects, and a rejection carries a reason.
--   AC-47  Request, approval, an approval increase and provision add NOTHING to posted funding.
--   AC-48  Only the Manager's confirmation of the current handover posts money, exactly once.
--   AC-49  Requested, approved, provided and received stay separately visible.
--   AC-50  Every step names its actor and time; either Director may act.
--   Ex. 9  Provision may be lower than approval. More needs a recorded approval increase first,
--          and every approval amount survives.
--   Ex. 10 A counted difference is a mismatch that leaves the funding unconfirmed. Zero is a count.
--   Ex. 11 A Director resolves with a corrected handover and explanation, inside the approval.
--   Ex. 12 The Manager confirms the correction or reports again. Each cycle stays traceable.
--   Ex. 13 A stale screen cannot confirm. Once received, nothing rewrites it.
--   §14.2  A committed refusal leaves an audit row. Clients cannot write the tables directly.

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

select tests.mk_user('e4800000-0000-0000-0000-000000000001'::uuid);  -- Director A
select tests.mk_user('e4800000-0000-0000-0000-000000000002'::uuid);  -- Director B
select tests.mk_user('e4800000-0000-0000-0000-000000000003'::uuid);  -- Manager
select tests.mk_user('e4800000-0000-0000-0000-000000000004'::uuid);  -- Cashier
select tests.mk_user('e4800000-0000-0000-0000-000000000005'::uuid);  -- Sales Representative
select tests.mk_user('e4800000-0000-0000-0000-000000000006'::uuid);  -- Disabled Manager

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('e4800000-0000-0000-0000-000000000001', 'Fund Director A', '+255700004801', true,  false),
  ('e4800000-0000-0000-0000-000000000002', 'Fund Director B', '+255700004802', true,  false),
  ('e4800000-0000-0000-0000-000000000003', 'Fund Manager',    '+255700004803', true,  false),
  ('e4800000-0000-0000-0000-000000000004', 'Fund Cashier',    '+255700004804', true,  false),
  ('e4800000-0000-0000-0000-000000000005', 'Fund Rep',        '+255700004805', true,  false),
  ('e4800000-0000-0000-0000-000000000006', 'Gone Manager',    '+255700004806', false, false);

insert into public.user_roles (user_id, role) values
  ('e4800000-0000-0000-0000-000000000001', 'director'),
  ('e4800000-0000-0000-0000-000000000002', 'director'),
  ('e4800000-0000-0000-0000-000000000003', 'manager'),
  ('e4800000-0000-0000-0000-000000000004', 'cashier'),
  ('e4800000-0000-0000-0000-000000000005', 'sales_rep'),
  ('e4800000-0000-0000-0000-000000000006', 'manager');

create or replace function tests.director_a() returns void language sql as $$
  select tests.acting_as('e4800000-0000-0000-0000-000000000001'::uuid); $$;
create or replace function tests.director_b() returns void language sql as $$
  select tests.acting_as('e4800000-0000-0000-0000-000000000002'::uuid); $$;
create or replace function tests.manager() returns void language sql as $$
  select tests.acting_as('e4800000-0000-0000-0000-000000000003'::uuid); $$;

-- Every command result, by name, so later steps can read the id, version and handover.
create temp table r (name text primary key, res jsonb not null);
create or replace function tests.keep(p_name text, p_res jsonb) returns text language sql as $$
  insert into r values (p_name, p_res) returning res ->> 'reason';
$$;
create or replace function tests.fid(p_name text) returns uuid language sql as $$
  select (res -> 'funding' ->> 'id')::uuid from r where name = p_name; $$;
create or replace function tests.s(p_id uuid) returns public.imprest_funding_summaries
  language sql as $$ select * from public.imprest_funding_summaries where id = p_id; $$;
create or replace function tests.posted() returns bigint language sql as $$
  select posted_funding_tzs from public.imprest_funding_position; $$;

-- ---------------------------------------------------------------------------
-- The tables cannot be written by a client, and the service role holds nothing on them
-- ---------------------------------------------------------------------------
select ok(
  not has_table_privilege('authenticated', 'public.' || t, 'insert')
  and not has_table_privilege('authenticated', 'public.' || t, 'update')
  and not has_table_privilege('authenticated', 'public.' || t, 'delete')
  and not has_table_privilege('service_role', 'public.' || t, 'select')
  and not has_table_privilege('service_role', 'public.' || t, 'insert'),
  'authenticated may only read public.' || t || ', and the service role holds nothing on it')
from unnest(array['imprest_funds', 'imprest_fundings', 'imprest_funding_approvals',
                  'imprest_funding_handovers', 'imprest_funding_mismatches']) t;

select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     join pg_roles o on o.oid = p.proowner
    where n.nspname = 'api' and p.proname like '%imprest%'
      and p.prosecdef and o.rolname = 'fv_definer_owner'),
  7,
  'seven imprest funding commands, every one security definer and owned by fv_definer_owner');

select ok(
  not has_function_privilege('authenticated',
    'private.impl_staff_confirm_imprest_received(uuid, integer, uuid, text)', 'execute'),
  'the implementation behind a command is not callable by a client');

-- ---------------------------------------------------------------------------
-- §4.1 · Only a live Manager requests
-- ---------------------------------------------------------------------------
select tests.director_a();
select throws_ok(
  $$ select api.staff_request_imprest_funding(100000, 'yard float', 'imp-dir-req') $$,
  '42501', null, 'a Director cannot request imprest funding');

select tests.acting_as('e4800000-0000-0000-0000-000000000004'::uuid);
select throws_ok(
  $$ select api.staff_request_imprest_funding(100000, 'yard float', 'imp-cash-req') $$,
  '42501', null, 'nor can a Cashier');

select tests.acting_as('e4800000-0000-0000-0000-000000000005'::uuid);
select throws_ok(
  $$ select api.staff_request_imprest_funding(100000, 'yard float', 'imp-rep-req') $$,
  '42501', null, 'nor a Sales Representative');

select tests.acting_as('e4800000-0000-0000-0000-000000000006'::uuid);
select throws_ok(
  $$ select api.staff_request_imprest_funding(100000, 'yard float', 'imp-gone-req') $$,
  '42501', null, 'nor a Manager whose account is disabled');

-- ---------------------------------------------------------------------------
-- Example 1 · request 100,000, approve 80,000, provide 70,000, confirm → posted 70,000
-- ---------------------------------------------------------------------------
select tests.manager();
select is(tests.keep('f1.req',
  api.staff_request_imprest_funding(100000, 'Opening yard float', 'imp-f1-req')),
  'requested', 'the Manager requests TZS 100,000');

select is(
  (select count(*)::int from public.imprest_funds where is_active), 1,
  'the first request opens the single active fund');

select is(
  api.staff_request_imprest_funding(100000, 'Opening yard float', 'imp-f1-req') ->> 'reason',
  'replayed', 'a retry with the same key and inputs replays');

select is(
  (select count(*)::int from public.imprest_fundings where requested_by =
     'e4800000-0000-0000-0000-000000000003'), 1,
  'and creates no second request');

select is(
  api.staff_request_imprest_funding(90000, 'Opening yard float', 'imp-f1-req') ->> 'reason',
  'idempotency_key_conflict', 'the same key with a different amount is a conflict, not a replay');

select is(
  api.staff_request_imprest_funding(0, 'Opening yard float', 'imp-f1-zero') ->> 'reason',
  'amount_invalid', 'a request must ask for a positive amount');

select is(tests.posted(), 0::bigint, 'a request posts nothing');

select tests.manager();
select throws_ok(
  format($$ select api.admin_decide_imprest_funding(%L, 1, true, 80000, null, 'imp-f1-mgr') $$,
         tests.fid('f1.req')),
  '42501', null, 'a Manager cannot approve their own request');

select tests.director_a();
select is(
  api.admin_decide_imprest_funding(tests.fid('f1.req'), 7, true, 80000, null, 'imp-f1-stale')
    ->> 'reason',
  'stale', 'an approval against an old version of the request is refused');

select is(tests.keep('f1.app',
  api.admin_decide_imprest_funding(tests.fid('f1.req'), 1, true, 80000, null, 'imp-f1-app')),
  'approved', 'Director A approves TZS 80,000');

select is(tests.posted(), 0::bigint, 'approval posts nothing (AC-47)');

select is(
  api.admin_record_imprest_provided(tests.fid('f1.req'), 2, 0, 'imp-f1-prov0') ->> 'reason',
  'amount_invalid', 'a provision must be a positive amount');

select tests.director_b();
select is(tests.keep('f1.prov',
  api.admin_record_imprest_provided(tests.fid('f1.req'), 2, 70000, 'imp-f1-prov')),
  'provided', 'Director B provides TZS 70,000, below the approval');

select is(tests.posted(), 0::bigint, 'provision posts nothing');

select is((tests.s(tests.fid('f1.req'))).status::text, 'provided', 'the funding awaits receipt');

select tests.director_a();
select throws_ok(
  format($$ select api.staff_confirm_imprest_received(%L, 3, %L, 'imp-f1-dir-conf') $$,
         tests.fid('f1.req'), (select res -> 'funding' ->> 'handover_id' from r where name = 'f1.prov')),
  '42501', null, 'a Director cannot confirm receipt on the Manager''s behalf');

select tests.manager();
select is(tests.keep('f1.conf',
  api.staff_confirm_imprest_received(tests.fid('f1.req'), 3,
    (select (res -> 'funding' ->> 'handover_id')::uuid from r where name = 'f1.prov'),
    'imp-f1-conf')),
  'received', 'the Manager confirms the displayed handover');

select is(tests.posted(), 70000::bigint, 'posted funding is the confirmed TZS 70,000');

select is(
  api.staff_confirm_imprest_received(tests.fid('f1.req'), 3,
    (select (res -> 'funding' ->> 'handover_id')::uuid from r where name = 'f1.prov'),
    'imp-f1-conf') ->> 'reason',
  'replayed', 'a retried confirmation replays');

select is(
  api.staff_confirm_imprest_received(tests.fid('f1.req'), 4,
    (select (res -> 'funding' ->> 'handover_id')::uuid from r where name = 'f1.prov'),
    'imp-f1-conf-2') ->> 'reason',
  'not_awaiting_receipt', 'a second confirmation under a new key is refused');

select is(tests.posted(), 70000::bigint, 'and the money posted exactly once');

select results_eq(
  format($$ select requested_amount_tzs, original_approved_tzs, approved_amount_tzs,
                   provided_amount_tzs, received_amount_tzs
              from public.imprest_funding_summaries where id = %L $$, tests.fid('f1.req')),
  $$ values (100000::bigint, 80000::bigint, 80000::bigint, 70000::bigint, 70000::bigint) $$,
  'requested, approved, provided and received stay separate figures (AC-49)');

select results_eq(
  format($$ select requested_by, approved_by, provided_by, received_by
              from public.imprest_funding_summaries where id = %L $$, tests.fid('f1.req')),
  $$ values ('e4800000-0000-0000-0000-000000000003'::uuid,
             'e4800000-0000-0000-0000-000000000001'::uuid,
             'e4800000-0000-0000-0000-000000000002'::uuid,
             'e4800000-0000-0000-0000-000000000003'::uuid) $$,
  'each actor is recorded, and the approving and providing Directors differ (AC-50)');

select ok(
  (select requested_at is not null and approved_at is not null and provided_at is not null
          and received_at is not null
     from public.imprest_funding_summaries where id = tests.fid('f1.req')),
  'and every step carries its timestamp');

select is(
  (select count(*)::int from public.audit_events
    where entity_type = 'imprest_funding' and entity_id = tests.fid('f1.req')
      and action in ('imprest_funding_requested', 'imprest_funding_approved',
                     'imprest_funding_provided', 'imprest_funding_received')),
  4, 'the four successful transitions are audited');

-- ---------------------------------------------------------------------------
-- Example 2 · approve 80,000 and try to provide 90,000 → refuse, then increase first
-- ---------------------------------------------------------------------------
select tests.manager();
select is(tests.keep('f2.req',
  api.staff_request_imprest_funding(90000, 'Diesel for the mixer', 'imp-f2-req')),
  'requested', 'a subsequent request uses the same workflow');

select is(
  (select count(*)::int from public.imprest_funds), 1,
  'and joins the same fund rather than opening another');

select is(
  (tests.s(tests.fid('f1.req'))).received_amount_tzs, 70000::bigint,
  'the earlier funding is untouched by the new request');

select tests.director_a();
select is(
  api.admin_decide_imprest_funding(tests.fid('f2.req'), 1, true, 80000, null, 'imp-f2-app')
    ->> 'reason', 'approved', 'approved at TZS 80,000');

select tests.director_b();
select is(tests.keep('f2.over',
  api.admin_record_imprest_provided(tests.fid('f2.req'), 2, 90000, 'imp-f2-over')),
  'exceeds_approval', 'providing TZS 90,000 against an 80,000 approval is refused');

select is(
  ((select res from r where name = 'f2.over') ->> 'approved_amount_tzs')::bigint, 80000::bigint,
  'and the refusal says what the approval allows');

select is(
  (select count(*)::int from public.audit_events
    where action = 'command_refused' and entity_id = tests.fid('f2.req')
      and source_operation = 'api.admin_record_imprest_provided'
      and after_state ->> 'reason' = 'exceeds_approval'),
  1, 'the refusal is committed to the audit trail');

select is(
  api.admin_increase_imprest_approval(tests.fid('f2.req'), 2, 80000, null, 'imp-f2-same')
    ->> 'reason',
  'increase_not_higher', 'an approval increase must be higher than the current approval');

select is(
  api.admin_increase_imprest_approval(tests.fid('f2.req'), 2, 90000, 'Fuel price rose', 'imp-f2-inc')
    ->> 'reason',
  'approval_increased', 'Director B records an approval increase to TZS 90,000');

select is(
  api.admin_increase_imprest_approval(tests.fid('f2.req'), 2, 90000, 'Different note', 'imp-f2-inc')
    ->> 'reason',
  'idempotency_key_conflict', 'a retry with a changed note cannot replay the increase');

select is(tests.posted(), 70000::bigint, 'an approval increase posts nothing');

select results_eq(
  format($$ select sequence, amount_tzs, approved_by from public.imprest_funding_approvals
             where funding_id = %L order by sequence $$, tests.fid('f2.req')),
  $$ values (1, 80000::bigint, 'e4800000-0000-0000-0000-000000000001'::uuid),
            (2, 90000::bigint, 'e4800000-0000-0000-0000-000000000002'::uuid) $$,
  'the original approval and the increase both survive, each with its Director');

select is(
  api.admin_record_imprest_provided(tests.fid('f2.req'), 3, 90000, 'imp-f2-prov') ->> 'reason',
  'provided', 'now TZS 90,000 may be provided');

select is(
  api.admin_increase_imprest_approval(tests.fid('f2.req'), 4, 95000, null, 'imp-f2-late')
    ->> 'reason',
  'not_open_for_approval_change', 'no increase while a handover awaits the Manager');

-- ---------------------------------------------------------------------------
-- Example 3 · provide 80,000, count 75,000, correct, count 0, correct, confirm
-- ---------------------------------------------------------------------------
select tests.manager();
select is(tests.keep('f3.req',
  api.staff_request_imprest_funding(80000, 'Weekly float', 'imp-f3-req')),
  'requested', 'a third request');

select tests.director_a();
select is(
  api.admin_decide_imprest_funding(tests.fid('f3.req'), 1, true, 80000, null, 'imp-f3-app')
    ->> 'reason', 'approved', 'approved at TZS 80,000');
select is(tests.keep('f3.prov1',
  api.admin_record_imprest_provided(tests.fid('f3.req'), 2, 80000, 'imp-f3-prov')),
  'provided', 'TZS 80,000 provided');

select tests.director_a();
select is(
  api.admin_resolve_imprest_mismatch(tests.fid('f3.req'), 3, 80000, 'nothing to fix', 'imp-f3-early')
    ->> 'reason',
  'not_in_dispute', 'a Director cannot "correct" a handover nobody disputed');

select tests.manager();
select is(
  api.staff_report_imprest_mismatch(tests.fid('f3.req'), 3,
    (select (res -> 'funding' ->> 'handover_id')::uuid from r where name = 'f3.prov1'),
    80000, null, 'imp-f3-same') ->> 'reason',
  'counted_matches_provided', 'a count equal to the handover is a confirmation, not a mismatch');

select is(tests.keep('f3.mm1',
  api.staff_report_imprest_mismatch(tests.fid('f3.req'), 3,
    (select (res -> 'funding' ->> 'handover_id')::uuid from r where name = 'f3.prov1'),
    75000, 'One bundle short', 'imp-f3-mm1')),
  'mismatch_reported', 'the Manager counts TZS 75,000 and reports a shortage');

select is((tests.s(tests.fid('f3.req'))).status::text, 'disputed', 'the funding stays unconfirmed');
select is(tests.posted(), 70000::bigint, 'a mismatch posts nothing');

select is(
  api.staff_confirm_imprest_received(tests.fid('f3.req'), 3,
    (select (res -> 'funding' ->> 'handover_id')::uuid from r where name = 'f3.prov1'),
    'imp-f3-stale-conf') ->> 'reason',
  'stale', 'a stale screen cannot confirm the disputed amount');

select tests.director_b();
select is(
  api.admin_resolve_imprest_mismatch(tests.fid('f3.req'), 4, 75000, '', 'imp-f3-noexp')
    ->> 'reason',
  'explanation_required', 'a corrected handover needs an explanation');

select is(tests.keep('f3.res1',
  api.admin_resolve_imprest_mismatch(tests.fid('f3.req'), 4, 75000,
    'Recounted the envelope: 75,000 was handed over', 'imp-f3-res1')),
  'handover_corrected', 'Director B records the corrected handover of TZS 75,000');

select is(
  api.admin_resolve_imprest_mismatch(tests.fid('f3.req'), 4, 75000,
    'A different explanation', 'imp-f3-res1') ->> 'reason',
  'idempotency_key_conflict', 'a retry with a changed explanation cannot replay the correction');

select is(tests.posted(), 70000::bigint, 'a Director''s correction alone posts nothing');

select tests.manager();
select is(
  api.staff_report_imprest_mismatch(tests.fid('f3.req'), 5,
    (select (res -> 'funding' ->> 'handover_id')::uuid from r where name = 'f3.prov1'),
    0, null, 'imp-f3-oldhand') ->> 'reason',
  'stale', 'a mismatch against the superseded handover is refused');

select is(tests.keep('f3.mm2',
  api.staff_report_imprest_mismatch(tests.fid('f3.req'), 5,
    (select (res -> 'funding' ->> 'handover_id')::uuid from r where name = 'f3.res1'),
    0, 'The envelope never arrived', 'imp-f3-mm2')),
  'mismatch_reported', 'a further mismatch: a zero count records that no cash arrived');

select tests.director_a();
select is(
  api.admin_resolve_imprest_mismatch(tests.fid('f3.req'), 6, 85000,
    'Handed over with the fuel money', 'imp-f3-res-over') ->> 'reason',
  'exceeds_approval', 'a corrected handover above the approval is refused');

select is(tests.keep('f3.res2',
  api.admin_resolve_imprest_mismatch(tests.fid('f3.req'), 6, 78000,
    'Handed over in person at the gate', 'imp-f3-res2')),
  'handover_corrected', 'Director A records a second correction of TZS 78,000');

select tests.manager();
select is(
  api.staff_confirm_imprest_received(tests.fid('f3.req'), 6,
    (select (res -> 'funding' ->> 'handover_id')::uuid from r where name = 'f3.res2'),
    'imp-f3-conf-old') ->> 'reason',
  'stale', 'confirming with the version seen before the correction is refused');

select is(tests.keep('f3.conf',
  api.staff_confirm_imprest_received(tests.fid('f3.req'), 7,
    (select (res -> 'funding' ->> 'handover_id')::uuid from r where name = 'f3.res2'),
    'imp-f3-conf')),
  'received', 'the Manager confirms the corrected handover');

select is(tests.posted(), 148000::bigint, 'only the final TZS 78,000 posts: 70,000 + 78,000');

select results_eq(
  format($$ select h.cycle, h.amount_tzs, m.counted_tzs
              from public.imprest_funding_handovers h
              left join public.imprest_funding_mismatches m on m.handover_id = h.id
             where h.funding_id = %L order by h.cycle $$, tests.fid('f3.req')),
  $$ values (1, 80000::bigint, 75000::bigint), (2, 75000::bigint, 0::bigint),
            (3, 78000::bigint, null::bigint) $$,
  'every handover and every count survives, in order');

select is(
  (select count(*)::int from public.imprest_funding_handovers
    where funding_id = tests.fid('f3.req') and cycle > 1 and explanation is not null),
  2, 'each correction keeps its explanation');

-- Once received, the pre-receipt actions cannot rewrite it.
select tests.director_a();
select is(
  api.admin_resolve_imprest_mismatch(tests.fid('f3.req'), 8, 70000, 'late change', 'imp-f3-after')
    ->> 'reason',
  'not_in_dispute', 'a received funding cannot be corrected');
select is(
  api.admin_increase_imprest_approval(tests.fid('f3.req'), 8, 99000, null, 'imp-f3-after-inc')
    ->> 'reason',
  'not_open_for_approval_change', 'nor its approval increased');
select tests.manager();
select is(
  api.staff_report_imprest_mismatch(tests.fid('f3.req'), 8,
    (select (res -> 'funding' ->> 'handover_id')::uuid from r where name = 'f3.res2'),
    1000, null, 'imp-f3-after-mm') ->> 'reason',
  'not_awaiting_receipt', 'nor a mismatch reported against it');

-- An excess is a mismatch too.
select tests.manager();
select is(tests.keep('f4.req',
  api.staff_request_imprest_funding(50000, 'Spare parts', 'imp-f4-req')),
  'requested', 'a fourth request');
select tests.director_a();
select is(
  api.admin_decide_imprest_funding(tests.fid('f4.req'), 1, true, 50000, null, 'imp-f4-app')
    ->> 'reason', 'approved', 'approved');
select is(tests.keep('f4.prov',
  api.admin_record_imprest_provided(tests.fid('f4.req'), 2, 40000, 'imp-f4-prov')),
  'provided', 'TZS 40,000 provided');
select tests.manager();
select is(
  api.staff_report_imprest_mismatch(tests.fid('f4.req'), 3,
    (select (res -> 'funding' ->> 'handover_id')::uuid from r where name = 'f4.prov'),
    45000, 'Counted 45,000', 'imp-f4-mm') ->> 'reason',
  'mismatch_reported', 'an excess count is reported the same way');
select is(tests.posted(), 148000::bigint, 'and posts nothing either');

-- ---------------------------------------------------------------------------
-- Rejection · a reason is required, and it is part of what a retry must repeat
-- ---------------------------------------------------------------------------
select tests.manager();
select is(tests.keep('f5.req',
  api.staff_request_imprest_funding(20000, 'Office tea', 'imp-f5-req')),
  'requested', 'a fifth request');
select tests.director_b();
select is(
  api.admin_decide_imprest_funding(tests.fid('f5.req'), 1, false, null, ' ', 'imp-f5-noreason')
    ->> 'reason',
  'reason_required', 'a rejection must carry a reason');
select is(
  api.admin_decide_imprest_funding(tests.fid('f5.req'), 1, false, null, 'Not an operating cost',
    'imp-f5-rej') ->> 'reason',
  'rejected', 'Director B rejects with a reason');
select is(
  api.admin_decide_imprest_funding(tests.fid('f5.req'), 1, false, null, 'Another reason',
    'imp-f5-rej') ->> 'reason',
  'idempotency_key_conflict', 'a retry with a different rejection reason is not a replay');
select results_eq(
  format($$ select status::text, rejected_by, rejection_reason, approved_by
              from public.imprest_funding_summaries where id = %L $$, tests.fid('f5.req')),
  $$ values ('rejected', 'e4800000-0000-0000-0000-000000000002'::uuid,
             'Not an operating cost', null::uuid) $$,
  'a rejection records its Director and reason, and no approver (§4.3)');
select is(
  api.admin_decide_imprest_funding(tests.fid('f5.req'), 2, true, 20000, null, 'imp-f5-late')
    ->> 'reason',
  'not_awaiting_decision', 'a rejected request cannot then be approved');

-- ---------------------------------------------------------------------------
-- History is immutable, for every role including the definer
-- ---------------------------------------------------------------------------
select throws_ok(
  format($$ update public.imprest_funding_approvals set amount_tzs = 1 where funding_id = %L $$,
         tests.fid('f2.req')),
  '23001', null, 'an approval amount cannot be edited');
select throws_ok(
  format($$ delete from public.imprest_funding_handovers where funding_id = %L $$,
         tests.fid('f3.req')),
  '23001', null, 'a handover cannot be deleted');
select throws_ok(
  format($$ update public.imprest_funding_mismatches set counted_tzs = 80000
             where funding_id = %L $$, tests.fid('f3.req')),
  '23001', null, 'a count cannot be edited');
select throws_ok(
  format($$ update public.imprest_fundings set received_amount_tzs = 1 where id = %L $$,
         tests.fid('f1.req')),
  '23001', null, 'a received funding cannot be rewritten');
select throws_ok(
  format($$ delete from public.imprest_fundings where id = %L $$, tests.fid('f5.req')),
  '23001', null, 'a funding cannot be deleted');

-- ---------------------------------------------------------------------------
-- Reads · the imprest roles see the history; a Sales Representative sees none of it
-- ---------------------------------------------------------------------------
select tests.acting_as('e4800000-0000-0000-0000-000000000005'::uuid);
set local role authenticated;
select is((select count(*)::int from public.imprest_fundings), 0,
  'a Sales Representative reads no funding');
select is((select count(*)::int from public.imprest_funding_position), 0,
  'and no funding total');
reset role;

select tests.acting_as('e4800000-0000-0000-0000-000000000004'::uuid);
set local role authenticated;
select is((select count(*)::int from public.imprest_fundings), 5,
  'a Cashier reads the funding history under the existing imprest read policy');
reset role;

select * from finish();
rollback;
