-- Issue #73 · Migration chain, step 62: what the link migration added to a populated v0.11.0
-- database, and proof that it works against one
--
-- The preservation query has already required every released row, file, report, Cron job, grant,
-- policy, constraint, trigger, function body, enum, column, view and index to be identical, apart
-- from the two functions this release replaces or drops and what it adds. This file checks the other
-- half: what arrived, that no released receipt gained a link and no figure or stock moved, that the
-- six-argument form the released application calls still enters a receipt, and that a receipt paid
-- from a released payment links to it, moving nothing, while a released receipt cannot gain a link.

-- ---------------------------------------------------------------------------
-- 1. The chain, the objects, and what was replaced
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 54
     or (select max(version) from supabase_migrations.schema_migrations) <> '20261005000100' then
    raise exception 'expected the 53 released migrations and the link one, found % ending at %',
      (select count(*) from supabase_migrations.schema_migrations),
      (select max(version) from supabase_migrations.schema_migrations);
  end if;

  -- The six-argument command was replaced, and its six-argument body dropped.
  if to_regprocedure('private.impl_staff_enter_stock_receipt(uuid,text,date,text,jsonb,text)') is not null then
    raise exception 'the six-argument receipt body should be gone';
  end if;
  if to_regprocedure('private.impl_staff_enter_stock_receipt(uuid,text,date,text,jsonb,uuid,text)') is null
     or to_regprocedure('api.staff_enter_stock_receipt(uuid,text,date,text,jsonb,uuid,text)') is null
     or to_regprocedure('api.staff_enter_stock_receipt(uuid,text,date,text,jsonb,text)') is null then
    raise exception 'the seven-argument command, its body, or the six-argument command is missing';
  end if;
  if exists (select 1 from pg_proc p
              where p.oid = 'api.staff_enter_stock_receipt(uuid,text,date,text,jsonb,text)'::regprocedure
                and md5(replace(p.prosrc, E'\r', '')) = 'e0b9a9640a1b752fa454d9c1373377c4') then
    raise exception 'the six-argument command still has its v0.11.0 body';
  end if;

  -- Nothing was linked: every released receipt is unpaid from imprest.
  if (select count(*) from public.stock_receipt_imprest_links) <> 0 then
    raise exception 'the migration wrote a link into a database that had none';
  end if;

  if has_table_privilege('authenticated', 'public.stock_receipt_imprest_links', 'insert')
     or has_table_privilege('authenticated', 'public.stock_receipt_imprest_links', 'update')
     or has_table_privilege('authenticated', 'public.stock_receipt_imprest_links', 'delete')
     or not has_table_privilege('authenticated', 'public.stock_receipt_imprest_links', 'select')
     or has_table_privilege('service_role', 'public.stock_receipt_imprest_links', 'select')
     or has_table_privilege('anon', 'public.stock_receipt_imprest_links', 'select')
     or has_table_privilege('fv_definer_owner', 'public.stock_receipt_imprest_links', 'update')
     or has_table_privilege('fv_definer_owner', 'public.stock_receipt_imprest_links', 'delete') then
    raise exception 'the link table has the wrong grants';
  end if;
  if not (select relrowsecurity from pg_class
           where oid = 'public.stock_receipt_imprest_links'::regclass) then
    raise exception 'the link table has no row-level security';
  end if;

  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where ((n.nspname = 'api'
           and p.proname in ('staff_enter_stock_receipt', 'staff_imprest_receipt_payment_options',
                             'staff_stock_receipt_imprest_links',
                             'staff_imprest_disbursement_stock_receipts'))
       or (n.nspname = 'private'
           and p.proname in ('check_stock_receipt_imprest_link', 'stock_receipt_disbursement_summary',
                             'impl_staff_enter_stock_receipt', 'stock_receipt_entry_result')))
     and (pg_get_userbyid(p.proowner) <> 'fv_definer_owner'
          or has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('service_role', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute') <> (n.nspname = 'api'));
  if v_bad is not null then
    raise exception 'link functions with the wrong owner or grants: %', v_bad;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Nothing moved
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  select s.posted_funding_tzs || '/' || s.posted_balance_tzs || '/' || s.set_aside_tzs || '/'
         || s.free_to_approve_tzs || '/' || private.imprest_awaiting_verification_tzs(f.id)
    into v
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active;
  if v is distinct from '95000/70500/25000/45500/15000' then
    raise exception 'the upgrade moved the figures: expected 95000/70500/25000/45500/15000, found %', v;
  end if;
  if exists (select 1 from migration_chain.v0110_ground g
              where g.receipts <> (select count(*) from public.stock_receipts)
                 or g.stock <> (select coalesce(sum(quantity_delta), 0) from public.inventory_ledger)
                 or g.pending <> (select count(*) from public.approval_requests
                                   where entity_type = 'stock_receipt' and status = 'pending')) then
    raise exception 'the upgrade moved a receipt, its decision or the stock';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. It works against the released data
-- ---------------------------------------------------------------------------
-- The Cashier's released payment that paid out, the newest, is the one the picker offers first.
create table migration_chain.v0110_after (name text primary key, res jsonb not null);

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
insert into migration_chain.v0110_after values
  ('options', api.staff_imprest_receipt_payment_options());
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
insert into migration_chain.v0110_after values
  ('linked', api.staff_enter_stock_receipt(
     (select id from public.suppliers order by created_at limit 1), 'store', current_date,
     'DN-CHAIN-V0110-LINKED',
     jsonb_build_array(jsonb_build_object('product_id', migration_chain.product('Dangote Cement 42R'),
                                          'expected_quantity', 3, 'received_quantity', 3)),
     (select (o ->> 'id')::uuid
        from migration_chain.v0110_after a, jsonb_array_elements(a.res) o
       where a.name = 'options'
         and (select proposed_by from public.imprest_disbursements where id = (o ->> 'id')::uuid)
             = 'c0000000-0000-0000-0000-000000000003'
       limit 1),
     'chain-v0110-linked')),
  ('six', api.staff_enter_stock_receipt(
     (select id from public.suppliers order by created_at limit 1), 'store', current_date,
     'DN-CHAIN-V0110-SIX',
     jsonb_build_array(jsonb_build_object('product_id', migration_chain.product('Dangote Cement 42R'),
                                          'expected_quantity', 2, 'received_quantity', 2)),
     'chain-v0110-six'));
commit;

do $$
declare
  v_options jsonb := (select res from migration_chain.v0110_after where name = 'options');
  v_linked  jsonb := (select res from migration_chain.v0110_after where name = 'linked');
  v_six     jsonb := (select res from migration_chain.v0110_after where name = 'six');
  v text;
begin
  -- The picker offers exactly the released payments of the active fund that paid out.
  if (select string_agg(o ->> 'id', ',' order by o ->> 'id') from jsonb_array_elements(v_options) o)
     is distinct from (select string_agg(d.id::text, ',' order by d.id::text)
                         from public.imprest_disbursements d
                         join public.imprest_funds f on f.id = d.fund_id and f.is_active
                        where d.status::text in ('handed_out', 'settled', 'sent_back', 'verified')) then
    raise exception 'the picker should offer every released payment that paid out: %', v_options;
  end if;
  if jsonb_array_length(v_options) = 0 then
    raise exception 'the released ground should hold a payment that paid out';
  end if;

  if v_linked ->> 'reason' is distinct from 'entered'
     or v_linked -> 'imprest_link' ->> 'linked_by' is distinct from 'c0000000-0000-0000-0000-000000000003' then
    raise exception 'a receipt paid from a released payment should link to it: %', v_linked;
  end if;
  if v_six ->> 'reason' is distinct from 'entered' or v_six -> 'imprest_link' <> 'null'::jsonb then
    raise exception 'the six-argument form should still enter a receipt, with no link: %', v_six;
  end if;

  select s.posted_funding_tzs || '/' || s.posted_balance_tzs || '/' || s.set_aside_tzs || '/'
         || s.free_to_approve_tzs || '/' || private.imprest_awaiting_verification_tzs(f.id)
    into v
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active;
  if v is distinct from '95000/70500/25000/45500/15000' then
    raise exception 'linking moved a figure: found %', v;
  end if;
  if (select g.stock from migration_chain.v0110_ground g)
     <> (select coalesce(sum(quantity_delta), 0) from public.inventory_ledger) then
    raise exception 'linking moved stock';
  end if;
end
$$;

-- A released receipt cannot gain a link afterwards, whoever writes it. The commands' owner holds no
-- grant on this harness's schema, so the receipt is named before the role changes.
select set_config('migration_chain.released_receipt',
                  (select res -> 'receipt' ->> 'id' from migration_chain.v0110 where name = 'r1'), false);
set role fv_definer_owner;
do $$
begin
  begin
    insert into public.stock_receipt_imprest_links
      (receipt_id, disbursement_id, fund_id, linked_by, linked_role, correlation_id)
    select current_setting('migration_chain.released_receipt')::uuid,
           d.id, d.fund_id, 'c0000000-0000-0000-0000-000000000003', 'cashier', gen_random_uuid()
      from public.imprest_disbursements d
     where d.status::text in ('handed_out', 'settled', 'sent_back', 'verified')
       and d.proposed_by = 'c0000000-0000-0000-0000-000000000003'
     limit 1;
    raise exception 'a released receipt gained a link after it was entered';
  exception when restrict_violation then
    null;
  end;
end
$$;
reset role;

\echo 'migration-chain: the link migration upgraded a populated v0.11.0 database and works on it'
