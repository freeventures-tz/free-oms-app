-- Stage 8B corrective · The api surface, matched to claimed commands and derived identity
--
-- Three prefixes now, each declaring its audience, each enforced by test:
--
--   api.admin_*    `authenticated` Directors. Derives its actor. May START administrative work.
--   api.self_*     any `authenticated` user. Derives its own identity and may act ONLY on itself.
--   api.service_*  `service_role`. Takes ids and a worker token, never an identity. Continuation only.
--
-- `api.self_*` exists because of a reproduced forgery: `service_record_access_denial(user, path)`
-- let the secret key nominate any user and manufacture audit history attributed to them. A refused
-- route attempt is now recorded by the session that made it, and there is no parameter to aim.

begin;

-- ---------------------------------------------------------------------------
-- First-login evidence is recorded alongside the operation
-- ---------------------------------------------------------------------------
alter table public.first_login_operations
  add column auth_evidence text;

comment on column public.first_login_operations.auth_evidence is
  'The marker the server wrote into the Auth user''s app_metadata in the SAME request that changed '
  'the password. This database cannot verify it — the auth schema is unreachable (architecture.md '
  '§7.9) — but recording it makes the claim auditable and ties the operation to one Auth write.';

create or replace function private.record_first_login_password_changed(
  p_operation_id  uuid,
  p_user_id       uuid,
  p_auth_evidence text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_op public.first_login_operations%rowtype;
begin
  if p_auth_evidence is null or length(btrim(p_auth_evidence)) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'evidence_required');
  end if;

  select * into v_op from public.first_login_operations
   where id = p_operation_id for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_operation');
  end if;

  if v_op.user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'reason', 'operation_user_mismatch');
  end if;

  if v_op.stage = 'superseded' then
    return jsonb_build_object('ok', false, 'reason', 'superseded');
  end if;

  if v_op.stage in ('auth_changed', 'complete') then
    return jsonb_build_object('ok', true, 'reason', 'already_recorded', 'operation', to_jsonb(v_op));
  end if;

  update public.first_login_operations
     set stage = 'auth_changed', auth_changed_at = now(),
         auth_evidence = p_auth_evidence, updated_at = now()
   where id = p_operation_id
   returning * into v_op;

  return jsonb_build_object('ok', true, 'reason', 'recorded', 'operation', to_jsonb(v_op));
end;
$$;

alter function private.record_first_login_password_changed(uuid, uuid, text)
  owner to fv_definer_owner;
revoke execute on function private.record_first_login_password_changed(uuid, uuid, text)
  from public, anon, authenticated, service_role;
drop function if exists private.record_first_login_password_changed(uuid, uuid);

-- ---------------------------------------------------------------------------
-- admin_* — one live command per account, and a key bound to the change it was issued for
-- ---------------------------------------------------------------------------
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

    -- A completed reset is DONE. The temporary password it produced is stored nowhere by design,
    -- so replaying the key cannot return it — and must not issue a replacement behind the
    -- Director's back, because the first one may already be in the target's hands.
    if v_cmd.stage = 'complete' then
      return jsonb_build_object('ok', false, 'reason', 'already_completed', 'command', to_jsonb(v_cmd));
    end if;

    -- A failed attempt is retryable under the same key: the gate is already armed, and nothing
    -- was handed over.
    if v_cmd.stage in ('failed', 'reverted') then
      update public.admin_commands
         set stage = 'db_applied', error_code = null, worker_token = null,
             claimed_at = null, attempt_count = attempt_count + 1, updated_at = now()
       where id = v_cmd.id returning * into v_cmd;
    else
      update public.admin_commands
         set attempt_count = attempt_count + 1, updated_at = now()
       where id = v_cmd.id returning * into v_cmd;
    end if;

    return jsonb_build_object('ok', true, 'reason', 'resumed', 'command', to_jsonb(v_cmd));
  end if;

  if not exists (select 1 from public.profiles where id = p_target_user_id) then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;

  if exists (
    select 1 from public.admin_commands
     where target_user_id = p_target_user_id
       and kind = 'password_reset'
       and stage in ('db_applied', 'auth_pending')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'change_already_in_flight');
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
    -- The key is bound to the exact change it was issued for: same kind, same target, same number.
    if v_cmd.kind <> 'phone_change'
       or v_cmd.target_user_id <> p_target_user_id
       or (v_cmd.payload ->> 'phone_e164') is distinct from p_phone_e164 then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;

    if v_cmd.stage = 'complete' then
      return jsonb_build_object('ok', true, 'reason', 'already_completed', 'command', to_jsonb(v_cmd));
    end if;

    if v_cmd.stage in ('failed', 'reverted') then
      -- The database was put back, so this command describes a change that no longer exists.
      -- A new change needs a new command; replaying this one would push Auth somewhere the
      -- database is not.
      return jsonb_build_object('ok', false, 'reason', 'already_settled', 'stage', v_cmd.stage);
    end if;

    update public.admin_commands
       set attempt_count = attempt_count + 1, updated_at = now()
     where id = v_cmd.id returning * into v_cmd;
    return jsonb_build_object('ok', true, 'reason', 'resumed', 'command', to_jsonb(v_cmd));
  end if;

  -- One account cannot have two phone changes in flight. Two of them applied out of order is how
  -- the database ended up on the newest number and Auth on an older one.
  if exists (
    select 1 from public.admin_commands
     where target_user_id = p_target_user_id
       and kind = 'phone_change'
       and stage in ('db_applied', 'auth_pending')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'change_already_in_flight');
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

-- ---------------------------------------------------------------------------
-- self_* — acts only on the caller, who is derived and cannot be nominated
-- ---------------------------------------------------------------------------
create or replace function api.self_record_access_denial(p_path text)
returns jsonb
language sql
security definer
set search_path = ''
as $$ select private.record_own_access_denial(p_path); $$;

comment on function api.self_record_access_denial(text) is
  'Records that THIS session was refused a route. There is no user parameter, so no caller — '
  'including the secret key — can manufacture audit history attributed to somebody else.';

alter function api.self_record_access_denial(text) owner to fv_definer_owner;

-- ---------------------------------------------------------------------------
-- service_* — continuation, now claim-based
-- ---------------------------------------------------------------------------
drop function if exists api.service_record_access_denial(uuid, text);
drop function if exists api.service_complete_command(uuid);
drop function if exists api.service_fail_command(uuid, text);
drop function if exists api.service_revert_phone_change(uuid);
drop function if exists api.service_pending_phone_changes();
drop function if exists api.service_record_first_login_password_changed(uuid, uuid);

create or replace function api.service_claim_command(p_command_id uuid, p_worker_token uuid)
returns jsonb language sql security definer set search_path = ''
as $$ select private.claim_admin_command(p_command_id, p_worker_token); $$;

create or replace function api.service_complete_command(p_command_id uuid, p_worker_token uuid)
returns jsonb language sql security definer set search_path = ''
as $$ select private.complete_admin_command(p_command_id, p_worker_token); $$;

create or replace function api.service_fail_command(
  p_command_id uuid, p_worker_token uuid, p_error_code text
)
returns jsonb language sql security definer set search_path = ''
as $$ select private.fail_admin_command(p_command_id, p_worker_token, p_error_code); $$;

create or replace function api.service_revert_phone_change(p_command_id uuid, p_worker_token uuid)
returns jsonb language sql security definer set search_path = ''
as $$ select private.revert_phone_change(p_command_id, p_worker_token); $$;

create or replace function api.service_pending_phone_changes()
returns jsonb language sql security definer set search_path = ''
as $$ select private.pending_phone_changes(); $$;

create or replace function api.service_record_first_login_password_changed(
  p_operation_id  uuid,
  p_user_id       uuid,
  p_auth_evidence text
)
returns jsonb language sql security definer set search_path = ''
as $$ select private.record_first_login_password_changed(p_operation_id, p_user_id, p_auth_evidence); $$;

-- ---------------------------------------------------------------------------
-- One grant policy, stated by prefix and asserted by test
-- ---------------------------------------------------------------------------
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
    if fn.proname like 'admin\_%' or fn.proname like 'self\_%' then
      execute format('grant execute on function %s to authenticated', fn.signature);
    elsif fn.proname like 'service\_%' then
      execute format('grant execute on function %s to service_role', fn.signature);
    else
      raise exception 'api.% has no audience prefix (admin_, self_ or service_)', fn.proname;
    end if;
  end loop;
end
$$;

commit;
