-- Issue #64 · Imprest spending, part 2b-1: the Manager verifies a settled payment, which posts it
--
-- product.md §13.3 points 5 and 6, §13.3a and §13.4. Since part 2a a settled disbursement waits
-- for the Manager, still set aside, and nothing posts. Here the Manager verifies its latest
-- settlement EXACTLY AS THE CASHIER SUBMITTED IT. The command takes no amount (AC-103a).
--
-- Verifying:
--
--   posts Used as an imprest expense, always, even when Used is nothing, so every verification has
--   its expense;
--   posts Not accounted for, when above zero, as an unexplained loss that needs a Director's
--   accountability decision (§13.1). There is no salary deduction;
--   releases the whole approved amount from set aside, so only Returned comes back to Free to
--   approve;
--   makes the disbursement final. Its settlement and hand-out were already append-only.
--
-- NOT ACCOUNTED FOR IS POSTED, NOT RELEASED (Owner decision, 27 September 2026). It is cash that
-- never came back to the tin. Releasing it would let the Manager approve money the tin does not
-- hold. This supersedes issue #62's sentence that verification releases "returned and unexplained
-- money".
--
--   imprest_verifications   one row per verified disbursement, naming the settlement it verified.
--   imprest_postings        the expense and, when there is one, the unexplained loss. Never changed.
--
-- THE FIGURES, all calculated in `private.imprest_spending_figures` and never stored:
--
--   posted balance  = posted funding − verified expenses − verified unexplained losses
--   set aside       = approved + handed out + settled (verified no longer counts)
--   Free to approve = posted balance − set aside
--
-- Awaiting verification already counts handed-out and settled disbursements alone, so a verified
-- one leaves it with no change here. Expected cash in the tin is posted balance − Awaiting
-- verification, and for the worked example of issue #64 that is exactly the cash in the tin.
--
-- The daily report's imprest position and approved expenses stay withheld: a later ticket changes
-- the report.

begin;

-- ---------------------------------------------------------------------------
-- A verified row keeps its approver
-- ---------------------------------------------------------------------------
alter table public.imprest_disbursements drop constraint disbursement_approval_shape;
alter table public.imprest_disbursements
  add constraint disbursement_approval_shape check (
    (status in ('approved', 'handed_out', 'settled', 'verified', 'cancelled')) = (approved_by is not null)
    and (approved_by is null) = (approved_at is null)
  );

create type public.imprest_posting_kind as enum (
  'expense',          -- Used, the verified spending
  'unexplained_loss'  -- Not accounted for: cash that never came back, for a Director to decide on
);

comment on type public.imprest_posting_kind is
  'What a verification posts (issue #64): Used as an imprest expense, and Not accounted for as an '
  'unexplained loss. Both reduce the posted balance.';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.imprest_verifications (
  id               uuid primary key default gen_random_uuid(),
  disbursement_id  uuid not null unique references public.imprest_disbursements (id)
                     on delete restrict,
  -- The settlement cycle the Manager was shown. Always the disbursement's latest.
  settlement_id    uuid not null unique references public.imprest_settlements (id)
                     on delete restrict,
  fund_id          uuid not null references public.imprest_funds (id) on delete restrict,
  verified_by      uuid not null references public.profiles (id),
  verified_at      timestamptz not null default now()
);

comment on table public.imprest_verifications is
  'The Manager''s verification of a settled disbursement (issue #64). One per disbursement, never '
  'changed. A correction is a later Director reversal, never an edit.';

create index imprest_verifications_by_idx   on public.imprest_verifications (verified_by);
create index imprest_verifications_fund_idx on public.imprest_verifications (fund_id);

create table public.imprest_postings (
  id                       uuid primary key default gen_random_uuid(),
  verification_id          uuid not null references public.imprest_verifications (id)
                             on delete restrict,
  disbursement_id          uuid not null references public.imprest_disbursements (id)
                             on delete restrict,
  settlement_id            uuid not null references public.imprest_settlements (id)
                             on delete restrict,
  fund_id                  uuid not null references public.imprest_funds (id) on delete restrict,
  kind                     public.imprest_posting_kind not null,
  amount_tzs               bigint not null check (amount_tzs >= 0),
  -- An unexplained loss needs a Director's accountability decision (§13.1); an expense does not.
  -- The decision itself will be its own append-only record, so this row never changes.
  needs_director_decision  boolean not null,
  posted_at                timestamptz not null default now(),
  unique (verification_id, kind),
  constraint posting_loss_shape
    check ((kind = 'unexplained_loss') = needs_director_decision
           and (kind = 'expense' or amount_tzs > 0))
);

comment on table public.imprest_postings is
  'What a verification posted (issue #64): Used as the imprest expense and, when above zero, Not '
  'accounted for as an unexplained loss. Both reduce the posted balance. Never changed or deleted.';

create index imprest_postings_fund_idx         on public.imprest_postings (fund_id, kind);
create index imprest_postings_disbursement_idx on public.imprest_postings (disbursement_id);
create index imprest_postings_settlement_idx   on public.imprest_postings (settlement_id);

-- ---------------------------------------------------------------------------
-- Append-only, and consistent
-- ---------------------------------------------------------------------------
-- Part 2a's refusal, which names the table it meets. TRUNCATE is refused too, since it skips the
-- row triggers.
create trigger imprest_verifications_append_only
  before update or delete on public.imprest_verifications
  for each row execute function private.refuse_imprest_settlement_edit();
create trigger imprest_verifications_no_truncate
  before truncate on public.imprest_verifications
  for each statement execute function private.refuse_imprest_settlement_edit();
create trigger imprest_postings_append_only
  before update or delete on public.imprest_postings
  for each row execute function private.refuse_imprest_settlement_edit();
create trigger imprest_postings_no_truncate
  before truncate on public.imprest_postings
  for each statement execute function private.refuse_imprest_settlement_edit();

-- A verification is of a settled disbursement, of its latest settlement, in its own fund. A posting
-- is exactly its settlement's figure: Used for the expense, Not accounted for for the loss. So
-- nothing can post a figure the Cashier did not settle, whoever writes the row.
create or replace function private.check_imprest_verification_target()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_d public.imprest_disbursements%rowtype;
  v_s public.imprest_settlements%rowtype;
  v_v      public.imprest_verifications%rowtype;
  v_figure bigint;
begin
  if tg_table_name = 'imprest_verifications' then
    select * into v_d from public.imprest_disbursements where id = new.disbursement_id;
    select * into v_s from public.imprest_settlements
     where disbursement_id = new.disbursement_id order by cycle desc limit 1;
    if v_d.status is distinct from 'settled' or v_d.fund_id is distinct from new.fund_id
       or v_s.id is distinct from new.settlement_id then
      raise exception 'imprest disbursement % is not settled at settlement %', new.disbursement_id,
        new.settlement_id using errcode = 'check_violation';
    end if;
    return new;
  end if;

  select * into v_v from public.imprest_verifications where id = new.verification_id;
  select * into v_s from public.imprest_settlements where id = v_v.settlement_id;
  if new.kind = 'expense' then
    v_figure := v_s.used_tzs;
  else
    v_figure := v_s.unaccounted_tzs;
  end if;
  if v_v.id is null
     or new.disbursement_id is distinct from v_v.disbursement_id
     or new.settlement_id is distinct from v_v.settlement_id
     or new.fund_id is distinct from v_v.fund_id
     or new.amount_tzs is distinct from v_figure then
    raise exception 'imprest posting % of % does not match its settlement', new.kind, new.amount_tzs
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function private.check_imprest_verification_target() is
  'A verification names a settled disbursement''s latest settlement in its own fund; a posting is '
  'exactly that settlement''s Used or Not accounted for (issue #64).';

create trigger imprest_verifications_target
  before insert on public.imprest_verifications
  for each row execute function private.check_imprest_verification_target();
create trigger imprest_postings_target
  before insert on public.imprest_postings
  for each row execute function private.check_imprest_verification_target();

-- At commit, a verification carries its expense, a loss exactly when there is a remainder, and a
-- verified disbursement. The rows can be written in any order but never go without each other.
create or replace function private.check_imprest_verification_complete()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_id      uuid;
  v_v       public.imprest_verifications%rowtype;
  v_s       public.imprest_settlements%rowtype;
  v_expense integer;
  v_loss    integer;
begin
  if tg_table_name = 'imprest_verifications' then
    v_id := new.id;
  else
    v_id := new.verification_id;
  end if;

  select * into v_v from public.imprest_verifications where id = v_id;
  select * into v_s from public.imprest_settlements where id = v_v.settlement_id;
  select count(*) filter (where kind = 'expense'), count(*) filter (where kind = 'unexplained_loss')
    into v_expense, v_loss
    from public.imprest_postings where verification_id = v_id;

  if v_expense <> 1 or (v_loss = 1) <> (v_s.unaccounted_tzs > 0) or v_loss > 1
     or not exists (select 1 from public.imprest_disbursements
                     where id = v_v.disbursement_id and status = 'verified') then
    raise exception 'imprest verification % has % expense and % loss postings for a remainder of %',
      v_id, v_expense, v_loss, v_s.unaccounted_tzs using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

create constraint trigger imprest_verification_complete
  after insert on public.imprest_verifications
  deferrable initially deferred
  for each row execute function private.check_imprest_verification_complete();
create constraint trigger imprest_posting_complete
  after insert on public.imprest_postings
  deferrable initially deferred
  for each row execute function private.check_imprest_verification_complete();

-- The disbursement row moves forward only: approved to handed out, handed out to settled, settled to
-- verified. A verified row is final: no update of any kind reaches it.
create or replace function private.guard_imprest_disbursement_progress()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'verified' then
    raise exception 'imprest disbursement % is verified and final', old.id
      using errcode = 'restrict_violation';
  end if;

  if new.status is distinct from old.status
     and ((old.status in ('handed_out', 'settled'))
          or new.status in ('handed_out', 'settled', 'verified'))
     and not ((old.status = 'approved' and new.status = 'handed_out'
               and exists (select 1 from public.imprest_disbursement_handouts h
                            where h.disbursement_id = new.id))
              or (old.status = 'handed_out' and new.status = 'settled'
                  and exists (select 1 from public.imprest_settlements s
                               where s.disbursement_id = new.id))
              or (old.status = 'settled' and new.status = 'verified'
                  and exists (select 1 from public.imprest_verifications v
                               where v.disbursement_id = new.id))) then
    raise exception 'imprest disbursement % cannot go from % to %', old.id, old.status, new.status
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

comment on function private.guard_imprest_disbursement_progress() is
  'Approved goes to handed out only with a hand-out row, handed out to settled only with a '
  'settlement row, settled to verified only with a verification. None goes back, and a verified '
  'row never changes again.';

-- ---------------------------------------------------------------------------
-- Grants and row-level security: the readers of the disbursement itself
-- ---------------------------------------------------------------------------
alter table public.imprest_verifications enable row level security;
alter table public.imprest_postings enable row level security;

revoke all on public.imprest_verifications, public.imprest_postings
  from public, anon, authenticated, service_role;
grant select on public.imprest_verifications, public.imprest_postings to authenticated;
grant select, insert on public.imprest_verifications, public.imprest_postings to fv_definer_owner;

create policy imprest_verifications_select on public.imprest_verifications
  for select to authenticated
  using ((select private.authorize(array['director', 'manager']::public.app_role[]))
         or ((select private.authorize(array['cashier']::public.app_role[]))
             and exists (select 1 from public.imprest_disbursements d
                          where d.id = disbursement_id and d.proposed_by = (select auth.uid()))));
create policy imprest_postings_select on public.imprest_postings
  for select to authenticated
  using ((select private.authorize(array['director', 'manager']::public.app_role[]))
         or ((select private.authorize(array['cashier']::public.app_role[]))
             and exists (select 1 from public.imprest_disbursements d
                          where d.id = disbursement_id and d.proposed_by = (select auth.uid()))));

create policy imprest_verifications_definer_owner on public.imprest_verifications
  for all to fv_definer_owner using (true) with check (true);
create policy imprest_postings_definer_owner on public.imprest_postings
  for all to fv_definer_owner using (true) with check (true);

-- ---------------------------------------------------------------------------
-- The figures, calculated in one place
-- ---------------------------------------------------------------------------
-- A new column changes the function's result type, so it is dropped and made again. Its callers
-- are PL/pgSQL, which resolves it on each call.
drop function private.imprest_spending_figures(uuid);

create function private.imprest_spending_figures(p_fund_id uuid)
returns table (posted_funding_tzs bigint, posted_balance_tzs bigint, set_aside_tzs bigint,
               free_to_approve_tzs bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with posted as (
    select coalesce(sum(f.received_amount_tzs) filter (where f.status = 'received'), 0)::bigint
             as tzs
      from public.imprest_fundings f
     where f.fund_id = p_fund_id
  ), spent as (
    -- Verified expenses and verified unexplained losses alike: both are cash gone from the tin.
    select coalesce(sum(p.amount_tzs), 0)::bigint as tzs
      from public.imprest_postings p
     where p.fund_id = p_fund_id
  ), aside as (
    -- Handed out and settled stay set aside until the Manager verifies them (AC-102).
    select coalesce(sum(d.amount_tzs), 0)::bigint as tzs
      from public.imprest_disbursements d
     where d.fund_id = p_fund_id and d.status in ('approved', 'handed_out', 'settled')
  )
  select posted.tzs, posted.tzs - spent.tzs, aside.tzs, posted.tzs - spent.tzs - aside.tzs
    from posted, spent, aside;
$$;

comment on function private.imprest_spending_figures(uuid) is
  'Posted imprest funding; the posted balance (funding minus verified expenses and unexplained '
  'losses); what approved, handed-out and settled disbursements set aside; and Free to approve, '
  'the posted balance minus set aside (AC-99, AC-102, issue #64). Calculated, never stored.';

drop function api.staff_imprest_spending_position();

create function api.staff_imprest_spending_position()
returns table (fund_id uuid, posted_funding_tzs bigint, posted_balance_tzs bigint,
               set_aside_tzs bigint, free_to_approve_tzs bigint, awaiting_verification_tzs bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.acting_staff(array['director', 'manager', 'cashier']::public.app_role[]);
  v_role  public.app_role := private.live_role_of(v_actor);
begin
  -- No active fund returns no row, so a screen can tell "nothing yet" from a read that failed.
  -- `posted_funding_tzs` stays for a screen from the release before, during a deployment.
  return query
    select fu.id,
           case when v_role = 'cashier' then null else s.posted_funding_tzs end,
           case when v_role = 'cashier' then null else s.posted_balance_tzs end,
           case when v_role = 'cashier' then null else s.set_aside_tzs end,
           s.free_to_approve_tzs,
           case when v_role = 'cashier' then null
                else private.imprest_awaiting_verification_tzs(fu.id) end
      from public.imprest_funds fu
      cross join lateral private.imprest_spending_figures(fu.id) s
     where fu.is_active;
end;
$$;

comment on function api.staff_imprest_spending_position() is
  'The spending figures of the active fund. A Director and the Manager see them all; a Cashier sees '
  'only Free to approve. Calculated here because a Cashier reads only their own rows.';

-- ---------------------------------------------------------------------------
-- Verify (the Manager). There is no amount: the settlement is verified as it stands.
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_verify_imprest_disbursement(
  p_id uuid, p_expected_version integer, p_settlement_id uuid, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor        uuid := private.acting_staff(array['manager']::public.app_role[]);
  v_stop         jsonb;
  v_d            public.imprest_disbursements%rowtype;
  v_s            public.imprest_settlements%rowtype;
  v_free         bigint;
  v_verification uuid := gen_random_uuid();
  v_request      jsonb := jsonb_build_object('id', p_id, 'expected_version', p_expected_version,
                                             'settlement_id', p_settlement_id);
begin
  v_stop := private.imprest_disbursement_open(p_idempotency_key, 'imprest.verify_disbursement',
    v_actor, v_request, p_id, p_expected_version, 'settled');
  if v_stop is not null then
    if v_stop ->> 'reason' = 'not_approved' then
      v_stop := jsonb_set(v_stop, '{reason}', '"not_settled"');
    end if;
    return v_stop;
  end if;

  select * into v_d from public.imprest_disbursements where id = p_id;

  -- Only the settlement the Manager was shown, and only if it is still the latest one.
  select * into v_s from public.imprest_settlements
   where disbursement_id = p_id order by cycle desc limit 1;
  if p_settlement_id is null or v_s.id is distinct from p_settlement_id then
    return jsonb_build_object('ok', false, 'reason', 'settlement_not_latest');
  end if;

  -- Serialised per fund with every approval (part 1), so neither reads figures the other is
  -- about to change.
  perform pg_advisory_xact_lock(hashtextextended('imprest_fund_spend:' || v_d.fund_id::text, 0));

  if private.imprest_claim_key(p_idempotency_key, 'imprest.verify_disbursement', v_actor,
                               v_request, p_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  insert into public.imprest_verifications (id, disbursement_id, settlement_id, fund_id, verified_by)
  values (v_verification, p_id, v_s.id, v_d.fund_id, v_actor);

  insert into public.imprest_postings (verification_id, disbursement_id, settlement_id, fund_id,
                                       kind, amount_tzs, needs_director_decision)
  values (v_verification, p_id, v_s.id, v_d.fund_id, 'expense', v_s.used_tzs, false);

  if v_s.unaccounted_tzs > 0 then
    insert into public.imprest_postings (verification_id, disbursement_id, settlement_id, fund_id,
                                         kind, amount_tzs, needs_director_decision)
    values (v_verification, p_id, v_s.id, v_d.fund_id, 'unexplained_loss', v_s.unaccounted_tzs,
            true);
  end if;

  update public.imprest_disbursements
     set status = 'verified', version = version + 1
   where id = p_id;

  select s.free_to_approve_tzs into v_free from private.imprest_spending_figures(v_d.fund_id) s;

  perform private.imprest_disbursement_audit(v_actor, 'imprest_disbursement_verified', p_id,
    jsonb_build_object('status', 'settled', 'set_aside', true),
    jsonb_build_object('status', 'verified', 'settlement_id', v_s.id, 'cycle', v_s.cycle,
                       'approved_tzs', v_s.approved_tzs, 'expense_tzs', v_s.used_tzs,
                       'unexplained_loss_tzs', v_s.unaccounted_tzs,
                       'released_to_free_tzs', v_s.returned_tzs, 'set_aside', false,
                       'free_to_approve_tzs', v_free),
    'api.staff_verify_imprest_disbursement');

  return private.imprest_disbursement_result('verified', p_id);
end;
$$;

create or replace function api.staff_verify_imprest_disbursement(
  p_id uuid, p_expected_version integer, p_settlement_id uuid, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_verify_imprest_disbursement(
  p_id, p_expected_version, p_settlement_id, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_verify_imprest_disbursement', 'imprest_disbursement', p_id, v);
end $$;

comment on function api.staff_verify_imprest_disbursement(uuid, integer, uuid, text) is
  'The Manager verifies the latest settlement of a settled disbursement exactly as the Cashier '
  'submitted it: Used posts as the imprest expense, Not accounted for as an unexplained loss, and '
  'the approved amount leaves set aside (issue #64).';

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
            and p.proname in ('staff_verify_imprest_disbursement', 'staff_imprest_spending_position'))
        or (n.nspname = 'private'
            and p.proname in ('check_imprest_verification_target',
                              'check_imprest_verification_complete',
                              'guard_imprest_disbursement_progress', 'imprest_spending_figures',
                              'impl_staff_verify_imprest_disbursement'))
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
