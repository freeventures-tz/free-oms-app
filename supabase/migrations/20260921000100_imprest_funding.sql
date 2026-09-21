-- Issue #48 · Imprest funding: the tables, the read models and the rules no command may forget
--
-- product.md §13.2 and the funding exceptions the Owner approved on 20 September 2026. This is the
-- FUNDING slice of the imprest parent (#9) and nothing more: no expense, encumbrance,
-- reconciliation or retirement table exists here, and the funding total below is the sum of
-- confirmed receipts, not a cash count and not an available-to-disburse figure.
--
-- Source material was the preserved `feat/stage-14-imprest-application` branch. Nothing is copied
-- from it wholesale: its position view reads expense tables that do not exist in this slice, and
-- its single-row funding cannot hold an approval increase or a disputed handover without
-- overwriting the first claim. The shape here keeps every claim as its own row:
--
--   imprest_fundings            one row per request; its status, and the receipt once confirmed
--   imprest_funding_approvals   APPEND ONLY. Sequence 1 is the approval; later rows are increases
--   imprest_funding_handovers   APPEND ONLY. Cycle 1 is the provision; later rows are corrections
--   imprest_funding_mismatches  APPEND ONLY. At most one per handover: what the Manager counted
--
-- Posting happens in exactly one place: a funding whose status is `received` contributes its
-- `received_amount_tzs`, which the confirmation copies from the handover the Manager confirmed.
-- A received funding can never change again, so it can never post twice.

begin;

create type public.imprest_funding_status as enum (
  'requested',  -- the Manager asked. Nothing is posted (§13.2 point 3, AC-47)
  'approved',   -- a Director agreed an amount. Still nothing is posted
  'provided',   -- a Director recorded a handover, which awaits the Manager's confirmation
  'disputed',   -- the Manager counted something else. Awaits a Director's corrected handover
  'received',   -- the Manager confirmed the current handover. ONLY NOW is it posted (AC-48)
  'rejected'    -- a Director refused the request, with a reason (§4.3)
);

comment on type public.imprest_funding_status is
  'The funding workflow of product.md §13.2 with the approved discrepancy cycle. Only `received` '
  'contributes to posted funding.';

-- ---------------------------------------------------------------------------
-- imprest_funds — the one continuing fund, opened by the first request
--
-- §13 speaks of "the imprest" as one fund. It is kept so that the later spending slice has a fund
-- to hang expenses on, and so that the funding total has a row to belong to: a role that may not
-- read imprest sees NO row rather than a total of zero.
-- ---------------------------------------------------------------------------
create table public.imprest_funds (
  id         uuid primary key default gen_random_uuid(),
  opened_by  uuid not null references public.profiles (id),
  opened_at  timestamptz not null default now(),
  is_active  boolean not null default true
);

comment on table public.imprest_funds is
  'The imprest fund the Manager holds (product.md §13). One active at a time, opened by the first '
  'funding request.';

create unique index imprest_one_active_fund_idx on public.imprest_funds ((true)) where is_active;
create index imprest_funds_opened_by_idx on public.imprest_funds (opened_by);

-- ---------------------------------------------------------------------------
-- imprest_fundings — one request and what finally became of it
-- ---------------------------------------------------------------------------
create table public.imprest_fundings (
  id                    uuid primary key default gen_random_uuid(),
  funding_no            text not null unique,
  fund_id               uuid not null references public.imprest_funds (id) on delete restrict,
  status                public.imprest_funding_status not null default 'requested',
  -- Every transition increments it. A command states the version it was shown and is refused
  -- when the funding has moved since, so a stale screen cannot act on an older handover.
  version               integer not null default 1 check (version >= 1),
  requested_amount_tzs  bigint not null check (requested_amount_tzs > 0
                                               and requested_amount_tzs <= 100000000),
  reason                text not null check (length(btrim(reason)) between 3 and 500),
  requested_by          uuid not null references public.profiles (id),
  requested_at          timestamptz not null default now(),
  rejected_by           uuid references public.profiles (id),
  rejected_at           timestamptz,
  rejection_reason      text check (rejection_reason is null
                                    or length(btrim(rejection_reason)) between 3 and 500),
  -- The receipt. `received_handover_id` names the handover the Manager confirmed, and the amount
  -- is copied from it inside the same locked transaction.
  received_handover_id  uuid,
  received_amount_tzs   bigint check (received_amount_tzs is null or received_amount_tzs > 0),
  received_by           uuid references public.profiles (id),
  received_at           timestamptz,
  constraint funding_rejection_shape check (
    (status = 'rejected') = (rejected_by is not null)
    and (rejected_by is null) = (rejected_at is null)
    and (rejected_by is null) = (rejection_reason is null)
  ),
  constraint funding_receipt_shape check (
    (status = 'received') = (received_by is not null)
    and (received_by is null) = (received_at is null)
    and (received_by is null) = (received_amount_tzs is null)
    and (received_by is null) = (received_handover_id is null)
  )
);

comment on table public.imprest_fundings is
  'One imprest funding request (product.md §13.2). Posted funding is the received amount of the '
  'received rows and nothing else: request, approval, increase, provision, mismatch and correction '
  'post nothing (AC-47, AC-48).';

create index imprest_fundings_fund_idx     on public.imprest_fundings (fund_id, requested_at desc);
create index imprest_fundings_status_idx   on public.imprest_fundings (status, requested_at desc);
create index imprest_fundings_requested_idx on public.imprest_fundings (requested_by);
create index imprest_fundings_rejected_idx on public.imprest_fundings (rejected_by);
create index imprest_fundings_received_idx on public.imprest_fundings (received_by);

create table public.imprest_funding_approvals (
  id          uuid primary key default gen_random_uuid(),
  funding_id  uuid not null references public.imprest_fundings (id) on delete restrict,
  sequence    integer not null check (sequence >= 1),
  amount_tzs  bigint not null check (amount_tzs > 0 and amount_tzs <= 100000000),
  -- Null on the original approval, optional on an increase.
  note        text check (note is null or length(btrim(note)) between 3 and 500),
  approved_by uuid not null references public.profiles (id),
  approved_at timestamptz not null default now(),
  unique (funding_id, sequence)
);

comment on table public.imprest_funding_approvals is
  'Every approval amount a Director recorded on a funding, in order. Sequence 1 is the original '
  'approval; each later row is an increase and must be higher. Nothing here posts money.';

create index imprest_funding_approvals_by_idx on public.imprest_funding_approvals (approved_by);

create table public.imprest_funding_handovers (
  id          uuid primary key default gen_random_uuid(),
  funding_id  uuid not null references public.imprest_fundings (id) on delete restrict,
  cycle       integer not null check (cycle >= 1),
  amount_tzs  bigint not null check (amount_tzs > 0 and amount_tzs <= 100000000),
  -- The Director's explanation of a corrected handover. The first provision has none.
  explanation text check (explanation is null or length(btrim(explanation)) between 3 and 500),
  provided_by uuid not null references public.profiles (id),
  provided_at timestamptz not null default now(),
  unique (funding_id, cycle),
  constraint handover_explanation_shape check ((cycle = 1) = (explanation is null))
);

comment on table public.imprest_funding_handovers is
  'Every handover a Director recorded: cycle 1 is Imprest Provided, later cycles are corrected '
  'handovers after a reported mismatch. None of them posts money.';

create index imprest_funding_handovers_by_idx on public.imprest_funding_handovers (provided_by);

alter table public.imprest_fundings
  add constraint imprest_fundings_received_handover_fk
  foreign key (received_handover_id) references public.imprest_funding_handovers (id);
create index imprest_fundings_received_handover_idx
  on public.imprest_fundings (received_handover_id);

create table public.imprest_funding_mismatches (
  id           uuid primary key default gen_random_uuid(),
  funding_id   uuid not null references public.imprest_fundings (id) on delete restrict,
  handover_id  uuid not null unique references public.imprest_funding_handovers (id),
  -- What the Manager counted. Zero records that no cash arrived.
  counted_tzs  bigint not null check (counted_tzs >= 0 and counted_tzs <= 100000000),
  note         text check (note is null or length(btrim(note)) between 3 and 500),
  reported_by  uuid not null references public.profiles (id),
  reported_at  timestamptz not null default now()
);

comment on table public.imprest_funding_mismatches is
  'What the Manager counted when it differed from a recorded handover. A shortage and an excess '
  'are both kept, and neither posts money.';

create index imprest_funding_mismatches_funding_idx on public.imprest_funding_mismatches (funding_id);
create index imprest_funding_mismatches_by_idx on public.imprest_funding_mismatches (reported_by);

-- ---------------------------------------------------------------------------
-- History cannot be rewritten, by anybody
--
-- The three history tables are append only. A funding row may move forward through its states,
-- one version at a time, and nothing else: what was requested stays what was requested, and a
-- received or rejected funding is final.
-- ---------------------------------------------------------------------------
create or replace function private.refuse_imprest_history_edit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is imprest funding history: rows are added, never changed or removed',
    tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

comment on function private.refuse_imprest_history_edit() is
  'Refuses UPDATE and DELETE on the append-only imprest funding history, for every role.';

alter function private.refuse_imprest_history_edit() owner to fv_definer_owner;
revoke execute on function private.refuse_imprest_history_edit()
  from public, anon, authenticated, service_role;

create trigger imprest_funding_approvals_append_only
  before update or delete on public.imprest_funding_approvals
  for each row execute function private.refuse_imprest_history_edit();
create trigger imprest_funding_handovers_append_only
  before update or delete on public.imprest_funding_handovers
  for each row execute function private.refuse_imprest_history_edit();
create trigger imprest_funding_mismatches_append_only
  before update or delete on public.imprest_funding_mismatches
  for each row execute function private.refuse_imprest_history_edit();

create or replace function private.guard_imprest_funding_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'imprest funding % cannot be deleted', old.id using errcode = 'restrict_violation';
  end if;

  if old.status in ('received', 'rejected') then
    raise exception 'imprest funding % is % and final', old.id, old.status
      using errcode = 'restrict_violation';
  end if;

  if new.id is distinct from old.id
     or new.funding_no is distinct from old.funding_no
     or new.fund_id is distinct from old.fund_id
     or new.requested_amount_tzs is distinct from old.requested_amount_tzs
     or new.reason is distinct from old.reason
     or new.requested_by is distinct from old.requested_by
     or new.requested_at is distinct from old.requested_at then
    raise exception 'imprest funding % keeps what was requested', old.id
      using errcode = 'restrict_violation';
  end if;

  if new.version <> old.version + 1 then
    raise exception 'imprest funding % moves one version at a time', old.id
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

comment on function private.guard_imprest_funding_update() is
  'A funding moves forward one version per transition, never changes what was requested, and is '
  'final once received or rejected. Refuses deletion outright.';

alter function private.guard_imprest_funding_update() owner to fv_definer_owner;
revoke execute on function private.guard_imprest_funding_update()
  from public, anon, authenticated, service_role;

create trigger imprest_fundings_guard
  before update or delete on public.imprest_fundings
  for each row execute function private.guard_imprest_funding_update();

-- ---------------------------------------------------------------------------
-- Read models
-- ---------------------------------------------------------------------------
create view public.imprest_funding_summaries
with (security_invoker = true) as
select f.id,
       f.funding_no,
       f.fund_id,
       f.status,
       f.version,
       f.requested_amount_tzs,
       f.reason,
       f.requested_by,
       f.requested_at,
       first_a.amount_tzs    as original_approved_tzs,
       cur_a.amount_tzs      as approved_amount_tzs,
       cur_a.approved_by,
       cur_a.approved_at,
       coalesce(cur_a.sequence, 0) as approval_count,
       cur_h.id              as handover_id,
       cur_h.amount_tzs      as provided_amount_tzs,
       cur_h.provided_by,
       cur_h.provided_at,
       coalesce(cur_h.cycle, 0) as handover_count,
       cur_m.counted_tzs     as disputed_counted_tzs,
       f.rejected_by,
       f.rejected_at,
       f.rejection_reason,
       f.received_amount_tzs,
       f.received_by,
       f.received_at
  from public.imprest_fundings f
  left join lateral (
    select a.amount_tzs from public.imprest_funding_approvals a
     where a.funding_id = f.id and a.sequence = 1
  ) first_a on true
  left join lateral (
    select a.amount_tzs, a.approved_by, a.approved_at, a.sequence
      from public.imprest_funding_approvals a
     where a.funding_id = f.id order by a.sequence desc limit 1
  ) cur_a on true
  left join lateral (
    select h.id, h.amount_tzs, h.provided_by, h.provided_at, h.cycle
      from public.imprest_funding_handovers h
     where h.funding_id = f.id order by h.cycle desc limit 1
  ) cur_h on true
  left join lateral (
    select m.counted_tzs from public.imprest_funding_mismatches m
     where m.handover_id = cur_h.id
  ) cur_m on true;

comment on view public.imprest_funding_summaries is
  'One row per funding with its current approval, current handover and any count disputing that '
  'handover. Requested, approved, provided and received stay separate columns (AC-49).';

create view public.imprest_funding_position
with (security_invoker = true) as
select fu.id as fund_id,
       coalesce(sum(f.received_amount_tzs) filter (where f.status = 'received'), 0)::bigint
         as posted_funding_tzs,
       count(f.id) filter (where f.status = 'received')::integer as received_count
  from public.imprest_funds fu
  left join public.imprest_fundings f on f.fund_id = fu.id
 where fu.is_active
 group by fu.id;

comment on view public.imprest_funding_position is
  'Posted imprest funding: the sum of confirmed receipts. It is NOT a physical cash count and not '
  'an available-to-disburse figure; spending and reconciliation are not in this slice.';

-- ---------------------------------------------------------------------------
-- Grants and row-level security
--
-- Reads follow the imprest read policy of the Stage 14 design: a Director, the Manager and the
-- Cashier read imprest; a Sales Representative reads none of it. Writes go through the api
-- commands alone, which run as fv_definer_owner. The service role holds nothing.
-- ---------------------------------------------------------------------------
alter table public.imprest_funds              enable row level security;
alter table public.imprest_fundings           enable row level security;
alter table public.imprest_funding_approvals  enable row level security;
alter table public.imprest_funding_handovers  enable row level security;
alter table public.imprest_funding_mismatches enable row level security;

revoke all on public.imprest_funds, public.imprest_fundings, public.imprest_funding_approvals,
              public.imprest_funding_handovers, public.imprest_funding_mismatches,
              public.imprest_funding_summaries, public.imprest_funding_position
  from public, anon, authenticated, service_role;

grant select on public.imprest_funds, public.imprest_fundings, public.imprest_funding_approvals,
                public.imprest_funding_handovers, public.imprest_funding_mismatches,
                public.imprest_funding_summaries, public.imprest_funding_position
  to authenticated;

grant select, insert, update on public.imprest_funds, public.imprest_fundings to fv_definer_owner;
grant select, insert on public.imprest_funding_approvals, public.imprest_funding_handovers,
                        public.imprest_funding_mismatches to fv_definer_owner;
grant select on public.imprest_funding_summaries, public.imprest_funding_position
  to fv_definer_owner;

do $$
declare t text;
begin
  foreach t in array array['imprest_funds', 'imprest_fundings', 'imprest_funding_approvals',
                           'imprest_funding_handovers', 'imprest_funding_mismatches'] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using '
      '((select private.authorize(array[''director'',''manager'',''cashier'']::public.app_role[])))',
      t || '_select', t);
    execute format(
      'create policy %I on public.%I for all to fv_definer_owner using (true) with check (true)',
      t || '_definer_owner', t);
  end loop;
end
$$;

-- Funding numbers join the daily document numbering, as batches did in migration 20260822001100.
do $$
declare
  v_definition text := (
    select pg_get_constraintdef(c.oid)
      from pg_constraint c
      join pg_class t     on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'document_sequences'
       and c.conname = 'document_sequences_kind_check');
  v_kind text;
begin
  if v_definition is null then
    raise exception 'public.document_sequences has no document_sequences_kind_check to extend';
  end if;
  foreach v_kind in array array['order', 'proforma', 'invoice', 'batch'] loop
    if position('''' || v_kind || '''' in v_definition) = 0 then
      raise exception 'the released numbering permits % and this migration would drop it: %',
        v_kind, v_definition;
    end if;
  end loop;
  if position('''imprest''' in v_definition) > 0 then
    raise exception 'public.document_sequences already permits an imprest kind: %', v_definition;
  end if;
end
$$;

alter table public.document_sequences drop constraint document_sequences_kind_check;
alter table public.document_sequences
  add constraint document_sequences_kind_check
  check (kind in ('order', 'proforma', 'invoice', 'batch', 'imprest'));

commit;
