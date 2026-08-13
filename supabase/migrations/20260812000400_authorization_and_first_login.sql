-- Stage 8A · Live authorization, first-login proof, Auth hook
--
-- THE central rule (architecture.md §7.4): a JWT role claim is a routing hint.
-- Authorization reads live database state — identity, activation, first-login
-- gate, and role — on every evaluation. Nothing here consults auth.jwt().

begin;

-- ---------------------------------------------------------------------------
-- Caller identity WITHOUT an auth-schema dependency.
--
-- auth.uid() lives in the auth schema, which SECURITY DEFINER functions owned by
-- fv_definer_owner cannot reach: postgres holds no GRANT OPTION on auth, so the
-- grant silently no-ops. auth.uid() is only a reader of the request GUC that
-- PostgREST populates from the *verified* JWT, so we read the same GUC directly.
-- Identical trust source, zero auth-schema coupling.
-- ---------------------------------------------------------------------------
create or replace function private.request_uid()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(
           coalesce(
             nullif(current_setting('request.jwt.claim.sub', true), ''),
             nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
           ),
           ''
         )::uuid;
$$;

comment on function private.request_uid() is
  'Caller uuid from the verified JWT request GUC. Same source as auth.uid(), without '
  'depending on the auth schema, which migrations cannot grant access to.';

revoke execute on function private.request_uid() from public, anon;
-- fv_definer_owner is required: request_uid is SECURITY INVOKER, so when called
-- from inside a definer function the privilege check is against that owner.
grant  execute on function private.request_uid()
  to authenticated, service_role, fv_definer_owner, postgres;

-- ---------------------------------------------------------------------------
-- CLASS 2 · authorization predicate. STABLE, side-effect free, never audits.
-- ---------------------------------------------------------------------------
create or replace function private.authorize(required_roles public.app_role[])
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
    where p.id                   = private.request_uid()
      and p.is_active            = true
      and p.must_change_password = false
      and r.role                 = any (required_roles)
  );
$$;

comment on function private.authorize(public.app_role[]) is
  'Live authorization predicate. Verifies auth.uid(), is_active, the first-login gate, '
  'and a single live user_roles row. Writes nothing — it runs per candidate row under RLS.';

alter function private.authorize(public.app_role[]) owner to fv_definer_owner;
revoke execute on function private.authorize(public.app_role[]) from public, anon;
grant  execute on function private.authorize(public.app_role[])
  to authenticated, service_role, postgres;

-- ---------------------------------------------------------------------------
-- Routing hint only. Never referenced by a policy or an authority check.
-- ---------------------------------------------------------------------------
create or replace function private.current_role_hint()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select r.role
  from public.user_roles r
  join public.profiles p on p.id = r.user_id
  where r.user_id = private.request_uid()
    and p.is_active = true;
$$;

comment on function private.current_role_hint() is
  'Interface/routing hint only. Not an authorization mechanism. Reads live state so it '
  'cannot outlive a role change, but no RLS policy depends on it.';

alter function private.current_role_hint() owner to fv_definer_owner;
revoke execute on function private.current_role_hint() from public, anon;
grant  execute on function private.current_role_hint()
  to authenticated, service_role, postgres;

-- ---------------------------------------------------------------------------
-- First-login gate: SERVER-MEDIATED, no client-callable completion.
--
-- PLATFORM CONSTRAINT, proven on this database:
--   postgres is not a superuser and is not a member of supabase_auth_admin or
--   supabase_admin. `grant usage on schema auth to <role>` emits
--   "WARNING: no privileges were granted" and silently does nothing, so a
--   migration cannot obtain auth.users access. An in-database proof that
--   compares password hashes is therefore not implementable here.
--
-- The replacement is stronger than the proof it replaces: rather than letting a
-- client clear the gate and then inferring whether it was entitled to, NO client
-- can clear it at all. `authenticated` has no RPC and no column grant. The only
-- actor that can clear the gate is the server, using the secret key, in the same
-- operation in which it performed and observed a successful Auth password change.
-- ---------------------------------------------------------------------------

-- Arm the gate. Used at provisioning and at every Director-initiated reset, so a
-- reset always re-arms and cannot be satisfied by an earlier change.
create or replace function private.arm_first_login_gate(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
     set must_change_password = true,
         updated_at           = now()
   where id = p_user_id;

  if not found then
    raise exception 'arm_first_login_gate: no profile for %', p_user_id
      using errcode = 'no_data_found';
  end if;

  insert into public.audit_events (is_system_actor, action, entity_type, entity_id,
                                   correlation_id, source_operation)
  values (true, 'first_login_gate_armed', 'profile', p_user_id,
          gen_random_uuid(), 'private.arm_first_login_gate');
end;
$$;

alter function private.arm_first_login_gate(uuid) owner to fv_definer_owner;
revoke execute on function private.arm_first_login_gate(uuid) from public, authenticated, anon;
grant  execute on function private.arm_first_login_gate(uuid) to service_role;

-- Clear the gate. Callable ONLY by service_role, i.e. the server holding the
-- secret key, which calls it only after Supabase Auth has confirmed the password
-- change for that same user. Never granted to authenticated or anon.
create or replace function private.clear_first_login_gate(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
begin
  select * into v_profile from public.profiles where id = p_user_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;

  if not v_profile.is_active then
    return jsonb_build_object('ok', false, 'reason', 'inactive');
  end if;

  -- Idempotent, so a retry after a partial failure succeeds.
  if not v_profile.must_change_password then
    return jsonb_build_object('ok', true, 'reason', 'already_completed');
  end if;

  update public.profiles
     set must_change_password = false,
         updated_at           = now()
   where id = p_user_id;

  insert into public.audit_events (actor_id, action, entity_type, entity_id,
                                   correlation_id, source_operation)
  values (p_user_id, 'first_login_completed', 'profile', p_user_id,
          gen_random_uuid(), 'private.clear_first_login_gate');

  return jsonb_build_object('ok', true, 'reason', 'completed');
end;
$$;

alter function private.clear_first_login_gate(uuid) owner to fv_definer_owner;
revoke execute on function private.clear_first_login_gate(uuid) from public, authenticated, anon;
grant  execute on function private.clear_first_login_gate(uuid) to service_role;

-- There is deliberately NO api.complete_first_login(). A gated client has no
-- callable path to its own gate; test 002 asserts that no such function exists.

-- ---------------------------------------------------------------------------
-- CLASS 3 · Custom Access Token hook. ONE privilege model: SECURITY DEFINER.
--
-- Privileges live with the OWNER; execution rights live with the CALLER.
--   fv_definer_owner  → SELECT on public.user_roles + an explicit RLS policy,
--                       because the owner is not the table owner and RLS applies.
--   supabase_auth_admin → EXECUTE on the function and NO table grant at all.
-- ---------------------------------------------------------------------------
grant select on public.user_roles to fv_definer_owner;

create or replace function private.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role   public.app_role;
  v_claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
begin
  select r.role
    into v_role
    from public.user_roles r
   where r.user_id = (event ->> 'user_id')::uuid;

  if v_role is not null then
    v_claims := jsonb_set(v_claims, '{user_role}', to_jsonb(v_role::text), true);
  else
    v_claims := v_claims - 'user_role';
  end if;

  return jsonb_set(event, '{claims}', v_claims, true);
end;
$$;

comment on function private.custom_access_token_hook(jsonb) is
  'Adds a user_role ROUTING HINT to the JWT. Never an authorization source: '
  'private.authorize() reads live state and ignores this claim entirely.';

alter function private.custom_access_token_hook(jsonb) owner to fv_definer_owner;
revoke execute on function private.custom_access_token_hook(jsonb) from public, anon, authenticated;
grant  usage   on schema private to supabase_auth_admin;
grant  execute on function private.custom_access_token_hook(jsonb) to supabase_auth_admin;

commit;
