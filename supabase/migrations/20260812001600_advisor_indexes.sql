-- Stage 8B corrective · Index every foreign key
--
-- The `unindexed_foreign_keys` advisor is informational, not an error: PostgreSQL does not require
-- an index on the referencing side. It matters here for two reasons. Deleting or updating a
-- referenced row scans the referencing table without one — and every one of these columns is a
-- column somebody will actually filter on: "what did this Director do", "who requested this",
-- "which decision superseded that one".
--
-- The write cost is a few bytes per insert on tables that see tens of rows a day.

begin;

create index if not exists provisioning_requested_by_idx
  on public.account_provisioning_jobs (requested_by);

create index if not exists admin_commands_actor_idx
  on public.admin_commands (actor_id, created_at desc);

create index if not exists approval_decisions_supersedes_idx
  on public.approval_decisions (supersedes_decision_id);

create index if not exists approval_requests_approved_by_idx
  on public.approval_requests (approved_by);

create index if not exists approval_requests_requested_by_idx
  on public.approval_requests (requested_by);

create index if not exists audit_events_approval_reference_idx
  on public.audit_events (approval_reference);

create index if not exists idempotency_keys_created_by_idx
  on public.idempotency_keys (created_by);

create index if not exists user_roles_assigned_by_idx
  on public.user_roles (assigned_by);

commit;
