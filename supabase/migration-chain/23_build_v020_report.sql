-- Issue #55 · Migration chain, step 23: a real scheduled report on the v0.2.0 database
--
-- Runs after steps 11 and 15, so the four people and the imprest funding already exist. v0.2.0's
-- own entry point writes the report, exactly as Supabase Cron runs it, so the run, the snapshot,
-- its stamped digest and the delivery rows are the ones production holds after its first night.
-- The disbursement migration then has to carry them across untouched.
--
-- NO ALERT IS BUILT. The claim derives its business date itself, so a second, failed night could
-- only be made by editing rows by hand, and this harness proves migrations against what the product
-- writes. The alert table is still in the preservation query, and reads `-` on both sides.
--
-- NOT IN A TRANSACTION BLOCK, deliberately: the procedure commits its claim before generating, and
-- a CALL inside `begin` could not.

call private.run_scheduled_report(1);

do $$
declare
  v_expected integer;
begin
  select count(*) into v_expected
    from public.profiles p join public.user_roles r on r.user_id = p.id
   where p.is_active and r.role in ('director', 'manager');

  if (select count(*) from public.report_runs where status = 'succeeded') <> 1
     or (select count(*) from public.report_snapshots) <> 1 then
    raise exception 'the report fixture should hold exactly one succeeded run and one snapshot';
  end if;

  -- Without deliveries, the delivery digest either side of the migration compares nothing to nothing.
  if (select count(*) from public.report_deliveries) <> v_expected or v_expected < 2 then
    raise exception 'deliveries % do not match the % active Directors and Managers',
      (select count(*) from public.report_deliveries), v_expected;
  end if;

  if not (select integrity_ok from public.daily_reports) then
    raise exception 'the fixture report fails its own integrity check before the upgrade';
  end if;

  if (select count(*) from cron.job where jobname like 'fv-daily-pilot-report%') <> 4 then
    raise exception 'the v0.2.0 database should carry the four report jobs';
  end if;

  raise notice 'report fixture: one snapshot, % deliveries, four Cron jobs', v_expected;
end
$$;
