-- Supabase database advisors, run locally and in CI.
--
-- `supabase db lint` is a plpgsql checker; it is NOT the advisors. The CLI has no advisors command
-- (`supabase inspect db` offers only performance statistics), and the hosted Advisors page cannot
-- see a local database. So the rules are implemented here, from Supabase's published lint
-- definitions, and this script EXITS NON-ZERO on any finding — which is the part that matters.
--
-- Scope: the rules that apply to a schema of this shape. Rules about auth-schema exposure, foreign
-- tables, extensions in public and materialised views are not reachable in this database and are
-- deliberately absent rather than silently passing.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

create temporary table advisor_findings (rule text, level text, detail text);

-- 0002 auth_users_exposed: no view or table in an exposed schema may surface auth.users.
insert into advisor_findings
select 'auth_users_exposed', 'ERROR', n.nspname || '.' || c.relname
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'api')
  and c.relkind in ('v', 'm')
  and pg_get_viewdef(c.oid) ilike '%auth.users%';

-- 0007 rls_disabled_in_public: every table in an exposed schema must have RLS.
insert into advisor_findings
select 'rls_disabled_in_public', 'ERROR', n.nspname || '.' || c.relname
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

-- 0008 rls_enabled_no_policy: RLS with no policy denies everything, which is usually a mistake.
-- `idempotency_keys` is deliberate: it is written only inside functions and read by nobody.
insert into advisor_findings
select 'rls_enabled_no_policy', 'INFO', n.nspname || '.' || c.relname
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  and c.relname <> 'idempotency_keys'
  and not exists (
    select 1 from pg_policy p where p.polrelid = c.oid
  );

-- 0006 multiple_permissive_policies: two permissive policies for the same role and action are
-- evaluated separately and ORed, on every row.
insert into advisor_findings
select 'multiple_permissive_policies', 'WARN',
       tablename || ' / ' || roles::text || ' / ' || cmd || ' -> ' || string_agg(policyname, ', ')
from pg_policies
where schemaname = 'public' and permissive = 'PERMISSIVE'
group by tablename, roles, cmd
having count(*) > 1;

-- 0003 auth_rls_initplan: a policy that calls a function per ROW instead of once per QUERY.
-- Wrapping the call in a scalar sub-select makes PostgreSQL evaluate it once.
--
-- Detected by ELIMINATION rather than by a lookbehind: PostgreSQL deparses a wrapped call as
-- `( SELECT private.authorize(...) AS authorize)`, in upper case, so a case-sensitive
-- "not preceded by select" pattern matches every policy and reports nothing but false alarms —
-- which is exactly what the first version of this rule did. Strip the wrapped calls first; whatever
-- still names one of these functions is genuinely unwrapped.
insert into advisor_findings
select 'auth_rls_initplan', 'WARN', tablename || ' / ' || policyname
from pg_policies
where schemaname = 'public'
  and regexp_replace(
        coalesce(qual, '') || ' ' || coalesce(with_check, ''),
        'select\s+private\.', '', 'gi'
      ) ~* 'private\.(authorize|request_uid|current_role_hint)\s*\(';

-- 0011 function_search_path_mutable: every function we own must pin search_path.
insert into advisor_findings
select 'function_search_path_mutable', 'WARN', n.nspname || '.' || p.proname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'api', 'private')
  and p.prokind = 'f'
  and (p.proconfig is null or not ('search_path=""' = any (p.proconfig)));

-- 0001 unindexed_foreign_keys: a foreign key with no leading index makes the referencing side scan.
insert into advisor_findings
select 'unindexed_foreign_keys', 'INFO',
       conrelid::regclass::text || ' (' || conname || ')'
from pg_constraint c
where c.contype = 'f'
  and connamespace = 'public'::regnamespace
  and not exists (
    select 1 from pg_index i
    where i.indrelid = c.conrelid
      and (i.indkey::smallint[])[0:array_length(c.conkey, 1) - 1] @> c.conkey
      and array_length(c.conkey, 1) = 1
      and (i.indkey::smallint[])[0] = c.conkey[1]
  );

-- Project rule, not a Supabase one, and the one a leaked secret key depends on:
-- service_role must hold no privilege on any table in an exposed schema.
insert into advisor_findings
select 'service_role_table_privilege', 'ERROR', table_name || ':' || privilege_type
from information_schema.table_privileges
where grantee = 'service_role' and table_schema = 'public';

\pset tuples_only off
\pset format aligned
select rule, level, detail from advisor_findings order by level, rule, detail;

\pset tuples_only on
\pset format unaligned
select case
         when count(*) = 0 then 'ADVISORS: no findings'
         else 'ADVISORS: ' || count(*) || ' finding(s)'
       end
from advisor_findings;

-- Fail the run on anything at WARN or above. INFO is reported and tolerated.
do $$
declare
  v_blocking integer;
begin
  select count(*) into v_blocking from advisor_findings where level in ('ERROR', 'WARN');
  if v_blocking > 0 then
    raise exception 'database advisors reported % blocking finding(s)', v_blocking;
  end if;
end
$$;
