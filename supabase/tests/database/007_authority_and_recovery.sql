-- Stage 8B corrective · Actor derivation, the Director-set invariant, and first-login recovery
--
-- These are the invariants the review found missing. Each one is asserted where it is enforced —
-- in the database — so it holds whatever the application does.
create extension if not exists pgtap with schema extensions;

begin;
select plan(20);

create schema if not exists tests;

create or replace function tests.mk_user(p_id uuid) returns void language plpgsql as $$
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          created_at, updated_at)
  values (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          p_id::text || '@test.local', extensions.crypt('x', extensions.gen_salt('bf')),
          now(), now());
end $$;

create or replace function tests.act_as(p_id uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_id::text, 'role', 'authenticated')::text, true);
end $$;

create or replace function tests.act_as_nobody() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', null, true);
end $$;

select tests.mk_user('a1000000-0000-0000-0000-000000000001'::uuid);  -- Director one
select tests.mk_user('a1000000-0000-0000-0000-000000000002'::uuid);  -- Director two
select tests.mk_user('a1000000-0000-0000-0000-000000000003'::uuid);  -- Manager
select tests.mk_user('a1000000-0000-0000-0000-000000000004'::uuid);  -- gated Director
select tests.mk_user('a1000000-0000-0000-0000-000000000005'::uuid);  -- staff target

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('a1000000-0000-0000-0000-000000000001', 'Director One',   '+255700000071', true,  false),
  ('a1000000-0000-0000-0000-000000000002', 'Director Two',   '+255700000072', true,  false),
  ('a1000000-0000-0000-0000-000000000003', 'A Manager',      '+255700000073', true,  false),
  ('a1000000-0000-0000-0000-000000000004', 'Gated Director', '+255700000074', true,  true),
  ('a1000000-0000-0000-0000-000000000005', 'Staff Target',   '+255700000075', true,  true);

insert into public.user_roles (user_id, role) values
  ('a1000000-0000-0000-0000-000000000001', 'director'),
  ('a1000000-0000-0000-0000-000000000002', 'director'),
  ('a1000000-0000-0000-0000-000000000003', 'manager'),
  ('a1000000-0000-0000-0000-000000000004', 'director'),
  ('a1000000-0000-0000-0000-000000000005', 'cashier');

-- ---------------------------------------------------------------------------
-- The acting Director is DERIVED from the session, and there is no way to name one
-- ---------------------------------------------------------------------------
select tests.act_as('a1000000-0000-0000-0000-000000000001');
select is(private.acting_director(), 'a1000000-0000-0000-0000-000000000001'::uuid,
          'the actor is taken from the verified JWT of the caller');

select tests.act_as_nobody();
select throws_ok(
  $$ select private.acting_director() $$,
  '42501',
  null,
  'no session means no administrative authority, whatever the caller holds');

select tests.act_as('a1000000-0000-0000-0000-000000000003');
select throws_ok(
  $$ select private.acting_director() $$,
  '42501',
  null,
  'a Manager session cannot act as a Director');

select tests.act_as('a1000000-0000-0000-0000-000000000004');
select throws_ok(
  $$ select private.acting_director() $$,
  '42501',
  null,
  'a Director still behind the first-login gate holds no administrative authority');

select tests.act_as('a1000000-0000-0000-0000-000000000005');
select throws_ok(
  $$ select private.acting_director() $$,
  '42501',
  null,
  'a Cashier session cannot act as a Director');

-- A deactivated Director's session survives; their authority does not.
update public.profiles set is_active = false where id = 'a1000000-0000-0000-0000-000000000002';
select tests.act_as('a1000000-0000-0000-0000-000000000002');
select throws_ok(
  $$ select private.acting_director() $$,
  '42501',
  null,
  'a deactivated Director loses authority on the same session, with no token refresh');
update public.profiles set is_active = true where id = 'a1000000-0000-0000-0000-000000000002';

-- ---------------------------------------------------------------------------
-- The Director set never reaches zero
-- ---------------------------------------------------------------------------
select tests.act_as('a1000000-0000-0000-0000-000000000001');

select is(
  (private.change_user_role('a1000000-0000-0000-0000-000000000002',
                            'a1000000-0000-0000-0000-000000000001', 'manager') ->> 'reason'),
  'changed',
  'with two Directors, demoting one is permitted');

-- The gated Director still holds an active Director ROW, so the invariant counts them and this is
-- permitted: the actor remains.
select is(
  (private.change_user_role('a1000000-0000-0000-0000-000000000004',
                            'a1000000-0000-0000-0000-000000000001', 'cashier') ->> 'reason'),
  'changed',
  'demoting the last other Director is permitted while the actor is still one');

-- Now the actor is the only Director left, and demoting themselves would empty the set.
select throws_ok(
  $$ select private.change_user_role('a1000000-0000-0000-0000-000000000001',
                                     'a1000000-0000-0000-0000-000000000001', 'manager') $$,
  'P0001',
  'this change would leave no active Director',
  'the invariant is checked after the change, so self-demotion cannot slip through');

select is(
  (select count(*)::int
     from public.user_roles r join public.profiles p on p.id = r.user_id
    where r.role = 'director' and p.is_active),
  1,
  'exactly one Director survives -- the refused self-demotion left the role untouched');

select is(
  (private.set_account_active('a1000000-0000-0000-0000-000000000001',
                              'a1000000-0000-0000-0000-000000000001', false) ->> 'reason'),
  'cannot_deactivate_self',
  'self-deactivation is refused by name, so the message is useful');

-- ---------------------------------------------------------------------------
-- First-login recovery: the evidence, and what it is worth
-- ---------------------------------------------------------------------------
select is(
  (private.begin_first_login('a1000000-0000-0000-0000-000000000005') ->> 'reason'),
  'ready',
  'an operation opens for a gated user');

select is(
  (select count(*)::int from public.first_login_operations
    where user_id = 'a1000000-0000-0000-0000-000000000005'
      and stage in ('pending', 'auth_changed')),
  1,
  'a second attempt reuses the same live operation rather than opening another');

select is(
  (private.begin_first_login('a1000000-0000-0000-0000-000000000005') -> 'operation' ->> 'attempt_count'),
  '2',
  'the attempt counter is durable recovery state');

do $do$
declare v_op uuid;
begin
  select id into v_op from public.first_login_operations
   where user_id = 'a1000000-0000-0000-0000-000000000005' and stage = 'pending';
  perform private.record_first_login_password_changed(v_op, 'a1000000-0000-0000-0000-000000000005', 'pgtap-evidence');
end
$do$;

select is(
  (select stage::text from public.first_login_operations
    where user_id = 'a1000000-0000-0000-0000-000000000005'),
  'auth_changed',
  'the observed Auth change is recorded BEFORE the gate is touched');

-- THE recovery: a retry finds the recorded change and needs no password at all.
select is(
  (private.begin_first_login('a1000000-0000-0000-0000-000000000005') -> 'operation' ->> 'stage'),
  'auth_changed',
  'a retry after a failed gate clear sees the recorded change and skips Auth entirely');

select is(
  (
    select private.clear_first_login_gate('a1000000-0000-0000-0000-000000000005', o.id) ->> 'reason'
    from public.first_login_operations o
    where o.user_id = 'a1000000-0000-0000-0000-000000000005' and o.stage = 'auth_changed'
  ),
  'completed',
  'the retry completes without changing the password again');

select ok(
  not (select must_change_password from public.profiles
        where id = 'a1000000-0000-0000-0000-000000000005'),
  'the gate is cleared');

-- An operation belonging to somebody else is not evidence about this user.
select tests.mk_user('a1000000-0000-0000-0000-000000000006'::uuid);
insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password)
values ('a1000000-0000-0000-0000-000000000006', 'Another Gated', '+255700000076', true, true);
insert into public.user_roles (user_id, role)
values ('a1000000-0000-0000-0000-000000000006', 'cashier');

select is(
  (
    select private.clear_first_login_gate('a1000000-0000-0000-0000-000000000006', o.id) ->> 'reason'
    from public.first_login_operations o
    where o.user_id = 'a1000000-0000-0000-0000-000000000005'
    limit 1
  ),
  'no_operation',
  'one user cannot complete their gate with another user''s operation');

select ok(
  (select must_change_password from public.profiles
    where id = 'a1000000-0000-0000-0000-000000000006'),
  'the other user stays gated');

select * from finish();
rollback;
