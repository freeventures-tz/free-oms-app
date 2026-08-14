-- Stage 8A · Foundation: schemas, restricted definer owner, enums
--
-- Privilege model (single, coherent — architecture.md §5.5, §5.6):
--   public   exposed via Data API. RLS on every table. Narrow grants.
--   api      exposed via Data API. FUNCTIONS ONLY. SECURITY INVOKER wrappers.
--   private  NOT exposed. Implementations, authorization predicate, auth hook.
--
-- Every SECURITY DEFINER function is owned by fv_definer_owner (NOLOGIN),
-- never postgres, so a definer runs with the narrowest rights that work.

begin;

-- ---------------------------------------------------------------------------
-- Extensions (digest() for the first-login password fingerprint)
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Restricted owner for SECURITY DEFINER functions
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'fv_definer_owner') then
    create role fv_definer_owner nologin noinherit;
  end if;

  -- PostgreSQL requires the current user to be a MEMBER of a role before it can
  -- reassign objects to it (ALTER ... OWNER TO). Grant membership to whichever
  -- role runs migrations, and to postgres, which owns the schemas.
  execute format('grant fv_definer_owner to %I', current_user);

  if exists (select 1 from pg_roles where rolname = 'postgres')
     and current_user <> 'postgres' then
    execute 'grant fv_definer_owner to postgres';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Schemas
-- ---------------------------------------------------------------------------
create schema if not exists api;
create schema if not exists private;

-- Strip defaults, then grant back deliberately.
revoke all on schema api      from public;
revoke all on schema private  from public;

grant usage on schema api     to authenticated;
grant usage on schema private to authenticated;   -- resolution only; execute is per-function

-- A function's owner must hold CREATE on the schema that contains it, otherwise
-- ALTER FUNCTION ... OWNER TO is refused.
grant usage, create on schema private to fv_definer_owner;
grant usage         on schema api     to fv_definer_owner;

-- anon reaches nothing. There is no public signup (product.md §17.1).
revoke all on schema api      from anon;
revoke all on schema private  from anon;

-- Default privileges: an attempt to stop PUBLIC receiving EXECUTE on future functions.
--
-- PROVEN NOT TO WORK ON THIS DATABASE, and therefore NOT RELIED UPON. Running these statements as
-- `postgres` reports "ALTER DEFAULT PRIVILEGES" and writes NO pg_default_acl row, so a function
-- created afterwards in either schema still has `proacl = NULL` — which means PUBLIC holds
-- EXECUTE. This is the same failure shape as the `auth` schema GRANT recorded in migration 000400:
-- a statement that succeeds loudly and does nothing.
--
-- The real control is an explicit REVOKE on every function, and test 003 asserts, structurally,
-- that no function anywhere in `api` or `private` leaves EXECUTE with PUBLIC. The statements are
-- kept because they are correct intent and harmless where they do work.
alter default privileges in schema api     revoke execute on functions from public;
alter default privileges in schema private revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Enums (Stage 8A subset — business enums arrive with their modules)
-- ---------------------------------------------------------------------------
create type public.app_role as enum ('director', 'manager', 'cashier', 'sales_rep');

create type public.approval_status as enum (
  'pending', 'approved', 'rejected', 'escalated', 'superseded', 'cancelled', 'expired', 'withdrawn'
);

create type public.decision_outcome as enum (
  'approved', 'rejected', 'escalated', 'superseded', 'cancelled', 'expired', 'withdrawn'
);

create type public.approval_type as enum (
  'discount', 'credit_or_unpaid_balance', 'payment_reversal', 'stock_adjustment',
  'accountability', 'imprest_funding', 'imprest_expense', 'imprest_expense_amendment',
  'imprest_reversal', 'imprest_retirement'
);

create type public.provisioning_stage as enum (
  'pending', 'auth_created', 'profile_created', 'complete', 'failed'
);

commit;
