-- Issue #83 · Migration chain, step 83c: what the till migration added to a populated v0.12.1
-- database, and proof that it works against one
--
-- The preservation query has already required every released row, file, report, Cron job, grant,
-- policy, constraint, trigger, function body, enum, column, view and index to be identical, apart
-- from what this release adds. This file checks the other half: what arrived, with the grants and
-- row-level security it needs; that no count was written and counting starts today; that the
-- expected figures are the released payments' own; and that a count runs to a committed
-- confirmation against released payments, moving no payment.

-- ---------------------------------------------------------------------------
-- 1. The chain, the objects, and nothing written
-- ---------------------------------------------------------------------------
do $$
declare
  v_table text;
  v_rows  bigint;
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 55
     or (select max(version) from supabase_migrations.schema_migrations) <> '20261007000100' then
    raise exception 'expected the 54 released migrations and the till one, found % ending at %',
      (select count(*) from supabase_migrations.schema_migrations),
      (select max(version) from supabase_migrations.schema_migrations);
  end if;

  if to_regprocedure('api.staff_enter_till_count(date,uuid,jsonb,text,text,text)') is null
     or to_regprocedure('api.staff_confirm_till_count(uuid,integer,text,text,text)') is null
     or to_regprocedure('api.staff_send_back_till_count(uuid,integer,text,text)') is null
     or to_regprocedure('api.staff_till_counts(integer,integer,date)') is null
     or to_regprocedure('api.staff_till_expected(date)') is null
     or to_regprocedure('api.staff_till_days(integer,integer,boolean)') is null then
    raise exception 'a till command or read is missing';
  end if;

  foreach v_table in array array['reconciliations', 'reconciliation_lines', 'reconciliation_returns',
                                 'reconciliation_confirmations'] loop
    if (select count(*) from pg_class where oid = ('public.' || v_table)::regclass and relrowsecurity) <> 1 then
      raise exception '% has no row-level security', v_table;
    end if;
    if has_table_privilege('authenticated', 'public.' || v_table, 'insert')
       or has_table_privilege('authenticated', 'public.' || v_table, 'update')
       or has_table_privilege('authenticated', 'public.' || v_table, 'delete')
       or not has_table_privilege('authenticated', 'public.' || v_table, 'select')
       or has_table_privilege('anon', 'public.' || v_table, 'select')
       or has_table_privilege('service_role', 'public.' || v_table, 'select') then
      raise exception '% has the wrong grants', v_table;
    end if;
    execute format('select count(*) from public.%I', v_table) into strict v_rows;
    if v_rows <> 0 then
      raise exception 'the migration wrote a till record into a database that had none';
    end if;
  end loop;

  if private.till_counting_starts_on() <> (now() at time zone 'Africa/Dar_es_Salaam')::date then
    raise exception 'till counting should start on the day the migration ran, not %',
      private.till_counting_starts_on();
  end if;

  -- The expected figures are the released payments' own, method by method, reversals included.
  if exists (
    select 1
      from private.till_expected((now() at time zone 'Africa/Dar_es_Salaam')::date) e
     where e.expected_tzs is distinct from (
             select coalesce(sum(p.amount_tzs), 0) from public.payments p
              where p.method::text = e.line
                and p.business_date = (now() at time zone 'Africa/Dar_es_Salaam')::date)) then
    raise exception 'an expected till figure is not the sum of the released payments';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. A count against released payments, entered by the Cashier and confirmed by the Manager,
--    committed so the deferred checks run
-- ---------------------------------------------------------------------------
create table migration_chain.till (name text primary key, res jsonb not null);

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
insert into migration_chain.till
select 'count', api.staff_enter_till_count(
  (now() at time zone 'Africa/Dar_es_Salaam')::date, null,
  (select jsonb_object_agg(e.line, case when e.line = 'cash' then greatest(e.expected_tzs - 100, 0)
                                        else greatest(e.expected_tzs, 0) end)
     from private.till_expected((now() at time zone 'Africa/Dar_es_Salaam')::date) e),
  null, null, 'chain-till-count');
commit;

do $$
begin
  if (select res ->> 'reason' from migration_chain.till where name = 'count') <> 'counted' then
    raise exception 'the Cashier could not count the till: %',
      (select res from migration_chain.till where name = 'count');
  end if;
end
$$;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
insert into migration_chain.till
select 'confirm', api.staff_confirm_till_count(
  (select (res -> 'count' ->> 'id')::uuid from migration_chain.till where name = 'count'), 1,
  -- A reason only when a line differs: a balanced count takes none.
  (select case when bool_or(l.variance_tzs <> 0) then 'counting_error' end
     from public.reconciliation_lines l
    where l.reconciliation_id = (select (res -> 'count' ->> 'id')::uuid
                                   from migration_chain.till where name = 'count')),
  null, 'chain-till-confirm');
commit;

do $$
declare
  v_state text;
begin
  if (select res ->> 'reason' from migration_chain.till where name = 'confirm') <> 'confirmed' then
    raise exception 'the Manager could not confirm the till count: %',
      (select res from migration_chain.till where name = 'confirm');
  end if;
  select d.state into v_state from private.till_days() d
   where d.business_date = (now() at time zone 'Africa/Dar_es_Salaam')::date;
  if v_state not in ('shortage', 'excess', 'balanced') then
    raise exception 'today should be closed after the confirmation, not %', v_state;
  end if;
  if (select count(*) from public.audit_events
       where entity_type = 'reconciliation' and action in ('till_count_entered', 'till_count_confirmed')) <> 2 then
    raise exception 'the count and its confirmation are not both on the audit trail';
  end if;
end
$$;

\echo 'migration-chain: the till count migration added its objects and counts a released day'
