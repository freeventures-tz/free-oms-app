-- Issue #84 · A Director decides who is accountable for an imprest loss or count shortage
--
-- product.md §13.1 and §15, design.md §7B.10, architecture.md §10.10 and AC-70. An imprest
-- unexplained loss and a confirmed imprest count shortage post and then wait for a Director's
-- accountability decision. This records it.
--
--   accountability_decisions        one row per decided subject: the subject, the Director, when,
--                                   and the written decision explaining responsibility and
--                                   resolution. Never changed or deleted.
--   accountability_decision_staff   the staff a decision names as responsible, if any. A decision
--                                   names at least one, or states that nobody has been identified.
--
-- A DECISION IS A RECORD AND NOTHING ELSE. It posts nothing, changes no balance, moves no stock and
-- triggers no payroll action. It has no outcome list and no recovery amount. It closes the
-- subject's place in the Directors' undecided list, and the subject's own rows are never touched.
--
-- ONE COMMAND, MANY SUBJECTS. `subject_type` names the kind of thing decided, and each kind has its
-- own foreign-key column, so later subjects (a till or stock variance) add an enum label and a
-- column without a second command. Exactly one subject column is set, and each is unique: a subject
-- gets at most one decision.
--
-- DIRECTORS ONLY, AND EVERY REFUSAL IS ON THE TRAIL. A live member of staff in any other role is
-- refused by the command as a committed refusal, so the attempt is audited with their live role.
-- A request with no session, or from an account that is not live, is refused before anything is
-- written, as every other command refuses it.
--
-- One released function is replaced, signature unchanged: `private.imprest_fund_unresolved`, which
-- lists what a retired or retiring fund still waits on, no longer lists a decided loss or shortage.

begin;

-- ---------------------------------------------------------------------------
-- The record
-- ---------------------------------------------------------------------------
create type public.accountability_subject_type as enum (
  'imprest_unexplained_loss',  -- an imprest posting of kind unexplained_loss, not a reversal
  'imprest_count_shortage'     -- an imprest count posting of kind count_shortage
);

comment on type public.accountability_subject_type is
  'What a Director''s accountability decision is about (issue #84). Later subjects add a label.';

create table public.accountability_decisions (
  id                        uuid primary key default gen_random_uuid(),
  subject_type              public.accountability_subject_type not null,
  imprest_posting_id        uuid unique references public.imprest_postings (id) on delete restrict,
  imprest_count_posting_id  uuid unique references public.imprest_count_postings (id)
                              on delete restrict,
  -- The fund the subject belongs to, copied from it and checked against it.
  fund_id                   uuid not null references public.imprest_funds (id) on delete restrict,
  -- Trimmed of every kind of whitespace, so a decision of only tabs and line breaks is no decision.
  decision                  text not null
                              check (length(btrim(decision, E' 	
')) between 3 and 2000),
  nobody_identified         boolean not null,
  decided_by                uuid not null references public.profiles (id),
  decided_at                timestamptz not null default now(),
  correlation_id            uuid not null,
  constraint accountability_subject_shape check (
    num_nonnulls(imprest_posting_id, imprest_count_posting_id) = 1
    and (subject_type = 'imprest_unexplained_loss') = (imprest_posting_id is not null)
    and (subject_type = 'imprest_count_shortage') = (imprest_count_posting_id is not null)
  )
);

comment on table public.accountability_decisions is
  'A Director''s accountability decision on one subject (issue #84, product.md §15): the written '
  'decision, who decided and when. At most one per subject. A record only: it posts nothing and '
  'triggers no payroll action. Never changed or deleted.';

create index accountability_decisions_decided_at_idx
  on public.accountability_decisions (decided_at desc);
create index accountability_decisions_fund_idx on public.accountability_decisions (fund_id);
create index accountability_decisions_decided_by_idx on public.accountability_decisions (decided_by);

create table public.accountability_decision_staff (
  decision_id  uuid not null references public.accountability_decisions (id) on delete restrict,
  staff_id     uuid not null references public.profiles (id) on delete restrict,
  primary key (decision_id, staff_id)
);

comment on table public.accountability_decision_staff is
  'The staff a decision names as responsible (issue #84). Written with the decision and never '
  'changed. A decision that states nobody has been identified names nobody here.';

create index accountability_decision_staff_staff_idx
  on public.accountability_decision_staff (staff_id);

-- ---------------------------------------------------------------------------
-- Nothing is ever changed or deleted
-- ---------------------------------------------------------------------------
create or replace function private.refuse_accountability_edit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'an accountability decision is permanent: it is never changed or deleted'
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger accountability_decisions_append_only
  before update or delete on public.accountability_decisions
  for each row execute function private.refuse_accountability_edit();
create trigger accountability_decisions_no_truncate
  before truncate on public.accountability_decisions
  for each statement execute function private.refuse_accountability_edit();
create trigger accountability_decision_staff_append_only
  before update or delete on public.accountability_decision_staff
  for each row execute function private.refuse_accountability_edit();
create trigger accountability_decision_staff_no_truncate
  before truncate on public.accountability_decision_staff
  for each statement execute function private.refuse_accountability_edit();

-- ---------------------------------------------------------------------------
-- A decision is about a real, undecided subject, and names staff or states nobody, at commit
-- ---------------------------------------------------------------------------
create or replace function private.check_accountability_decision(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d     public.accountability_decisions%rowtype;
  v_named integer;
begin
  select * into v_d from public.accountability_decisions where id = p_id;
  if not found then
    raise exception 'responsible staff name a decision that does not exist'
      using errcode = 'check_violation';
  end if;

  if v_d.subject_type = 'imprest_unexplained_loss' and not exists (
       select 1 from public.imprest_postings p
        where p.id = v_d.imprest_posting_id and p.fund_id = v_d.fund_id
          and p.kind = 'unexplained_loss' and p.needs_director_decision) then
    raise exception 'decision % is not about an unexplained loss of its fund', p_id
      using errcode = 'check_violation';
  elsif v_d.subject_type = 'imprest_count_shortage' and not exists (
       select 1 from public.imprest_count_postings cp
        where cp.id = v_d.imprest_count_posting_id and cp.fund_id = v_d.fund_id
          and cp.kind = 'count_shortage' and cp.needs_director_decision) then
    raise exception 'decision % is not about a count shortage of its fund', p_id
      using errcode = 'check_violation';
  end if;

  select count(*) into v_named from public.accountability_decision_staff where decision_id = p_id;
  if v_d.nobody_identified <> (v_named = 0) then
    raise exception 'decision % must name responsible staff or state that nobody is identified, '
                    'not both and not neither', p_id
      using errcode = 'check_violation';
  end if;
end;
$$;

create or replace function private.check_accountability_decision_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'accountability_decisions' then
    perform private.check_accountability_decision(new.id);
  else
    perform private.check_accountability_decision(new.decision_id);
  end if;
  return null;
end;
$$;

create constraint trigger accountability_decision_complete
  after insert on public.accountability_decisions
  deferrable initially deferred
  for each row execute function private.check_accountability_decision_row();
create constraint trigger accountability_decision_staff_complete
  after insert on public.accountability_decision_staff
  deferrable initially deferred
  for each row execute function private.check_accountability_decision_row();

-- ---------------------------------------------------------------------------
-- Grants and row-level security: Directors and the Manager read, the command alone writes
-- ---------------------------------------------------------------------------
alter table public.accountability_decisions enable row level security;
alter table public.accountability_decision_staff enable row level security;

revoke all on public.accountability_decisions, public.accountability_decision_staff
  from public, anon, authenticated, service_role;
grant select on public.accountability_decisions, public.accountability_decision_staff
  to authenticated;
grant select, insert on public.accountability_decisions, public.accountability_decision_staff
  to fv_definer_owner;

-- architecture.md §13.4: Directors and the Manager read decisions; a Cashier and a Sales
-- Representative are shown no accountability information.
create policy accountability_decisions_select on public.accountability_decisions
  for select to authenticated
  using ((select private.authorize(array['director', 'manager']::public.app_role[])));
create policy accountability_decision_staff_select on public.accountability_decision_staff
  for select to authenticated
  using ((select private.authorize(array['director', 'manager']::public.app_role[])));
create policy accountability_decisions_definer_owner on public.accountability_decisions
  for all to fv_definer_owner using (true) with check (true);
create policy accountability_decision_staff_definer_owner on public.accountability_decision_staff
  for all to fv_definer_owner using (true) with check (true);

-- ---------------------------------------------------------------------------
-- What is still waiting
-- ---------------------------------------------------------------------------
-- Replaced (issue #72's), signature unchanged: a decided loss or shortage no longer waits.
create or replace function private.imprest_fund_unresolved(p_fund_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'losses', coalesce((
      select jsonb_agg(jsonb_build_object('posting_id', p.id, 'disbursement_id', d.id,
                                          'disbursement_no', d.disbursement_no,
                                          'amount_tzs', p.amount_tzs, 'posted_at', p.posted_at)
                       order by p.posted_at, d.disbursement_no)
        from public.imprest_postings p
        join public.imprest_disbursements d on d.id = p.disbursement_id
       where p.fund_id = p_fund_id and p.needs_director_decision
         and not exists (select 1 from public.imprest_postings x
                          where x.corrects_posting_id = p.id and x.entry = 'reversal')
         and not exists (select 1 from public.accountability_decisions a
                          where a.imprest_posting_id = p.id)), '[]'),
    'shortages', coalesce((
      select jsonb_agg(jsonb_build_object('count_id', cp.count_id, 'business_date', c.business_date,
                                          'amount_tzs', cp.amount_tzs)
                       order by c.business_date)
        from public.imprest_count_postings cp
        join public.imprest_counts c on c.id = cp.count_id
       where cp.fund_id = p_fund_id and cp.needs_director_decision
         and not exists (select 1 from public.accountability_decisions a
                          where a.imprest_count_posting_id = cp.id)), '[]'),
    'excesses_tzs', (select coalesce(sum(cp.amount_tzs), 0) from public.imprest_count_postings cp
                      where cp.fund_id = p_fund_id and cp.kind = 'count_excess'),
    'not_counted_days', coalesce((
      select jsonb_agg(d.business_date order by d.business_date)
        from private.imprest_count_days(p_fund_id) d where d.state = 'not_counted'), '[]'));
$$;

comment on function private.imprest_fund_unresolved(uuid) is
  'A fund''s unexplained losses and count shortages waiting for a Director''s decision, its count '
  'excesses, and its Not counted days (issue #72). A decided loss or shortage no longer waits '
  '(issue #84). Retirement resolves none of them.';

-- ---------------------------------------------------------------------------
-- The command
-- ---------------------------------------------------------------------------
create or replace function private.accountability_decision_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(a) || jsonb_build_object(
           'subject_id', coalesce(a.imprest_posting_id, a.imprest_count_posting_id),
           'decided_by_name', pr.full_name,
           -- What was decided, so a decision reads on its own: the payment or the day counted.
           'amount_tzs', coalesce(ip.amount_tzs, cp.amount_tzs),
           'disbursement_id', d.id, 'disbursement_no', d.disbursement_no,
           'business_date', c.business_date,
           'responsible', coalesce((
             select jsonb_agg(jsonb_build_object('id', s.staff_id, 'full_name', sp.full_name)
                              order by sp.full_name, s.staff_id)
               from public.accountability_decision_staff s
               join public.profiles sp on sp.id = s.staff_id
              where s.decision_id = a.id), '[]'))
    from public.accountability_decisions a
    join public.profiles pr on pr.id = a.decided_by
    left join public.imprest_postings ip on ip.id = a.imprest_posting_id
    left join public.imprest_disbursements d on d.id = ip.disbursement_id
    left join public.imprest_count_postings cp on cp.id = a.imprest_count_posting_id
    left join public.imprest_counts c on c.id = cp.count_id
   where a.id = p_id;
$$;

create or replace function private.impl_admin_record_accountability_decision(
  p_subject_type text, p_subject_id uuid, p_decision text, p_nobody_identified boolean,
  p_responsible_staff uuid[], p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := private.request_uid();
  v_type     public.accountability_subject_type;
  v_decision text := btrim(coalesce(p_decision, ''), E' 	
');
  v_staff    uuid[];
  v_fund     uuid;
  v_id       uuid := gen_random_uuid();
  v_corr     uuid := gen_random_uuid();
  v_class    jsonb;
  v_existing public.accountability_decisions%rowtype;
  v_request  jsonb;
begin
  if v_actor is null then
    raise exception 'administrative command requires an authenticated session'
      using errcode = 'insufficient_privilege';
  end if;
  if not private.is_live_director(v_actor) then
    -- A live member of staff in another role is refused on the record, with their live role. An
    -- account that is not live has no role to record and is refused as every command refuses it.
    if private.live_role_of(v_actor) is null then
      raise exception 'actor % is not a live Director', v_actor
        using errcode = 'insufficient_privilege';
    end if;
    return jsonb_build_object('ok', false, 'reason', 'director_only');
  end if;

  if p_subject_type is null or p_subject_id is null
     or p_subject_type not in (select unnest(enum_range(null::public.accountability_subject_type))::text) then
    return jsonb_build_object('ok', false, 'reason', 'no_subject');
  end if;
  v_type := p_subject_type::public.accountability_subject_type;

  select coalesce(array_agg(distinct s), '{}') into v_staff
    from unnest(coalesce(p_responsible_staff, '{}')) s where s is not null;
  v_request := jsonb_build_object('subject_type', p_subject_type, 'subject_id', p_subject_id,
                                  'decision', v_decision, 'nobody_identified', p_nobody_identified,
                                  'responsible_staff', to_jsonb(v_staff));

  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));
  v_class := private.classify_idempotency_key(p_idempotency_key, 'accountability.record_decision',
                                              v_actor, v_request);
  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  elsif v_class ->> 'status' = 'replay' then
    return jsonb_build_object('ok', true, 'reason', 'replayed',
                              'decision', private.accountability_decision_json(
                                            (v_class ->> 'result_ref')::uuid));
  end if;

  if length(v_decision) < 3 or length(v_decision) > 2000 then
    return jsonb_build_object('ok', false, 'reason', 'decision_required');
  elsif p_nobody_identified is null
        or (not p_nobody_identified and cardinality(v_staff) = 0) then
    return jsonb_build_object('ok', false, 'reason', 'responsible_required');
  elsif p_nobody_identified and cardinality(v_staff) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'responsible_conflict');
  elsif cardinality(v_staff) > 10 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_staff');
  elsif (select count(*) from public.profiles where id = any (v_staff)) <> cardinality(v_staff) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_staff');
  end if;

  if v_type = 'imprest_unexplained_loss' then
    select fund_id into v_fund from public.imprest_postings
     where id = p_subject_id and kind = 'unexplained_loss' and needs_director_decision;
  else
    select fund_id into v_fund from public.imprest_count_postings
     where id = p_subject_id and kind = 'count_shortage' and needs_director_decision;
  end if;
  if v_fund is null then
    return jsonb_build_object('ok', false, 'reason', 'no_subject');
  end if;

  -- Serialised with every reversal approval of the fund, so a loss reversed meanwhile is seen as
  -- reversed, and with every other decision on the same subject.
  perform pg_advisory_xact_lock(hashtextextended('imprest_fund_spend:' || v_fund::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('accountability:' || p_subject_id::text, 0));

  select * into v_existing from public.accountability_decisions
   where imprest_posting_id = p_subject_id or imprest_count_posting_id = p_subject_id;
  if found then
    return jsonb_build_object('ok', false, 'reason', 'already_decided',
                              'decided_at', v_existing.decided_at::text);
  end if;
  if v_type = 'imprest_unexplained_loss' and exists (
       select 1 from public.imprest_postings x
        where x.corrects_posting_id = p_subject_id and x.entry = 'reversal') then
    return jsonb_build_object('ok', false, 'reason', 'subject_reversed');
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'accountability.record_decision', v_actor,
                               v_request, v_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  insert into public.accountability_decisions (id, subject_type, imprest_posting_id,
                                               imprest_count_posting_id, fund_id, decision,
                                               nobody_identified, decided_by, correlation_id)
  values (v_id, v_type,
          case when v_type = 'imprest_unexplained_loss' then p_subject_id end,
          case when v_type = 'imprest_count_shortage' then p_subject_id end,
          v_fund, v_decision, p_nobody_identified, v_actor, v_corr);
  insert into public.accountability_decision_staff (decision_id, staff_id)
  select v_id, s from unnest(v_staff) s;

  insert into public.audit_events (
    actor_id, actor_role, is_system_actor, action, entity_type, entity_id,
    before_state, after_state, correlation_id, source_operation
  )
  values (v_actor, private.live_role_of(v_actor), false, 'accountability_decision_recorded',
          'accountability_decision', v_id, null,
          jsonb_build_object('subject_type', p_subject_type, 'subject_id', p_subject_id,
                             'fund_id', v_fund, 'decision', v_decision,
                             'nobody_identified', p_nobody_identified,
                             'responsible_staff', to_jsonb(v_staff)),
          v_corr, 'api.admin_record_accountability_decision');

  return jsonb_build_object('ok', true, 'reason', 'recorded',
                            'decision', private.accountability_decision_json(v_id));
end;
$$;

create or replace function api.admin_record_accountability_decision(
  p_subject_type text, p_subject_id uuid, p_decision text, p_nobody_identified boolean,
  p_responsible_staff uuid[], p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_admin_record_accountability_decision(
  p_subject_type, p_subject_id, p_decision, p_nobody_identified, p_responsible_staff,
  p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.admin_record_accountability_decision',
                        case p_subject_type
                          when 'imprest_unexplained_loss' then 'imprest_posting'
                          when 'imprest_count_shortage' then 'imprest_count_posting'
                          else 'accountability_subject' end,
                        p_subject_id, v);
end $$;

comment on function api.admin_record_accountability_decision(text, uuid, text, boolean, uuid[], text) is
  'A Director records the accountability decision on an imprest unexplained loss or a confirmed '
  'imprest count shortage (issue #84): a written decision of 3 to 2,000 characters, and up to ten '
  'responsible staff or a statement that nobody has been identified. One decision per subject, '
  'never changed. Posts nothing and triggers no payroll action. Every other role is refused on the '
  'audit trail.';

-- ---------------------------------------------------------------------------
-- The Directors' screen: what waits, what was decided lately, and who can be named
-- ---------------------------------------------------------------------------
create or replace function api.admin_accountability_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.acting_director();
begin
  return jsonb_build_object(
    'undecided', coalesce((
      select jsonb_agg(u order by u ->> 'posted_at', u ->> 'subject_id') from (
        select jsonb_build_object(
                 'subject_type', 'imprest_unexplained_loss', 'subject_id', p.id,
                 'fund_id', p.fund_id, 'fund_retired', not f.is_active,
                 'amount_tzs', p.amount_tzs, 'posted_at', p.posted_at, 'entry', p.entry,
                 'disbursement_id', d.id, 'disbursement_no', d.disbursement_no,
                 'purpose', d.purpose, 'proposed_by_name', pp.full_name,
                 'explanation', s.unaccounted_explanation) as u
          from public.imprest_postings p
          join public.imprest_funds f on f.id = p.fund_id
          join public.imprest_disbursements d on d.id = p.disbursement_id
          join public.imprest_settlements s on s.id = p.settlement_id
          join public.profiles pp on pp.id = d.proposed_by
         where p.kind = 'unexplained_loss' and p.needs_director_decision
           and not exists (select 1 from public.imprest_postings x
                            where x.corrects_posting_id = p.id and x.entry = 'reversal')
           and not exists (select 1 from public.accountability_decisions a
                            where a.imprest_posting_id = p.id)
        union all
        select jsonb_build_object(
                 'subject_type', 'imprest_count_shortage', 'subject_id', cp.id,
                 'fund_id', cp.fund_id, 'fund_retired', not f.is_active,
                 'amount_tzs', cp.amount_tzs, 'posted_at', cp.posted_at,
                 'count_id', c.id, 'business_date', c.business_date,
                 'counted_by_name', cb.full_name, 'confirmed_by_name', mb.full_name,
                 'explanation', cc.explanation, 'explanation_note', cc.explanation_note)
          from public.imprest_count_postings cp
          join public.imprest_funds f on f.id = cp.fund_id
          join public.imprest_counts c on c.id = cp.count_id
          join public.imprest_count_confirmations cc on cc.id = cp.confirmation_id
          join public.profiles cb on cb.id = c.counted_by
          join public.profiles mb on mb.id = cc.confirmed_by
         where cp.kind = 'count_shortage' and cp.needs_director_decision
           and not exists (select 1 from public.accountability_decisions a
                            where a.imprest_count_posting_id = cp.id)) q(u)), '[]'),
    'decided', coalesce((
      select jsonb_agg(private.accountability_decision_json(r.id) order by r.decided_at desc, r.id)
        from (select a.id, a.decided_at from public.accountability_decisions a
               order by a.decided_at desc, a.id limit 20) r), '[]'),
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'full_name', p.full_name, 'role', r.role,
                                          'is_active', p.is_active)
                       order by p.is_active desc, p.full_name, p.id)
        from public.profiles p
        join public.user_roles r on r.user_id = p.id), '[]'));
end;
$$;

comment on function api.admin_accountability_queue() is
  'For a Director (issue #84): every imprest unexplained loss and confirmed imprest count shortage '
  'still waiting for an accountability decision, oldest first, with what it came from; the twenty '
  'latest decisions; and the staff a decision may name.';

-- ---------------------------------------------------------------------------
-- Ownership and grants
-- ---------------------------------------------------------------------------
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure::text as signature, n.nspname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'api'
            and p.proname in ('admin_record_accountability_decision', 'admin_accountability_queue'))
        or (n.nspname = 'private'
            and p.proname in ('refuse_accountability_edit', 'check_accountability_decision',
                              'check_accountability_decision_row',
                              'imprest_fund_unresolved', 'accountability_decision_json',
                              'impl_admin_record_accountability_decision'))
  loop
    execute format('alter function %s owner to fv_definer_owner', fn.signature);
    execute format('revoke execute on function %s from public, anon, authenticated, service_role',
                   fn.signature);
    if fn.nspname = 'api' then
      execute format('grant execute on function %s to authenticated', fn.signature);
    end if;
  end loop;
end
$$;

notify pgrst, 'reload schema';

commit;
