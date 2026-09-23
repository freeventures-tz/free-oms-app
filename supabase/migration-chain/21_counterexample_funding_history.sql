-- Issue #51 · Counterexample: a superseded handover's amount rewritten in place
--
-- The funding history is append-only by trigger, so a real migration could only do this by
-- disabling the trigger — which is exactly the shortcut a careless backfill reaches for. This file
-- takes it, changes the amount of the FIRST handover of the funding that was later corrected — the
-- one the Manager disputed — and puts the trigger back. (The correction itself cannot be rewritten
-- even this way: the released receipt-integrity key ties a receipt to its handover's amount, and
-- refused the first version of this file.) No row is added or removed, so every count in the
-- preservation query is unchanged, and the gate is REQUIRED to notice anyway. If it did not, a migration could rewrite what a Director handed over and the
-- release gate would call the database preserved.

begin;

create temp table counts_before as
select (select count(*) from public.imprest_fundings)          as fundings,
       (select count(*) from public.imprest_funding_handovers) as handovers,
       (select count(*) from public.imprest_funding_approvals) as approvals;

alter table public.imprest_funding_handovers disable trigger imprest_funding_handovers_append_only;

update public.imprest_funding_handovers
   set amount_tzs = amount_tzs + 1
 where cycle = 1
   and funding_id in (select funding_id from public.imprest_funding_handovers where cycle = 2);

alter table public.imprest_funding_handovers enable trigger imprest_funding_handovers_append_only;

do $$
begin
  if (select count(*) from public.imprest_funding_handovers where cycle = 2) <> 1 then
    raise exception 'the counterexample expects exactly one corrected handover to rewrite';
  end if;
  if exists (select 1 from counts_before c
              where c.fundings  <> (select count(*) from public.imprest_fundings)
                 or c.handovers <> (select count(*) from public.imprest_funding_handovers)
                 or c.approvals <> (select count(*) from public.imprest_funding_approvals)) then
    raise exception 'the counterexample changed a count, so it does not test the content digests';
  end if;
end
$$;

commit;
