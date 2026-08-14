-- Stage 8A · Structural guarantees: RLS coverage, grant boundaries, Auth hook
create extension if not exists pgtap with schema extensions;

begin;
select plan(18);

-- ---------------------------------------------------------------------------
-- RLS is enabled on EVERY table in public. Guards the likeliest future mistake:
-- adding a table and forgetting.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int
     from pg_tables t
     join pg_class c on c.relname = t.tablename
     join pg_namespace n on n.oid = c.relnamespace and n.nspname = t.schemaname
    where t.schemaname = 'public' and not c.relrowsecurity),
  0,
  'every table in public has RLS enabled');

-- ---------------------------------------------------------------------------
-- No blanket write grants to authenticated beyond the documented allowlist.
-- ---------------------------------------------------------------------------
-- A column-level grant creates NO table-level privilege row, so the correct
-- expectation here is empty: authenticated holds no whole-table write anywhere.
select is(
  (select coalesce(string_agg(distinct table_name || ':' || privilege_type, ', '), '')
     from information_schema.table_privileges
    where grantee = 'authenticated'
      and table_schema = 'public'
      and privilege_type in ('INSERT','UPDATE','DELETE')),
  '',
  'authenticated holds no table-wide INSERT/UPDATE/DELETE on any public table');

-- ...and that UPDATE is column-limited to locale.
select is(
  (select coalesce(string_agg(column_name, ',' order by column_name), '')
     from information_schema.column_privileges
    where grantee = 'authenticated' and table_schema = 'public'
      and table_name = 'profiles' and privilege_type = 'UPDATE'),
  'locale',
  'profiles UPDATE is column-limited to locale -- not is_active, not the gate, not the fingerprint');

-- ---------------------------------------------------------------------------
-- Approval and audit surfaces are read-only to clients
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from information_schema.table_privileges
    where grantee = 'authenticated' and table_schema = 'public'
      and table_name in ('approval_requests','approval_decisions','audit_events',
                         'user_roles','account_provisioning_jobs')
      and privilege_type in ('INSERT','UPDATE','DELETE')),
  0,
  'approval, audit, roles and provisioning tables grant no write to authenticated');

select is(
  (select count(*)::int from information_schema.table_privileges
    where grantee = 'authenticated' and table_schema = 'public'
      and table_name = 'idempotency_keys'),
  0,
  'idempotency_keys grants nothing at all to authenticated');

-- ---------------------------------------------------------------------------
-- anon reaches nothing
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from information_schema.table_privileges
    where grantee = 'anon' and table_schema = 'public'),
  0,
  'anon holds no privilege on any public table');

-- ---------------------------------------------------------------------------
-- The secret key's entire surface is the api schema.
--
-- service_role carries BYPASSRLS, so policies mean nothing to it and GRANTs are the only control
-- left. It holds NOTHING on any public table — not SELECT, not TRUNCATE — so a leaked secret key
-- can only do what the named api functions do, each of which checks live authority and audits.
-- ---------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(distinct table_name || ':' || privilege_type, ', '), '')
     from information_schema.table_privileges
    where grantee = 'service_role' and table_schema = 'public'),
  '',
  'service_role holds NO privilege of any kind on any public table');

select ok(not has_schema_privilege('anon', 'api', 'usage'),     'anon cannot use schema api');
select ok(not has_schema_privilege('anon', 'private', 'usage'), 'anon cannot use schema private');

-- ---------------------------------------------------------------------------
-- private is NOT exposed through the Data API; api holds functions only
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_tables where schemaname = 'api'),
  0,
  'the api schema contains no tables -- functions only');

select is(
  (select count(*)::int from pg_views where schemaname = 'api'),
  0,
  'the api schema contains no views');

-- ---------------------------------------------------------------------------
-- Every SECURITY DEFINER function is hardened and owned by the restricted role
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join pg_roles r on r.oid = p.proowner
    where n.nspname in ('private','api')
      and p.prosecdef
      and r.rolname <> 'fv_definer_owner'),
  0,
  'no SECURITY DEFINER function is owned by anything but fv_definer_owner');

select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('private','api')
      and p.prosecdef
      and (p.proconfig is null or not ('search_path=' || '""') = any(p.proconfig))),
  0,
  'every SECURITY DEFINER function pins search_path to empty');

-- ---------------------------------------------------------------------------
-- PUBLIC holds EXECUTE on nothing in api or private.
--
-- This is the structural guard for a proven silent failure: ALTER DEFAULT PRIVILEGES ... REVOKE
-- EXECUTE ON FUNCTIONS FROM PUBLIC writes no pg_default_acl row on this database, so a function
-- created without an explicit REVOKE keeps `proacl = NULL` — the built-in default, in which PUBLIC
-- holds EXECUTE. `proacl IS NULL` is therefore a failure, not a neutral state.
-- ---------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(n.nspname || '.' || p.proname, ', ' order by p.proname), '')
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('api','private')
      and (p.proacl is null
           or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))),
  '',
  'no function in api or private leaves EXECUTE with PUBLIC');

-- ---------------------------------------------------------------------------
-- Auth hook: ONE privilege model. Owner holds table rights; caller holds EXECUTE.
-- ---------------------------------------------------------------------------
select ok(
  has_function_privilege('supabase_auth_admin',
                         'private.custom_access_token_hook(jsonb)', 'execute'),
  'supabase_auth_admin can execute the Auth hook');

select ok(
  not has_function_privilege('authenticated',
                             'private.custom_access_token_hook(jsonb)', 'execute'),
  'authenticated cannot execute the Auth hook');

select ok(
  not has_function_privilege('anon',
                             'private.custom_access_token_hook(jsonb)', 'execute'),
  'anon cannot execute the Auth hook');

-- The owner reads user_roles; supabase_auth_admin gets NO table grant. That is
-- the single-model boundary: privileges with the owner, execution with the caller.
select ok(
  has_table_privilege('fv_definer_owner', 'public.user_roles', 'select')
  and not has_table_privilege('supabase_auth_admin', 'public.user_roles', 'select'),
  'hook privilege model is coherent: owner reads the table, caller only executes');

select * from finish();
rollback;
