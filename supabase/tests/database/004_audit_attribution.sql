-- Stage 8A hardening · Audit attribution
--
-- The audit trail must name WHO acted and under WHAT authority. A Director resetting a colleague's
-- password is not "system activity", and a user actor with no recorded role is not a usable record.
create extension if not exists pgtap with schema extensions;

begin;
select plan(15);

create schema if not exists tests;

create or replace function tests.mk_user(p_id uuid) returns void language plpgsql as $$
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          created_at, updated_at)
  values (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          p_id::text || '@test.local', extensions.crypt('x', extensions.gen_salt('bf')),
          now(), now());
end $$;

select tests.mk_user('d0000000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('d0000000-0000-0000-0000-000000000002'::uuid);  -- Cashier, gated
select tests.mk_user('d0000000-0000-0000-0000-000000000003'::uuid);  -- role-less, gated
select tests.mk_user('d0000000-0000-0000-0000-000000000004'::uuid);  -- bootstrap-style target
select tests.mk_user('d0000000-0000-0000-0000-000000000005'::uuid);  -- a Manager, not a Director

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('d0000000-0000-0000-0000-000000000001', 'A Director',  '+255700000021', true, false),
  ('d0000000-0000-0000-0000-000000000002', 'A Cashier',   '+255700000022', true, true),
  ('d0000000-0000-0000-0000-000000000003', 'No Role',     '+255700000023', true, true),
  ('d0000000-0000-0000-0000-000000000004', 'Fresh User',  '+255700000024', true, false),
  ('d0000000-0000-0000-0000-000000000005', 'A Manager',   '+255700000025', true, false);

insert into public.user_roles (user_id, role) values
  ('d0000000-0000-0000-0000-000000000001', 'director'),
  ('d0000000-0000-0000-0000-000000000002', 'cashier'),
  ('d0000000-0000-0000-0000-000000000004', 'sales_rep'),
  ('d0000000-0000-0000-0000-000000000005', 'manager');

-- ---------------------------------------------------------------------------
-- Completion names the user AND the authority they held while doing it
-- ---------------------------------------------------------------------------
-- The three real steps: open the operation, record the observed Auth change, clear the gate.
do $do$
declare v_op uuid;
begin
  v_op := (private.begin_first_login('d0000000-0000-0000-0000-000000000002') -> 'operation' ->> 'id')::uuid;
  perform private.record_first_login_password_changed(v_op, 'd0000000-0000-0000-0000-000000000002', 'pgtap-evidence');
  perform private.clear_first_login_gate('d0000000-0000-0000-0000-000000000002', v_op);
end
$do$;

select is(
  (select actor_id from public.audit_events
    where action = 'first_login_completed'
      and entity_id = 'd0000000-0000-0000-0000-000000000002'),
  'd0000000-0000-0000-0000-000000000002'::uuid,
  'first-login completion records the user as the actor');

select is(
  (select actor_role from public.audit_events
    where action = 'first_login_completed'
      and entity_id = 'd0000000-0000-0000-0000-000000000002'),
  'cashier'::public.app_role,
  'completion records the role held at the time, not a blank');

select is(
  (select is_system_actor from public.audit_events
    where action = 'first_login_completed'
      and entity_id = 'd0000000-0000-0000-0000-000000000002'),
  false,
  'a user completing their own first login is NOT system activity');

-- ---------------------------------------------------------------------------
-- A DIRECTOR RESET names the Director and the affected account
-- ---------------------------------------------------------------------------
select private.arm_first_login_gate_by_director('d0000000-0000-0000-0000-000000000002',
                                                'd0000000-0000-0000-0000-000000000001');

select is(
  (select actor_id from public.audit_events where action = 'password_reset_by_director'),
  'd0000000-0000-0000-0000-000000000001'::uuid,
  'a Director reset records WHICH Director performed it');

select is(
  (select actor_role from public.audit_events where action = 'password_reset_by_director'),
  'director'::public.app_role,
  'the reset records the authority it was taken under');

select is(
  (select entity_id from public.audit_events where action = 'password_reset_by_director'),
  'd0000000-0000-0000-0000-000000000002'::uuid,
  'the reset records WHICH account was affected');

select is(
  (select count(*)::int from public.audit_events
    where action = 'first_login_gate_armed'
      and entity_id = 'd0000000-0000-0000-0000-000000000002'),
  0,
  'a Director reset is NOT recorded as anonymous system activity');

-- ---------------------------------------------------------------------------
-- A non-Director cannot arm anyone's gate, even through the privileged function
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select private.arm_first_login_gate_by_director('d0000000-0000-0000-0000-000000000004',
                                                     'd0000000-0000-0000-0000-000000000005') $$,
  '42501',
  null,
  'a Manager passed as the actor is refused -- authority is checked live in the database');

-- The Director reset has no anonymous form at all: passing NULL is an error, not a system action.
select throws_ok(
  $$ select private.arm_first_login_gate_by_director('d0000000-0000-0000-0000-000000000004', null) $$,
  '42501',
  null,
  'a NULL actor cannot perform a Director reset');

-- ---------------------------------------------------------------------------
-- Only genuine system activity may be anonymous
-- ---------------------------------------------------------------------------
select private.arm_first_login_gate_system('d0000000-0000-0000-0000-000000000004');

select ok(
  (select is_system_actor and actor_id is null and actor_role is null
     from public.audit_events
    where action = 'first_login_gate_armed'
      and entity_id = 'd0000000-0000-0000-0000-000000000004'),
  'the separate SYSTEM function (bootstrap only) records a coherent system actor');

-- ---------------------------------------------------------------------------
-- The constraint admits exactly two shapes and no third
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.audit_events (actor_id, actor_role, is_system_actor, action, correlation_id)
     values ('d0000000-0000-0000-0000-000000000001', null, false, 'shapeless', gen_random_uuid()) $$,
  '23514',
  null,
  'a user actor with no role is refused -- the authority must be captured on write');

select throws_ok(
  $$ insert into public.audit_events (actor_id, actor_role, is_system_actor, action, correlation_id)
     values ('d0000000-0000-0000-0000-000000000001', 'director', true, 'shapeless', gen_random_uuid()) $$,
  '23514',
  null,
  'a system actor carrying a user id is refused');

select throws_ok(
  $$ insert into public.audit_events (actor_id, actor_role, is_system_actor, action, correlation_id)
     values (null, 'director', true, 'shapeless', gen_random_uuid()) $$,
  '23514',
  null,
  'a system actor carrying a role is refused');

-- ---------------------------------------------------------------------------
-- A roleless user cannot be recorded dishonestly: completion refuses instead
-- ---------------------------------------------------------------------------
select is(
  (
    with op as (
      select (private.begin_first_login('d0000000-0000-0000-0000-000000000003')
              -> 'operation' ->> 'id')::uuid as id
    ),
    recorded as (
      select private.record_first_login_password_changed(op.id,
               'd0000000-0000-0000-0000-000000000003', 'pgtap-evidence') from op
    )
    select private.clear_first_login_gate('d0000000-0000-0000-0000-000000000003', op.id) ->> 'reason'
    from op, recorded
  ),
  'no_role',
  'completion refuses for a user with no live role rather than forging an authority');

select ok(
  (select must_change_password from public.profiles
    where id = 'd0000000-0000-0000-0000-000000000003'),
  'the refused user stays gated -- the failure mode is always "still blocked"');

select * from finish();
rollback;
