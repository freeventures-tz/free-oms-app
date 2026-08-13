-- Stage 8B corrective · Claimed commands, honest audit attribution, one live change per account
--
-- Four reproduced defects are closed here.
--
--   1. Replaying a completed password-reset key issued a SECOND temporary password, silently
--      invalidating the one the Director had already written down and handed over.
--   2. A reverted or failed phone-change command could be replayed straight into Supabase Auth,
--      leaving Auth on the new number and the database on the old one.
--   3. Two phone changes could be live for one account at once, so applying them out of order left
--      the two systems disagreeing about which number signs that account in.
--   4. A self-demotion was audited under the role the Director ENDED with, because the actor's role
--      was read after the mutation. The audit trail named an authority they did not act with.
--
-- The shape of the fix is the same in each case: the cross-system side effect is a CLAIM, held by
-- exactly one worker, on a command whose stage says whether it may still be performed at all.

begin;

-- ---------------------------------------------------------------------------
-- Claiming
-- ---------------------------------------------------------------------------
alter table public.admin_commands
  add column worker_token uuid,
  add column claimed_at   timestamptz;

comment on column public.admin_commands.worker_token is
  'Whoever holds this may perform the Auth side of this command, once. A stale claim can be taken '
  'over after five minutes, so a crashed worker does not strand the command forever.';

-- One live command per account per kind. This is what stops two phone changes existing at once and
-- being applied in whichever order they happen to finish.
create unique index admin_commands_one_live_per_target_idx
  on public.admin_commands (target_user_id, kind)
  where stage in ('db_applied', 'auth_pending');

/**
 * Take the right to perform this command's Auth side.
 *
 * Returns ok only to the winner. A command that is already complete, reverted or failed is NOT
 * claimable — replaying it was how a completed reset issued a second password and how a reverted
 * phone change was pushed into Auth after the database had been put back.
 */
create or replace function private.claim_admin_command(
  p_command_id   uuid,
  p_worker_token uuid,
  p_stale_after  interval default '5 minutes'
)
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
    return jsonb_build_object('ok', false, 'reason', 'already_completed', 'command', to_jsonb(v_cmd));
  end if;

  if v_cmd.stage in ('reverted', 'failed') then
    return jsonb_build_object('ok', false, 'reason', 'already_settled',
                              'stage', v_cmd.stage, 'command', to_jsonb(v_cmd));
  end if;

  if v_cmd.stage = 'auth_pending'
     and v_cmd.claimed_at is not null
     and v_cmd.claimed_at >= now() - p_stale_after then
    return jsonb_build_object('ok', false, 'reason', 'claimed_by_other');
  end if;

  update public.admin_commands
     set stage         = 'auth_pending',
         worker_token  = p_worker_token,
         claimed_at    = now(),
         attempt_count = attempt_count + 1,
         updated_at    = now()
   where id = p_command_id
   returning * into v_cmd;

  return jsonb_build_object('ok', true, 'command', to_jsonb(v_cmd));
end;
$$;

alter function private.claim_admin_command(uuid, uuid, interval) owner to fv_definer_owner;
revoke execute on function private.claim_admin_command(uuid, uuid, interval)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Completion, failure and revert now require the claim
-- ---------------------------------------------------------------------------
create or replace function private.complete_admin_command(
  p_command_id   uuid,
  p_worker_token uuid
)
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

  if v_cmd.stage <> 'auth_pending' then
    return jsonb_build_object('ok', false, 'reason', 'not_claimed', 'stage', v_cmd.stage);
  end if;

  if v_cmd.worker_token is distinct from p_worker_token then
    return jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  update public.admin_commands
     set stage = 'complete', completed_at = now(), error_code = null, updated_at = now()
   where id = p_command_id
   returning * into v_cmd;

  return jsonb_build_object('ok', true, 'reason', 'completed', 'command', to_jsonb(v_cmd));
end;
$$;

alter function private.complete_admin_command(uuid, uuid) owner to fv_definer_owner;
revoke execute on function private.complete_admin_command(uuid, uuid)
  from public, anon, authenticated, service_role;
drop function if exists private.complete_admin_command(uuid);

create or replace function private.fail_admin_command(
  p_command_id   uuid,
  p_worker_token uuid,
  p_error_code   text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cmd public.admin_commands%rowtype;
begin
  update public.admin_commands
     set stage = 'failed', error_code = p_error_code, worker_token = null, updated_at = now()
   where id = p_command_id
     and stage in ('db_applied', 'auth_pending')
     and (worker_token is null or worker_token = p_worker_token)
   returning * into v_cmd;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_command_or_settled');
  end if;

  return jsonb_build_object('ok', true, 'command', to_jsonb(v_cmd));
end;
$$;

alter function private.fail_admin_command(uuid, uuid, text) owner to fv_definer_owner;
revoke execute on function private.fail_admin_command(uuid, uuid, text)
  from public, anon, authenticated, service_role;
drop function if exists private.fail_admin_command(uuid, text);

create or replace function private.revert_phone_change(
  p_command_id   uuid,
  p_worker_token uuid
)
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

  if v_cmd.stage <> 'auth_pending' then
    return jsonb_build_object('ok', false, 'reason', 'not_claimed', 'stage', v_cmd.stage);
  end if;

  if v_cmd.worker_token is distinct from p_worker_token then
    return jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  v_previous := v_cmd.payload ->> 'previous_phone_e164';
  if v_previous is null then
    return jsonb_build_object('ok', false, 'reason', 'no_previous_phone');
  end if;

  select phone_e164 into v_current from public.profiles
   where id = v_cmd.target_user_id for update;

  if v_current is distinct from (v_cmd.payload ->> 'phone_e164') then
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
     set stage = 'reverted', worker_token = null, updated_at = now()
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

alter function private.revert_phone_change(uuid, uuid) owner to fv_definer_owner;
revoke execute on function private.revert_phone_change(uuid, uuid)
  from public, anon, authenticated, service_role;
drop function if exists private.revert_phone_change(uuid);

/**
 * Phone changes a recovery worker may pick up: unclaimed, or claimed so long ago that the worker
 * holding them is presumed gone. A settled command is never returned, whatever its outcome.
 */
create or replace function private.pending_phone_changes(p_stale_after interval default '5 minutes')
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at), '[]'::jsonb)
  from public.admin_commands c
  where c.kind = 'phone_change'
    and (c.stage = 'db_applied'
         or (c.stage = 'auth_pending'
             and (c.claimed_at is null or c.claimed_at < now() - p_stale_after)));
$$;

alter function private.pending_phone_changes(interval) owner to fv_definer_owner;
revoke execute on function private.pending_phone_changes(interval)
  from public, anon, authenticated, service_role;
drop function if exists private.pending_phone_changes();

-- ---------------------------------------------------------------------------
-- The audit trail records the authority the actor ACTED WITH
-- ---------------------------------------------------------------------------
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
  v_before     public.app_role;
  v_actor_role public.app_role;
  v_corr       uuid := gen_random_uuid();
begin
  perform private.lock_director_set();

  if not private.is_live_director(p_actor_id) then
    raise exception 'change_user_role: actor % is not a live Director', p_actor_id
      using errcode = 'insufficient_privilege';
  end if;

  -- Snapshot the authority BEFORE the mutation. A Director demoting themselves still did it as a
  -- Director, and reading the role afterwards recorded the one they ended with.
  v_actor_role := private.live_role_of(p_actor_id);

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

  perform private.assert_director_remains();

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (
    p_actor_id, v_actor_role, false, 'user_role_changed',
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
  v_before     public.profiles%rowtype;
  v_actor_role public.app_role;
  v_corr       uuid := gen_random_uuid();
begin
  perform private.lock_director_set();

  if not private.is_live_director(p_actor_id) then
    raise exception 'set_account_active: actor % is not a live Director', p_actor_id
      using errcode = 'insufficient_privilege';
  end if;

  v_actor_role := private.live_role_of(p_actor_id);

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
    p_actor_id, v_actor_role, false,
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

-- ---------------------------------------------------------------------------
-- A refused route is recorded against the session that made it
--
-- The old function took a user id from its caller, so the secret key could manufacture audit
-- history attributed to any Director. Identity is now derived from the verified JWT, and there is
-- no parameter to aim.
-- ---------------------------------------------------------------------------
drop function if exists private.record_access_denial(uuid, text);

create or replace function private.record_own_access_denial(p_path text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := private.request_uid();
  v_role public.app_role;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  end if;

  if not exists (select 1 from public.profiles where id = v_user) then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;

  v_role := private.live_role_of(v_user);

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    after_state, correlation_id, source_operation
  )
  values (
    -- A roleless or deactivated user cannot be a user actor under audit_actor_shape, and being
    -- roleless is usually WHY they were refused. Such an attempt is recorded as a system
    -- observation whose SUBJECT is the user, which is the honest shape for it.
    case when v_role is null then null else v_user end,
    v_role,
    v_role is null,
    'route_access_denied', 'profile', v_user,
    jsonb_build_object('path', left(p_path, 200)),
    gen_random_uuid(), 'private.record_own_access_denial'
  );

  return jsonb_build_object('ok', true);
end;
$$;

alter function private.record_own_access_denial(text) owner to fv_definer_owner;
revoke execute on function private.record_own_access_denial(text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Duplicate permissive policies, merged
--
-- Three tables had two PERMISSIVE SELECT policies for `authenticated`, which PostgreSQL evaluates
-- separately and ORs — the Supabase advisor's `multiple_permissive_policies` finding. One policy
-- with an OR predicate is exactly equivalent and is evaluated once.
-- ---------------------------------------------------------------------------
drop policy profiles_select_own   on public.profiles;
drop policy profiles_select_staff on public.profiles;

create policy profiles_select on public.profiles
  for select to authenticated
  using (
    -- Own row first, and deliberately WITHOUT authorize(): this is the carve-out that lets a
    -- first-login-gated user see their own setup screen.
    id = (select private.request_uid())
    or (select private.authorize(array['manager','director']::public.app_role[]))
  );

drop policy user_roles_select_own       on public.user_roles;
drop policy user_roles_select_oversight on public.user_roles;

create policy user_roles_select on public.user_roles
  for select to authenticated
  using (
    user_id = (select private.request_uid())
    or (select private.authorize(array['manager','director']::public.app_role[]))
  );

drop policy approval_requests_select_own      on public.approval_requests;
drop policy approval_requests_select_deciders on public.approval_requests;

create policy approval_requests_select on public.approval_requests
  for select to authenticated
  using (
    requested_by = (select private.request_uid())
    or (select private.authorize(array['cashier','manager','director']::public.app_role[]))
  );

commit;
