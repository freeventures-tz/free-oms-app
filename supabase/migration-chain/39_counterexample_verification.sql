-- Issue #65 · Counterexample: a verification reattributed to another Manager in place
--
-- Verifications are append-only by trigger, so a real migration could only do this by disabling
-- the trigger, which is the shortcut a careless backfill of send-back history would reach for. This
-- file takes it, names the Director as the one who verified B, and puts the trigger back. No row is
-- added or removed and no amount moves, so every count and every figure is unchanged, and the gate
-- is REQUIRED to notice anyway. If it did not, the send-back release could rewrite who verified a
-- payment and the gate would call the database preserved.

begin;

create temp table counts_before as
select (select count(*) from public.imprest_verifications) as verifications,
       (select count(*) from public.imprest_postings) as postings,
       (select string_agg(s.posted_balance_tzs::text || '/' || s.free_to_approve_tzs::text, ',')
          from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s)
         as figures;

alter table public.imprest_verifications disable trigger imprest_verifications_append_only;

update public.imprest_verifications
   set verified_by = 'c0000000-0000-0000-0000-000000000001'
 where disbursement_id = migration_chain.did('b');

alter table public.imprest_verifications enable trigger imprest_verifications_append_only;

do $$
begin
  if (select count(*) from public.imprest_verifications
       where verified_by = 'c0000000-0000-0000-0000-000000000001') <> 1 then
    raise exception 'the counterexample expects exactly one verification to reattribute';
  end if;
  if exists (select 1 from counts_before c
              where c.verifications <> (select count(*) from public.imprest_verifications)
                 or c.postings <> (select count(*) from public.imprest_postings)
                 or c.figures is distinct from (
                      select string_agg(s.posted_balance_tzs::text || '/' || s.free_to_approve_tzs::text, ',')
                        from public.imprest_funds f
                        cross join lateral private.imprest_spending_figures(f.id) s)) then
    raise exception 'the counterexample changed a count or a figure, so it does not test the content digests';
  end if;
end
$$;

commit;
