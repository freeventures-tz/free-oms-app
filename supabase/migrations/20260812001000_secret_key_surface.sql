-- Stage 8A hardening · What the secret key can actually do
--
-- `service_role` carries BYPASSRLS. That makes RLS irrelevant to it, so the ONLY thing standing
-- between the secret key and every row in the database is the GRANT layer. This migration makes
-- that layer say what the architecture already claims: the server may call the named `api`
-- functions, and may not touch tables.
--
-- Discovered while writing the integration tests, and worth stating plainly: `service_role` already
-- held no SELECT, INSERT, UPDATE or DELETE on these tables, because they are created by `postgres`
-- and the default privileges for that role grant service_role only TRUNCATE, REFERENCES and
-- TRIGGER. That accident is now a decision — including TRUNCATE, which is a destructive privilege
-- nothing in this system needs and which RLS could not have restrained.
--
-- The consequence is a property worth having: a leaked secret key cannot read the audit trail,
-- cannot read profiles, and cannot empty a table. It can only do the specific things the `api`
-- functions do, each of which checks live Director authority and writes its own audit row.

begin;

revoke all on all tables in schema public from service_role;

-- Attempted for future tables. NOT relied upon — the same statement writes no default-ACL row for
-- schemas that have none, and test 003 asserts the property structurally instead.
alter default privileges in schema public revoke all on tables from service_role;

comment on schema api is
  'Exposed through PostgREST and executable ONLY by service_role. Functions only — no tables, no '
  'views. This schema is the entire surface the Supabase secret key has on this database.';

commit;
