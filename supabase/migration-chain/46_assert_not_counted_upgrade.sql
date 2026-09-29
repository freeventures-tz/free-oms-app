-- Issue #69 · Migration chain, step 46: what the Not counted migration added to a populated v0.7.0
-- database, and proof that it works against one
--
-- The preservation query has already required every released row, file, report, Cron job, grant,
-- policy, constraint, trigger, function body, enum, column, view and index to be identical, apart
-- from the four count functions this release replaces and the one column it adds. This file checks
-- the other half: what arrived, where counting starts, that yesterday reads Not counted and the day
-- counted reads as it was confirmed, and that yesterday is counted late and confirmed, committed.

-- ---------------------------------------------------------------------------
-- 1. The chain, the objects, and the replaced functions
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 50
     or (select max(version) from supabase_migrations.schema_migrations) <> '20261001000100' then
    raise exception 'expected the 49 released migrations and the Not counted one, found % ending at %',
      (select count(*) from supabase_migrations.schema_migrations),
      (select max(version) from supabase_migrations.schema_migrations);
  end if;

  -- The four released functions were replaced: none still has its v0.7.0 body, and the old
  -- five-argument command behind Enter count is gone.
  if to_regprocedure('private.impl_staff_enter_imprest_count(date,uuid,bigint,text,text)') is not null then
    raise exception 'the five-argument count command was not dropped';
  end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p
   where md5(replace(p.prosrc, E'\r', '')) in ('11278055e61c80c14c32ed73d8268023',
                                                'f24777f04eb4197ec01888efba1628ba',
                                                '700070aaa1d72331dac9c3e1c803d200');
  if v_bad is not null then
    raise exception 'released count functions were not replaced: %', v_bad;
  end if;

  -- Every count kept its figures, and none was made late.
  if exists (select 1 from public.imprest_counts where late_reason is not null) then
    raise exception 'the migration gave an existing count a late reason';
  end if;
  if not has_column_privilege('authenticated', 'public.imprest_counts', 'late_reason', 'select')
     or has_column_privilege('authenticated', 'public.imprest_counts', 'posted_balance_tzs', 'select') then
    raise exception 'the count columns a session may select are not the intended ones';
  end if;

  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where ((n.nspname = 'api'
           and p.proname in ('staff_enter_imprest_count', 'staff_imprest_counts',
                             'staff_imprest_open_count_days', 'staff_imprest_count_alert_history'))
       or (n.nspname = 'private'
           and p.proname in ('imprest_business_date_of', 'imprest_business_day_close',
                             'imprest_counting_starts_on', 'imprest_first_count_day',
                             'imprest_count_days', 'check_imprest_count_entry',
                             'impl_staff_enter_imprest_count')))
     and (pg_get_userbyid(p.proowner) <> 'fv_definer_owner'
          or has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('service_role', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute') <> (n.nspname = 'api'));
  if v_bad is not null then
    raise exception 'Not counted functions with the wrong owner or grants: %', v_bad;
  end if;

  -- Counting starts on the first count's day, two days ago, not on the day the migration ran.
  if private.imprest_counting_starts_on() is distinct from private.imprest_business_date() - 2 then
    raise exception 'counting should start on the first count''s day, %, not %',
      private.imprest_business_date() - 2, private.imprest_counting_starts_on();
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. The days as they stand: the count as confirmed, yesterday Not counted, today due
-- ---------------------------------------------------------------------------
begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
do $$
declare
  v text;
begin
  select string_agg((private.imprest_business_date() - d.business_date) || ':' || d.state, ','
                    order by d.business_date)
    into v
    from public.imprest_funds f cross join lateral private.imprest_count_days(f.id) d
   where f.is_active;
  if v is distinct from '2:shortage,1:not_counted,0:due' then
    raise exception 'the days should read 2:shortage,1:not_counted,0:due, found %', v;
  end if;

  select string_agg((private.imprest_business_date() - business_date) || ':' || state, ',')
    into v from api.staff_imprest_open_count_days(10, 0);
  if v is distinct from '1:not_counted' then
    raise exception 'the Manager should read yesterday as the one open day, found %', v;
  end if;
end
$$;
commit;

-- ---------------------------------------------------------------------------
-- 3. The Cashier counts yesterday late at the 57,000 expected; the Manager confirms it Balanced
-- ---------------------------------------------------------------------------
begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.spend('count.late', api.staff_enter_imprest_count(
  private.imprest_business_date() - 1, null, 57000, null, 'Nobody counted after the release',
  'chain-count-late'), 'counted');
commit;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.spend('count.late.confirmed', api.staff_confirm_imprest_count(
  (select (res -> 'count' ->> 'id')::uuid from migration_chain.disbursements where name = 'count.late'),
  1, null, null, 'chain-count-late-confirm'), 'confirmed');
commit;

-- And today through issue #68's five-argument form, as a screen loaded before the release would.
begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.spend('count.today', api.staff_enter_imprest_count(
  private.imprest_business_date(), null, 57000, null, 'chain-count-today'), 'counted');
commit;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.spend('count.today.confirmed', api.staff_confirm_imprest_count(
  (select (res -> 'count' ->> 'id')::uuid from migration_chain.disbursements where name = 'count.today'),
  1, null, null, 'chain-count-today-confirm'), 'confirmed');
commit;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
do $$
declare
  v text;
begin
  select string_agg((private.imprest_business_date() - d.business_date) || ':' || d.state, ','
                    order by d.business_date)
    into v
    from public.imprest_funds f cross join lateral private.imprest_count_days(f.id) d
   where f.is_active;
  if v is distinct from '2:shortage,1:balanced,0:balanced' then
    raise exception 'after the late count the days should read 2:shortage,1:balanced,0:balanced, found %', v;
  end if;

  if exists (select 1 from api.staff_imprest_open_count_days(10, 0)) then
    raise exception 'no day should be open once yesterday is counted late';
  end if;

  select string_agg(kind || ':' || resolution, ',' order by kind)
    into v from api.staff_imprest_count_alert_history(100, 0)
   where business_date = private.imprest_business_date() - 1;
  if v is distinct from 'awaiting_confirmation:confirmed,not_counted:counted_late' then
    raise exception 'yesterday''s alerts should be resolved in the history, found %', v;
  end if;

  if (select late_reason from public.imprest_counts
       where id = (select (res -> 'count' ->> 'id')::uuid from migration_chain.disbursements
                    where name = 'count.late'))
     is distinct from 'Nobody counted after the release' then
    raise exception 'the late count did not keep its reason';
  end if;

  -- 76,000 posted still: both counts balanced.
  select s.posted_balance_tzs || '/' || s.set_aside_tzs || '/' || s.free_to_approve_tzs
    into v
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active;
  if v is distinct from '76000/29000/47000' then
    raise exception 'two balanced counts should leave 76000/29000/47000, found %', v;
  end if;
end
$$;
commit;

-- A count's late reason never changes, even by the table's owner.
do $$
begin
  begin
    update public.imprest_counts set late_reason = 'Rewritten';
    raise exception 'a late reason was rewritten';
  exception when restrict_violation then
    null;
  end;
end
$$;

\echo 'migration-chain: the Not counted migration upgraded a populated v0.7.0 database and works on it'
