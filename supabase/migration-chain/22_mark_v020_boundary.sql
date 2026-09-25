-- Issue #55 · Migration chain, step 22: the released v0.2.0 database, and nothing after it
--
-- Runs against a database reset to `20260923000200_scheduled_report_retries_and_alerts` — the 41st
-- and last released migration, which is what hosted Supabase holds once v0.2.0 is applied. The
-- v0.2.0 phase then builds the v0.0.5 ground on it (step 11), adds imprest funding (step 15) and a
-- real scheduled report (step 23), so the disbursement migration meets a database carrying every
-- kind of record production can hold.
--
-- It asserts the boundary before writing the marker that step 11 reads, so the marker can only ever
-- exist on the database it names. It also pins the ONE released object the disbursement migration
-- replaces: the preservation query leaves `document_sequences_kind_check` out of its constraint
-- digest, so its released text is required here, exactly, and its new text in step 24.

begin;

do $$
declare
  v_kinds text;
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 41
     or (select max(version) from supabase_migrations.schema_migrations) <> '20260923000200' then
    raise exception
      'the database is not at the v0.2.0 boundary: expected 41 migrations ending at 20260923000200. '
      'Reset to version 20260923000200 before running this fixture';
  end if;

  if to_regclass('public.report_alerts') is null
     or to_regclass('public.report_schedule_slots') is null then
    raise exception 'the database is not at the v0.2.0 boundary: the report retry tables are missing';
  end if;

  if to_regclass('public.imprest_disbursements') is not null
     or to_regtype('public.imprest_category') is not null
     or to_regtype('public.imprest_disbursement_status') is not null then
    raise exception
      'the database is already past v0.2.0: the disbursement objects exist. Reset to version '
      '20260923000200 before running this fixture, or it proves nothing';
  end if;

  select pg_get_constraintdef(c.oid) into v_kinds
    from pg_constraint c
   where c.conrelid = 'public.document_sequences'::regclass
     and c.conname = 'document_sequences_kind_check';

  if v_kinds is distinct from
     'CHECK ((kind = ANY (ARRAY[''order''::text, ''proforma''::text, ''invoice''::text, '
     '''batch''::text, ''imprest''::text])))' then
    raise exception 'the released document numbering constraint is not the v0.2.0 one: %', v_kinds;
  end if;
end
$$;

create schema if not exists migration_chain;

create table migration_chain.boundary (version text primary key);
insert into migration_chain.boundary values ('20260923000200');

commit;

\echo 'migration-chain: the database is the released v0.2.0 shape'
