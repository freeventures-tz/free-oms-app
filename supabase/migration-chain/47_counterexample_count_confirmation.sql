-- Issue #69 · Counterexample: a count confirmation's reason rewritten in place
--
-- Confirmations are append-only by trigger, so a real migration could only do this by disabling the
-- trigger, which is the shortcut a careless backfill of missed days would reach for. This file takes
-- it, rewrites the reason the Manager chose for the confirmed shortage, and puts the trigger back.
-- No row is added or removed and no amount moves, so every count and every figure is unchanged, and
-- the gate is REQUIRED to notice anyway. If it did not, the Not counted release could rewrite why a
-- shortage was confirmed and the gate would call the database preserved.

begin;

create temp table counts_before as
select (select count(*) from public.imprest_count_confirmations) as confirmations,
       (select string_agg(s.posted_balance_tzs::text || '/' || s.free_to_approve_tzs::text, ',')
          from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s)
         as figures;

alter table public.imprest_count_confirmations disable trigger imprest_count_confirmations_append_only;

update public.imprest_count_confirmations
   set explanation = 'recording_error'
 where outcome = 'shortage' and explanation = 'counting_error';

alter table public.imprest_count_confirmations enable trigger imprest_count_confirmations_append_only;

do $$
begin
  if (select count(*) from public.imprest_count_confirmations where explanation = 'recording_error') <> 1 then
    raise exception 'the counterexample expects exactly one confirmation to rewrite';
  end if;
  if exists (select 1 from counts_before c
              where c.confirmations <> (select count(*) from public.imprest_count_confirmations)
                 or c.figures is distinct from (
                      select string_agg(s.posted_balance_tzs::text || '/' || s.free_to_approve_tzs::text, ',')
                        from public.imprest_funds f
                        cross join lateral private.imprest_spending_figures(f.id) s)) then
    raise exception 'the counterexample changed a count or a figure, so it does not test the content digests';
  end if;
end
$$;

commit;
