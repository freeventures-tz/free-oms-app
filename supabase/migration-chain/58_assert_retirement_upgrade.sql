-- Issue #72 · Migration chain, step 58: what the retirement migration added to a populated v0.10.0
-- database, and proof that it works against one
--
-- The preservation query has already required every released row, file, report, Cron job, grant,
-- policy, constraint, trigger, function body, enum, column, view and index to be identical, apart
-- from the five functions this release replaces and what it adds. This file checks the other half:
-- what arrived, that the released fund and its figures and days did not move, and that the new
-- command, run against the released data, refuses to retire a fund with payments still open and
-- names each one, committed.

-- ---------------------------------------------------------------------------
-- 1. The chain, the objects, and what was replaced
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 53
     or (select max(version) from supabase_migrations.schema_migrations) <> '20261004000100' then
    raise exception 'expected the 52 released migrations and the retirement one, found % ending at %',
      (select count(*) from supabase_migrations.schema_migrations),
      (select max(version) from supabase_migrations.schema_migrations);
  end if;

  -- The five released functions were replaced: none still has its v0.10.0 body.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p
   where md5(replace(p.prosrc, E'\r', '')) in ('aa1438bbd4f9e93b9e5c20e78a3d2956',
                                                '148c3c9134e364ce1ac7f8489f3dd605',
                                                '3d08e8a1415d73a7608deeb8b1062ea0',
                                                '0f0eba99cdb6d6493724c6136c02033c',
                                                'c4d9235463686615794c3a8d76ad17ff');
  if v_bad is not null then
    raise exception 'released functions were not replaced: %', v_bad;
  end if;

  -- Nothing was retired or carried, and the released fund is still the active one.
  if (select count(*) from public.imprest_retirements) <> 0
     or (select count(*) from public.imprest_fund_openings) <> 0 then
    raise exception 'the migration wrote a retirement or an opening into a database that had none';
  end if;
  if (select count(*) from public.imprest_funds where is_active and retired_at is null) <> 1
     or exists (select 1 from public.imprest_funds where retired_at is not null) then
    raise exception 'the released fund should be the one active fund, with no retirement time';
  end if;

  -- Both tables are written by the commands alone, and read by Directors and the Manager.
  if has_table_privilege('authenticated', 'public.imprest_retirements', 'insert')
     or has_table_privilege('authenticated', 'public.imprest_retirements', 'update')
     or has_table_privilege('authenticated', 'public.imprest_fund_openings', 'insert')
     or not has_table_privilege('authenticated', 'public.imprest_retirements', 'select')
     or not has_table_privilege('authenticated', 'public.imprest_fund_openings', 'select')
     or has_table_privilege('service_role', 'public.imprest_retirements', 'select')
     or has_table_privilege('anon', 'public.imprest_fund_openings', 'select')
     or has_table_privilege('fv_definer_owner', 'public.imprest_fund_openings', 'update') then
    raise exception 'the retirement tables have the wrong grants';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.imprest_retirements'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.imprest_fund_openings'::regclass) then
    raise exception 'a retirement table has no row-level security';
  end if;

  -- Every table a fund's rows live in refuses a row for a retired fund.
  if (select count(*) from pg_trigger where tgname like '%\_fund\_active' and not tgisinternal) <> 8 then
    raise exception 'the retired-fund guard is not on all eight tables';
  end if;

  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where ((n.nspname = 'api'
           and p.proname in ('staff_submit_imprest_retirement', 'admin_decide_imprest_retirement',
                             'staff_imprest_fund_state', 'staff_imprest_retired_funds',
                             'staff_imprest_fund_record', 'staff_propose_imprest_disbursement',
                             'staff_enter_imprest_count'))
       or (n.nspname = 'private'
           and p.proname in ('guard_imprest_fund', 'guard_imprest_retirement',
                             'check_imprest_fund_opening', 'check_imprest_retirement_complete',
                             'refuse_retired_imprest_fund', 'imprest_spending_figures',
                             'imprest_first_count_day', 'imprest_last_count_day',
                             'imprest_count_days', 'imprest_retirement_blockers',
                             'imprest_last_posting_at', 'imprest_count_closes_fund',
                             'imprest_fund_unresolved', 'imprest_retirement_result',
                             'imprest_retirement_audit', 'impl_staff_submit_imprest_retirement',
                             'impl_admin_decide_imprest_retirement')))
     and (pg_get_userbyid(p.proowner) <> 'fv_definer_owner'
          or has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('service_role', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute') <> (n.nspname = 'api'));
  if v_bad is not null then
    raise exception 'retirement functions with the wrong owner or grants: %', v_bad;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. The figures and the days did not move
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  select s.posted_funding_tzs || '/' || s.posted_balance_tzs || '/' || s.set_aside_tzs || '/'
         || s.free_to_approve_tzs || '/' || private.imprest_awaiting_verification_tzs(f.id)
    into v
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active;
  if v is distinct from '95000/70500/25000/45500/15000' then
    raise exception 'the upgrade moved the figures: expected 95000/70500/25000/45500/15000, found %', v;
  end if;

  if exists (select 1 from migration_chain.v0100_days b
              where b.first_day is distinct from private.imprest_first_count_day(b.fund_id)
                 or b.days is distinct from (
                      select string_agg(d.business_date::text || ':' || d.state || ':'
                                        || coalesce(d.not_counted_since::text, '') || ':'
                                        || coalesce(d.resolved_at::text, ''), ',' order by d.business_date)
                        from private.imprest_count_days(b.fund_id) d)) then
    raise exception 'the upgrade moved the active fund''s business days';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. The released fund cannot retire with payments open, and is told which
-- ---------------------------------------------------------------------------
create table migration_chain.retirements (name text primary key, res jsonb not null);

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
insert into migration_chain.retirements
values ('blocked', api.staff_submit_imprest_retirement(null, 'Month end on the upgraded fund',
                                                       'chain-v0100-retire'));
commit;

do $$
declare
  v_res jsonb := (select res from migration_chain.retirements where name = 'blocked');
begin
  if v_res ->> 'reason' is distinct from 'blocked' then
    raise exception 'retiring a fund with payments open should be refused as blocked, got %', v_res;
  end if;
  -- Every open payment of the released fund, and nothing else, is named.
  if (select string_agg(b ->> 'number', ',' order by b ->> 'number')
        from jsonb_array_elements(v_res -> 'blockers') b where b ->> 'kind' = 'disbursement')
     is distinct from (select string_agg(disbursement_no, ',' order by disbursement_no)
                         from public.imprest_disbursements
                        where status not in ('verified', 'rejected', 'withdrawn', 'cancelled')) then
    raise exception 'the refusal should name every open payment: %', v_res -> 'blockers';
  end if;
  if not exists (select 1 from public.audit_events
                  where action = 'command_refused'
                    and source_operation = 'api.staff_submit_imprest_retirement'
                    and after_state ->> 'reason' = 'blocked') then
    raise exception 'the refusal was not committed to the audit trail';
  end if;
  if (select count(*) from public.imprest_retirements) <> 0 then
    raise exception 'a refused submission wrote a retirement';
  end if;
end
$$;

\echo 'migration-chain: the retirement migration upgraded a populated v0.10.0 database and works on it'
