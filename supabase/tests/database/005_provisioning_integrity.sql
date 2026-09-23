-- Stage 8A hardening · Account provisioning integrity
--
-- Account creation spans Supabase Auth and this database, and no transaction spans both. The job
-- row is the durable coordinator; these tests are about what happens when the process dies between
-- the two systems, and about never creating a second privileged account.
create extension if not exists pgtap with schema extensions;

begin;
select plan(26);

create schema if not exists tests;

create or replace function tests.mk_user(p_id uuid) returns void language plpgsql as $$
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          created_at, updated_at)
  values (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          p_id::text || '@test.local', extensions.crypt('x', extensions.gen_salt('bf')),
          now(), now());
end $$;

select tests.mk_user('e0000000-0000-0000-0000-000000000001'::uuid);  -- Director
select tests.mk_user('e0000000-0000-0000-0000-000000000002'::uuid);  -- Manager
select tests.mk_user('e0000000-0000-0000-0000-0000000000a1'::uuid);  -- Auth user for job 1
select tests.mk_user('e0000000-0000-0000-0000-0000000000a2'::uuid);  -- a different Auth user
select tests.mk_user('e0000000-0000-0000-0000-0000000000a3'::uuid);  -- Auth user for the bootstrap

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password) values
  ('e0000000-0000-0000-0000-000000000001', 'A Director', '+255700000031', true, false),
  ('e0000000-0000-0000-0000-000000000002', 'A Manager',  '+255700000032', true, false);

insert into public.user_roles (user_id, role) values
  ('e0000000-0000-0000-0000-000000000001', 'director'),
  ('e0000000-0000-0000-0000-000000000002', 'manager');

-- ---------------------------------------------------------------------------
-- Only a live Director may provision
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select private.claim_provisioning_job('k-mgr', 'e0000000-0000-0000-0000-000000000002',
                                           'Someone', '+255700000041', 'cashier') $$,
  '42501',
  null,
  'a Manager cannot claim a provisioning job');

-- ---------------------------------------------------------------------------
-- Claim, then resume on the same key. Retrying never makes a second job.
-- ---------------------------------------------------------------------------
select is(
  (private.claim_provisioning_job('k-1', 'e0000000-0000-0000-0000-000000000001',
                                  'New Cashier', '+255700000041', 'cashier') ->> 'reason'),
  'claimed',
  'a Director claims a new provisioning job');

select is(
  (private.claim_provisioning_job('k-1', 'e0000000-0000-0000-0000-000000000001',
                                  'New Cashier', '+255700000041', 'cashier') ->> 'reason'),
  'resumed',
  'the same idempotency key RESUMES the same durable job');

select is(
  (select count(*)::int from public.account_provisioning_jobs where idempotency_key = 'k-1'),
  1,
  'retrying produced exactly one job row');

select is(
  (select attempt_count from public.account_provisioning_jobs where idempotency_key = 'k-1'),
  2,
  'the attempt counter is durable resume state');

select is(
  (private.claim_provisioning_job('k-1', 'e0000000-0000-0000-0000-000000000001',
                                  'New Cashier', '+255700000099', 'cashier') ->> 'reason'),
  'idempotency_key_conflict',
  'the same key with a different target is a conflict, never a resume');

select is(
  (private.claim_provisioning_job('k-dup', 'e0000000-0000-0000-0000-000000000001',
                                  'Clash', '+255700000031', 'cashier') ->> 'reason'),
  'phone_in_use',
  'a phone already in use is refused BEFORE an Auth user is created');

-- ---------------------------------------------------------------------------
-- The Auth call is mutually exclusive: two runs cannot both create an Auth user
-- ---------------------------------------------------------------------------
select is(
  (private.begin_auth_attempt(
     (select id from public.account_provisioning_jobs where idempotency_key = 'k-1')) ->> 'ok'),
  'true',
  'the first run is cleared to call the Auth Admin API');

select is(
  (private.begin_auth_attempt(
     (select id from public.account_provisioning_jobs where idempotency_key = 'k-1')) ->> 'reason'),
  'attempt_in_progress',
  'a concurrent run is REFUSED -- it must adopt any existing Auth user, not create a second');

-- ---------------------------------------------------------------------------
-- Recording the Auth user
-- ---------------------------------------------------------------------------
select is(
  (private.record_provisioning_auth_user(
     (select id from public.account_provisioning_jobs where idempotency_key = 'k-1'),
     'e0000000-0000-0000-0000-0000000000a1') ->> 'reason'),
  'recorded',
  'the Auth user id is recorded and the job advances to auth_created');

select is(
  (select stage from public.account_provisioning_jobs where idempotency_key = 'k-1'),
  'auth_created'::public.provisioning_stage,
  'stage reflects what actually exists in the other system');

select is(
  (private.record_provisioning_auth_user(
     (select id from public.account_provisioning_jobs where idempotency_key = 'k-1'),
     'e0000000-0000-0000-0000-0000000000a2') ->> 'reason'),
  'auth_user_conflict',
  'a second, different Auth user is refused and reported as an orphan to disable');

-- A different job may not adopt an Auth user another job already owns.
select private.claim_provisioning_job('k-2', 'e0000000-0000-0000-0000-000000000001',
                                      'Another', '+255700000042', 'sales_rep');

select is(
  (private.record_provisioning_auth_user(
     (select id from public.account_provisioning_jobs where idempotency_key = 'k-2'),
     'e0000000-0000-0000-0000-0000000000a1') ->> 'reason'),
  'auth_user_claimed_by_other_job',
  'two jobs cannot claim the same Auth user');

-- ---------------------------------------------------------------------------
-- Completion: inactive first, activated last, audited to the Director
-- ---------------------------------------------------------------------------
select is(
  (private.complete_provisioning(
     (select id from public.account_provisioning_jobs where idempotency_key = 'k-1')) ->> 'reason'),
  'completed',
  'provisioning completes');

select ok(
  (select is_active and must_change_password from public.profiles
    where id = 'e0000000-0000-0000-0000-0000000000a1'),
  'the provisioned account is active AND still gated on first login');

select is(
  (select role from public.user_roles where user_id = 'e0000000-0000-0000-0000-0000000000a1'),
  'cashier'::public.app_role,
  'exactly the requested role was assigned');

select is(
  (select actor_id from public.audit_events
    where action = 'account_provisioned'
      and entity_id = 'e0000000-0000-0000-0000-0000000000a1'),
  'e0000000-0000-0000-0000-000000000001'::uuid,
  'provisioning is audited to the Director who requested it');

select is(
  (private.complete_provisioning(
     (select id from public.account_provisioning_jobs where idempotency_key = 'k-1')) ->> 'reason'),
  'already_complete',
  'completion is idempotent');

-- ---------------------------------------------------------------------------
-- Stage cannot lie about what exists
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ update public.account_provisioning_jobs set stage = 'complete'
      where idempotency_key = 'k-2' $$,
  '23514',
  null,
  'a job cannot reach complete without an Auth user and a profile');

select private.fail_provisioning(
  (select id from public.account_provisioning_jobs where idempotency_key = 'k-2'), 'auth_api_error');

select throws_ok(
  $$ update public.account_provisioning_jobs
        set profile_id = 'e0000000-0000-0000-0000-000000000001'
      where idempotency_key = 'k-2' $$,
  '23514',
  null,
  'a profile id that disagrees with its Auth user id is refused');

select throws_ok(
  $$ update public.account_provisioning_jobs
        set auth_user_id = 'e0000000-0000-0000-0000-0000000000a2'
      where idempotency_key = 'k-1' $$,
  '23000',
  null,
  'a recorded Auth user id is immutable -- recovery depends on it');

select throws_ok(
  $$ update public.account_provisioning_jobs
        set error_detail = 'failed with temporary password Hunter2-Hunter2'
      where idempotency_key = 'k-2' $$,
  '23514',
  null,
  'error_detail accepts a CODE only, so no caller can park a credential in it');

-- ---------------------------------------------------------------------------
-- BOOTSTRAP: one job for the lifetime of the database, even after it fails
--
-- Bootstrap is guarded on "no Director exists yet", so the fixture Director's role is removed
-- first. Everything above has already run.
-- ---------------------------------------------------------------------------
delete from public.user_roles where role = 'director';

select private.claim_provisioning_job('k-boot', null, 'First Director', '+255700000051',
                                      'director', true);

select private.record_provisioning_auth_user(
  (select id from public.account_provisioning_jobs where is_bootstrap),
  'e0000000-0000-0000-0000-0000000000a3');

select private.fail_provisioning(
  (select id from public.account_provisioning_jobs where is_bootstrap), 'profile_insert_failed');

select is(
  (private.claim_provisioning_job('k-boot-retry', null, 'First Director', '+255700000051',
                                  'director', true) -> 'job' ->> 'stage'),
  'auth_created',
  'a FAILED bootstrap resumes at the stage its recorded Auth user proves -- it never re-creates one');

select is(
  (select count(*)::int from public.account_provisioning_jobs where is_bootstrap),
  1,
  'there is exactly one bootstrap job, and a failure does not permit a second');

select throws_ok(
  $$ insert into public.account_provisioning_jobs
       (idempotency_key, target_full_name, target_phone_e164, target_role, is_bootstrap)
     values ('k-boot-2', 'Second Director', '+255700000052', 'director', true) $$,
  '23505',
  null,
  'a second bootstrap job cannot be inserted at all');

-- ---------------------------------------------------------------------------
-- No temporary password is persisted anywhere
-- ---------------------------------------------------------------------------
-- A deliberately paranoid sweep. Exemptions are named one at a time, with a reason, so that adding
-- a genuinely secret-bearing column has to be an argued decision rather than a silent one.
--
--   profiles.must_change_password   a boolean flag, not a password
--   admin_commands.worker_token     a random claim marker. It authenticates nothing and grants no
--                                   access: holding it only lets a worker finish the one command it
--                                   already claimed, and the row is readable by Directors anyway.
--   report_runs.claim_token         the same kind of marker, for the same kind of reason (issue
--                                   #19). It is a fencing token for one scheduled report run: the
--                                   only things that consult it are `private.complete_report_run`
--                                   and `private.fail_report_run`, which no Data API role may
--                                   execute, so holding it opens nothing and proves nobody's
--                                   identity.
select is(
  (select coalesce(string_agg(table_name || '.' || column_name, ', '), '')
     from information_schema.columns
    where table_schema = 'public'
      and column_name ~ 'password|secret|token|credential'
      and not (table_name = 'profiles'       and column_name = 'must_change_password')
      and not (table_name = 'admin_commands' and column_name = 'worker_token')
      and not (table_name = 'report_runs'    and column_name = 'claim_token')),
  '',
  'no column in public stores a password, secret, token, or credential');

select * from finish();
rollback;
