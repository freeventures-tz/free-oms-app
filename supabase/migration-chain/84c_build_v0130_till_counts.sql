-- Issue #84 · Migration chain, step 84c: the till counted, sent back, counted again and confirmed,
-- on the v0.13.0 database
--
-- Runs after step 83b. Through the released v0.13.0 commands, the Cashier counts today's till, the
-- Manager sends it back with a reason, the Cashier counts again naming the first count, and the
-- Manager confirms the recount. So the accountability migration meets every till table populated:
-- two counts, twelve lines, a send-back and a confirmation, and the preservation query has rows in
-- each to compare.

begin;
create temp table till_chain (name text primary key, res jsonb not null);

do $$
declare
  v_first    jsonb;
  v_back     jsonb;
  v_second   jsonb;
  v_confirm  jsonb;
  v_counted  jsonb := jsonb_build_object('cash', 15000, 'mixx_by_yas', 0, 'halopesa', 0,
                                         'mwanga_hakika_transfer', 0, 'crdb_transfer', 0,
                                         'cheque', 0);
begin
  perform migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
  v_first := api.staff_enter_till_count(private.reconciliation_business_date(), null, v_counted,
                                        'Evening count', null, 'chain-v0130-till-1');
  if v_first ->> 'reason' <> 'counted' then
    raise exception 'the first till count was not entered: %', v_first;
  end if;

  perform migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
  v_back := api.staff_send_back_till_count((v_first -> 'count' ->> 'id')::uuid,
                                           (v_first -> 'count' ->> 'version')::integer,
                                           'Count the cash drawer again', 'chain-v0130-till-back');
  if v_back ->> 'reason' <> 'sent_back' then
    raise exception 'the till count was not sent back: %', v_back;
  end if;

  perform migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
  v_second := api.staff_enter_till_count(private.reconciliation_business_date(),
                                         (v_first -> 'count' ->> 'id')::uuid, v_counted,
                                         'Recounted', null, 'chain-v0130-till-2');
  if v_second ->> 'reason' <> 'counted' then
    raise exception 'the recount was not entered: %', v_second;
  end if;

  perform migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
  -- A balanced day takes no reason; a short or over one needs one. Whichever the fixture's payments
  -- make it, the Manager confirms it as it stands.
  v_confirm := api.staff_confirm_till_count((v_second -> 'count' ->> 'id')::uuid,
                                            (v_second -> 'count' ->> 'version')::integer,
                                            'counting_error', null, 'chain-v0130-till-ok');
  if v_confirm ->> 'reason' = 'explanation_not_needed' then
    v_confirm := api.staff_confirm_till_count((v_second -> 'count' ->> 'id')::uuid,
                                              (v_second -> 'count' ->> 'version')::integer,
                                              null, null, 'chain-v0130-till-ok-balanced');
  end if;
  if v_confirm ->> 'reason' <> 'confirmed' then
    raise exception 'the recount was not confirmed: %', v_confirm;
  end if;
end
$$;
commit;

do $$
begin
  if (select count(*) from public.reconciliations) <> 2
     or (select count(*) from public.reconciliation_lines) <> 12
     or (select count(*) from public.reconciliation_returns) <> 1
     or (select count(*) from public.reconciliation_confirmations) <> 1 then
    raise exception 'the till tables should hold 2 counts, 12 lines, 1 send-back and 1 confirmation, '
                    'found %, %, %, %',
      (select count(*) from public.reconciliations), (select count(*) from public.reconciliation_lines),
      (select count(*) from public.reconciliation_returns),
      (select count(*) from public.reconciliation_confirmations);
  end if;
end
$$;

\echo 'migration-chain: the till counted, sent back, counted again and confirmed, on the v0.13.0 database'
