-- Stage 8B corrective · Bind administrative authority to the authenticated actor
--
-- THE DEFECT
--   Every administrative operation was a service-only function taking `p_actor_id`. The database
--   verified that the supplied id belonged to a live Director — but not that this Director had
--   asked for anything. A bug anywhere in the server, or the secret key in the wrong hands, could
--   name any Director as the actor of any change, and the audit trail would name them too. The
--   database was checking a fact, not authorising a request.
--
-- THE FIX
--   Administrative commands are issued by `authenticated`, through `api.admin_*` functions that
--   derive the actor from `private.request_uid()` — the verified JWT of the session making the
--   call. There is no actor parameter to supply. The secret key keeps only what genuinely cannot be
--   done from a user session: CONTINUING a cross-system operation, addressed by its command id.
--
--   The naming carries the rule, and a test enforces it:
--     api.admin_*    executable by `authenticated` only. Derives its own actor. May START work.
--     api.service_*  executable by `service_role` only. Takes ids, never an actor. May only
--                    CONTINUE work that an authenticated actor already started.
--
-- ALSO FIXED HERE
--   * Two Directors could concurrently demote or deactivate each other, leaving zero Directors.
--     Both transactions saw the other as still active. Now every operation that can shrink the
--     Director set serialises on an advisory lock and RECHECKS after applying.
--   * `service_reset_password_gate` accepted a null actor and audited a Director reset as system
--     activity. The Director path can no longer be called without a Director; the system path is a
--     separate function with its own audit action, reachable only by provisioning.

begin;

-- ---------------------------------------------------------------------------
-- Durable commands, for the operations that span Supabase Auth and this database.
--
-- The command is created UNDER THE AUTHENTICATED SESSION and records who issued it. Every later
-- step is addressed by command id alone, so a continuation can never invent an actor.
-- ---------------------------------------------------------------------------
create type public.admin_command_kind as enum ('password_reset', 'phone_change');

create type public.admin_command_stage as enum ('db_applied', 'complete', 'reverted', 'failed');

create table public.admin_commands (
  id               uuid primary key default gen_random_uuid(),
  kind             public.admin_command_kind not null,
  idempotency_key  text not null unique,

  -- Derived from the session that issued the command. Never supplied by a caller.
  actor_id         uuid not null references public.profiles (id),
  actor_role       public.app_role not null,
  target_user_id   uuid not null references public.profiles (id),

  -- Non-secret only. A temporary password never appears here, as the check constraint below and
  -- the pgTAP column sweep both insist.
  payload          jsonb not null default '{}'::jsonb,

  stage            public.admin_command_stage not null default 'db_applied',
  error_code       text check (error_code is null or error_code ~ '^[a-z0-9_.:-]{1,120}$'),
  attempt_count    integer not null default 1 check (attempt_count >= 0),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz
);

comment on table public.admin_commands is
  'Cross-system administrative operations. Created under an authenticated Director session and '
  'continued by the server using the command id — never using a supplied actor id.';

create index admin_commands_resumable_idx
  on public.admin_commands (kind, stage)
  where stage = 'db_applied';

create index admin_commands_target_idx on public.admin_commands (target_user_id, created_at desc);

alter table public.admin_commands enable row level security;

grant select on public.admin_commands to authenticated;

create policy admin_commands_select_director on public.admin_commands
  for select to authenticated
  using ( (select private.authorize(array['director']::public.app_role[])) );

grant select, insert, update on public.admin_commands to fv_definer_owner;

create policy admin_commands_definer_owner_all on public.admin_commands
  for all to fv_definer_owner
  using ( true ) with check ( true );

-- ---------------------------------------------------------------------------
-- Authority, derived rather than supplied
-- ---------------------------------------------------------------------------
create or replace function private.acting_director()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.request_uid();
begin
  if v_actor is null then
    raise exception 'administrative command requires an authenticated session'
      using errcode = 'insufficient_privilege';
  end if;

  if not private.is_live_director(v_actor) then
    raise exception 'actor % is not a live Director', v_actor
      using errcode = 'insufficient_privilege';
  end if;

  return v_actor;
end;
$$;

comment on function private.acting_director() is
  'The Director making THIS request, from the verified JWT. There is no parameter, so no caller — '
  'server, script, or leaked key — can nominate somebody else as the actor.';

alter function private.acting_director() owner to fv_definer_owner;
revoke execute on function private.acting_director() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The Director set must never reach zero
--
-- The previous guards read the Director set without holding anything, so two transactions could
-- each see the other Director as active, each conclude it was safe, and both commit. The lock
-- serialises every operation that can shrink the set; the recheck runs AFTER the change, so it sees
-- the world the transaction is actually about to commit.
-- ---------------------------------------------------------------------------
create or replace function private.lock_director_set()
returns void
language sql
security definer
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtext('free_ventures.director_set'));
$$;

alter function private.lock_director_set() owner to fv_definer_owner;
revoke execute on function private.lock_director_set() from public, anon, authenticated, service_role;

create or replace function private.assert_director_remains()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_remaining integer;
begin
  select count(*) into v_remaining
    from public.user_roles r
    join public.profiles p on p.id = r.user_id
   where r.role = 'director'
     and p.is_active;

  if v_remaining = 0 then
    raise exception 'this change would leave no active Director'
      using errcode = 'raise_exception';
  end if;
end;
$$;

comment on function private.assert_director_remains() is
  'Post-change invariant: at least one active Director exists at COMMIT. Paired with '
  'private.lock_director_set(), which makes concurrent shrinking transactions take turns.';

alter function private.assert_director_remains() owner to fv_definer_owner;
revoke execute on function private.assert_director_remains()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Gate arming: two functions, two audit actions, two authority paths.
--
-- The single function with a nullable actor was the whole reason an anonymous Director reset was
-- possible. A caller can no longer choose to be anonymous — it is a property of which function
-- exists to be called.
-- ---------------------------------------------------------------------------
drop function if exists private.arm_first_login_gate(uuid, uuid, uuid);

create or replace function private.arm_first_login_gate_by_director(
  p_target_user_id uuid,
  p_actor_id       uuid,
  p_correlation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_corr uuid := coalesce(p_correlation_id, gen_random_uuid());
begin
  if p_actor_id is null then
    raise exception 'a Director reset has no anonymous form'
      using errcode = 'insufficient_privilege';
  end if;

  if not private.is_live_director(p_actor_id) then
    raise exception 'actor % is not a live Director', p_actor_id
      using errcode = 'insufficient_privilege';
  end if;

  update public.profiles
     set must_change_password = true, updated_at = now()
   where id = p_target_user_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;

  -- A re-armed gate cannot be satisfied by an earlier password change.
  perform private.invalidate_first_login_operations(p_target_user_id);

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    after_state, correlation_id, source_operation
  )
  values (
    p_actor_id, private.live_role_of(p_actor_id), false,
    'password_reset_by_director', 'profile', p_target_user_id,
    jsonb_build_object('must_change_password', true),
    v_corr, 'private.arm_first_login_gate_by_director'
  );

  return jsonb_build_object('ok', true, 'correlation_id', v_corr);
end;
$$;

alter function private.arm_first_login_gate_by_director(uuid, uuid, uuid) owner to fv_definer_owner;
revoke execute on function private.arm_first_login_gate_by_director(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function private.arm_first_login_gate_system(
  p_target_user_id uuid,
  p_correlation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_corr uuid := coalesce(p_correlation_id, gen_random_uuid());
begin
  update public.profiles
     set must_change_password = true, updated_at = now()
   where id = p_target_user_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;

  perform private.invalidate_first_login_operations(p_target_user_id);

  insert into public.audit_events (
    is_system_actor, action, entity_type, entity_id, after_state,
    correlation_id, source_operation
  )
  values (
    true, 'first_login_gate_armed', 'profile', p_target_user_id,
    jsonb_build_object('must_change_password', true),
    v_corr, 'private.arm_first_login_gate_system'
  );

  return jsonb_build_object('ok', true, 'correlation_id', v_corr);
end;
$$;

comment on function private.arm_first_login_gate_system(uuid, uuid) is
  'System arming. Reachable ONLY from provisioning, which genuinely has no user actor during '
  'bootstrap. It is not a Director reset and is audited under a different action.';

alter function private.arm_first_login_gate_system(uuid, uuid) owner to fv_definer_owner;
revoke execute on function private.arm_first_login_gate_system(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Account lifecycle, serialised
-- ---------------------------------------------------------------------------
create or replace function private.set_account_active(
  p_target_user_id uuid,
  p_actor_id       uuid,
  p_is_active      boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.profiles%rowtype;
  v_corr   uuid := gen_random_uuid();
begin
  -- Take the lock BEFORE re-verifying authority: an actor may have lost it while queueing behind
  -- another transaction, and the check must reflect the world this transaction will commit into.
  perform private.lock_director_set();

  if not private.is_live_director(p_actor_id) then
    raise exception 'set_account_active: actor % is not a live Director', p_actor_id
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.profiles where id = p_target_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;

  if v_before.is_active = p_is_active then
    return jsonb_build_object('ok', true, 'reason', 'unchanged');
  end if;

  if not p_is_active and p_target_user_id = p_actor_id then
    return jsonb_build_object('ok', false, 'reason', 'cannot_deactivate_self');
  end if;

  update public.profiles
     set is_active = p_is_active, updated_at = now()
   where id = p_target_user_id;

  perform private.assert_director_remains();

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    p_actor_id, private.live_role_of(p_actor_id), false,
    case when p_is_active then 'account_reactivated' else 'account_deactivated' end,
    'profile', p_target_user_id,
    jsonb_build_object('is_active', v_before.is_active),
    jsonb_build_object('is_active', p_is_active),
    v_corr, 'private.set_account_active'
  );

  return jsonb_build_object('ok', true, 'reason', 'changed', 'correlation_id', v_corr);
end;
$$;

alter function private.set_account_active(uuid, uuid, boolean) owner to fv_definer_owner;
revoke execute on function private.set_account_active(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;

create or replace function private.change_user_role(
  p_target_user_id uuid,
  p_actor_id       uuid,
  p_role           public.app_role
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.app_role;
  v_corr   uuid := gen_random_uuid();
begin
  perform private.lock_director_set();

  if not private.is_live_director(p_actor_id) then
    raise exception 'change_user_role: actor % is not a live Director', p_actor_id
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from public.profiles where id = p_target_user_id) then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;

  select r.role into v_before from public.user_roles r
   where r.user_id = p_target_user_id for update;

  if v_before = p_role then
    return jsonb_build_object('ok', true, 'reason', 'unchanged');
  end if;

  insert into public.user_roles (user_id, role, assigned_by)
  values (p_target_user_id, p_role, p_actor_id)
  on conflict (user_id) do update
    set role = excluded.role, assigned_by = excluded.assigned_by, assigned_at = now();

  -- Runs after the change, so a concurrent demotion of the other Director cannot slip past.
  perform private.assert_director_remains();

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    p_actor_id, private.live_role_of(p_actor_id), false, 'user_role_changed',
    'profile', p_target_user_id,
    jsonb_build_object('role', v_before),
    jsonb_build_object('role', p_role),
    v_corr, 'private.change_user_role'
  );

  return jsonb_build_object('ok', true, 'reason', 'changed', 'correlation_id', v_corr);
end;
$$;

alter function private.change_user_role(uuid, uuid, public.app_role) owner to fv_definer_owner;
revoke execute on function private.change_user_role(uuid, uuid, public.app_role)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Phone change: the same function, made race-safe.
--
-- Checking "is this number free?" and then writing it is two statements. Two concurrent requests
-- for the SAME new number both pass the check and one loses at the unique index — which surfaced as
-- an unhandled 23505 rather than a plain refusal.
-- ---------------------------------------------------------------------------
create or replace function private.change_user_phone(
  p_target_user_id uuid,
  p_actor_id       uuid,
  p_phone_e164     text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.profiles%rowtype;
  v_corr   uuid := gen_random_uuid();
begin
  if not private.is_live_director(p_actor_id) then
    raise exception 'change_user_phone: actor % is not a live Director', p_actor_id
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.profiles where id = p_target_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;

  if v_before.phone_e164 = p_phone_e164 then
    return jsonb_build_object('ok', true, 'reason', 'unchanged');
  end if;

  begin
    update public.profiles
       set phone_e164 = p_phone_e164, updated_at = now()
     where id = p_target_user_id;
  exception when unique_violation then
    -- Lost the race to another request for the same number. A refusal, not a crash.
    return jsonb_build_object('ok', false, 'reason', 'phone_in_use');
  end;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    p_actor_id, private.live_role_of(p_actor_id), false, 'user_phone_changed',
    'profile', p_target_user_id,
    jsonb_build_object('phone_e164', v_before.phone_e164),
    jsonb_build_object('phone_e164', p_phone_e164),
    v_corr, 'private.change_user_phone'
  );

  return jsonb_build_object('ok', true, 'reason', 'changed',
                            'previous_phone_e164', v_before.phone_e164,
                            'correlation_id', v_corr);
end;
$$;

alter function private.change_user_phone(uuid, uuid, text) owner to fv_definer_owner;
revoke execute on function private.change_user_phone(uuid, uuid, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Command continuation — by id, with no actor anywhere in the signature
-- ---------------------------------------------------------------------------
create or replace function private.complete_admin_command(p_command_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cmd public.admin_commands%rowtype;
begin
  select * into v_cmd from public.admin_commands where id = p_command_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_command');
  end if;

  if v_cmd.stage = 'complete' then
    return jsonb_build_object('ok', true, 'reason', 'already_complete', 'command', to_jsonb(v_cmd));
  end if;

  if v_cmd.stage <> 'db_applied' then
    return jsonb_build_object('ok', false, 'reason', 'not_resumable', 'command', to_jsonb(v_cmd));
  end if;

  update public.admin_commands
     set stage = 'complete', completed_at = now(), error_code = null, updated_at = now()
   where id = p_command_id
   returning * into v_cmd;

  return jsonb_build_object('ok', true, 'reason', 'completed', 'command', to_jsonb(v_cmd));
end;
$$;

alter function private.complete_admin_command(uuid) owner to fv_definer_owner;
revoke execute on function private.complete_admin_command(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.fail_admin_command(p_command_id uuid, p_error_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cmd public.admin_commands%rowtype;
begin
  update public.admin_commands
     set stage = 'failed', error_code = p_error_code, updated_at = now()
   where id = p_command_id and stage = 'db_applied'
   returning * into v_cmd;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_command_or_settled');
  end if;

  return jsonb_build_object('ok', true, 'command', to_jsonb(v_cmd));
end;
$$;

alter function private.fail_admin_command(uuid, text) owner to fv_definer_owner;
revoke execute on function private.fail_admin_command(uuid, text)
  from public, anon, authenticated, service_role;

/**
 * Compensation for a phone change whose Auth side failed.
 *
 * Attributed to the Director who issued the command — recovered from the command row, never
 * supplied — because reverting their change is part of their change, not system activity.
 */
create or replace function private.revert_phone_change(p_command_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cmd      public.admin_commands%rowtype;
  v_previous text;
  v_current  text;
begin
  select * into v_cmd from public.admin_commands where id = p_command_id for update;
  if not found or v_cmd.kind <> 'phone_change' then
    return jsonb_build_object('ok', false, 'reason', 'no_command');
  end if;

  if v_cmd.stage = 'reverted' then
    return jsonb_build_object('ok', true, 'reason', 'already_reverted');
  end if;

  if v_cmd.stage <> 'db_applied' then
    return jsonb_build_object('ok', false, 'reason', 'not_resumable');
  end if;

  v_previous := v_cmd.payload ->> 'previous_phone_e164';
  if v_previous is null then
    return jsonb_build_object('ok', false, 'reason', 'no_previous_phone');
  end if;

  select phone_e164 into v_current from public.profiles
   where id = v_cmd.target_user_id for update;

  if v_current is distinct from (v_cmd.payload ->> 'phone_e164') then
    -- Somebody changed it again in the meantime; reverting now would undo their work.
    return jsonb_build_object('ok', false, 'reason', 'phone_moved_on');
  end if;

  begin
    update public.profiles
       set phone_e164 = v_previous, updated_at = now()
     where id = v_cmd.target_user_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'previous_phone_taken');
  end;

  update public.admin_commands
     set stage = 'reverted', updated_at = now()
   where id = p_command_id;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    v_cmd.actor_id, v_cmd.actor_role, false, 'user_phone_change_reverted',
    'profile', v_cmd.target_user_id,
    jsonb_build_object('phone_e164', v_cmd.payload ->> 'phone_e164'),
    jsonb_build_object('phone_e164', v_previous),
    gen_random_uuid(), 'private.revert_phone_change'
  );

  return jsonb_build_object('ok', true, 'reason', 'reverted', 'phone_e164', v_previous);
end;
$$;

alter function private.revert_phone_change(uuid) owner to fv_definer_owner;
revoke execute on function private.revert_phone_change(uuid)
  from public, anon, authenticated, service_role;

/** Phone changes applied in the database whose Auth side was never confirmed. */
create or replace function private.pending_phone_changes()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at), '[]'::jsonb)
  from public.admin_commands c
  where c.kind = 'phone_change' and c.stage = 'db_applied';
$$;

alter function private.pending_phone_changes() owner to fv_definer_owner;
revoke execute on function private.pending_phone_changes()
  from public, anon, authenticated, service_role;

commit;
