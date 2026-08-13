-- Stage 8B corrective · A duplicate phone names the account it collides with
--
-- Refreshing the create-account page mints a NEW idempotency key, so the resubmission is a new job
-- and is refused with `phone_in_use` rather than `already_provisioned`. That refusal was a dead end:
-- correct, but it left the Director looking at an error for an account that already existed, with
-- no way to get a usable credential for it.
--
-- The refusal now names the existing account, so the interface can offer the one action that helps:
-- issue a new temporary password for it. This tells a Director nothing they cannot already see —
-- they may read every profile — and it is the difference between "that did not work" and "here is
-- the account you were trying to create".

begin;

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
  v_job      public.account_provisioning_jobs%rowtype;
  v_stage    public.provisioning_stage;
  v_existing uuid;
begin
  if p_is_bootstrap then
    if p_requested_by is not null then
      return jsonb_build_object('ok', false, 'reason', 'bootstrap_has_no_requester');
    end if;

    if p_role <> 'director' then
      return jsonb_build_object('ok', false, 'reason', 'bootstrap_must_be_director');
    end if;

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
    if v_job.target_phone_e164 <> p_phone_e164
       or v_job.target_role   <> p_role
       or v_job.is_bootstrap  <> p_is_bootstrap then
      return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
    end if;

    v_stage := v_job.stage;
    if v_stage = 'failed' then
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

  -- The phone is what actually prevents a duplicate account after a refresh, and the account it
  -- collides with is the one the Director was trying to create.
  select id into v_existing from public.profiles where phone_e164 = p_phone_e164;
  if v_existing is not null then
    return jsonb_build_object('ok', false, 'reason', 'phone_in_use', 'existing_user_id', v_existing);
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
  from public, anon, authenticated, service_role;

commit;
