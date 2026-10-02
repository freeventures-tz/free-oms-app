-- Issue #82 · Migration chain, step 65: what the report migration changed on a populated v0.12.1
-- database, and proof that it reads one truthfully
--
-- The preservation query has already required every released row, stored report, Cron job, grant,
-- policy, constraint, trigger, function body, enum, column, view and index to be identical, apart
-- from the one function this release replaces and the one it adds. This file checks the other half:
-- what arrived, that every stored report still matches its fingerprint, and that a report built now
-- states the fund's real figures and the counts' real outcomes on the fixture's own data.

do $$
declare
  v_fund     uuid;
  v_section  jsonb;
  v_figures  record;
  v_awaiting bigint;
  v_bad      text;
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 55
     or (select max(version) from supabase_migrations.schema_migrations) <> '20261006000100' then
    raise exception 'expected the 54 released migrations and the report one, found % ending at %',
      (select count(*) from supabase_migrations.schema_migrations),
      (select max(version) from supabase_migrations.schema_migrations);
  end if;

  -- The replaced reader, pinned exactly, and the new one, private.
  if (select md5(replace(p.prosrc, E'\r', '')) from pg_proc p
       where p.oid = 'private.report_content(date)'::regprocedure)
     is distinct from 'b9aa5b95bd73860455143c48516b3c39' then
    raise exception 'private.report_content is not the body issue #82 wrote';
  end if;
  if not exists (select 1 from pg_proc p join pg_roles o on o.oid = p.proowner
                  where p.oid = 'private.report_imprest_section(date)'::regprocedure
                    and p.prosecdef and o.rolname = 'fv_definer_owner')
     or has_function_privilege('authenticated', 'private.report_imprest_section(date)', 'execute')
     or has_function_privilege('anon', 'private.report_imprest_section(date)', 'execute')
     or has_function_privilege('service_role', 'private.report_imprest_section(date)', 'execute') then
    raise exception 'private.report_imprest_section is missing, not owned by the definer, or exposed';
  end if;

  -- The report the fixture delivered before the upgrade still matches its fingerprint and still
  -- carries the words it was written with.
  if not (select bool_and(integrity_ok) from public.daily_reports) then
    raise exception 'a stored report fails its integrity check after the upgrade';
  end if;

  -- A report built now reads the active fund as the imprest screen does.
  select f.id into v_fund from public.imprest_funds f where f.is_active;
  v_section := private.report_content(private.business_date()) -> 'sections' -> 'imprest';
  select * into v_figures from private.imprest_spending_figures(v_fund);
  v_awaiting := private.imprest_awaiting_verification_tzs(v_fund);

  if v_section ->> 'state' <> 'active' or (v_section ->> 'fund_id')::uuid <> v_fund
     or v_section ? 'unavailable'
     or position('imprest_spending_not_built' in v_section::text) > 0 then
    raise exception 'the report does not state the active fund: %', v_section;
  end if;

  if (v_section -> 'position' ->> 'posted_tzs')::bigint <> v_figures.posted_balance_tzs
     or (v_section -> 'position' ->> 'set_aside_tzs')::bigint <> v_figures.set_aside_tzs
     or (v_section -> 'position' ->> 'available_tzs')::bigint <> v_figures.free_to_approve_tzs
     or (v_section -> 'position' ->> 'awaiting_verification_tzs')::bigint <> v_awaiting
     or (v_section -> 'position' ->> 'expected_cash_tzs')::bigint
          <> v_figures.posted_balance_tzs - v_awaiting then
    raise exception 'the report''s balance (%) is not the imprest screen''s (% / % / % / %)',
      v_section -> 'position', v_figures.posted_balance_tzs, v_figures.set_aside_tzs,
      v_figures.free_to_approve_tzs, v_awaiting;
  end if;

  -- Every closed day the fixture confirmed before its close reads that outcome, and no closed day
  -- whose count was confirmed before its close reads Not counted.
  select string_agg(d.business_date::text || '=' || d.state || '/'
                    || (private.report_content(d.business_date) -> 'sections' -> 'imprest'
                          -> 'reconciliation' ->> 'state'), ', ')
    into v_bad
    from private.imprest_count_days(v_fund) d
   where d.business_date < private.business_date()
     and d.state in ('balanced', 'shortage', 'excess')
     and d.resolved_at < private.imprest_business_day_close(d.business_date)
     and private.report_content(d.business_date) -> 'sections' -> 'imprest'
           -> 'reconciliation' ->> 'state' <> d.state;
  if v_bad is not null then
    raise exception 'a day confirmed before its close does not read its outcome: %', v_bad;
  end if;

  if exists (select 1 from private.imprest_count_days(v_fund) d
              where d.business_date < private.business_date()
                and d.state = 'not_counted' and d.latest_count_id is null
                and private.report_content(d.business_date) -> 'sections' -> 'imprest'
                      -> 'reconciliation' <> private.report_reconciliation_state(
                           'not_counted', null, null, null, null, 'no_reconciliation_record')) then
    raise exception 'a day nobody counted is not reported Not counted with null amounts';
  end if;

  raise notice 'report imprest upgrade: the section states the fund, its balance and its counts';
end
$$;
