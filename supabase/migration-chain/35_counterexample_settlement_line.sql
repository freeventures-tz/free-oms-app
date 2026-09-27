-- Issue #64 · Counterexample: a settlement line's purpose rewritten in place
--
-- Settlement lines are append-only by trigger, so a real migration could only do this by disabling
-- the trigger, which is the shortcut a careless backfill of verification would reach for. This file
-- takes it, rewrites what the Cashier said the parking line was for, and puts the trigger back. No
-- row is added or removed and no amount moves, so every count and every figure is unchanged, and the
-- gate is REQUIRED to notice anyway. If it did not, the verification release could rewrite what a
-- Cashier settled and the gate would call the database preserved.

begin;

create temp table counts_before as
select (select count(*) from public.imprest_settlement_lines) as lines,
       (select sum(amount_tzs) from public.imprest_settlement_lines) as used,
       (select string_agg(s.set_aside_tzs::text, ',')
          from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s)
         as set_aside;

alter table public.imprest_settlement_lines disable trigger imprest_settlement_lines_append_only;

update public.imprest_settlement_lines
   set purpose = purpose || '.'
 where purpose = 'Parking';

alter table public.imprest_settlement_lines enable trigger imprest_settlement_lines_append_only;

do $$
begin
  if (select count(*) from public.imprest_settlement_lines where purpose = 'Parking.') <> 1 then
    raise exception 'the counterexample expects exactly one parking line to rewrite';
  end if;
  if exists (select 1 from counts_before c
              where c.lines <> (select count(*) from public.imprest_settlement_lines)
                 or c.used <> (select sum(amount_tzs) from public.imprest_settlement_lines)
                 or c.set_aside is distinct from (
                      select string_agg(s.set_aside_tzs::text, ',')
                        from public.imprest_funds f
                        cross join lateral private.imprest_spending_figures(f.id) s)) then
    raise exception 'the counterexample changed a count or a figure, so it does not test the content digests';
  end if;
end
$$;

commit;
