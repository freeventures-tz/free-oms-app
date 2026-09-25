-- Issue #55 · Counterexample: a label added to a released enum
--
-- The disbursement migration creates two enums of its own beside the released ones. The one-line
-- mistake is `alter type ... add value` on the wrong type: it writes no row, re-issues no function
-- and changes no grant, so every earlier part of the gate reads the same. This file makes that
-- mistake on the funding status a Director's history is written in, and the gate is REQUIRED to
-- notice.

alter type public.imprest_funding_status add value 'disbursed';

do $$
begin
  if not ('disbursed' = any (enum_range(null::public.imprest_funding_status)::text[])) then
    raise exception 'the counterexample did not add the label it meant to';
  end if;
end
$$;
