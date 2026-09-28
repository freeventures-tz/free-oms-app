-- Issue #68 · Counterexample: a send-back's reason rewritten in place
--
-- Returns are append-only by trigger, so a real migration could only do this by disabling the
-- trigger, which is the shortcut a careless backfill of count history would reach for. This file
-- takes it, rewrites the reason the Manager gave for sending G back, and puts the trigger back. No
-- row is added or removed and no amount moves, so every count and every figure is unchanged, and
-- the gate is REQUIRED to notice anyway. If it did not, the count release could rewrite why a
-- settlement was sent back and the gate would call the database preserved.

begin;

create temp table counts_before as
select (select count(*) from public.imprest_settlement_returns) as returns,
       (select string_agg(s.posted_balance_tzs::text || '/' || s.free_to_approve_tzs::text, ',')
          from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s)
         as figures;

alter table public.imprest_settlement_returns disable trigger imprest_settlement_returns_append_only;

update public.imprest_settlement_returns
   set reason = 'Looks fine'
 where disbursement_id = migration_chain.did('g');

alter table public.imprest_settlement_returns enable trigger imprest_settlement_returns_append_only;

do $$
begin
  if (select count(*) from public.imprest_settlement_returns where reason = 'Looks fine') <> 1 then
    raise exception 'the counterexample expects exactly one return to rewrite';
  end if;
  if exists (select 1 from counts_before c
              where c.returns <> (select count(*) from public.imprest_settlement_returns)
                 or c.figures is distinct from (
                      select string_agg(s.posted_balance_tzs::text || '/' || s.free_to_approve_tzs::text, ',')
                        from public.imprest_funds f
                        cross join lateral private.imprest_spending_figures(f.id) s)) then
    raise exception 'the counterexample changed a count or a figure, so it does not test the content digests';
  end if;
end
$$;

commit;
