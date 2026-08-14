-- Stage 8A · Live authorization: gate, deactivation, role removal, stale claim
create extension if not exists pgtap with schema extensions;

begin;
select plan(21);

-- ---------------------------------------------------------------------------
-- Fixtures. Three users covering: ready, gated, and role-less.
-- ---------------------------------------------------------------------------
create schema if not exists tests;

create or replace function tests.mk_user(p_id uuid, p_phone text, p_pw text)
returns void language plpgsql as $$
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          created_at, updated_at)
  values (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          p_id::text || '@test.local', extensions.crypt(p_pw, extensions.gen_salt('bf')),
          now(), now());
end $$;

select lives_ok(
  $$ select tests.mk_user('11111111-1111-1111-1111-111111111111'::uuid, '+255700000001', 'temp-A') $$,
  'auth user: manager');
select lives_ok(
  $$ select tests.mk_user('22222222-2222-2222-2222-222222222222'::uuid, '+255700000002', 'temp-B') $$,
  'auth user: gated');
select lives_ok(
  $$ select tests.mk_user('33333333-3333-3333-3333-333333333333'::uuid, '+255700000003', 'temp-C') $$,
  'auth user: role-less');

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password)
values ('11111111-1111-1111-1111-111111111111', 'Ready Manager',  '+255700000001', true,  false),
       ('22222222-2222-2222-2222-222222222222', 'Gated Manager',  '+255700000002', true,  true),
       ('33333333-3333-3333-3333-333333333333', 'No Role User',   '+255700000003', true,  false);

insert into public.user_roles (user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'manager'),
  ('22222222-2222-2222-2222-222222222222', 'manager');
-- user 3 deliberately has no role.

create or replace function tests.act_as(p_id uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_id::text, 'role', 'authenticated')::text, true);
end $$;

create or replace function tests.act_as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', null, true);
end $$;

-- ---------------------------------------------------------------------------
-- authorize(): the happy path
-- ---------------------------------------------------------------------------
select tests.act_as('11111111-1111-1111-1111-111111111111');
select ok(private.authorize(array['manager']::public.app_role[]),
          'active manager, gate cleared, correct role -> authorized');
select ok(not private.authorize(array['director']::public.app_role[]),
          'manager is not authorized as director');

-- ---------------------------------------------------------------------------
-- FIRST-LOGIN GATE at the security boundary
-- ---------------------------------------------------------------------------
select tests.act_as('22222222-2222-2222-2222-222222222222');
select ok(not private.authorize(array['manager']::public.app_role[]),
          'GATED user with valid session, active profile and valid role -> NOT authorized');
select ok(not private.authorize(array['manager','director','cashier','sales_rep']::public.app_role[]),
          'gated user is authorized for no role at all');

-- ---------------------------------------------------------------------------
-- No role -> zero authority
-- ---------------------------------------------------------------------------
select tests.act_as('33333333-3333-3333-3333-333333333333');
select ok(not private.authorize(array['manager','director','cashier','sales_rep']::public.app_role[]),
          'user with no user_roles row is authorized for nothing');

-- ---------------------------------------------------------------------------
-- Unauthenticated
-- ---------------------------------------------------------------------------
select tests.act_as_anon();
select ok(not private.authorize(array['manager']::public.app_role[]),
          'no auth.uid() -> not authorized');

-- ---------------------------------------------------------------------------
-- DEACTIVATION denies immediately, with the session unchanged
-- ---------------------------------------------------------------------------
select tests.act_as('11111111-1111-1111-1111-111111111111');
select ok(private.authorize(array['manager']::public.app_role[]), 'authorized before deactivation');

update public.profiles set is_active = false where id = '11111111-1111-1111-1111-111111111111';

select ok(not private.authorize(array['manager']::public.app_role[]),
          'DEACTIVATION denies immediately -- same session, no token refresh, no revocation');

update public.profiles set is_active = true where id = '11111111-1111-1111-1111-111111111111';
select ok(private.authorize(array['manager']::public.app_role[]), 'reactivation restores authority');

-- ---------------------------------------------------------------------------
-- ROLE REMOVAL denies immediately
-- ---------------------------------------------------------------------------
delete from public.user_roles where user_id = '11111111-1111-1111-1111-111111111111';
select ok(not private.authorize(array['manager']::public.app_role[]),
          'ROLE REMOVAL denies immediately on the same session');

insert into public.user_roles (user_id, role)
values ('11111111-1111-1111-1111-111111111111', 'manager');

-- ---------------------------------------------------------------------------
-- STALE / TAMPERED CLAIM buys nothing: no policy or predicate reads the claim
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims',
  json_build_object('sub', '33333333-3333-3333-3333-333333333333',
                    'role', 'authenticated',
                    'user_role', 'director')::text, true);
select ok(not private.authorize(array['director']::public.app_role[]),
          'FORGED user_role=director claim grants nothing -- authorize reads live state');

select set_config('request.jwt.claims',
  json_build_object('sub', '22222222-2222-2222-2222-222222222222',
                    'role', 'authenticated',
                    'user_role', 'director')::text, true);
select ok(not private.authorize(array['director','manager']::public.app_role[]),
          'gated user with an elevated stale claim is still denied');

-- ---------------------------------------------------------------------------
-- No RLS policy anywhere may consult the JWT role claim
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int
     from pg_policies
    where schemaname = 'public'
      and (coalesce(qual,'') || coalesce(with_check,'')) like '%user_role%'),
  0,
  'no RLS policy references the user_role JWT claim');

-- ---------------------------------------------------------------------------
-- Predicate hardening
-- ---------------------------------------------------------------------------
select ok(
  (select 'search_path=""' = any(p.proconfig) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'authorize'),
  'authorize() pins search_path to empty');

select is(
  (select r.rolname from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join pg_roles r on r.oid = p.proowner
    where n.nspname = 'private' and p.proname = 'authorize'),
  'fv_definer_owner',
  'authorize() is owned by the restricted NOLOGIN role, not postgres');

select is(
  (select p.provolatile from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'authorize'),
  's',
  'authorize() is STABLE -- side-effect free, safe per-row under RLS');

select ok(
  not has_function_privilege('anon', 'private.authorize(public.app_role[])', 'execute'),
  'anon cannot execute authorize()');

select ok(
  (select rolcanlogin = false from pg_roles where rolname = 'fv_definer_owner'),
  'fv_definer_owner is NOLOGIN');

select * from finish();
rollback;
