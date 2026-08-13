-- Stage 8A hardening · Account provisioning integrity
--
-- Account creation spans two systems — Supabase Auth and this database — and no transaction spans
-- both. The job row is therefore the durable coordinator, and it has to be strong enough that a
-- crash between the two systems is recoverable rather than duplicating a privileged account.
--
-- Defects repaired:
--   * A FAILED bootstrap left `is_bootstrap AND stage <> 'failed'` unsatisfied, so a second
--     bootstrap job — and a second Director Auth user — could be created. One bootstrap job now
--     exists for the lifetime of the database, and a retry RESUMES it.
--   * Stage said nothing about which identifiers must be present, so 'complete' could be reached
--     with no profile.
--   * Two jobs could claim the same Auth user or the same profile.
--   * profile_id and auth_user_id could disagree, though a profile IS the auth user (same uuid).
--   * There was no state to resume from: no attempt marker, no target name, no completion time.
--   * `error_detail` was free text, one careless caller away from logging a temporary password.

begin;

-- ---------------------------------------------------------------------------
-- Resumable state. None of it is secret; a temporary password is never among it.
-- ---------------------------------------------------------------------------
alter table public.account_provisioning_jobs
  add column target_full_name        text,
  add column attempt_count           integer     not null default 0,
  add column auth_attempt_started_at timestamptz,
  add column last_attempt_at         timestamptz,
  add column completed_at            timestamptz;

update public.account_provisioning_jobs
   set target_full_name = 'unknown'
 where target_full_name is null;

alter table public.account_provisioning_jobs
  alter column target_full_name set not null;

alter table public.account_provisioning_jobs
  add constraint provisioning_full_name_nonempty
    check (length(btrim(target_full_name)) > 0),
  add constraint provisioning_attempt_count_sane
    check (attempt_count >= 0);

comment on column public.account_provisioning_jobs.auth_attempt_started_at is
  'Set immediately BEFORE the Auth Admin API call and never cleared. If the process dies between '
  'the call and recording the id, this marker is the evidence that an Auth user may exist, so the '
  'retry adopts it by identifier instead of creating a second one.';

comment on column public.account_provisioning_jobs.error_detail is
  'A short failure CODE, not free text and not provider output. The pattern constraint exists so '
  'that no caller can ever put a temporary password, token, or credential in this column.';

alter table public.account_provisioning_jobs
  add constraint provisioning_error_detail_is_a_code
    check (error_detail is null or error_detail ~ '^[a-z0-9_.:-]{1,120}$');

-- ---------------------------------------------------------------------------
-- Exactly one bootstrap job, forever — including after it fails.
-- ---------------------------------------------------------------------------
drop index public.provisioning_single_bootstrap_idx;

create unique index provisioning_single_bootstrap_idx
  on public.account_provisioning_jobs ((true))
  where is_bootstrap;

comment on index public.provisioning_single_bootstrap_idx is
  'The single-holder claim for Director bootstrap. Deliberately has NO stage predicate: a failed '
  'bootstrap must be resumed, never replaced, or a second Director Auth user could be created.';

-- ---------------------------------------------------------------------------
-- Stage means something. Each stage names exactly which identifiers exist.
-- ---------------------------------------------------------------------------
alter table public.account_provisioning_jobs
  drop constraint provisioning_stage_requires_auth_user;

alter table public.account_provisioning_jobs
  add constraint provisioning_stage_shape check (
    case stage
      when 'pending'         then auth_user_id is null     and profile_id is null
      when 'auth_created'    then auth_user_id is not null and profile_id is null
      when 'profile_created' then auth_user_id is not null and profile_id is not null
      when 'complete'        then auth_user_id is not null and profile_id is not null
      -- 'failed' retains whatever was reached, which is what makes recovery possible.
      when 'failed'          then true
    end
  );

-- A profile IS its Auth user: public.profiles.id references auth.users.id. Written the long way
-- deliberately: `profile_id = auth_user_id` evaluates to NULL when auth_user_id is null, and a
-- CHECK that evaluates to NULL PASSES — which would have let a failed job hold a profile it never
-- created an Auth user for.
alter table public.account_provisioning_jobs
  add constraint provisioning_profile_is_the_auth_user
    check (profile_id is null
           or (auth_user_id is not null and profile_id = auth_user_id));

-- No two jobs may claim the same Auth user or the same profile.
create unique index provisioning_auth_user_unique_idx
  on public.account_provisioning_jobs (auth_user_id)
  where auth_user_id is not null;

create unique index provisioning_profile_unique_idx
  on public.account_provisioning_jobs (profile_id)
  where profile_id is not null;

-- ---------------------------------------------------------------------------
-- Identity, once recorded, is permanent. Recovery depends on it.
-- ---------------------------------------------------------------------------
create or replace function private.provisioning_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.auth_user_id is not null and new.auth_user_id is distinct from old.auth_user_id then
    raise exception 'account_provisioning_jobs.auth_user_id is immutable once recorded (job %)', old.id
      using errcode = 'integrity_constraint_violation';
  end if;

  if old.profile_id is not null and new.profile_id is distinct from old.profile_id then
    raise exception 'account_provisioning_jobs.profile_id is immutable once recorded (job %)', old.id
      using errcode = 'integrity_constraint_violation';
  end if;

  if old.is_bootstrap is distinct from new.is_bootstrap then
    raise exception 'account_provisioning_jobs.is_bootstrap is immutable (job %)', old.id
      using errcode = 'integrity_constraint_violation';
  end if;

  if old.stage = 'complete' and new.stage is distinct from old.stage then
    raise exception 'a complete provisioning job cannot be reopened (job %)', old.id
      using errcode = 'integrity_constraint_violation';
  end if;

  if old.auth_attempt_started_at is not null and new.auth_attempt_started_at is null then
    raise exception 'auth_attempt_started_at may not be cleared (job %)', old.id
      using errcode = 'integrity_constraint_violation';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

comment on function private.provisioning_guard() is
  'Keeps cross-system identity monotonic. SECURITY INVOKER: it only raises, so it needs no rights '
  'of its own.';

-- Explicit, because ALTER DEFAULT PRIVILEGES does not actually revoke the implicit PUBLIC EXECUTE
-- on this database (see migration 000100). Silence here would leave this callable by anyone.
revoke execute on function private.provisioning_guard() from public, anon, authenticated;

create trigger provisioning_guard_trg
  before update on public.account_provisioning_jobs
  for each row execute function private.provisioning_guard();

-- ---------------------------------------------------------------------------
-- Privileges the orchestration functions below need, as their owner.
-- ---------------------------------------------------------------------------
grant insert                 on public.profiles                  to fv_definer_owner;
grant insert, update, delete on public.user_roles                to fv_definer_owner;
grant select, insert, update on public.account_provisioning_jobs to fv_definer_owner;

create policy user_roles_definer_owner_write on public.user_roles
  for all to fv_definer_owner
  using ( true ) with check ( true );

create policy provisioning_definer_owner_all on public.account_provisioning_jobs
  for all to fv_definer_owner
  using ( true ) with check ( true );

-- ---------------------------------------------------------------------------
-- Bootstrap guard
-- ---------------------------------------------------------------------------
create or replace function private.director_exists()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.user_roles r where r.role = 'director');
$$;

alter function private.director_exists() owner to fv_definer_owner;
revoke execute on function private.director_exists() from public, anon, authenticated;
grant  execute on function private.director_exists() to service_role;

-- ---------------------------------------------------------------------------
-- 1. CLAIM — creates the durable job, or resumes the existing one.
-- ---------------------------------------------------------------------------
create or replace function private.claim_provisioning_job(
  p_idempotency_key text,
  p_requested_by    uuid,
  p_full_name       text,
  p_phone_e164      text,
  p_role            public.app_role,
  p_is_bootstrap    boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job   public.account_provisioning_jobs%rowtype;
  v_stage public.provisioning_stage;
begin
  if p_is_bootstrap then
    if p_requested_by is not null then
      return jsonb_build_object('ok', false, 'reason', 'bootstrap_has_no_requester');
    end if;

    if p_role <> 'director' then
      return jsonb_build_object('ok', false, 'reason', 'bootstrap_must_be_director');
    end if;

    -- The bootstrap job is the single holder. Take it if it already exists, whatever its state.
    select * into v_job
      from public.account_provisioning_jobs
     where is_bootstrap
     for update;

    if not found and private.director_exists() then
      return jsonb_build_object('ok', false, 'reason', 'already_bootstrapped');
    end if;
  else
    if not private.is_live_director(p_requested_by) then
      raise exception 'claim_provisioning_job: requester % is not a live Director', p_requested_by
        using errcode = 'insufficient_privilege';
    end if;

    select * into v_job
      from public.account_provisioning_jobs
     where idempotency_key = p_idempotency_key
     for update;
  end if;

  if found then
    -- Same key, different payload: this is a bug or a replay of the wrong request, never a resume.
    if v_job.target_phone_e164 <> p_phone_e164
       or v_job.target_role   <> p_role
       or v_job.is_bootstrap  <> p_is_bootstrap then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;

    -- Resume from whatever was actually reached. A failed job returns to the stage its recorded
    -- identifiers prove, so recovery never repeats a step that already succeeded.
    v_stage := v_job.stage;
    if v_stage = 'failed' then
      -- Cast explicitly: an untyped literal here is `text`, and relying on an implicit assignment
      -- cast into an enum is exactly what `supabase db lint` flags.
      v_stage := case
                   when v_job.profile_id   is not null then 'profile_created'::public.provisioning_stage
                   when v_job.auth_user_id is not null then 'auth_created'::public.provisioning_stage
                   else                                     'pending'::public.provisioning_stage
                 end;
    end if;

    update public.account_provisioning_jobs
       set stage           = v_stage,
           error_detail    = null,
           attempt_count   = attempt_count + 1,
           last_attempt_at = now()
     where id = v_job.id
     returning * into v_job;

    return jsonb_build_object('ok', true, 'reason', 'resumed', 'job', to_jsonb(v_job));
  end if;

  -- A phone already in use would fail later at the profiles unique constraint; refuse now, before
  -- an Auth user is created that would have to be cleaned up.
  if exists (select 1 from public.profiles p where p.phone_e164 = p_phone_e164) then
    return jsonb_build_object('ok', false, 'reason', 'phone_in_use');
  end if;

  begin
    insert into public.account_provisioning_jobs (
      idempotency_key, requested_by, target_full_name, target_phone_e164, target_role,
      is_bootstrap, stage, attempt_count, last_attempt_at
    )
    values (
      p_idempotency_key, p_requested_by, p_full_name, p_phone_e164, p_role,
      p_is_bootstrap, 'pending', 1, now()
    )
    returning * into v_job;
  exception when unique_violation then
    -- A concurrent claim won the race. Take its job rather than making a second one.
    select * into v_job
      from public.account_provisioning_jobs
     where (p_is_bootstrap and is_bootstrap)
        or (not p_is_bootstrap and idempotency_key = p_idempotency_key)
     for update;

    if not found then
      raise;
    end if;

    return jsonb_build_object('ok', true, 'reason', 'resumed', 'job', to_jsonb(v_job));
  end;

  return jsonb_build_object('ok', true, 'reason', 'claimed', 'job', to_jsonb(v_job));
end;
$$;

alter function private.claim_provisioning_job(text, uuid, text, text, public.app_role, boolean)
  owner to fv_definer_owner;
revoke execute on function private.claim_provisioning_job(text, uuid, text, text, public.app_role, boolean)
  from public, anon, authenticated;
grant  execute on function private.claim_provisioning_job(text, uuid, text, text, public.app_role, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. BEGIN AUTH ATTEMPT — the mutual exclusion that stops two Auth users existing.
-- ---------------------------------------------------------------------------
create or replace function private.begin_auth_attempt(
  p_job_id      uuid,
  p_stale_after interval default '10 minutes'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.account_provisioning_jobs%rowtype;
begin
  update public.account_provisioning_jobs
     set auth_attempt_started_at = now(),
         attempt_count           = attempt_count + 1,
         last_attempt_at         = now()
   where id           = p_job_id
     and stage        = 'pending'
     and auth_user_id is null
     and (auth_attempt_started_at is null
          or auth_attempt_started_at < now() - p_stale_after)
   returning * into v_job;

  if found then
    return jsonb_build_object('ok', true, 'job', to_jsonb(v_job));
  end if;

  select * into v_job from public.account_provisioning_jobs where id = p_job_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_job');
  end if;

  if v_job.auth_user_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'auth_user_already_exists',
                              'job', to_jsonb(v_job));
  end if;

  if v_job.stage <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'not_pending', 'job', to_jsonb(v_job));
  end if;

  -- Pending, no id, but an attempt is already running: an Auth user MAY exist and be unrecorded.
  -- The caller must adopt by identifier, not create.
  return jsonb_build_object('ok', false, 'reason', 'attempt_in_progress', 'job', to_jsonb(v_job));
end;
$$;

alter function private.begin_auth_attempt(uuid, interval) owner to fv_definer_owner;
revoke execute on function private.begin_auth_attempt(uuid, interval) from public, anon, authenticated;
grant  execute on function private.begin_auth_attempt(uuid, interval) to service_role;

-- ---------------------------------------------------------------------------
-- 3. RECORD AUTH USER
-- ---------------------------------------------------------------------------
create or replace function private.record_provisioning_auth_user(
  p_job_id       uuid,
  p_auth_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.account_provisioning_jobs%rowtype;
begin
  select * into v_job from public.account_provisioning_jobs where id = p_job_id for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_job');
  end if;

  if v_job.auth_user_id is not null then
    if v_job.auth_user_id = p_auth_user_id then
      return jsonb_build_object('ok', true, 'reason', 'already_recorded', 'job', to_jsonb(v_job));
    end if;
    -- This job already owns a different Auth user. The caller created an orphan and must disable
    -- it; the recorded id is returned so the two can be told apart.
    return jsonb_build_object('ok', false, 'reason', 'auth_user_conflict',
                              'recorded_auth_user_id', v_job.auth_user_id,
                              'orphan_auth_user_id', p_auth_user_id);
  end if;

  begin
    update public.account_provisioning_jobs
       set auth_user_id    = p_auth_user_id,
           stage           = 'auth_created',
           last_attempt_at = now()
     where id = p_job_id
     returning * into v_job;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'auth_user_claimed_by_other_job',
                              'orphan_auth_user_id', p_auth_user_id);
  end;

  return jsonb_build_object('ok', true, 'reason', 'recorded', 'job', to_jsonb(v_job));
end;
$$;

alter function private.record_provisioning_auth_user(uuid, uuid) owner to fv_definer_owner;
revoke execute on function private.record_provisioning_auth_user(uuid, uuid)
  from public, anon, authenticated;
grant  execute on function private.record_provisioning_auth_user(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. COMPLETE — profile inactive first, role assigned, activated last.
-- ---------------------------------------------------------------------------
create or replace function private.complete_provisioning(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job        public.account_provisioning_jobs%rowtype;
  v_actor_role public.app_role;
  v_corr       uuid := gen_random_uuid();
  v_role_now   public.app_role;
begin
  select * into v_job from public.account_provisioning_jobs where id = p_job_id for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_job');
  end if;

  if v_job.stage = 'complete' then
    return jsonb_build_object('ok', true, 'reason', 'already_complete', 'job', to_jsonb(v_job));
  end if;

  if v_job.auth_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_auth_user');
  end if;

  -- Inactive and gated on insert: a half-finished account has zero access by construction.
  insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password)
  values (v_job.auth_user_id, v_job.target_full_name, v_job.target_phone_e164, false, true)
  on conflict (id) do nothing;

  insert into public.user_roles (user_id, role, assigned_by)
  values (v_job.auth_user_id, v_job.target_role, v_job.requested_by)
  on conflict (user_id) do nothing;

  select r.role into v_role_now from public.user_roles r where r.user_id = v_job.auth_user_id;

  if v_role_now is distinct from v_job.target_role then
    return jsonb_build_object('ok', false, 'reason', 'role_conflict',
                              'existing_role', v_role_now);
  end if;

  update public.account_provisioning_jobs
     set stage      = 'profile_created',
         profile_id = v_job.auth_user_id
   where id = p_job_id;

  -- Activation is the last step, so every earlier failure leaves an account that can do nothing.
  update public.profiles
     set is_active  = true,
         updated_at = now()
   where id = v_job.auth_user_id;

  update public.account_provisioning_jobs
     set stage           = 'complete',
         completed_at    = now(),
         error_detail    = null,
         last_attempt_at = now()
   where id = p_job_id
   returning * into v_job;

  if v_job.requested_by is not null then
    v_actor_role := private.live_role_of(v_job.requested_by);
  end if;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    after_state, correlation_id, source_operation
  )
  values (
    v_job.requested_by,
    v_actor_role,
    v_job.requested_by is null,
    case when v_job.is_bootstrap then 'director_bootstrapped' else 'account_provisioned' end,
    'profile',
    v_job.auth_user_id,
    jsonb_build_object('role', v_job.target_role,
                       'phone_e164', v_job.target_phone_e164,
                       'is_active', true,
                       'must_change_password', true),
    v_corr,
    'private.complete_provisioning'
  );

  return jsonb_build_object('ok', true, 'reason', 'completed', 'job', to_jsonb(v_job));
end;
$$;

alter function private.complete_provisioning(uuid) owner to fv_definer_owner;
revoke execute on function private.complete_provisioning(uuid) from public, anon, authenticated;
grant  execute on function private.complete_provisioning(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. FAIL — records a CODE and keeps every identifier reached.
-- ---------------------------------------------------------------------------
create or replace function private.fail_provisioning(p_job_id uuid, p_error_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.account_provisioning_jobs%rowtype;
begin
  update public.account_provisioning_jobs
     set stage           = 'failed',
         error_detail    = p_error_code,
         last_attempt_at = now()
   where id = p_job_id
     and stage <> 'complete'
   returning * into v_job;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_job_or_complete');
  end if;

  return jsonb_build_object('ok', true, 'job', to_jsonb(v_job));
end;
$$;

alter function private.fail_provisioning(uuid, text) owner to fv_definer_owner;
revoke execute on function private.fail_provisioning(uuid, text) from public, anon, authenticated;
grant  execute on function private.fail_provisioning(uuid, text) to service_role;

commit;
