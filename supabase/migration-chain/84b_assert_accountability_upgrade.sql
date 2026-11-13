-- Issue #84 · Migration chain, step 84b: what the accountability migration changed on a populated
-- v0.13.0 database, and proof that a Director can decide what production already holds
--
-- The preservation query has already required every released row, stored report, Cron job, grant,
-- policy, constraint, trigger, function body, enum, column, view and index to be identical, apart
-- from the one function this release replaces and the objects it adds. This file checks the other
-- half: what arrived, that the replaced reader still lists exactly what the released one listed
-- while nothing is decided, and that a Director's decision on a released loss and a released
-- shortage closes both without moving a figure. That last part is rolled back.

do $$
declare
  v_bad text;
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 57
     or (select max(version) from supabase_migrations.schema_migrations) <> '20261008000100' then
    raise exception 'expected the 56 released migrations and the accountability one, found % ending at %',
      (select count(*) from supabase_migrations.schema_migrations),
      (select max(version) from supabase_migrations.schema_migrations);
  end if;

  if (select md5(replace(p.prosrc, E'\r', '')) from pg_proc p
       where p.oid = 'private.imprest_fund_unresolved(uuid)'::regprocedure)
     is distinct from '9bbc24271112fdf9e398c826ecaacc2e' then
    raise exception 'private.imprest_fund_unresolved is not the body issue #84 wrote';
  end if;

  select string_agg(sig, ', ') into v_bad
    from unnest(array['api.admin_record_accountability_decision(text,uuid,text,boolean,uuid[],text)',
                      'api.admin_accountability_queue()',
                      'private.impl_admin_record_accountability_decision(text,uuid,text,boolean,uuid[],text)',
                      'private.accountability_decision_json(uuid)',
                      'private.check_accountability_decision(uuid)',
                      'private.imprest_fund_unresolved(uuid)']) sig
   where not exists (select 1 from pg_proc p join pg_roles o on o.oid = p.proowner
                      where p.oid = to_regprocedure(sig) and p.prosecdef
                        and o.rolname = 'fv_definer_owner')
      or has_function_privilege('anon', sig, 'execute')
      or has_function_privilege('service_role', sig, 'execute')
      or (sig like 'private.%' and has_function_privilege('authenticated', sig, 'execute'))
      or (sig like 'api.%' and not has_function_privilege('authenticated', sig, 'execute'));
  if v_bad is not null then
    raise exception 'missing, not owned by the definer, or wrongly exposed: %', v_bad;
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.accountability_decisions'::regclass)
     or not (select relrowsecurity from pg_class
              where oid = 'public.accountability_decision_staff'::regclass)
     or has_table_privilege('authenticated', 'public.accountability_decisions', 'insert')
     or has_table_privilege('fv_definer_owner', 'public.accountability_decisions', 'update')
     or has_table_privilege('fv_definer_owner', 'public.accountability_decisions', 'delete') then
    raise exception 'the decisions table is writable outside the command, or has no row-level security';
  end if;

  if exists (select 1 from public.accountability_decisions) then
    raise exception 'the migration wrote a decision';
  end if;

  -- While nothing is decided, the replaced reader lists what the released one did, fund by fund.
  if exists (
    select 1 from public.imprest_funds f
     where private.imprest_fund_unresolved(f.id) -> 'losses' is distinct from coalesce((
             select jsonb_agg(jsonb_build_object('posting_id', p.id, 'disbursement_id', d.id,
                                                 'disbursement_no', d.disbursement_no,
                                                 'amount_tzs', p.amount_tzs, 'posted_at', p.posted_at)
                              order by p.posted_at, d.disbursement_no)
               from public.imprest_postings p
               join public.imprest_disbursements d on d.id = p.disbursement_id
              where p.fund_id = f.id and p.needs_director_decision
                and not exists (select 1 from public.imprest_postings x
                                 where x.corrects_posting_id = p.id and x.entry = 'reversal')), '[]')
        or jsonb_array_length(private.imprest_fund_unresolved(f.id) -> 'shortages')
           <> (select count(*) from public.imprest_count_postings cp
                where cp.fund_id = f.id and cp.needs_director_decision)) then
    raise exception 'the replaced reader lists something other than the released one did';
  end if;

  if (select count(*) from public.imprest_postings p
       where p.needs_director_decision
         and not exists (select 1 from public.imprest_postings x
                          where x.corrects_posting_id = p.id and x.entry = 'reversal')) = 0
     or (select count(*) from public.imprest_count_postings where needs_director_decision) = 0 then
    raise exception 'the fixture holds no undecided loss or shortage, so the decision below proves nothing';
  end if;
end
$$;

-- A Director decides one released loss and one released shortage. Rolled back: the database the
-- counterexamples meet is the one the upgrade left.
begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000001');

create temp table chain_before as
  select (select count(*) from public.imprest_postings) as postings,
         (select count(*) from public.imprest_count_postings) as count_postings,
         (select count(*) from public.inventory_ledger) as ledger,
         (select string_agg(s.posted_balance_tzs::text, ',' order by f.id)
            from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s)
           as balances,
         jsonb_array_length(api.admin_accountability_queue() -> 'undecided') as waiting;

do $$
declare
  v_loss     uuid;
  v_shortage uuid;
  v          jsonb;
begin
  select (u ->> 'subject_id')::uuid into v_loss
    from jsonb_array_elements(api.admin_accountability_queue() -> 'undecided') u
   where u ->> 'subject_type' = 'imprest_unexplained_loss' limit 1;
  select (u ->> 'subject_id')::uuid into v_shortage
    from jsonb_array_elements(api.admin_accountability_queue() -> 'undecided') u
   where u ->> 'subject_type' = 'imprest_count_shortage' limit 1;

  v := api.admin_record_accountability_decision('imprest_unexplained_loss', v_loss,
         'The chain decides this loss.', true, null, 'chain-84-loss');
  if v ->> 'reason' <> 'recorded' then raise exception 'the loss was not decided: %', v; end if;
  v := api.admin_record_accountability_decision('imprest_count_shortage', v_shortage,
         'The chain decides this shortage.', false,
         array['c0000000-0000-0000-0000-000000000001'::uuid], 'chain-84-shortage');
  if v ->> 'reason' <> 'recorded' then raise exception 'the shortage was not decided: %', v; end if;
end
$$;

-- The deferred checks run now, inside the transaction, so a decision they would refuse fails here.
set constraints all immediate;

do $$
declare b record;
begin
  select * into b from chain_before;
  if (select count(*) from public.imprest_postings) <> b.postings
     or (select count(*) from public.imprest_count_postings) <> b.count_postings
     or (select count(*) from public.inventory_ledger) <> b.ledger
     or (select string_agg(s.posted_balance_tzs::text, ',' order by f.id)
           from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s)
        is distinct from b.balances then
    raise exception 'a decision posted something or moved a balance';
  end if;
  if jsonb_array_length(api.admin_accountability_queue() -> 'undecided') <> b.waiting - 2 then
    raise exception 'the two decided subjects did not leave the undecided list';
  end if;
end
$$;
rollback;

\echo 'migration-chain: the accountability upgrade is what issue #84 wrote, and decides released losses and shortages'
