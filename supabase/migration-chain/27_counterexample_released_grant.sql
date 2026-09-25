-- Issue #55 · Counterexample: a released table's grant widened
--
-- The disbursement migration grants on its own table. Granting on the one beside it instead would
-- let any signed-in person write imprest funding history straight through the Data API, and it
-- changes no row at all. The gate is REQUIRED to notice.

begin;

grant insert on public.imprest_fundings to authenticated;

do $$
begin
  if not has_table_privilege('authenticated', 'public.imprest_fundings', 'insert') then
    raise exception 'the counterexample did not widen the grant it meant to';
  end if;
end
$$;

commit;
