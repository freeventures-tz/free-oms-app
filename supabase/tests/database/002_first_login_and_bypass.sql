-- Stage 8A/8B · First-login gate, approval integrity, direct-write bypasses
create extension if not exists pgtap with schema extensions;

begin;
select plan(26);

create schema if not exists tests;

create or replace function tests.mk_user(p_id uuid, p_pw text)
returns void language plpgsql as $$
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          created_at, updated_at)
  values (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          p_id::text || '@test.local', extensions.crypt(p_pw, extensions.gen_salt('bf')),
          now(), now());
end $$;

create or replace function tests.act_as(p_id uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_id::text, 'role', 'authenticated')::text, true);
end $$;

-- Runs the three real steps the server takes, and returns the completion result.
create or replace function tests.complete_first_login(p_user_id uuid)
returns jsonb language plpgsql as $$
declare
  v_begun jsonb;
  v_op    uuid;
begin
  v_begun := private.begin_first_login(p_user_id);
  v_op    := (v_begun -> 'operation' ->> 'id')::uuid;
  perform private.record_first_login_password_changed(v_op, p_user_id, 'pgtap-evidence');
  return private.clear_first_login_gate(p_user_id, v_op);
end $$;

select tests.mk_user('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'temp-pass-1');
select tests.mk_user('bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'temp-pass-2');
select tests.mk_user('cccccccc-0000-0000-0000-000000000003'::uuid, 'director-pw');

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'New Cashier',  '+255700000011', true, true),
       ('bbbbbbbb-0000-0000-0000-000000000002', 'Other User',   '+255700000012', true, true),
       ('cccccccc-0000-0000-0000-000000000003', 'A Director',   '+255700000013', true, false);

insert into public.user_roles (user_id, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'cashier'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'cashier'),
  ('cccccccc-0000-0000-0000-000000000003', 'director');

-- ---------------------------------------------------------------------------
-- THE GATE: a fully valid session gets zero business authority while gated
-- ---------------------------------------------------------------------------
select tests.act_as('aaaaaaaa-0000-0000-0000-000000000001');

select ok(not private.authorize(array['cashier']::public.app_role[]),
          'GATED user with valid session, active profile and correct role -> NO authority');

-- ---------------------------------------------------------------------------
-- NO CLIENT-CALLABLE COMPLETION EXISTS. This is the mechanism, not an inference.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api'
      and p.proname like '%first_login%'
      and (has_function_privilege('authenticated', p.oid, 'execute')
           or has_function_privilege('anon', p.oid, 'execute'))),
  0,
  'no first-login function in the exposed api schema is executable by anon or authenticated');

select ok(
  not has_function_privilege('authenticated', 'private.clear_first_login_gate(uuid,uuid,uuid)', 'execute'),
  'authenticated cannot execute clear_first_login_gate');

select ok(
  not has_function_privilege('anon', 'private.clear_first_login_gate(uuid,uuid,uuid)', 'execute'),
  'anon cannot execute clear_first_login_gate');

-- Even the SERVER holds nothing in `private`: it reaches the gate only through the definer-owned
-- api.service_complete_first_login, which requires a recorded Auth change.
select ok(
  not has_function_privilege('service_role', 'private.clear_first_login_gate(uuid,uuid,uuid)', 'execute'),
  'service_role cannot execute the private implementation directly');

select ok(
  has_function_privilege('service_role', 'api.service_complete_first_login(uuid,uuid,uuid)', 'execute'),
  'the server reaches the gate only through the narrow api function');

select ok(
  not has_function_privilege('authenticated',
                             'private.arm_first_login_gate_by_director(uuid,uuid,uuid)', 'execute'),
  'authenticated cannot arm or re-arm the gate either');

-- A gated user cannot lift the gate by direct UPDATE: no column grant exists.
set local role authenticated;
select throws_ok(
  $$ update public.profiles set must_change_password = false
      where id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  '42501',
  null,
  'direct UPDATE of must_change_password is refused -- no column grant');
reset role;

-- ---------------------------------------------------------------------------
-- COMPLETION REQUIRES RECORDED EVIDENCE OF AN AUTH PASSWORD CHANGE
-- ---------------------------------------------------------------------------
select is(
  (private.clear_first_login_gate(
     'aaaaaaaa-0000-0000-0000-000000000001',
     ((private.begin_first_login('aaaaaaaa-0000-0000-0000-000000000001') -> 'operation' ->> 'id')::uuid)
   ) ->> 'reason'),
  'password_change_not_recorded',
  'an operation with no recorded Auth change cannot clear the gate, whoever asks');

select is((tests.complete_first_login('aaaaaaaa-0000-0000-0000-000000000001') ->> 'ok'), 'true',
          'server clears the gate once an Auth change is recorded');

select ok(
  not (select must_change_password from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'gate cleared');

select tests.act_as('aaaaaaaa-0000-0000-0000-000000000001');
select ok(private.authorize(array['cashier']::public.app_role[]),
          'authority granted only after completion');

select ok(
  (select must_change_password from public.profiles where id = 'bbbbbbbb-0000-0000-0000-000000000002'),
  'completing one user does not touch another');

select is(
  (select count(*)::int from public.audit_events
    where action = 'first_login_completed'
      and entity_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  1, 'completion is audited exactly once');

-- ---------------------------------------------------------------------------
-- DIRECTOR RESET re-arms and SUPERSEDES the evidence gathered before it
-- ---------------------------------------------------------------------------
select private.arm_first_login_gate_by_director('aaaaaaaa-0000-0000-0000-000000000001',
                                                'cccccccc-0000-0000-0000-000000000003');

select ok(
  (select must_change_password from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'Director reset re-arms the forced-change requirement');

-- A COMPLETED operation is already spent: clearing requires stage `auth_changed`, so it can never
-- be replayed. What must not survive a re-arm is a LIVE operation, and none does.
select is(
  (select count(*)::int from public.first_login_operations
    where user_id = 'aaaaaaaa-0000-0000-0000-000000000001'
      and stage in ('pending', 'auth_changed')),
  0,
  'after a reset no live operation remains that could satisfy the new gate');

select tests.act_as('aaaaaaaa-0000-0000-0000-000000000001');
select ok(not private.authorize(array['cashier']::public.app_role[]),
          'a previously completed user loses authority after a reset');

-- ---------------------------------------------------------------------------
-- APPROVAL INTEGRITY: the ELSE TRUE fix
-- ---------------------------------------------------------------------------
insert into public.approval_requests
  (id, entity_type, entity_id, approval_type, requested_by, requested_role, required_role)
values ('dddddddd-0000-0000-0000-000000000001', 'invoice', gen_random_uuid(), 'discount',
        'aaaaaaaa-0000-0000-0000-000000000001', 'cashier', 'manager');

select throws_ok(
  $$ update public.approval_requests
        set status = 'rejected',
            approved_by = 'cccccccc-0000-0000-0000-000000000003',
            approved_role = 'director',
            approved_at = now()
      where id = 'dddddddd-0000-0000-0000-000000000001' $$,
  '23514',
  null,
  'a REJECTED row carrying an approver violates the check constraint');

select lives_ok(
  $$ update public.approval_requests set status = 'rejected'
      where id = 'dddddddd-0000-0000-0000-000000000001' $$,
  'a rejected row with null approval fields is accepted');

select throws_ok(
  $$ update public.approval_requests set status = 'approved'
      where id = 'dddddddd-0000-0000-0000-000000000001' $$,
  '23514',
  null,
  'an APPROVED row without an approver violates the check constraint');

-- ---------------------------------------------------------------------------
-- DIRECT APPROVAL-FIELD WRITE fails on PRIVILEGE, before any policy
-- ---------------------------------------------------------------------------
select tests.act_as('cccccccc-0000-0000-0000-000000000003');   -- a Director, no less
set local role authenticated;

select throws_ok(
  $$ update public.approval_requests
        set status = 'approved', approved_by = 'cccccccc-0000-0000-0000-000000000003',
            approved_role = 'director', approved_at = now()
      where id = 'dddddddd-0000-0000-0000-000000000001' $$,
  '42501',
  null,
  'even a DIRECTOR cannot write approval fields directly -- no UPDATE grant exists');

select throws_ok(
  $$ insert into public.approval_decisions (request_id, outcome, decided_by, decided_role)
     values ('dddddddd-0000-0000-0000-000000000001', 'approved',
             'cccccccc-0000-0000-0000-000000000003', 'director') $$,
  '42501',
  null,
  'approval_decisions is append-only to functions -- no INSERT grant for authenticated');

select throws_ok(
  $$ insert into public.audit_events (actor_id, action, correlation_id)
     values ('cccccccc-0000-0000-0000-000000000003', 'forged', gen_random_uuid()) $$,
  '42501',
  null,
  'audit_events cannot be forged by a client');

select throws_ok(
  $$ delete from public.audit_events $$,
  '42501',
  null,
  'audit_events cannot be deleted by a client');

select throws_ok(
  $$ insert into public.first_login_operations (user_id, stage)
     values ('cccccccc-0000-0000-0000-000000000003', 'auth_changed') $$,
  '42501',
  null,
  'a client cannot forge the evidence that clears its own gate');

select throws_ok(
  $$ insert into public.admin_commands (kind, idempotency_key, actor_id, actor_role, target_user_id)
     values ('password_reset', 'forged', 'cccccccc-0000-0000-0000-000000000003', 'director',
             'aaaaaaaa-0000-0000-0000-000000000001') $$,
  '42501',
  null,
  'a client cannot forge an administrative command');

reset role;

select * from finish();
rollback;
