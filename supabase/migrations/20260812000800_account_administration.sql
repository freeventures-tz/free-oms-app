-- Stage 8A hardening · Director account administration, in the database
--
-- Every operation here is invoked by the SERVER holding the secret key, so there is no JWT request
-- context and private.authorize() cannot be used. The acting Director is passed explicitly and
-- verified live by private.is_live_director(). The application performs the same check before it
-- calls; neither layer is permitted to be the only one.
--
-- Deactivation ordering follows architecture.md §7.5: the database flag is what denies access.
-- Auth session revocation is hygiene performed afterwards by the server, and is retryable.

begin;

-- ---------------------------------------------------------------------------
-- Activate / deactivate. Accounts are never deleted (product.md §17).
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

  -- Losing the last Director turns an in-app task into the project-owner escalation procedure of
  -- §7.7. Refusing self-deactivation is sufficient to prevent it: the actor is verified live as an
  -- ACTIVE Director, so whenever the target is someone else there is by definition still an active
  -- Director afterwards — the actor. A separate "last active Director" branch here would be
  -- unreachable, and unreachable checks in security code are a liability, not defence in depth.
  -- The reachable version of that hazard is self-demotion, and it is guarded in change_user_role.
  if not p_is_active and p_target_user_id = p_actor_id then
    return jsonb_build_object('ok', false, 'reason', 'cannot_deactivate_self');
  end if;

  update public.profiles
     set is_active = p_is_active, updated_at = now()
   where id = p_target_user_id;

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
  from public, anon, authenticated;
grant  execute on function private.set_account_active(uuid, uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- Change role. Exactly one active role per user is a table constraint; this keeps the
-- system from losing its last Director.
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
  v_before public.app_role;
  v_other_active_directors integer;
  v_corr uuid := gen_random_uuid();
begin
  if not private.is_live_director(p_actor_id) then
    raise exception 'change_user_role: actor % is not a live Director', p_actor_id
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from public.profiles where id = p_target_user_id) then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;

  select r.role into v_before from public.user_roles r where r.user_id = p_target_user_id for update;

  if v_before = p_role then
    return jsonb_build_object('ok', true, 'reason', 'unchanged');
  end if;

  if v_before = 'director' and p_role <> 'director' then
    select count(*) into v_other_active_directors
      from public.user_roles r
      join public.profiles p on p.id = r.user_id
     where r.role = 'director'
       and p.is_active
       and r.user_id <> p_target_user_id;

    if v_other_active_directors = 0 then
      return jsonb_build_object('ok', false, 'reason', 'last_active_director');
    end if;
  end if;

  insert into public.user_roles (user_id, role, assigned_by)
  values (p_target_user_id, p_role, p_actor_id)
  on conflict (user_id) do update
    set role = excluded.role, assigned_by = excluded.assigned_by, assigned_at = now();

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
  from public, anon, authenticated;
grant  execute on function private.change_user_role(uuid, uuid, public.app_role) to service_role;

-- ---------------------------------------------------------------------------
-- Change phone. The phone IS the login identifier, so this claims the contended
-- resource — the unique phone — before the server touches Supabase Auth. If the Auth
-- side then fails, the server calls this again with the old number to compensate.
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

  if exists (select 1 from public.profiles where phone_e164 = p_phone_e164) then
    return jsonb_build_object('ok', false, 'reason', 'phone_in_use');
  end if;

  update public.profiles
     set phone_e164 = p_phone_e164, updated_at = now()
   where id = p_target_user_id;

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
  from public, anon, authenticated;
grant  execute on function private.change_user_phone(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Refused route access (design.md §4.5 item 4). Written by the SERVER after it has
-- resolved the user, so a client cannot forge one and `authenticated` gains no write path.
-- ---------------------------------------------------------------------------
create or replace function private.record_access_denial(p_user_id uuid, p_path text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.app_role;
  v_corr uuid := gen_random_uuid();
begin
  if not exists (select 1 from public.profiles where id = p_user_id) then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;

  v_role := private.live_role_of(p_user_id);

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    after_state, correlation_id, source_operation
  )
  values (
    -- A user with no live role cannot be recorded as a user actor under audit_actor_shape, and
    -- rolelessness is exactly why they were refused, so it is recorded as system observation.
    case when v_role is null then null else p_user_id end,
    v_role,
    v_role is null,
    'route_access_denied', 'profile', p_user_id,
    jsonb_build_object('path', left(p_path, 200), 'user_id', p_user_id),
    v_corr, 'private.record_access_denial'
  );

  return jsonb_build_object('ok', true);
end;
$$;

alter function private.record_access_denial(uuid, text) owner to fv_definer_owner;
revoke execute on function private.record_access_denial(uuid, text) from public, anon, authenticated;
grant  execute on function private.record_access_denial(uuid, text) to service_role;

commit;
