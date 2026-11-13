-- Issue #84 · Counterexample: a till send-back's reason rewritten in place
--
-- A send-back is written once and never changed: a trigger refuses UPDATE for every role, the
-- table's owner included. A migration that "tidied" released till records would have to step past
-- that trigger, and this file does, rewriting the reason the Manager gave. No row is added or
-- removed and no figure moves, so every count is unchanged, and the gate is REQUIRED to notice
-- anyway. If it did not, the accountability release could rewrite why a count was sent back and the
-- gate would call the database preserved.

begin;

create temp table till_before as
select (select count(*) from public.reconciliations) as counts,
       (select count(*) from public.reconciliation_returns) as returns,
       (select coalesce(sum(counted_tzs), 0) from public.reconciliation_lines) as counted;

set local session_replication_role = replica;
update public.reconciliation_returns
   set reason = 'Rewritten after the fact'
 where reason = 'Count the cash drawer again';
set local session_replication_role = origin;

do $$
begin
  if (select count(*) from public.reconciliation_returns where reason = 'Rewritten after the fact') <> 1 then
    raise exception 'the counterexample expects exactly one send-back to rewrite';
  end if;
  if exists (select 1 from till_before b
              where b.counts <> (select count(*) from public.reconciliations)
                 or b.returns <> (select count(*) from public.reconciliation_returns)
                 or b.counted <> (select coalesce(sum(counted_tzs), 0) from public.reconciliation_lines)) then
    raise exception 'the counterexample changed a till count or figure, so it does not test the content digests';
  end if;
end
$$;

commit;
