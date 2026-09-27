-- Issue #62 · Counterexample: a rejected disbursement's reason rewritten in place
--
-- A disbursement is guarded by trigger, so a real migration could only do this by disabling the
-- trigger, which is the shortcut a careless backfill of the new states would reach for. This file
-- takes it, rewrites the reason the Manager gave for rejecting disbursement C, and puts the trigger
-- back. No row is added or removed and no status or amount moves, so every count and every figure
-- is unchanged, and the gate is REQUIRED to notice anyway. If it did not, the settlement release
-- could rewrite what a Manager decided and the gate would call the database preserved.

begin;

create temp table counts_before as
select (select count(*) from public.imprest_disbursements) as disbursements,
       (select string_agg(s.set_aside_tzs::text, ',')
          from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s)
         as set_aside;

alter table public.imprest_disbursements disable trigger imprest_disbursements_guard;

update public.imprest_disbursements
   set rejection_reason = rejection_reason || '.'
 where status = 'rejected';

alter table public.imprest_disbursements enable trigger imprest_disbursements_guard;

do $$
begin
  if (select count(*) from public.imprest_disbursements where status = 'rejected') <> 1 then
    raise exception 'the counterexample expects exactly one rejected disbursement to rewrite';
  end if;
  if exists (select 1 from counts_before c
              where c.disbursements <> (select count(*) from public.imprest_disbursements)
                 or c.set_aside is distinct from (
                      select string_agg(s.set_aside_tzs::text, ',')
                        from public.imprest_funds f
                        cross join lateral private.imprest_spending_figures(f.id) s)) then
    raise exception 'the counterexample changed a count or a figure, so it does not test the content digests';
  end if;
end
$$;

commit;
