-- Issue #72 · Counterexample: a reversal request's reason rewritten in place
--
-- A reversal request moves forward once and keeps what was asked, by trigger, so a real migration
-- could only do this by disabling the trigger, which is the shortcut a careless backfill would reach
-- for. This file takes it, rewrites why the Cashier asked for a correction, and puts the trigger
-- back. No row is added or removed and no amount moves, so every posting and every figure is
-- unchanged, and the gate is REQUIRED to notice anyway. If it did not, the retirement release could
-- rewrite why a posting was corrected and the gate would call the database preserved.

begin;

create temp table reversals_before as
select (select count(*) from public.imprest_posting_reversals) as reversals,
       (select string_agg(s.posted_balance_tzs::text || '/' || s.free_to_approve_tzs::text, ',')
          from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s)
         as figures;

alter table public.imprest_posting_reversals disable trigger imprest_posting_reversals_guard;

update public.imprest_posting_reversals
   set reason = 'Rewritten after the fact'
 where reason = 'The stamp was 500 less than the receipt said';

-- The update queued the table's deferred completeness check, and a table with a pending trigger
-- event cannot be altered. Run it now: the request is still approved with its postings, so it holds.
set constraints public.imprest_posting_reversal_complete immediate;

alter table public.imprest_posting_reversals enable trigger imprest_posting_reversals_guard;

do $$
begin
  if (select count(*) from public.imprest_posting_reversals where reason = 'Rewritten after the fact') <> 1 then
    raise exception 'the counterexample expects exactly one reversal request to rewrite';
  end if;
  if exists (select 1 from reversals_before c
              where c.reversals <> (select count(*) from public.imprest_posting_reversals)
                 or c.figures is distinct from (
                      select string_agg(s.posted_balance_tzs::text || '/' || s.free_to_approve_tzs::text, ',')
                        from public.imprest_funds f
                        cross join lateral private.imprest_spending_figures(f.id) s)) then
    raise exception 'the counterexample changed a request or a figure, so it does not test the content digests';
  end if;
end
$$;

commit;
