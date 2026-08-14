-- Stage 8B corrective · The exposed API surface, rebuilt around who may START work
--
--   api.admin_*    `authenticated` ONLY. SECURITY DEFINER. Derives its actor from the verified JWT
--                  with private.acting_director(). Takes no actor parameter, so there is nothing to
--                  forge. These are the only functions that may BEGIN an administrative change.
--
--   api.service_*  `service_role` ONLY. SECURITY DEFINER, same restricted owner. Takes ids — a job
--                  id, a command id, an operation id — and never an actor. These may only CONTINUE
--                  work that an authenticated Director already began, plus the one genuinely
--                  actor-less operation in the system: first-Director bootstrap.
--
-- Test 006 asserts the prefix rule mechanically, so a future function cannot quietly land on the
-- wrong side of it.

begin;

-- `api` now holds SECURITY DEFINER functions, and a function's owner must hold CREATE on the schema
-- that contains it or ALTER FUNCTION … OWNER TO is refused. Migration 000100 granted this on
-- `private` only, because `api` held nothing but invoker wrappers at the time.
--
-- The move away from invoker wrappers is deliberate. An invoker wrapper runs with the CALLER's
-- rights, so `service_role` needed EXECUTE on the private implementations and USAGE on `private` for
-- the wrapper to work at all. Owning them by fv_definer_owner removes that need, and `private`
-- becomes unreachable to the secret key entirely.
grant usage, create on schema api to fv_definer_owner;

-- ---------------------------------------------------------------------------
-- Withdraw the functions that accepted a supplied actor
-- ---------------------------------------------------------------------------
drop function if exists api.service_set_account_active(uuid, uuid, boolean);
drop function if exists api.service_change_user_role(uuid, uuid, public.app_role);
drop function if exists api.service_change_user_phone(uuid, uuid, text);
drop function if exists api.service_reset_password_gate(uuid, uuid, uuid);
drop function if exists api.service_claim_provisioning_job(text, uuid, text, text, public.app_role, boolean);
drop function if exists api.service_complete_first_login(uuid, uuid);

-- ---------------------------------------------------------------------------
-- admin_* — issued by an authenticated Director
-- ---------------------------------------------------------------------------
create or replace function api.admin_set_account_active(
  p_target_user_id uuid,
  p_is_active      boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.set_account_active(p_target_user_id, private.acting_director(), p_is_active);
end;
$$;

alter function api.admin_set_account_active(uuid, boolean) owner to fv_definer_owner;

create or replace function api.admin_change_user_role(
  p_target_user_id uuid,
  p_role           public.app_role
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.change_user_role(p_target_user_id, private.acting_director(), p_role);
end;
$$;

alter function api.admin_change_user_role(uuid, public.app_role) owner to fv_definer_owner;

/**
 * Director-mediated password reset.
 *
 * The gate is armed HERE, inside the authenticated request, before the server holds any new
 * credential. If everything after this point fails, the target is gated with their old password —
 * blocked, and the Director simply retries.
 */
create or replace function api.admin_request_password_reset(
  p_target_user_id  uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.acting_director();
  v_cmd   public.admin_commands%rowtype;
  v_armed jsonb;
begin
  select * into v_cmd from public.admin_commands
   where idempotency_key = p_idempotency_key for update;

  if found then
    if v_cmd.kind <> 'password_reset' or v_cmd.target_user_id <> p_target_user_id then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    update public.admin_commands
       set attempt_count = attempt_count + 1, updated_at = now()
     where id = v_cmd.id returning * into v_cmd;
    return jsonb_build_object('ok', true, 'reason', 'resumed', 'command', to_jsonb(v_cmd));
  end if;

  if not exists (select 1 from public.profiles where id = p_target_user_id) then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;

  v_armed := private.arm_first_login_gate_by_director(p_target_user_id, v_actor);
  if not coalesce((v_armed ->> 'ok')::boolean, false) then
    return v_armed;
  end if;

  insert into public.admin_commands (
    kind, idempotency_key, actor_id, actor_role, target_user_id, payload, stage
  )
  values (
    'password_reset', p_idempotency_key, v_actor, private.live_role_of(v_actor), p_target_user_id,
    jsonb_build_object('correlation_id', v_armed ->> 'correlation_id'), 'db_applied'
  )
  returning * into v_cmd;

  return jsonb_build_object('ok', true, 'reason', 'issued', 'command', to_jsonb(v_cmd));
end;
$$;

alter function api.admin_request_password_reset(uuid, text) owner to fv_definer_owner;

/**
 * Phone change — the login identifier.
 *
 * The database is claimed first, because uniqueness is the contended resource, and the command row
 * records the previous number so the change can be completed or reverted after a crash.
 */
create or replace function api.admin_request_phone_change(
  p_target_user_id  uuid,
  p_phone_e164      text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := private.acting_director();
  v_cmd    public.admin_commands%rowtype;
  v_result jsonb;
begin
  select * into v_cmd from public.admin_commands
   where idempotency_key = p_idempotency_key for update;

  if found then
    if v_cmd.kind <> 'phone_change' or v_cmd.target_user_id <> p_target_user_id then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;
    update public.admin_commands
       set attempt_count = attempt_count + 1, updated_at = now()
     where id = v_cmd.id returning * into v_cmd;
    return jsonb_build_object('ok', true, 'reason', 'resumed', 'command', to_jsonb(v_cmd));
  end if;

  v_result := private.change_user_phone(p_target_user_id, v_actor, p_phone_e164);
  if not coalesce((v_result ->> 'ok')::boolean, false) then
    return v_result;
  end if;

  if v_result ->> 'reason' = 'unchanged' then
    return jsonb_build_object('ok', true, 'reason', 'unchanged');
  end if;

  insert into public.admin_commands (
    kind, idempotency_key, actor_id, actor_role, target_user_id, payload, stage
  )
  values (
    'phone_change', p_idempotency_key, v_actor, private.live_role_of(v_actor), p_target_user_id,
    jsonb_build_object(
      'previous_phone_e164', v_result ->> 'previous_phone_e164',
      'phone_e164', p_phone_e164,
      'correlation_id', v_result ->> 'correlation_id'
    ),
    'db_applied'
  )
  returning * into v_cmd;

  return jsonb_build_object('ok', true, 'reason', 'issued', 'command', to_jsonb(v_cmd));
end;
$$;

alter function api.admin_request_phone_change(uuid, text, text) owner to fv_definer_owner;

create or replace function api.admin_request_account_provisioning(
  p_idempotency_key text,
  p_full_name       text,
  p_phone_e164      text,
  p_role            public.app_role
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.claim_provisioning_job(
           p_idempotency_key, private.acting_director(), p_full_name, p_phone_e164, p_role, false);
end;
$$;

alter function api.admin_request_account_provisioning(text, text, text, public.app_role)
  owner to fv_definer_owner;

-- ---------------------------------------------------------------------------
-- service_* — continuation only, addressed by id
-- ---------------------------------------------------------------------------
create or replace function api.service_begin_first_login(p_user_id uuid)
returns jsonb language sql security definer set search_path = ''
as $$ select private.begin_first_login(p_user_id); $$;

create or replace function api.service_record_first_login_password_changed(
  p_operation_id uuid,
  p_user_id      uuid
)
returns jsonb language sql security definer set search_path = ''
as $$ select private.record_first_login_password_changed(p_operation_id, p_user_id); $$;

create or replace function api.service_complete_first_login(
  p_user_id        uuid,
  p_operation_id   uuid,
  p_correlation_id uuid default null
)
returns jsonb language sql security definer set search_path = ''
as $$ select private.clear_first_login_gate(p_user_id, p_operation_id, p_correlation_id); $$;

comment on function api.service_complete_first_login(uuid, uuid, uuid) is
  'Clears the gate ONLY for an operation that already recorded an observed Auth password change. '
  'Even the secret key cannot substitute its own assertion for that evidence.';

/**
 * The one genuinely actor-less operation in the system. It has no Director to attribute itself to,
 * because it exists to create the first one, and it is refused the moment any Director exists.
 */
create or replace function api.service_claim_bootstrap_job(
  p_idempotency_key text,
  p_full_name       text,
  p_phone_e164      text
)
returns jsonb language sql security definer set search_path = ''
as $$
  select private.claim_provisioning_job(
           p_idempotency_key, null, p_full_name, p_phone_e164, 'director'::public.app_role, true);
$$;

create or replace function api.service_complete_command(p_command_id uuid)
returns jsonb language sql security definer set search_path = ''
as $$ select private.complete_admin_command(p_command_id); $$;

create or replace function api.service_fail_command(p_command_id uuid, p_error_code text)
returns jsonb language sql security definer set search_path = ''
as $$ select private.fail_admin_command(p_command_id, p_error_code); $$;

create or replace function api.service_revert_phone_change(p_command_id uuid)
returns jsonb language sql security definer set search_path = ''
as $$ select private.revert_phone_change(p_command_id); $$;

create or replace function api.service_pending_phone_changes()
returns jsonb language sql security definer set search_path = ''
as $$ select private.pending_phone_changes(); $$;


-- Redefined here so the ENTIRE api surface has one security model. These were SECURITY INVOKER
-- wrappers, which required service_role to hold EXECUTE inside `private`; as definers owned by the
-- restricted role they need nothing there, and `private` becomes unreachable to service_role.
create or replace function api.service_director_exists()
returns boolean language sql security definer set search_path = ''
as $$ select private.director_exists(); $$;

create or replace function api.service_begin_auth_attempt(p_job_id uuid)
returns jsonb language sql security definer set search_path = ''
as $$ select private.begin_auth_attempt(p_job_id); $$;

create or replace function api.service_record_auth_user(p_job_id uuid, p_auth_user_id uuid)
returns jsonb language sql security definer set search_path = ''
as $$ select private.record_provisioning_auth_user(p_job_id, p_auth_user_id); $$;

create or replace function api.service_complete_provisioning(p_job_id uuid)
returns jsonb language sql security definer set search_path = ''
as $$ select private.complete_provisioning(p_job_id); $$;

create or replace function api.service_fail_provisioning(p_job_id uuid, p_error_code text)
returns jsonb language sql security definer set search_path = ''
as $$ select private.fail_provisioning(p_job_id, p_error_code); $$;

create or replace function api.service_record_access_denial(p_user_id uuid, p_path text)
returns jsonb language sql security definer set search_path = ''
as $$ select private.record_access_denial(p_user_id, p_path); $$;

-- Every api function is owned by the restricted role, whatever migration created it.
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure::text as signature
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'api'
  loop
    execute format('alter function %s owner to fv_definer_owner', fn.signature);
  end loop;
end
$$;

-- With the wrappers owned by fv_definer_owner, service_role needs nothing inside `private` — so it
-- gets nothing. Earlier migrations granted it EXECUTE on the implementations one by one, back when
-- the wrappers ran with the caller's rights; those grants are withdrawn here in full.
revoke execute on all functions in schema private from service_role;
revoke usage on schema private from service_role;

-- ---------------------------------------------------------------------------
-- One grant policy, stated by prefix and asserted by test
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema api from public, anon, authenticated, service_role;

do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure::text as signature, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'api'
  loop
    if fn.proname like 'admin\_%' then
      execute format('grant execute on function %s to authenticated', fn.signature);
    elsif fn.proname like 'service\_%' then
      execute format('grant execute on function %s to service_role', fn.signature);
    else
      raise exception 'api.% has neither the admin_ nor the service_ prefix, so its audience is undefined', fn.proname;
    end if;
  end loop;
end
$$;

commit;
