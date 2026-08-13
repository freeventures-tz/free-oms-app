-- Stage 8B corrective · Forced first login becomes a durable, resumable operation
--
-- THE DEFECT
--   Completion was: change the password through the user's session, then clear the gate. If the
--   password change succeeded and the gate clear failed, the retry called `updateUser` again with
--   the same password — and Supabase Auth answers
--
--       422 { "error_code": "same_password" }
--
--   (verified against the running stack). The user was stuck: the password they had already chosen
--   was now the one Auth refused to accept. The documentation promised a retry the code could not
--   perform.
--
-- THE FIX
--   The observed Auth success is written down BEFORE the gate is touched, as its own step. A retry
--   reads that record, SKIPS Auth entirely, and completes — needing no password at all, let alone a
--   different one.
--
--   This also makes the gate strictly harder to clear than before: `clear_first_login_gate` now
--   requires an operation that reached `auth_changed`, so the server cannot clear a gate without
--   having recorded an Auth success for that same user. It is not merely a recovery mechanism; it
--   is the evidence.
--
--   Arming the gate SUPERSEDES any live operation, so a Director reset can never be satisfied by a
--   password change that happened before it.

begin;

create type public.first_login_stage as enum ('pending', 'auth_changed', 'complete', 'superseded');

create table public.first_login_operations (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete restrict,
  stage           public.first_login_stage not null default 'pending',

  -- Set immediately before the Auth call is issued, so an unresolved attempt is visible afterwards.
  dispatched_at   timestamptz,
  auth_changed_at timestamptz,
  completed_at    timestamptz,
  attempt_count   integer not null default 0 check (attempt_count >= 0),

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint first_login_stage_shape check (
    case stage
      when 'pending'      then auth_changed_at is null and completed_at is null
      when 'auth_changed' then auth_changed_at is not null and completed_at is null
      when 'complete'     then auth_changed_at is not null and completed_at is not null
      when 'superseded'   then true
    end
  )
);

comment on table public.first_login_operations is
  'One live forced-password-change operation per user. Holds no password and no password-derived '
  'value — only the fact that Supabase Auth confirmed a change, and when.';

-- At most one live operation per user; superseded and complete rows are history.
create unique index first_login_operations_live_idx
  on public.first_login_operations (user_id)
  where stage in ('pending', 'auth_changed');

create index first_login_operations_user_idx on public.first_login_operations (user_id, created_at desc);

alter table public.first_login_operations enable row level security;

-- A user may see their own operation, which is what lets the setup screen tell them they only need
-- to finish. Deliberately no `authorize()` call: the caller is gated by definition.
grant select on public.first_login_operations to authenticated;

create policy first_login_operations_select_own on public.first_login_operations
  for select to authenticated
  using ( user_id = (select private.request_uid()) );

grant select, insert, update on public.first_login_operations to fv_definer_owner;

create policy first_login_operations_definer_owner_all on public.first_login_operations
  for all to fv_definer_owner
  using ( true ) with check ( true );

-- ---------------------------------------------------------------------------
-- Arming the gate invalidates any evidence gathered before it
-- ---------------------------------------------------------------------------
create or replace function private.invalidate_first_login_operations(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.first_login_operations
     set stage = 'superseded', updated_at = now()
   where user_id = p_user_id
     and stage in ('pending', 'auth_changed');

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

alter function private.invalidate_first_login_operations(uuid) owner to fv_definer_owner;
revoke execute on function private.invalidate_first_login_operations(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. BEGIN — hands back the live operation, creating one if this is a first attempt.
-- ---------------------------------------------------------------------------
create or replace function private.begin_first_login(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_op      public.first_login_operations%rowtype;
begin
  select * into v_profile from public.profiles where id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;
  if not v_profile.is_active then
    return jsonb_build_object('ok', false, 'reason', 'inactive');
  end if;
  if not v_profile.must_change_password then
    return jsonb_build_object('ok', true, 'reason', 'not_gated');
  end if;

  select * into v_op
    from public.first_login_operations
   where user_id = p_user_id and stage in ('pending', 'auth_changed')
   for update;

  if not found then
    insert into public.first_login_operations (user_id, stage, dispatched_at, attempt_count)
    values (p_user_id, 'pending', now(), 1)
    returning * into v_op;
  else
    update public.first_login_operations
       set attempt_count = attempt_count + 1,
           dispatched_at = coalesce(dispatched_at, now()),
           updated_at    = now()
     where id = v_op.id
     returning * into v_op;
  end if;

  return jsonb_build_object('ok', true, 'reason', 'ready', 'operation', to_jsonb(v_op));
end;
$$;

alter function private.begin_first_login(uuid) owner to fv_definer_owner;
revoke execute on function private.begin_first_login(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. RECORD — the observed Auth success, written before the gate is touched.
-- ---------------------------------------------------------------------------
create or replace function private.record_first_login_password_changed(
  p_operation_id uuid,
  p_user_id      uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_op public.first_login_operations%rowtype;
begin
  select * into v_op from public.first_login_operations
   where id = p_operation_id for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_operation');
  end if;

  -- The operation must belong to the user the server resolved from the session.
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
     set stage = 'auth_changed', auth_changed_at = now(), updated_at = now()
   where id = p_operation_id
   returning * into v_op;

  return jsonb_build_object('ok', true, 'reason', 'recorded', 'operation', to_jsonb(v_op));
end;
$$;

alter function private.record_first_login_password_changed(uuid, uuid) owner to fv_definer_owner;
revoke execute on function private.record_first_login_password_changed(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. COMPLETE — now requires recorded evidence, not just a trusted caller.
-- ---------------------------------------------------------------------------
drop function if exists private.clear_first_login_gate(uuid, uuid);

create or replace function private.clear_first_login_gate(
  p_user_id        uuid,
  p_operation_id   uuid,
  p_correlation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_op      public.first_login_operations%rowtype;
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

  select * into v_op from public.first_login_operations
   where id = p_operation_id for update;

  if not found or v_op.user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'reason', 'no_operation');
  end if;

  if v_op.stage = 'superseded' then
    return jsonb_build_object('ok', false, 'reason', 'superseded');
  end if;

  -- Idempotent: a retry after a partial failure succeeds rather than erroring.
  if v_op.stage = 'complete' and not v_profile.must_change_password then
    return jsonb_build_object('ok', true, 'reason', 'already_completed');
  end if;

  -- THE evidence requirement. Without a recorded Auth success there is nothing to complete, and
  -- no caller — however privileged — can substitute its own say-so for it.
  if v_op.stage <> 'auth_changed' then
    return jsonb_build_object('ok', false, 'reason', 'password_change_not_recorded');
  end if;

  v_role := private.live_role_of(p_user_id);
  if v_role is null then
    return jsonb_build_object('ok', false, 'reason', 'no_role');
  end if;

  update public.profiles
     set must_change_password = false, updated_at = now()
   where id = p_user_id;

  update public.first_login_operations
     set stage = 'complete', completed_at = now(), updated_at = now()
   where id = p_operation_id;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    after_state, correlation_id, source_operation
  )
  values (
    p_user_id, v_role, false, 'first_login_completed', 'profile', p_user_id,
    jsonb_build_object('must_change_password', false, 'operation_id', p_operation_id),
    v_corr, 'private.clear_first_login_gate'
  );

  return jsonb_build_object('ok', true, 'reason', 'completed', 'correlation_id', v_corr);
end;
$$;

alter function private.clear_first_login_gate(uuid, uuid, uuid) owner to fv_definer_owner;
revoke execute on function private.clear_first_login_gate(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

commit;
