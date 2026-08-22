-- Stage 8B · The exposed `api` schema and Director account administration
--
-- Exposing `api` through PostgREST decides what is ROUTABLE, not what is PERMITTED. These tests pin
-- that distinction, and the prefix rule that now carries it:
--
--   api.admin_*   `authenticated` Directors. Derives its own actor. May START administrative work.
--   api.staff_*   `authenticated` staff. Derives its own actor AND the roles it allows, from
--                 product.md §4.1 — receiving is entered by a Manager, a Cashier or a Sales
--                 Representative, and none of those is a Director.
--   api.self_*    any `authenticated` user. Derives its own identity and acts only on itself.
--   api.service_* `service_role` only. Takes ids and a worker token, never an identity.
--
-- `staff_` arrived with Stage 10D. It carries exactly the same guarantee as `admin_` — granted to
-- `authenticated`, refused inside the function unless the caller holds an allowed live role, and no
-- actor parameter anywhere — so the three assertions below cover it on the same terms.
create extension if not exists pgtap with schema extensions;

begin;
select plan(28);

create schema if not exists tests;

create or replace function tests.mk_user(p_id uuid) returns void language plpgsql as $$
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          created_at, updated_at)
  values (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          p_id::text || '@test.local', extensions.crypt('x', extensions.gen_salt('bf')),
          now(), now());
end $$;

select tests.mk_user('f0000000-0000-0000-0000-000000000001'::uuid);  -- Director (the only one)
select tests.mk_user('f0000000-0000-0000-0000-000000000002'::uuid);  -- Manager
select tests.mk_user('f0000000-0000-0000-0000-000000000003'::uuid);  -- Cashier

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('f0000000-0000-0000-0000-000000000001', 'Only Director', '+255700000061', true, false),
  ('f0000000-0000-0000-0000-000000000002', 'A Manager',     '+255700000062', true, false),
  ('f0000000-0000-0000-0000-000000000003', 'A Cashier',     '+255700000063', true, false);

insert into public.user_roles (user_id, role) values
  ('f0000000-0000-0000-0000-000000000001', 'director'),
  ('f0000000-0000-0000-0000-000000000002', 'manager'),
  ('f0000000-0000-0000-0000-000000000003', 'cashier');

-- ---------------------------------------------------------------------------
-- The prefix rule, enforced mechanically so a new function cannot land on the wrong side of it
-- ---------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api'
      and p.proname not like 'admin\_%'
      and p.proname not like 'staff\_%'
      and p.proname not like 'self\_%'
      and p.proname not like 'service\_%'),
  '',
  'every api function declares its audience through its name');

select is(
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api' and (p.proname like 'admin\_%' or p.proname like 'staff\_%'
                                 or p.proname like 'self\_%')
      and (not has_function_privilege('authenticated', p.oid, 'execute')
           or has_function_privilege('service_role', p.oid, 'execute')
           or has_function_privilege('anon', p.oid, 'execute'))),
  '',
  'every api.admin_, api.staff_ and api.self_ function is executable by authenticated ALONE');

-- The prefix is a promise about WHO, and it would be worth nothing if a staff_ function let the
-- caller say who they were. Same rule the service_ functions are held to, one row below in spirit:
-- authority is derived from the verified session, never supplied.
select is(
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api'
      and p.proname like 'staff\_%'
      and (pg_get_function_identity_arguments(p.oid) like '%p_user_id%'
           or pg_get_function_identity_arguments(p.oid) like '%p_actor%'
           or pg_get_function_identity_arguments(p.oid) like '%p_role%')),
  '',
  'no api.staff_ function accepts an identity or a role -- both come from the session');

select is(
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api' and p.proname like 'service\_%'
      and (not has_function_privilege('service_role', p.oid, 'execute')
           or has_function_privilege('authenticated', p.oid, 'execute')
           or has_function_privilege('anon', p.oid, 'execute'))),
  '',
  'every api.service_ function is executable by service_role ALONE');

select is(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join pg_roles r on r.oid = p.proowner
    where n.nspname = 'api' and (not p.prosecdef or r.rolname <> 'fv_definer_owner')),
  0,
  'every api function is SECURITY DEFINER owned by the restricted role');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api' and p.proname like '%actor%'),
  0,
  'no api function names an actor in its signature -- authority is derived, never supplied');

-- The forged-attribution defect: a service function that accepted a user id could manufacture
-- audit history for anyone. No service_ function may take a user identity as an argument.
select is(
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api'
      and p.proname like 'service\_%'
      and pg_get_function_identity_arguments(p.oid) like '%p_user_id%'
      -- The first-login pair names a user, but only alongside an operation id that the database
      -- itself issued and binds to that same user; there is nothing to aim.
      and p.proname not like '%first_login%'),
  '',
  'no service_ function takes a bare user identity it could attribute an action to');

-- ---------------------------------------------------------------------------
-- Reachability of the two non-public schemas
-- ---------------------------------------------------------------------------
select ok(has_schema_privilege('service_role', 'api', 'usage'),
          'service_role can reach the api schema');

select ok(not has_schema_privilege('service_role', 'private', 'usage'),
          'service_role cannot reach private at all -- the api functions are definer-owned');

select ok(has_schema_privilege('authenticated', 'api', 'usage'),
          'authenticated can reach the api schema, where only admin_ functions are executable');

-- authenticated needs USAGE on private because RLS policies call private.authorize(). That USAGE
-- must buy exactly three functions and nothing else.
select is(
  (select string_agg(p.proname, ',' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and has_function_privilege('authenticated', p.oid, 'execute')),
  'authorize,current_role_hint,request_uid',
  'authenticated can execute exactly the three read-only helpers in private, and nothing else');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and has_function_privilege('service_role', p.oid, 'execute')),
  0,
  'service_role can execute nothing in private');

-- ---------------------------------------------------------------------------
-- Administrative authority is verified in the database, not only in the app
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select private.set_account_active('f0000000-0000-0000-0000-000000000003',
                                       'f0000000-0000-0000-0000-000000000002', false) $$,
  '42501',
  null,
  'a Manager cannot deactivate an account even through the privileged function');

select is(
  (private.set_account_active('f0000000-0000-0000-0000-000000000001',
                              'f0000000-0000-0000-0000-000000000001', false) ->> 'reason'),
  'cannot_deactivate_self',
  'a Director cannot deactivate themselves -- that is how the last Director is lost');

select is(
  (private.set_account_active('f0000000-0000-0000-0000-000000000003',
                              'f0000000-0000-0000-0000-000000000001', false) ->> 'reason'),
  'changed',
  'a Director deactivates a staff account');

select ok(
  not (select is_active from public.profiles where id = 'f0000000-0000-0000-0000-000000000003'),
  'the account is inactive, which is what denies access -- session revocation is hygiene after it');

select is(
  (select actor_id from public.audit_events
    where action = 'account_deactivated'
      and entity_id = 'f0000000-0000-0000-0000-000000000003'),
  'f0000000-0000-0000-0000-000000000001'::uuid,
  'deactivation names the Director who performed it');

select is(
  (private.set_account_active('f0000000-0000-0000-0000-000000000003',
                              'f0000000-0000-0000-0000-000000000001', true) ->> 'reason'),
  'changed',
  'reactivation is available -- accounts are deactivated, never deleted');

-- ---------------------------------------------------------------------------
-- The Director set may never reach zero. The check runs AFTER the change, so it sees what the
-- transaction is actually about to commit, and it raises rather than returning a soft refusal.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select private.change_user_role('f0000000-0000-0000-0000-000000000001',
                                     'f0000000-0000-0000-0000-000000000001', 'manager') $$,
  'P0001',
  'this change would leave no active Director',
  'the only Director cannot demote themselves out of the Director role');

select is(
  (select role from public.user_roles where user_id = 'f0000000-0000-0000-0000-000000000001'),
  'director'::public.app_role,
  'the refused demotion left the role untouched');

select is(
  (private.change_user_role('f0000000-0000-0000-0000-000000000002',
                            'f0000000-0000-0000-0000-000000000001', 'cashier') ->> 'reason'),
  'changed',
  'a Director changes a staff role');

select is(
  (select role from public.user_roles where user_id = 'f0000000-0000-0000-0000-000000000002'),
  'cashier'::public.app_role,
  'exactly one role remains after the change');

-- ---------------------------------------------------------------------------
-- Phone changes — the phone IS the login identifier
-- ---------------------------------------------------------------------------
select is(
  (private.change_user_phone('f0000000-0000-0000-0000-000000000003',
                             'f0000000-0000-0000-0000-000000000001', '+255700000062') ->> 'reason'),
  'phone_in_use',
  'a phone already in use is refused before Supabase Auth is touched');

select is(
  (private.change_user_phone('f0000000-0000-0000-0000-000000000003',
                             'f0000000-0000-0000-0000-000000000001', '+255700000064') ->> 'previous_phone_e164'),
  '+255700000063',
  'the change returns the previous number, which the server needs to compensate an Auth failure');

select is(
  (select phone_e164 from public.profiles where id = 'f0000000-0000-0000-0000-000000000003'),
  '+255700000064',
  'the login identifier is updated');

select ok(
  (select before_state ->> 'phone_e164' = '+255700000063'
      and after_state  ->> 'phone_e164' = '+255700000064'
     from public.audit_events where action = 'user_phone_changed'),
  'the phone change records both the old and the new identifier');

-- ---------------------------------------------------------------------------
-- Refused route access is recorded (design.md §4.5)
-- ---------------------------------------------------------------------------
-- Identity comes from the request, not from an argument: there is no user parameter to pass.
select set_config('request.jwt.claims',
  json_build_object('sub', 'f0000000-0000-0000-0000-000000000003',
                    'role', 'authenticated')::text, true);

select private.record_own_access_denial('/admin/accounts');

select is(
  (select count(*)::int from public.audit_events
    where action = 'route_access_denied'
      and actor_id = 'f0000000-0000-0000-0000-000000000003'),
  1,
  'a refused route attempt is audited to the session that made it');

select set_config('request.jwt.claims', null, true);
select is(
  (private.record_own_access_denial('/admin/accounts') ->> 'reason'),
  'not_signed_in',
  'with no session there is no attempt to attribute, and nothing is written');

select * from finish();
rollback;
