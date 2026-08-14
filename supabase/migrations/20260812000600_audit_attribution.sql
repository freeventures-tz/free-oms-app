-- Stage 8A hardening · Audit attribution
--
-- Two defects are repaired here.
--
--   1. `arm_first_login_gate` recorded EVERY gate arming as anonymous system activity. A Director
--      resetting a colleague's password is not system activity: the audit trail must name the
--      Director who did it and the account it was done to. The same applied to first-login
--      completion, which recorded an actor but no role.
--
--   2. `audit_actor_shape` allowed an incoherent middle ground — a user actor with no role. The
--      role held AT THE TIME OF THE ACTION is the authority the action was taken under, and roles
--      change, so it cannot be reconstructed later from user_roles. It must be captured on write.
--
-- Shape after this migration:
--   system actor  → actor_id IS NULL     AND actor_role IS NULL
--   user actor    → actor_id IS NOT NULL AND actor_role IS NOT NULL

begin;

-- ---------------------------------------------------------------------------
-- Coherent actor shape
-- ---------------------------------------------------------------------------
alter table public.audit_events drop constraint audit_actor_shape;

alter table public.audit_events add constraint audit_actor_shape check (
  (is_system_actor       and actor_id is null     and actor_role is null)
  or
  (not is_system_actor   and actor_id is not null and actor_role is not null)
);

comment on constraint audit_actor_shape on public.audit_events is
  'A system actor has no user and no role. A user actor is identified by BOTH id and the role '
  'held at the time of the action. There is no third shape: no anonymous user, no roleless actor.';

comment on column public.audit_events.actor_role is
  'The role the actor held WHEN THE ACTION HAPPENED. Never re-derived from user_roles at read '
  'time — a later role change must not rewrite history.';

-- ---------------------------------------------------------------------------
-- Live role lookup, used only to stamp audit rows and check Director authority.
--
-- Definer-owned and granted to nobody: the only callers are the definer functions below, whose
-- privilege check runs as fv_definer_owner, which owns this function.
-- ---------------------------------------------------------------------------
create or replace function private.live_role_of(p_user_id uuid)
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select r.role
  from public.user_roles r
  join public.profiles p on p.id = r.user_id
  where r.user_id = p_user_id
    and p.is_active = true;
$$;

comment on function private.live_role_of(uuid) is
  'Live role of a user, or NULL if inactive or unassigned. Used to STAMP audit rows, never to '
  'authorize a request — request authorization is private.authorize().';

alter function private.live_role_of(uuid) owner to fv_definer_owner;
revoke execute on function private.live_role_of(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Live Director check, by explicit user id.
--
-- private.authorize() reads the JWT request context, which does not exist when the SERVER calls a
-- function as service_role. Administrative operations therefore pass the acting Director's id
-- explicitly and it is verified here, live, against the same four conditions authorize() uses.
-- ---------------------------------------------------------------------------
create or replace function private.is_live_director(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join public.user_roles r on r.user_id = p.id
    where p.id                   = p_user_id
      and p.is_active            = true
      and p.must_change_password = false
      and r.role                 = 'director'
  );
$$;

comment on function private.is_live_director(uuid) is
  'Server-side Director authority check for administrative operations invoked by service_role. '
  'Reads live state: active, first-login gate cleared, and a live director row in user_roles.';

alter function private.is_live_director(uuid) owner to fv_definer_owner;
revoke execute on function private.is_live_director(uuid) from public, anon, authenticated;
grant  execute on function private.is_live_director(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Gate arming, correctly attributed.
--
-- The signature changes (an actor is now required information, not an afterthought), so the old
-- one is dropped rather than overloaded — an overload would let a caller silently keep recording
-- Director resets as system activity.
-- ---------------------------------------------------------------------------
drop function if exists private.arm_first_login_gate(uuid);

create or replace function private.arm_first_login_gate(
  p_user_id        uuid,
  p_actor_id       uuid,          -- NULL means genuine system activity (bootstrap only)
  p_correlation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role public.app_role;
  v_corr       uuid := coalesce(p_correlation_id, gen_random_uuid());
begin
  if p_actor_id is not null then
    -- A named actor must be a live Director. This is the database's own copy of the authority
    -- check; the application performs it too, and neither is allowed to be the only one.
    if not private.is_live_director(p_actor_id) then
      raise exception 'arm_first_login_gate: actor % is not a live Director', p_actor_id
        using errcode = 'insufficient_privilege';
    end if;
    v_actor_role := private.live_role_of(p_actor_id);
  end if;

  update public.profiles
     set must_change_password = true,
         updated_at           = now()
   where id = p_user_id;

  if not found then
    raise exception 'arm_first_login_gate: no profile for %', p_user_id
      using errcode = 'no_data_found';
  end if;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    after_state, correlation_id, source_operation
  )
  values (
    p_actor_id,
    v_actor_role,
    p_actor_id is null,
    case when p_actor_id is null then 'first_login_gate_armed'
         else                         'password_reset_by_director' end,
    'profile',
    p_user_id,
    jsonb_build_object('must_change_password', true),
    v_corr,
    'private.arm_first_login_gate'
  );

  return jsonb_build_object('ok', true, 'correlation_id', v_corr);
end;
$$;

comment on function private.arm_first_login_gate(uuid, uuid, uuid) is
  'Arms the forced-password-change gate. A Director-initiated reset passes the Director id and is '
  'audited as that Director acting on that account. Only the one-time bootstrap, which has no user '
  'actor, may pass NULL.';

alter function private.arm_first_login_gate(uuid, uuid, uuid) owner to fv_definer_owner;
revoke execute on function private.arm_first_login_gate(uuid, uuid, uuid)
  from public, authenticated, anon;
grant  execute on function private.arm_first_login_gate(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Gate completion, correctly attributed.
--
-- The actor is the user themselves — they changed their own password — and the row now carries the
-- role they held while doing it.
-- ---------------------------------------------------------------------------
drop function if exists private.clear_first_login_gate(uuid);

create or replace function private.clear_first_login_gate(
  p_user_id        uuid,
  p_correlation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_role    public.app_role;
  v_corr    uuid := coalesce(p_correlation_id, gen_random_uuid());
begin
  select * into v_profile from public.profiles where id = p_user_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;

  if not v_profile.is_active then
    return jsonb_build_object('ok', false, 'reason', 'inactive');
  end if;

  -- Idempotent, so a retry after a partial failure succeeds rather than erroring.
  if not v_profile.must_change_password then
    return jsonb_build_object('ok', true, 'reason', 'already_completed');
  end if;

  v_role := private.live_role_of(p_user_id);

  -- A user with no live role has zero access whether the gate is set or not, and an audit row
  -- cannot honestly name the authority they acted under. Refuse rather than record a half-truth;
  -- once a Director assigns a role the same call succeeds.
  if v_role is null then
    return jsonb_build_object('ok', false, 'reason', 'no_role');
  end if;

  update public.profiles
     set must_change_password = false,
         updated_at           = now()
   where id = p_user_id;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    after_state, correlation_id, source_operation
  )
  values (
    p_user_id, v_role, false, 'first_login_completed', 'profile', p_user_id,
    jsonb_build_object('must_change_password', false),
    v_corr, 'private.clear_first_login_gate'
  );

  return jsonb_build_object('ok', true, 'reason', 'completed', 'correlation_id', v_corr);
end;
$$;

comment on function private.clear_first_login_gate(uuid, uuid) is
  'Clears the forced-password-change gate AFTER Supabase Auth has confirmed the password change '
  'for this same user. service_role only — no client-callable path to this exists.';

alter function private.clear_first_login_gate(uuid, uuid) owner to fv_definer_owner;
revoke execute on function private.clear_first_login_gate(uuid, uuid)
  from public, authenticated, anon;
grant  execute on function private.clear_first_login_gate(uuid, uuid) to service_role;

commit;
