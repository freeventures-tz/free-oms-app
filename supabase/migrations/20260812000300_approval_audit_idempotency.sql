-- Stage 8A · Approval requests + append-only decisions, audit, idempotency
--
-- Two rules this file exists to enforce:
--   1. A non-approval outcome carries NO approver (architecture.md §7.10).
--      The former `ELSE TRUE` branch let a rejected row keep approved_by.
--   2. approval_decisions is append-only and authoritative; the columns on
--      approval_requests are a server-owned projection (§7.10a).

begin;

-- ---------------------------------------------------------------------------
-- approval_requests — live request + approval projection
-- ---------------------------------------------------------------------------
create table public.approval_requests (
  id                uuid primary key default gen_random_uuid(),
  entity_type       text not null check (length(btrim(entity_type)) > 0),
  entity_id         uuid not null,
  approval_type     public.approval_type not null,
  request_seq       integer not null default 1 check (request_seq > 0),

  requested_by      uuid not null references public.profiles (id),
  requested_role    public.app_role not null,
  requested_at      timestamptz not null default now(),
  requested_amount  bigint check (requested_amount is null or requested_amount > 0),
  requested_percent numeric(5,2) check (requested_percent is null or requested_percent > 0),
  required_role     public.app_role not null,

  -- Projection of the latest approval_decisions row. One transactional writer.
  status            public.approval_status not null default 'pending',
  approved_by       uuid references public.profiles (id),
  approved_role     public.app_role,
  approved_at       timestamptz,

  idempotency_key   text unique,

  -- Enumerated: 'approved' requires a full approver; EVERY other status,
  -- pending and non-approval outcomes alike, requires the approval fields null.
  constraint approval_fields_match_status check (
    case status
      when 'approved' then approved_by is not null
                       and approved_role is not null
                       and approved_at is not null
      else                 approved_by is null
                       and approved_role is null
                       and approved_at is null
    end
  ),
  constraint approved_at_not_before_requested check (
    approved_at is null or approved_at >= requested_at
  ),

  unique (entity_type, entity_id, approval_type, request_seq)
);

-- At most one live approval per entity per approval type. Partial uniqueness must
-- be an INDEX; PostgreSQL rejects a WHERE clause on a table-level UNIQUE constraint.
create unique index approval_requests_one_live_approval_idx
  on public.approval_requests (entity_type, entity_id, approval_type)
  where status = 'approved';

create index approval_requests_queue_idx  on public.approval_requests (status, required_role);
create index approval_requests_entity_idx on public.approval_requests (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- approval_decisions — APPEND ONLY, authoritative
-- ---------------------------------------------------------------------------
create table public.approval_decisions (
  id                     uuid primary key default gen_random_uuid(),
  request_id             uuid not null references public.approval_requests (id) on delete restrict,
  outcome                public.decision_outcome not null,
  decided_by             uuid not null references public.profiles (id),
  decided_role           public.app_role not null,
  decided_at             timestamptz not null default now(),
  reason_code            text,
  note                   text,
  supersedes_decision_id uuid references public.approval_decisions (id)
);

create index approval_decisions_request_idx on public.approval_decisions (request_id, decided_at desc);
create index approval_decisions_actor_idx   on public.approval_decisions (decided_by, decided_at desc);

-- ---------------------------------------------------------------------------
-- audit_events — APPEND ONLY, permanent retention (product.md §16)
-- ---------------------------------------------------------------------------
create table public.audit_events (
  id                 uuid primary key default gen_random_uuid(),
  actor_id           uuid references public.profiles (id),   -- NULL for trusted system jobs
  actor_role         public.app_role,                        -- NULL alongside a 'system' source
  is_system_actor    boolean not null default false,
  action             text not null check (length(btrim(action)) > 0),
  entity_type        text,
  entity_id          uuid,
  before_state       jsonb,
  after_state        jsonb,
  approval_reference uuid references public.approval_requests (id),
  correlation_id     uuid not null,
  source_operation   text,
  occurred_at        timestamptz not null default now(),

  -- A system actor has no end user; a user actor must be identified.
  constraint audit_actor_shape check (
    (is_system_actor and actor_id is null)
    or (not is_system_actor and actor_id is not null)
  )
);

create index audit_events_entity_idx      on public.audit_events (entity_type, entity_id, occurred_at desc);
create index audit_events_actor_idx       on public.audit_events (actor_id, occurred_at desc);
create index audit_events_correlation_idx on public.audit_events (correlation_id);
create index audit_events_action_idx      on public.audit_events (action, occurred_at desc);

-- ---------------------------------------------------------------------------
-- idempotency_keys — retained permanently (architecture.md §5.7)
-- ---------------------------------------------------------------------------
create table public.idempotency_keys (
  key        text primary key,
  operation  text not null,
  result_ref uuid,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create index idempotency_keys_created_idx on public.idempotency_keys (created_at);

commit;
