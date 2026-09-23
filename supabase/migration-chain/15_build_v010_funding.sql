-- Issue #51 · Migration chain, step 15: imprest funding, through the released commands
--
-- Runs after step 11 on the v0.1.0 database, reusing its four people and its checked `expect`
-- helper. Every shape the released funding workflow can leave behind is built here, because each is
-- a different set of rows the reporting migrations must carry across untouched AND the report must
-- read honestly afterwards:
--
--   A  request 100,000 -> approve 80,000 -> increase to 90,000 -> provide 70,000
--      -> the Manager counts 60,000 (mismatch) -> corrected handover 65,000 -> received 65,000
--   B  request 50,000, never decided                     (a request with no receipt)
--   C  request 30,000 -> approve -> provide 30,000 -> received 30,000
--   D  request 20,000 -> rejected with a reason
--
-- So posted funding is 95,000 from two receipts, and approval, increase, handover, mismatch and
-- rejection history all exist beside it and post nothing.

begin;

create table migration_chain.funding (name text primary key, res jsonb not null);

create or replace function migration_chain.fund(p_name text, p_res jsonb, p_reason text)
returns jsonb language plpgsql as $$
begin
  perform migration_chain.expect(p_res, p_reason, 'imprest funding ' || p_name);
  insert into migration_chain.funding values (p_name, p_res);
  return p_res;
end
$$;

create or replace function migration_chain.fid(p_name text) returns uuid language sql stable as $$
  select (res -> 'funding' ->> 'id')::uuid from migration_chain.funding where name = p_name;
$$;

create or replace function migration_chain.hid(p_name text) returns uuid language sql stable as $$
  select (res -> 'funding' ->> 'handover_id')::uuid from migration_chain.funding where name = p_name;
$$;

-- The Manager asks.
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.fund('a.req',
  api.staff_request_imprest_funding(100000, 'Chain yard float', 'chain-imp-a-req'), 'requested');
select migration_chain.fund('b.req',
  api.staff_request_imprest_funding(50000, 'Chain diesel', 'chain-imp-b-req'), 'requested');
select migration_chain.fund('c.req',
  api.staff_request_imprest_funding(30000, 'Chain sand', 'chain-imp-c-req'), 'requested');
select migration_chain.fund('d.req',
  api.staff_request_imprest_funding(20000, 'Chain extras', 'chain-imp-d-req'), 'requested');

-- A Director decides, increases and hands over.
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000001');
select migration_chain.fund('a.app',
  api.admin_decide_imprest_funding(migration_chain.fid('a.req'), 1, true, 80000, null,
                                   'chain-imp-a-app'), 'approved');
select migration_chain.fund('a.inc',
  api.admin_increase_imprest_approval(migration_chain.fid('a.req'), 2, 90000,
                                      'More sand needed', 'chain-imp-a-inc'), 'approval_increased');
select migration_chain.fund('a.prov',
  api.admin_record_imprest_provided(migration_chain.fid('a.req'), 3, 70000, 'chain-imp-a-prov'),
  'provided');
select migration_chain.fund('c.app',
  api.admin_decide_imprest_funding(migration_chain.fid('c.req'), 1, true, 30000, null,
                                   'chain-imp-c-app'), 'approved');
select migration_chain.fund('c.prov',
  api.admin_record_imprest_provided(migration_chain.fid('c.req'), 2, 30000, 'chain-imp-c-prov'),
  'provided');
select migration_chain.fund('d.rej',
  api.admin_decide_imprest_funding(migration_chain.fid('d.req'), 1, false, null,
                                   'Not needed this week', 'chain-imp-d-rej'), 'rejected');

-- The Manager counts short on A.
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.fund('a.mis',
  api.staff_report_imprest_mismatch(migration_chain.fid('a.req'), 4, migration_chain.hid('a.prov'),
                                    60000, 'Counted less', 'chain-imp-a-mis'), 'mismatch_reported');

-- A Director corrects the handover.
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000001');
select migration_chain.fund('a.fix',
  api.admin_resolve_imprest_mismatch(migration_chain.fid('a.req'), 5, 65000, 'Corrected handover',
                                     'chain-imp-a-fix'), 'handover_corrected');

-- The Manager confirms both receipts. Only these post money.
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.fund('a.rec',
  api.staff_confirm_imprest_received(migration_chain.fid('a.req'), 6, migration_chain.hid('a.fix'),
                                     'chain-imp-a-rec'), 'received');
select migration_chain.fund('c.rec',
  api.staff_confirm_imprest_received(migration_chain.fid('c.req'), 3, migration_chain.hid('c.prov'),
                                     'chain-imp-c-rec'), 'received');

select set_config('request.jwt.claims', '', true);

-- Asserted rather than assumed: a fixture that built less than it claims would let the comparison
-- pass while carrying nothing across.
do $$
begin
  if (select count(*) from public.imprest_fundings) <> 4 then
    raise exception 'the funding fixture should hold four fundings';
  end if;
  if (select count(*) from public.imprest_funding_approvals) <> 3 then
    raise exception 'the funding fixture should hold three approval rows, one of them an increase';
  end if;
  if (select count(*) from public.imprest_funding_handovers) <> 3 then
    raise exception 'the funding fixture should hold three handovers, one of them a correction';
  end if;
  if (select count(*) from public.imprest_funding_mismatches) <> 1 then
    raise exception 'the funding fixture should hold one mismatch';
  end if;
  if (select posted_funding_tzs from public.imprest_funding_position) <> 95000 then
    raise exception 'posted funding should be the two receipts, 95,000';
  end if;
end
$$;

commit;

\echo 'migration-chain: added imprest funding with increase, mismatch, correction, rejection and two receipts'
