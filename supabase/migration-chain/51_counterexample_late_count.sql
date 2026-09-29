-- Issue #70 · Counterexample: a late count's reason rewritten in place
--
-- A count moves only its status and version, by trigger, so a real migration could only do this by
-- disabling the trigger, which is the shortcut a careless backfill would reach for. This file takes
-- it, rewrites the reason the Cashier gave for counting a missed day late, and puts the trigger
-- back. No row is added or removed and no amount moves, so every count and every figure is
-- unchanged, and the gate is REQUIRED to notice anyway. If it did not, the raised approval release
-- could rewrite why a day was counted late and the gate would call the database preserved.

begin;

create temp table counts_before as
select (select count(*) from public.imprest_counts) as counts,
       (select string_agg(s.posted_balance_tzs::text || '/' || s.free_to_approve_tzs::text, ',')
          from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s)
         as figures;

alter table public.imprest_counts disable trigger imprest_counts_progress;

update public.imprest_counts
   set late_reason = 'Rewritten after the fact'
 where late_reason = 'Nobody counted after the release';

alter table public.imprest_counts enable trigger imprest_counts_progress;

do $$
begin
  if (select count(*) from public.imprest_counts where late_reason = 'Rewritten after the fact') <> 1 then
    raise exception 'the counterexample expects exactly one late count to rewrite';
  end if;
  if exists (select 1 from counts_before c
              where c.counts <> (select count(*) from public.imprest_counts)
                 or c.figures is distinct from (
                      select string_agg(s.posted_balance_tzs::text || '/' || s.free_to_approve_tzs::text, ',')
                        from public.imprest_funds f
                        cross join lateral private.imprest_spending_figures(f.id) s)) then
    raise exception 'the counterexample changed a count or a figure, so it does not test the content digests';
  end if;
end
$$;

commit;
