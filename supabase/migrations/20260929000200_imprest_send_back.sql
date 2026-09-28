-- Issue #65 · Imprest spending, part 2b-2: send a settlement back with a reason; the Cashier settles
-- again
--
-- product.md §13.3a and AC-103b. The Manager never corrects the Cashier's figures. When a settlement
-- is wrong (an amount, a missing receipt, a weak explanation) the Manager SENDS BACK its latest
-- cycle with a written reason. The Cashier who proposed the disbursement reads the reason and
-- SETTLES AGAIN: a new settlement cycle, numbered after the last, with its own lines, receipts and
-- returned cash, held to every rule of the first. Nothing from an earlier cycle is changed or
-- deleted, and the new cycle waits for the Manager, who verifies it (part 2b-1) or sends it back.
--
--   imprest_settlement_returns   one row per send-back, tied to the cycle it returned: who, when
--                                and why. Never changed.
--
-- THE MONEY does not move on a send-back. A sent-back disbursement stays set aside, and Awaiting
-- verification counts the latest SUBMITTED cycle's Used plus Not accounted for, because that is the
-- Cashier's latest account of the cash that left the tin. Nothing posts until a cycle is verified,
-- and verification only ever takes the latest cycle.
--
-- RECEIPTS. A receipt belongs to the disbursement, not to a cycle, so a later cycle may cite one an
-- earlier cycle cited (never twice in the one cycle). New receipts are filed and uploaded while the
-- disbursement is sent back, and the bucket's trigger and insert policy now admit exactly that
-- state beside `handed_out`. Everything else they refused, they still refuse.
--
-- EIGHT RELEASED OBJECTS ARE REPLACED, each named where it is replaced: the approval shape, the
-- progress guard, the settlement target check, the verification target check, the spending
-- figures, Awaiting verification, the bucket's guard and insert policy, and the register and settle
-- commands. Their signatures do not change.

begin;

-- ---------------------------------------------------------------------------
-- A sent-back row keeps its approver
-- ---------------------------------------------------------------------------
alter table public.imprest_disbursements drop constraint disbursement_approval_shape;
alter table public.imprest_disbursements
  add constraint disbursement_approval_shape check (
    (status in ('approved', 'handed_out', 'settled', 'sent_back', 'verified', 'cancelled'))
      = (approved_by is not null)
    and (approved_by is null) = (approved_at is null)
  );

-- ---------------------------------------------------------------------------
-- The return
-- ---------------------------------------------------------------------------
create table public.imprest_settlement_returns (
  id               uuid primary key default gen_random_uuid(),
  disbursement_id  uuid not null references public.imprest_disbursements (id) on delete restrict,
  -- The cycle sent back. A cycle is sent back at most once: the next one is a new row.
  settlement_id    uuid not null unique references public.imprest_settlements (id)
                     on delete restrict,
  reason           text not null check (length(btrim(reason)) between 3 and 500),
  returned_by      uuid not null references public.profiles (id),
  returned_at      timestamptz not null default now()
);

comment on table public.imprest_settlement_returns is
  'The Manager sent a settlement cycle back to the Cashier, with a reason (issue #65, §13.3a). '
  'One per returned cycle, never changed. The Cashier answers with a new cycle.';

create index imprest_settlement_returns_disbursement_idx
  on public.imprest_settlement_returns (disbursement_id, returned_at);
create index imprest_settlement_returns_by_idx on public.imprest_settlement_returns (returned_by);

create trigger imprest_settlement_returns_append_only
  before update or delete on public.imprest_settlement_returns
  for each row execute function private.refuse_imprest_settlement_edit();
create trigger imprest_settlement_returns_no_truncate
  before truncate on public.imprest_settlement_returns
  for each statement execute function private.refuse_imprest_settlement_edit();

-- A return is of a settled disbursement's latest cycle, whoever writes the row.
create or replace function private.check_imprest_settlement_return()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status public.imprest_disbursement_status;
  v_latest uuid;
begin
  if tg_when = 'BEFORE' then
    select status into v_status from public.imprest_disbursements where id = new.disbursement_id;
    select id into v_latest from public.imprest_settlements
     where disbursement_id = new.disbursement_id order by cycle desc limit 1;
    if v_status is distinct from 'settled' or v_latest is distinct from new.settlement_id then
      raise exception 'imprest disbursement % is not settled at cycle %', new.disbursement_id,
        new.settlement_id using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- At commit: while the returned cycle is still the latest, the disbursement is sent back. Once a
  -- later cycle stands after it, the disbursement has moved on, which is the point of returning it.
  select id into v_latest from public.imprest_settlements
   where disbursement_id = new.disbursement_id order by cycle desc limit 1;
  if v_latest = new.settlement_id
     and not exists (select 1 from public.imprest_disbursements
                      where id = new.disbursement_id and status = 'sent_back') then
    raise exception 'imprest return % leaves disbursement % not sent back', new.id,
      new.disbursement_id using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

comment on function private.check_imprest_settlement_return() is
  'A return names a settled disbursement''s latest cycle, and at commit that disbursement is sent '
  'back unless a later cycle already follows the returned one (issue #65).';

create trigger imprest_settlement_returns_target
  before insert on public.imprest_settlement_returns
  for each row execute function private.check_imprest_settlement_return();
create constraint trigger imprest_settlement_returns_complete
  after insert on public.imprest_settlement_returns
  deferrable initially deferred
  for each row execute function private.check_imprest_settlement_return();

-- ---------------------------------------------------------------------------
-- Replaced · a settlement is cycle 1 of a handed-out disbursement, or the cycle after a returned one
-- ---------------------------------------------------------------------------
create or replace function private.check_imprest_settlement_target()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_d        public.imprest_disbursements%rowtype;
  v_last     integer;
  v_returned boolean;
begin
  if tg_table_name = 'imprest_settlements' then
    select * into v_d from public.imprest_disbursements where id = new.disbursement_id;
    select s.cycle, exists (select 1 from public.imprest_settlement_returns x
                             where x.settlement_id = s.id)
      into v_last, v_returned
      from public.imprest_settlements s
     where s.disbursement_id = new.disbursement_id
     order by s.cycle desc limit 1;
    if new.approved_tzs is distinct from v_d.amount_tzs
       or not ((v_d.status = 'handed_out' and v_last is null and new.cycle = 1)
               or (v_d.status = 'sent_back' and v_returned and new.cycle = v_last + 1)) then
      raise exception 'imprest disbursement % is not open to settlement cycle % at %',
        new.disbursement_id, new.cycle, new.approved_tzs using errcode = 'check_violation';
    end if;
  elsif new.receipt_id is not null and not exists (
          select 1 from public.imprest_receipts rc
            join public.imprest_settlements s on s.disbursement_id = rc.disbursement_id
           where rc.id = new.receipt_id and s.id = new.settlement_id) then
    raise exception 'receipt % belongs to another disbursement', new.receipt_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Replaced · the order of the states
-- ---------------------------------------------------------------------------
create or replace function private.guard_imprest_disbursement_progress()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_latest_returned boolean;
begin
  if old.status = 'verified' then
    raise exception 'imprest disbursement % is verified and final', old.id
      using errcode = 'restrict_violation';
  end if;

  select exists (select 1 from public.imprest_settlement_returns x where x.settlement_id = s.id)
    into v_latest_returned
    from public.imprest_settlements s
   where s.disbursement_id = new.id
   order by s.cycle desc limit 1;

  if new.status is distinct from old.status
     and ((old.status in ('handed_out', 'settled', 'sent_back'))
          or new.status in ('handed_out', 'settled', 'sent_back', 'verified'))
     and not ((old.status = 'approved' and new.status = 'handed_out'
               and exists (select 1 from public.imprest_disbursement_handouts h
                            where h.disbursement_id = new.id))
              or (old.status = 'handed_out' and new.status = 'settled'
                  and exists (select 1 from public.imprest_settlements s
                               where s.disbursement_id = new.id))
              -- Sent back only with a return of the latest cycle, and settled again only once a
              -- new cycle stands after it.
              or (old.status = 'settled' and new.status = 'sent_back'
                  and coalesce(v_latest_returned, false))
              or (old.status = 'sent_back' and new.status = 'settled'
                  and not coalesce(v_latest_returned, true))
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
  'Approved goes to handed out only with a hand-out, handed out to settled only with a settlement, '
  'settled to sent back only with a return of its latest cycle, sent back to settled only with a '
  'new cycle, settled to verified only with a verification. A verified row never changes again.';

-- ---------------------------------------------------------------------------
-- Replaced · a returned cycle is never verified
-- ---------------------------------------------------------------------------
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
       or v_s.id is distinct from new.settlement_id
       or exists (select 1 from public.imprest_settlement_returns x
                   where x.settlement_id = new.settlement_id) then
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
  'A verification names a settled disbursement''s latest settlement, never a returned one, in its '
  'own fund; a posting is exactly that settlement''s Used or Not accounted for (issues #64, #65).';

-- ---------------------------------------------------------------------------
-- Grants and row-level security: the readers of the disbursement itself
-- ---------------------------------------------------------------------------
alter table public.imprest_settlement_returns enable row level security;

revoke all on public.imprest_settlement_returns from public, anon, authenticated, service_role;
grant select on public.imprest_settlement_returns to authenticated;
grant select, insert on public.imprest_settlement_returns to fv_definer_owner;

create policy imprest_settlement_returns_select on public.imprest_settlement_returns
  for select to authenticated
  using ((select private.authorize(array['director', 'manager']::public.app_role[]))
         or ((select private.authorize(array['cashier']::public.app_role[]))
             and exists (select 1 from public.imprest_disbursements d
                          where d.id = disbursement_id and d.proposed_by = (select auth.uid()))));

create policy imprest_settlement_returns_definer_owner on public.imprest_settlement_returns
  for all to fv_definer_owner using (true) with check (true);

-- When a disbursement was last sent back, as a column PostgREST can sort the Manager's "Sent back,
-- waiting for the Cashier" list by. Invoker's rights, like `imprest_disbursement_settled_at`.
create or replace function public.imprest_disbursement_sent_back_at(d public.imprest_disbursements)
returns timestamptz
language sql
stable
security invoker
set search_path = ''
as $$
  select max(x.returned_at) from public.imprest_settlement_returns x where x.disbursement_id = d.id;
$$;

comment on function public.imprest_disbursement_sent_back_at(public.imprest_disbursements) is
  'When the disbursement was last sent back, for ordering the waiting list (issue #65).';

revoke execute on function public.imprest_disbursement_sent_back_at(public.imprest_disbursements)
  from public, anon, service_role;
grant execute on function public.imprest_disbursement_sent_back_at(public.imprest_disbursements)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Replaced · the bucket admits a new receipt while the disbursement is sent back
-- ---------------------------------------------------------------------------
drop policy imprest_evidence_insert on storage.objects;
create policy imprest_evidence_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'imprest-evidence'
              and (select private.authorize(array['cashier']::public.app_role[]))
              and exists (select 1 from public.imprest_receipts rc
                            join public.imprest_disbursements d on d.id = rc.disbursement_id
                           where rc.object_path = name
                             and rc.uploaded_by = (select auth.uid())
                             and d.proposed_by = (select auth.uid())
                             and d.status in ('handed_out', 'sent_back')));

create or replace function private.guard_imprest_evidence_object()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.bucket_id = 'imprest-evidence'
       and not exists (select 1 from public.imprest_receipts rc
                         join public.imprest_disbursements d on d.id = rc.disbursement_id
                        where rc.object_path = new.name
                          and rc.uploaded_by::text = new.owner_id
                          and new.owner is not distinct from rc.uploaded_by
                          and d.status in ('handed_out', 'sent_back')) then
      raise exception 'only the Cashier who registered this receipt may add it'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  if old.bucket_id = 'imprest-evidence'
     or (tg_op = 'UPDATE' and new.bucket_id = 'imprest-evidence') then
    raise exception 'an imprest receipt is never changed or deleted'
      using errcode = 'insufficient_privilege';
  end if;
  return coalesce(new, old);
end;
$$;

comment on function private.guard_imprest_evidence_object() is
  'Keeps the imprest-evidence bucket append-only for everybody, including the secret key, which '
  'row-level security does not restrain. A file is added only by the Cashier who registered it, '
  'while the disbursement is handed out or sent back (issues #62, #65).';

-- ---------------------------------------------------------------------------
-- Replaced · the figures: a sent-back disbursement stays set aside and awaiting verification
-- ---------------------------------------------------------------------------
create or replace function private.imprest_spending_figures(p_fund_id uuid)
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
    -- Handed out, settled and sent back stay set aside until the Manager verifies them (AC-102).
    select coalesce(sum(d.amount_tzs), 0)::bigint as tzs
      from public.imprest_disbursements d
     where d.fund_id = p_fund_id and d.status in ('approved', 'handed_out', 'settled', 'sent_back')
  )
  select posted.tzs, posted.tzs - spent.tzs, aside.tzs, posted.tzs - spent.tzs - aside.tzs
    from posted, spent, aside;
$$;

comment on function private.imprest_spending_figures(uuid) is
  'Posted imprest funding; the posted balance (funding minus verified expenses and unexplained '
  'losses); what approved, handed-out, settled and sent-back disbursements set aside; and Free to '
  'approve, the posted balance minus set aside (AC-99, AC-102, issues #64, #65). Never stored.';

create or replace function private.imprest_awaiting_verification_tzs(p_fund_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  -- Cash that has left the fund and is not verified: the whole amount while it is out, then the
  -- latest submitted cycle's Used plus Not accounted for, whether that cycle waits for the Manager
  -- or was sent back. Returned cash is back in the fund.
  select coalesce(sum(case when d.status = 'handed_out' then d.amount_tzs
                           else s.used_tzs + s.unaccounted_tzs end), 0)::bigint
    from public.imprest_disbursements d
    left join lateral (select st.used_tzs, st.unaccounted_tzs from public.imprest_settlements st
                        where st.disbursement_id = d.id
                        order by st.cycle desc limit 1) s on true
   where d.fund_id = p_fund_id and d.status in ('handed_out', 'settled', 'sent_back');
$$;

comment on function private.imprest_awaiting_verification_tzs(uuid) is
  'Awaiting verification (product.md §13.4): cash that has left the fund and has not been checked '
  'by the Manager, counting a sent-back disbursement at its latest submitted cycle. Never stored.';

-- ---------------------------------------------------------------------------
-- Replaced · register a receipt while handed out or sent back
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_register_imprest_receipt(
  p_disbursement_id uuid, p_file_name text, p_content_type text, p_byte_size bigint,
  p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := private.acting_staff(array['cashier']::public.app_role[]);
  v_name    text := private.normalise_label(p_file_name);
  v_id      uuid := gen_random_uuid();
  v_class   jsonb;
  v_status  public.imprest_disbursement_status;
  v_request jsonb := jsonb_build_object('disbursement_id', p_disbursement_id, 'file_name', v_name,
                                        'content_type', p_content_type, 'byte_size', p_byte_size);
begin
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_idempotency_key, ''), 0));
  v_class := private.classify_idempotency_key(
    p_idempotency_key, 'imprest.register_receipt', v_actor, v_request);
  if v_class ->> 'status' = 'conflict' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  elsif v_class ->> 'status' = 'replay' then
    return jsonb_build_object('ok', true, 'reason', 'replayed',
      'receipt', private.imprest_receipt_json((v_class ->> 'result_ref')::uuid, true));
  end if;

  select status into v_status from public.imprest_disbursements
   where id = p_disbursement_id and proposed_by = v_actor
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_disbursement');
  elsif v_status not in ('handed_out', 'sent_back') then
    return jsonb_build_object('ok', false, 'reason', 'not_handed_out', 'status', v_status::text);
  elsif p_content_type is null or p_content_type not in ('image/jpeg', 'image/png', 'image/webp',
                                                          'image/heic', 'application/pdf') then
    return jsonb_build_object('ok', false, 'reason', 'receipt_type_invalid');
  elsif p_byte_size is null or p_byte_size < 1 or p_byte_size > 15728640 then
    return jsonb_build_object('ok', false, 'reason', 'receipt_too_large');
  elsif length(v_name) < 1 or length(v_name) > 200 then
    return jsonb_build_object('ok', false, 'reason', 'receipt_name_invalid');
  elsif (select count(*) from public.imprest_receipts
          where disbursement_id = p_disbursement_id)
        >= 60 + 20 * (select count(*) from public.imprest_settlement_returns
                        where disbursement_id = p_disbursement_id) then
    -- Twenty lines at most, so sixty files leaves room for retakes and not for a file store. Each
    -- send-back allows another twenty, since the next cycle may need a new file on every line.
    return jsonb_build_object('ok', false, 'reason', 'too_many_receipts');
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'imprest.register_receipt', v_actor, v_request,
                               v_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  insert into public.imprest_receipts (id, disbursement_id, object_path, file_name, content_type,
                                       byte_size, encryption_key, uploaded_by)
  values (v_id, p_disbursement_id, 'imprest/' || p_disbursement_id::text || '/' || v_id::text,
          v_name, p_content_type, p_byte_size, extensions.gen_random_bytes(32), v_actor);

  -- The key never goes into the audit trail: the trail is readable more widely than a receipt.
  perform private.imprest_disbursement_audit(v_actor, 'imprest_receipt_registered', p_disbursement_id,
    null,
    jsonb_build_object('receipt_id', v_id, 'file_name', v_name, 'content_type', p_content_type,
                       'byte_size', p_byte_size),
    'api.staff_register_imprest_receipt');

  return jsonb_build_object('ok', true, 'reason', 'registered',
                            'receipt', private.imprest_receipt_json(v_id, true));
end;
$$;

comment on function api.staff_register_imprest_receipt(uuid, text, text, bigint, text) is
  'Files one receipt on a handed-out or sent-back disbursement and returns its path and encryption '
  'key. The phone encrypts the file with that key and uploads it to that path.';

-- ---------------------------------------------------------------------------
-- Replaced · settle: cycle 1 while handed out, the next cycle while sent back
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_settle_imprest_disbursement(
  p_id uuid, p_expected_version integer, p_lines jsonb, p_returned_tzs bigint,
  p_explanation text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor       uuid := private.acting_staff(array['cashier']::public.app_role[]);
  v_explanation text := nullif(private.normalise_label(p_explanation), '');
  v_stop        jsonb;
  v_d           public.imprest_disbursements%rowtype;
  v_needs       public.imprest_disbursement_status;
  v_cycle       integer;
  v_lines       jsonb := '[]'::jsonb;
  v_line        jsonb;
  v_i           integer := 0;
  v_amount      bigint;
  v_purpose     text;
  v_receipt     uuid;
  v_given       boolean;
  v_reason      text;
  v_note        text;
  v_rc          public.imprest_receipts%rowtype;
  v_owner       text;
  v_seen        uuid[] := '{}'::uuid[];
  v_used        bigint := 0;
  v_none        integer := 0;
  v_remainder   bigint;
  v_settlement  uuid := gen_random_uuid();
  v_request     jsonb;
begin
  -- The lines are compared as the Cashier sent them, tidied the way they are stored, so a retry
  -- with any line, file, amount or explanation changed is a conflict and never a replay.
  if p_lines is not null and jsonb_typeof(p_lines) = 'array' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'amount_tzs', e -> 'amount_tzs',
             'purpose', private.normalise_label(e ->> 'purpose'),
             'receipt_id', e -> 'receipt_id',
             'no_receipt_reason', e -> 'no_receipt_reason',
             'no_receipt_note', nullif(private.normalise_label(e ->> 'no_receipt_note'), ''))
             order by n), '[]'::jsonb)
      into v_lines
      from jsonb_array_elements(p_lines) with ordinality as t(e, n);
  end if;
  v_request := jsonb_build_object('id', p_id, 'expected_version', p_expected_version,
                                  'lines', v_lines, 'returned_tzs', p_returned_tzs,
                                  'explanation', v_explanation);

  -- A first settlement needs the cash handed out; a later one needs the last cycle sent back. The
  -- status read here only picks which; the shared opening locks the row and checks the version, so
  -- a status that moved in between has moved the version too and is refused as stale.
  select case when status = 'sent_back' then 'sent_back' else 'handed_out' end::public.imprest_disbursement_status
    into v_needs
    from public.imprest_disbursements where id = p_id and proposed_by = v_actor;
  v_stop := private.imprest_own_disbursement_open(p_idempotency_key,
    'imprest.settle_disbursement', v_actor, v_request, p_id, p_expected_version,
    coalesce(v_needs, 'handed_out'));
  if v_stop is not null then
    if v_stop ->> 'reason' = 'not_approved' then
      v_stop := jsonb_set(v_stop, '{reason}', '"not_handed_out"');
    end if;
    return v_stop;
  end if;

  select * into v_d from public.imprest_disbursements where id = p_id;
  select coalesce(max(cycle), 0) + 1 into v_cycle
    from public.imprest_settlements where disbursement_id = p_id;

  if p_returned_tzs is null or p_returned_tzs < 0 or p_returned_tzs > v_d.amount_tzs then
    return jsonb_build_object('ok', false, 'reason',
      case when p_returned_tzs > v_d.amount_tzs then 'over_approval' else 'returned_invalid' end,
      'amount_tzs', v_d.amount_tzs, 'returned_tzs', p_returned_tzs);
  elsif p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    return jsonb_build_object('ok', false, 'reason', 'lines_invalid');
  elsif jsonb_array_length(p_lines) > 20 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_lines');
  end if;

  for v_line in select value from jsonb_array_elements(v_lines) loop
    v_i := v_i + 1;

    -- A missing key is null, and null slips past every comparison, so its type is required first.
    if coalesce(jsonb_typeof(v_line -> 'amount_tzs'), 'missing') <> 'number'
       or (v_line ->> 'amount_tzs')::numeric <> trunc((v_line ->> 'amount_tzs')::numeric)
       or (v_line ->> 'amount_tzs')::numeric <= 0
       or (v_line ->> 'amount_tzs')::numeric > 100000000 then
      return jsonb_build_object('ok', false, 'reason', 'line_amount_invalid', 'line', v_i);
    end if;
    v_amount := (v_line ->> 'amount_tzs')::bigint;

    v_purpose := coalesce(v_line ->> 'purpose', '');
    if length(v_purpose) < 2 or length(v_purpose) > 120 then
      return jsonb_build_object('ok', false, 'reason', 'line_purpose_invalid', 'line', v_i);
    end if;

    v_reason := nullif(v_line ->> 'no_receipt_reason', '');
    v_note := v_line ->> 'no_receipt_note';
    -- A receipt is GIVEN when the key holds anything but null, whatever its type, so a number
    -- cannot slip past the receipt-or-reason rule and then fail a cast at insert.
    v_given := coalesce(jsonb_typeof(v_line -> 'receipt_id'), 'null') <> 'null';

    if not v_given and v_reason is null then
      return jsonb_build_object('ok', false, 'reason', 'line_evidence_required', 'line', v_i);
    elsif v_given and (v_reason is not null or v_note is not null) then
      return jsonb_build_object('ok', false, 'reason', 'line_evidence_both', 'line', v_i);
    end if;

    v_receipt := null;
    if v_given then
      if jsonb_typeof(v_line -> 'receipt_id') <> 'string' then
        return jsonb_build_object('ok', false, 'reason', 'receipt_not_found', 'line', v_i);
      end if;
      begin
        v_receipt := (v_line ->> 'receipt_id')::uuid;
      exception when invalid_text_representation then
        return jsonb_build_object('ok', false, 'reason', 'receipt_not_found', 'line', v_i);
      end;
    end if;

    if v_reason is not null then
      if not (v_reason = any (enum_range(null::public.imprest_no_receipt_reason)::text[])) then
        return jsonb_build_object('ok', false, 'reason', 'no_receipt_reason_invalid', 'line', v_i);
      elsif private.imprest_text_problem(v_note,
              v_reason in ('receipt_lost_or_damaged', 'other')) then
        return jsonb_build_object('ok', false, 'reason', 'no_receipt_note_required', 'line', v_i);
      end if;
      v_none := v_none + 1;
    else
      -- THE PATH IS CHECKED, NEVER TRUSTED (issue #62 criterion 10). A receipt an earlier cycle of
      -- this disbursement cited may be cited again; only twice in the one cycle is refused.
      select * into v_rc from public.imprest_receipts where id = v_receipt;
      if not found then
        return jsonb_build_object('ok', false, 'reason', 'receipt_not_found', 'line', v_i);
      elsif v_rc.disbursement_id <> p_id
            or v_rc.object_path not like 'imprest/' || p_id::text || '/%' then
        return jsonb_build_object('ok', false, 'reason', 'receipt_wrong_disbursement', 'line', v_i);
      elsif v_rc.uploaded_by <> v_actor then
        return jsonb_build_object('ok', false, 'reason', 'receipt_not_yours', 'line', v_i);
      elsif v_receipt = any (v_seen) then
        return jsonb_build_object('ok', false, 'reason', 'receipt_cited_twice', 'line', v_i);
      end if;

      select o.owner_id into v_owner from storage.objects o
       where o.bucket_id = 'imprest-evidence' and o.name = v_rc.object_path;
      if not found then
        return jsonb_build_object('ok', false, 'reason', 'receipt_not_uploaded', 'line', v_i);
      elsif v_owner is distinct from v_actor::text then
        return jsonb_build_object('ok', false, 'reason', 'receipt_not_yours', 'line', v_i);
      end if;
      v_seen := v_seen || v_receipt;
    end if;

    v_used := v_used + v_amount;
  end loop;

  -- AC-100: the lines and the returned cash may not claim more than was approved.
  if v_used + p_returned_tzs > v_d.amount_tzs then
    return jsonb_build_object('ok', false, 'reason', 'over_approval', 'amount_tzs', v_d.amount_tzs,
                              'used_tzs', v_used, 'returned_tzs', p_returned_tzs);
  end if;

  v_remainder := v_d.amount_tzs - v_used - p_returned_tzs;
  if v_remainder > 0 and private.imprest_text_problem(v_explanation, true) then
    return jsonb_build_object('ok', false, 'reason', 'explanation_required',
                              'unaccounted_tzs', v_remainder);
  elsif v_remainder = 0 and v_explanation is not null then
    return jsonb_build_object('ok', false, 'reason', 'explanation_not_needed');
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'imprest.settle_disbursement', v_actor,
                               v_request, p_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  insert into public.imprest_settlements (id, disbursement_id, cycle, approved_tzs, used_tzs,
                                          returned_tzs, unaccounted_tzs, unaccounted_explanation,
                                          line_count, no_receipt_lines, settled_by)
  values (v_settlement, p_id, v_cycle, v_d.amount_tzs, v_used, p_returned_tzs, v_remainder,
          case when v_remainder > 0 then v_explanation end, v_i, v_none, v_actor);

  insert into public.imprest_settlement_lines (settlement_id, line_no, amount_tzs, purpose,
                                               receipt_id, no_receipt_reason, no_receipt_note)
  select v_settlement, n::integer, (e ->> 'amount_tzs')::bigint, e ->> 'purpose',
         (e ->> 'receipt_id')::uuid,
         (nullif(e ->> 'no_receipt_reason', ''))::public.imprest_no_receipt_reason,
         e ->> 'no_receipt_note'
    from jsonb_array_elements(v_lines) with ordinality as t(e, n);

  update public.imprest_disbursements
     set status = 'settled', version = version + 1
   where id = p_id;

  perform private.imprest_disbursement_audit(v_actor, 'imprest_disbursement_settled', p_id,
    jsonb_build_object('status', v_d.status),
    jsonb_build_object('status', 'settled', 'cycle', v_cycle, 'approved_tzs', v_d.amount_tzs,
                       'used_tzs', v_used, 'returned_tzs', p_returned_tzs,
                       'unaccounted_tzs', v_remainder, 'lines', v_i, 'no_receipt_lines', v_none,
                       'set_aside', true),
    'api.staff_settle_imprest_disbursement');

  return private.imprest_disbursement_result('settled', p_id);
end;
$$;

comment on function api.staff_settle_imprest_disbursement(uuid, integer, jsonb, bigint, text, text) is
  'The Cashier settles a handed-out disbursement, or settles again one sent back, as the next cycle: '
  'its lines, the cash returned, and an explanation for any remainder. Approved = Used + Returned + '
  'Not accounted for (issues #62, #65).';

-- ---------------------------------------------------------------------------
-- Send back (the Manager). There is no amount: the Manager never corrects the Cashier's figures.
-- ---------------------------------------------------------------------------
create or replace function private.impl_staff_send_back_imprest_settlement(
  p_id uuid, p_expected_version integer, p_settlement_id uuid, p_reason text,
  p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := private.acting_staff(array['manager']::public.app_role[]);
  v_reason  text := private.normalise_label(p_reason);
  v_stop    jsonb;
  v_s       public.imprest_settlements%rowtype;
  v_request jsonb := jsonb_build_object('id', p_id, 'expected_version', p_expected_version,
                                        'settlement_id', p_settlement_id, 'reason', v_reason);
begin
  v_stop := private.imprest_disbursement_open(p_idempotency_key, 'imprest.send_back_settlement',
    v_actor, v_request, p_id, p_expected_version, 'settled');
  if v_stop is not null then
    if v_stop ->> 'reason' = 'not_approved' then
      v_stop := jsonb_set(v_stop, '{reason}', '"not_settled"');
    end if;
    return v_stop;
  end if;

  -- Only the cycle the Manager was shown, and only if it is still the latest one.
  select * into v_s from public.imprest_settlements
   where disbursement_id = p_id order by cycle desc limit 1;
  if p_settlement_id is null or v_s.id is distinct from p_settlement_id then
    return jsonb_build_object('ok', false, 'reason', 'settlement_not_latest');
  end if;

  if private.imprest_text_problem(v_reason, true) then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  if private.imprest_claim_key(p_idempotency_key, 'imprest.send_back_settlement', v_actor,
                               v_request, p_id) <> 'claimed' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_conflict');
  end if;

  insert into public.imprest_settlement_returns (disbursement_id, settlement_id, reason, returned_by)
  values (p_id, v_s.id, v_reason, v_actor);

  update public.imprest_disbursements
     set status = 'sent_back', version = version + 1
   where id = p_id;

  perform private.imprest_disbursement_audit(v_actor, 'imprest_settlement_sent_back', p_id,
    jsonb_build_object('status', 'settled', 'set_aside', true),
    jsonb_build_object('status', 'sent_back', 'settlement_id', v_s.id, 'cycle', v_s.cycle,
                       'reason', v_reason, 'set_aside', true),
    'api.staff_send_back_imprest_settlement');

  return private.imprest_disbursement_result('sent_back', p_id);
end;
$$;

create or replace function api.staff_send_back_imprest_settlement(
  p_id uuid, p_expected_version integer, p_settlement_id uuid, p_reason text,
  p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.impl_staff_send_back_imprest_settlement(
  p_id, p_expected_version, p_settlement_id, p_reason, p_idempotency_key);
begin
  if coalesce((v ->> 'ok')::boolean, false) then return v; end if;
  return private.refuse('api.staff_send_back_imprest_settlement', 'imprest_disbursement', p_id, v);
end $$;

comment on function api.staff_send_back_imprest_settlement(uuid, integer, uuid, text, text) is
  'The Manager sends the latest settlement cycle of a settled disbursement back to the Cashier with '
  'a reason of 3 to 500 characters (issue #65). Nothing is posted or released; the Cashier settles '
  'again as a new cycle.';

-- ---------------------------------------------------------------------------
-- Ownership and grants
-- ---------------------------------------------------------------------------
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure::text as signature, n.nspname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'api' and p.proname = 'staff_send_back_imprest_settlement')
        or (n.nspname = 'private'
            and p.proname in ('check_imprest_settlement_return', 'check_imprest_settlement_target',
                              'guard_imprest_disbursement_progress',
                              'check_imprest_verification_target', 'guard_imprest_evidence_object',
                              'imprest_spending_figures', 'imprest_awaiting_verification_tzs',
                              'impl_staff_register_imprest_receipt',
                              'impl_staff_settle_imprest_disbursement',
                              'impl_staff_send_back_imprest_settlement'))
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
