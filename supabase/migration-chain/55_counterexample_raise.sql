-- Issue #71 · Counterexample: a raise's reason rewritten in place
--
-- A raise only moves forward and keeps what was asked, by trigger, so a real migration could only do
-- this by disabling the trigger, which is the shortcut a careless backfill would reach for. This
-- file takes it, rewrites the reason the Cashier gave for asking for more, and puts the trigger
-- back. No row is added or removed and no amount moves, so every raise and every figure is
-- unchanged, and the gate is REQUIRED to notice anyway. If it did not, the reversal release could
-- rewrite why more was asked for and the gate would call the database preserved.

begin;

create temp table raises_before as
select (select count(*) from public.imprest_approval_raises) as raises,
       (select string_agg(s.posted_balance_tzs::text || '/' || s.free_to_approve_tzs::text, ',')
          from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s)
         as figures;

alter table public.imprest_approval_raises disable trigger imprest_approval_raises_guard;

update public.imprest_approval_raises
   set reason = 'Rewritten after the fact'
 where reason = 'The levy rose after the notice went up';

alter table public.imprest_approval_raises enable trigger imprest_approval_raises_guard;

do $$
begin
  if (select count(*) from public.imprest_approval_raises where reason = 'Rewritten after the fact') <> 1 then
    raise exception 'the counterexample expects exactly one raise to rewrite';
  end if;
  if exists (select 1 from raises_before c
              where c.raises <> (select count(*) from public.imprest_approval_raises)
                 or c.figures is distinct from (
                      select string_agg(s.posted_balance_tzs::text || '/' || s.free_to_approve_tzs::text, ',')
                        from public.imprest_funds f
                        cross join lateral private.imprest_spending_figures(f.id) s)) then
    raise exception 'the counterexample changed a raise or a figure, so it does not test the content digests';
  end if;
end
$$;

commit;
