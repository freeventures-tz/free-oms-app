-- Issue #55 · Counterexample: a delivered report's content rewritten in place
--
-- A snapshot refuses every UPDATE by trigger, so a migration could only do this by switching the
-- trigger off, which is the shortcut a careless backfill reaches for. This file takes it: it changes
-- the stored content and leaves the stamped digest alone, then puts the trigger back. No row is added
-- or removed, and `daily_reports` would now report an integrity failure only if somebody opened it.
-- The gate is REQUIRED to notice first.

begin;

create temp table counts_before as
select (select count(*) from public.report_snapshots)  as snapshots,
       (select count(*) from public.report_runs)       as runs,
       (select count(*) from public.report_deliveries) as deliveries;

alter table public.report_snapshots disable trigger report_snapshots_immutable;

update public.report_snapshots
   set content = jsonb_set(content, '{generated_by}', '"a migration"'::jsonb, true);

alter table public.report_snapshots enable trigger report_snapshots_immutable;

do $$
begin
  if (select count(*) from public.report_snapshots) <> 1 then
    raise exception 'the counterexample expects exactly one snapshot to rewrite';
  end if;
  if exists (select 1 from counts_before c
              where c.snapshots  <> (select count(*) from public.report_snapshots)
                 or c.runs       <> (select count(*) from public.report_runs)
                 or c.deliveries <> (select count(*) from public.report_deliveries)) then
    raise exception 'the counterexample changed a count, so it does not test the content digests';
  end if;
end
$$;

commit;
