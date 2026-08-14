-- Stage 8A hardening · The service-only `api` bridge
--
-- THE DEFECT THIS FIXES
--   `private` is not exposed through PostgREST, and must not be. But nothing else was exposed
--   either, so a real secret-key HTTP call to the gate-completion function returned
--   PGRST106 / HTTP 406 — "the schema must be added to 'db-schemas'". The database-level proof was
--   sound and the operation was unreachable: pgTAP calls functions over a direct PostgreSQL
--   session, which is not the path the application uses.
--
-- THE FIX
--   `api` is added to the exposed schemas in config.toml, and holds thin SECURITY INVOKER wrappers
--   over the private implementations. `private` stays unexposed.
--
-- WHY EXPOSING `api` IS NOT A WEAKENING
--   Exposure decides what PostgREST will ROUTE to, not who may run it. Every function below is
--   revoked from PUBLIC, `anon`, and `authenticated`, and granted to `service_role` alone. A
--   client presenting a publishable key or a user session is refused by PostgreSQL, at the
--   privilege layer, before any function body runs. The wrappers are SECURITY INVOKER, so they add
--   no privilege of their own: they cannot be a back door into `private`, because the caller's own
--   rights are what execute them.

begin;

-- The server's role needs to reach both schemas. USAGE alone grants nothing: EXECUTE is still
-- required per function, and default privileges revoke it from PUBLIC on everything created here.
grant usage on schema api     to service_role;
grant usage on schema private to service_role;

alter default privileges in schema api revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- First-login gate. The only completion path in the system.
-- ---------------------------------------------------------------------------
create or replace function api.service_complete_first_login(
  p_user_id        uuid,
  p_correlation_id uuid default null
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.clear_first_login_gate(p_user_id, p_correlation_id);
$$;

comment on function api.service_complete_first_login(uuid, uuid) is
  'Called by the server ONLY after Supabase Auth has confirmed the password change for this same '
  'user. service_role only. There is no client-callable equivalent and there must never be one.';

-- ---------------------------------------------------------------------------
-- Director-initiated password reset: re-arms the gate, attributed to that Director.
-- ---------------------------------------------------------------------------
create or replace function api.service_reset_password_gate(
  p_target_user_id uuid,
  p_actor_id       uuid,
  p_correlation_id uuid default null
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.arm_first_login_gate(p_target_user_id, p_actor_id, p_correlation_id);
$$;

comment on function api.service_reset_password_gate(uuid, uuid, uuid) is
  'p_actor_id is REQUIRED and is verified live as a Director inside private.arm_first_login_gate. '
  'A reset is never recorded as anonymous system activity.';

-- ---------------------------------------------------------------------------
-- Provisioning orchestration, one call per cross-system stage.
-- ---------------------------------------------------------------------------
create or replace function api.service_director_exists()
returns boolean
language sql
security invoker
set search_path = ''
as $$
  select private.director_exists();
$$;

create or replace function api.service_claim_provisioning_job(
  p_idempotency_key text,
  p_requested_by    uuid,
  p_full_name       text,
  p_phone_e164      text,
  p_role            public.app_role,
  p_is_bootstrap    boolean default false
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.claim_provisioning_job(
           p_idempotency_key, p_requested_by, p_full_name, p_phone_e164, p_role, p_is_bootstrap);
$$;

create or replace function api.service_begin_auth_attempt(p_job_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.begin_auth_attempt(p_job_id);
$$;

comment on function api.service_begin_auth_attempt(uuid) is
  'Mutual exclusion around the Auth Admin call. Exactly one caller is told to proceed; a caller '
  'refused with attempt_in_progress must ADOPT any existing Auth user by identifier, never create.';

create or replace function api.service_record_auth_user(p_job_id uuid, p_auth_user_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.record_provisioning_auth_user(p_job_id, p_auth_user_id);
$$;

create or replace function api.service_complete_provisioning(p_job_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.complete_provisioning(p_job_id);
$$;

create or replace function api.service_fail_provisioning(p_job_id uuid, p_error_code text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.fail_provisioning(p_job_id, p_error_code);
$$;

-- ---------------------------------------------------------------------------
-- Account administration
-- ---------------------------------------------------------------------------
create or replace function api.service_set_account_active(
  p_target_user_id uuid,
  p_actor_id       uuid,
  p_is_active      boolean
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.set_account_active(p_target_user_id, p_actor_id, p_is_active);
$$;

create or replace function api.service_change_user_role(
  p_target_user_id uuid,
  p_actor_id       uuid,
  p_role           public.app_role
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.change_user_role(p_target_user_id, p_actor_id, p_role);
$$;

create or replace function api.service_change_user_phone(
  p_target_user_id uuid,
  p_actor_id       uuid,
  p_phone_e164     text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.change_user_phone(p_target_user_id, p_actor_id, p_phone_e164);
$$;

create or replace function api.service_record_access_denial(p_user_id uuid, p_path text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.record_access_denial(p_user_id, p_path);
$$;

-- ---------------------------------------------------------------------------
-- One grant policy for the whole schema, stated once and provable:
-- nothing for PUBLIC, anon, or authenticated; execution for service_role only.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema api from public, anon, authenticated;
grant  execute on all functions in schema api to service_role;

commit;
