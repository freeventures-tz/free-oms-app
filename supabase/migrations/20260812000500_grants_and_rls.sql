-- Stage 8A · Grants and RLS
--
-- Two independent mechanisms, both required (architecture.md §13.1):
--   GRANT/REVOKE  which tables and COLUMNS a role may touch
--   RLS           which ROWS
--
-- The approval-bypass fix (§13.2) lives in the grant layer: `authenticated`
-- receives no grant on status/approved_by/approved_role/approved_at anywhere,
-- so a direct UPDATE fails on privilege before any policy is consulted.

begin;

-- ---------------------------------------------------------------------------
-- Strip defaults across public, then grant back deliberately.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from public, anon, authenticated;

alter table public.profiles                  enable row level security;
alter table public.user_roles                enable row level security;
alter table public.account_provisioning_jobs enable row level security;
alter table public.approval_requests         enable row level security;
alter table public.approval_decisions        enable row level security;
alter table public.audit_events              enable row level security;
alter table public.idempotency_keys          enable row level security;

-- ---------------------------------------------------------------------------
-- profiles
--   SELECT   own row (gated users included, for the setup screen) or via role
--   UPDATE   own row, COLUMN-LIMITED to locale. Nothing else is writable:
--            not is_active, not must_change_password, not password_fingerprint.
-- ---------------------------------------------------------------------------
grant select          on public.profiles to authenticated;
grant update (locale) on public.profiles to authenticated;

-- Reachable while first-login gated: deliberately does NOT call authorize().
-- This is the narrow carve-out that lets a gated user see the setup screen.
create policy profiles_select_own on public.profiles
  for select to authenticated
  using ( id = (select private.request_uid()) );

create policy profiles_select_staff on public.profiles
  for select to authenticated
  using ( (select private.authorize(array['manager','director']::public.app_role[])) );

create policy profiles_update_own_locale on public.profiles
  for update to authenticated
  using      ( id = (select private.request_uid()) and is_active )
  with check ( id = (select private.request_uid()) and is_active );

-- ---------------------------------------------------------------------------
-- user_roles — read only for users; all assignment happens in privileged code.
-- fv_definer_owner needs an explicit policy: it is not the table owner, so RLS
-- applies to it inside SECURITY DEFINER functions (including the Auth hook).
-- ---------------------------------------------------------------------------
grant select on public.user_roles to authenticated;

create policy user_roles_select_own on public.user_roles
  for select to authenticated
  using ( user_id = (select private.request_uid()) );

create policy user_roles_select_oversight on public.user_roles
  for select to authenticated
  using ( (select private.authorize(array['manager','director']::public.app_role[])) );

create policy user_roles_select_definer_owner on public.user_roles
  for select to fv_definer_owner
  using ( true );

-- ---------------------------------------------------------------------------
-- account_provisioning_jobs — Director visibility only, no direct write.
-- ---------------------------------------------------------------------------
grant select on public.account_provisioning_jobs to authenticated;

create policy provisioning_select_director on public.account_provisioning_jobs
  for select to authenticated
  using ( (select private.authorize(array['director']::public.app_role[])) );

-- ---------------------------------------------------------------------------
-- approval_requests
--   SELECT only. NO update grant at all — approval columns are unreachable by
--   any direct statement, which is what closes the bypass.
-- ---------------------------------------------------------------------------
grant select on public.approval_requests to authenticated;

create policy approval_requests_select_own on public.approval_requests
  for select to authenticated
  using ( requested_by = (select private.request_uid()) );

create policy approval_requests_select_deciders on public.approval_requests
  for select to authenticated
  using ( (select private.authorize(array['cashier','manager','director']::public.app_role[])) );

-- ---------------------------------------------------------------------------
-- approval_decisions — APPEND ONLY: SELECT policy only, and no write grant.
-- ---------------------------------------------------------------------------
grant select on public.approval_decisions to authenticated;

create policy approval_decisions_select on public.approval_decisions
  for select to authenticated
  using ( (select private.authorize(array['cashier','manager','director']::public.app_role[])) );

-- ---------------------------------------------------------------------------
-- audit_events — oversight read only. No INSERT/UPDATE/DELETE grant, ever.
-- Belt and braces beyond the blanket revoke above.
-- ---------------------------------------------------------------------------
grant select on public.audit_events to authenticated;
revoke insert, update, delete on public.audit_events from authenticated;

create policy audit_events_select_oversight on public.audit_events
  for select to authenticated
  using ( (select private.authorize(array['manager','director']::public.app_role[])) );

-- ---------------------------------------------------------------------------
-- idempotency_keys — no grant of any kind. Written only inside functions.
-- RLS on with zero policies: denies everything to authenticated.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Definer owner needs table access for the functions it owns.
-- ---------------------------------------------------------------------------
grant select, update on public.profiles      to fv_definer_owner;
grant insert         on public.audit_events  to fv_definer_owner;

create policy profiles_definer_owner_all on public.profiles
  for all to fv_definer_owner
  using ( true ) with check ( true );

create policy audit_events_definer_owner_insert on public.audit_events
  for insert to fv_definer_owner
  with check ( true );

commit;
