-- Issue #70 · Migration chain, step 49: a missed day counted late and confirmed
--
-- Runs after step 45 on the v0.8.0 database, reusing its people and its figures. Yesterday was never
-- counted, so it reads Not counted. Through the released commands the Cashier counts it late, with
-- a reason, at the TZS 57,000 expected, and the Manager confirms it Balanced. So the raised approval
-- migration meets what v0.8.0 released: a late count that keeps its reason, beside the count
-- confirmed short two days ago.
--
-- Nothing moves in the fund: a balanced count posts nothing.

begin;

-- v0.8.0 fixed the day counting started when its migration ran, which on this freshly reset database
-- is today. Production ran it two days ago, so the fixture moves that day back with the counts, by
-- replacing the one function that holds it. Same body, same owner: the preservation query reads it
-- identically on both sides of the upgrade, which does not touch it.
do $$
begin
  execute format($f$
    create or replace function private.imprest_counting_starts_on() returns date
    language sql immutable set search_path = ''
    as $b$ select %L::date $b$
  $f$, private.imprest_business_date() - 2);
end
$$;

do $$
declare
  v text;
begin
  select string_agg((private.imprest_business_date() - d.business_date) || ':' || d.state, ','
                    order by d.business_date)
    into v
    from public.imprest_funds f cross join lateral private.imprest_count_days(f.id) d
   where f.is_active;
  if v is distinct from '2:shortage,1:not_counted,0:due' then
    raise exception 'the days should read 2:shortage,1:not_counted,0:due before the late count, found %', v;
  end if;
end
$$;

select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.spend('count.late', api.staff_enter_imprest_count(
  private.imprest_business_date() - 1, null, 57000, null, 'Nobody counted after the release',
  'chain-count-late'), 'counted');
commit;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.spend('count.late.confirmed', api.staff_confirm_imprest_count(
  (select (res -> 'count' ->> 'id')::uuid from migration_chain.disbursements where name = 'count.late'),
  1, null, null, 'chain-count-late-confirm'), 'confirmed');
-- Committed, so the deferred check that the confirmation carries its posting and flag really runs.
commit;

do $$
declare
  v text;
begin
  select string_agg((private.imprest_business_date() - d.business_date) || ':' || d.state, ','
                    order by d.business_date)
    into v
    from public.imprest_funds f cross join lateral private.imprest_count_days(f.id) d
   where f.is_active;
  if v is distinct from '2:shortage,1:balanced,0:due' then
    raise exception 'the days should read 2:shortage,1:balanced,0:due after the late count, found %', v;
  end if;

  select s.posted_funding_tzs || '/' || s.posted_balance_tzs || '/' || s.set_aside_tzs || '/'
         || s.free_to_approve_tzs || '/' || private.imprest_awaiting_verification_tzs(f.id)
    into v
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active;
  if v is distinct from '95000/76000/29000/47000/19000' then
    raise exception 'the late-count fixture should leave 95000/76000/29000/47000/19000, found %', v;
  end if;

  if (select count(*) from public.imprest_counts where late_reason is not null) <> 1 then
    raise exception 'the fixture should hold exactly one late count';
  end if;
end
$$;

\echo 'migration-chain: a missed day counted late and confirmed Balanced'
