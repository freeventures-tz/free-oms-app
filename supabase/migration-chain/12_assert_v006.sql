-- v0.0.6 · Migration chain, step 12: what the two issue #7 migrations must have done, and not done
--
-- Runs AFTER `supabase migration up` has carried a populated v0.0.5 database across migrations 35
-- and 36. The preservation query beside it proves nothing was lost; this file proves the right
-- thing ARRIVED, that the surface a running application calls is unchanged, and that nothing from
-- another ticket came with it.
--
-- IT IS NOT pgTAP 014. That suite proves the RULE — a batch cannot consume promised stock — on a
-- freshly installed database. This one proves the UPGRADE PATH: that the rule reaches a database
-- that already holds orders, money, dispatches and brick production, without disturbing them.

do $$
declare
  v_count int;
  v_names text;
begin
  -- -------------------------------------------------------------------------
  -- The rule arrived
  -- -------------------------------------------------------------------------
  for v_names in
    select unnest(array['claim_unpromised_stock', 'claim_stock_for_withdrawal',
                        'claim_location_stock', 'lock_product_stock', 'lock_location_stock',
                        'stock_position', 'refuse', 'refuse_negative_availability'])
  loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'private' and p.proname = v_names) then
      raise exception 'migration 35 did not install private.%', v_names;
    end if;
  end loop;

  -- The deferred constraint on BOTH tables. product.md §8.1 has to hold whether the movement was
  -- written as a ledger row or as a claim, and a constraint on one of the two is a half-closed door.
  select count(*) into v_count
    from pg_trigger t
   where t.tgname in ('inventory_ledger_no_negative_availability',
                      'stock_allocations_no_negative_availability')
     and t.tgdeferrable and t.tginitdeferred;

  if v_count <> 2 then
    raise exception 'expected 2 deferred availability triggers, found %', v_count;
  end if;

  -- The location guard v0.0.5 shipped is still there, and is now `security definer` so it can see
  -- the ledger for a role that cannot. Losing it would leave a location able to hold less than
  -- nothing while availability stayed positive.
  if not exists (select 1 from pg_trigger where tgname = 'inventory_ledger_no_negative_stock') then
    raise exception 'the released negative-stock guard is gone';
  end if;

  if not (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private' and p.proname = 'refuse_negative_stock') then
    raise exception 'private.refuse_negative_stock is no longer SECURITY DEFINER';
  end if;

  -- -------------------------------------------------------------------------
  -- The sixteen commands moved, and are sealed where they landed
  -- -------------------------------------------------------------------------
  select count(*) into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname like 'impl\_%';

  if v_count <> 16 then
    raise exception 'expected 16 private.impl_ commands, found %', v_count;
  end if;

  select coalesce(string_agg(p.proname, ', ' order by p.proname), '') into v_names
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname like 'impl\_%'
     and (has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('service_role', p.oid, 'execute'));

  if v_names <> '' then
    raise exception 'these implementations are still reachable from outside: %', v_names;
  end if;

  -- -------------------------------------------------------------------------
  -- THE SURFACE A RUNNING APPLICATION CALLS IS UNCHANGED
  --
  -- This is the compatibility claim, and it is the one that decides whether the deployed browser
  -- code keeps working across the migration. Names, argument lists and audiences, all of them.
  -- -------------------------------------------------------------------------
  select coalesce(string_agg(x.proname, ', ' order by x.proname), '') into v_names
    from (select p.proname, pg_get_function_identity_arguments(p.oid) as args
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'api') x
   where (x.proname, x.args) not in (
     values ('admin_add_supplier',             'p_name text, p_idempotency_key text'),
            ('admin_set_supplier_active',      'p_supplier_id uuid, p_is_active boolean, p_idempotency_key text'),
            ('admin_record_opening_stock',     'p_product_id uuid, p_location_code text, p_quantity bigint, p_note text, p_idempotency_key text'),
            ('staff_enter_stock_receipt',      'p_supplier_id uuid, p_location_code text, p_delivery_date date, p_delivery_note_ref text, p_lines jsonb, p_idempotency_key text'),
            ('staff_approve_stock_receipt',    'p_receipt_id uuid, p_idempotency_key text'),
            ('staff_reject_stock_receipt',     'p_receipt_id uuid, p_reason text, p_idempotency_key text'),
            ('staff_enter_stock_transfer',     'p_from_location text, p_to_location text, p_note text, p_lines jsonb, p_idempotency_key text'),
            ('staff_approve_stock_transfer',   'p_transfer_id uuid, p_idempotency_key text'),
            ('staff_reject_stock_transfer',    'p_transfer_id uuid, p_reason text, p_idempotency_key text'),
            ('staff_enter_stock_adjustment',   'p_product_id uuid, p_location_code text, p_quantity_delta bigint, p_reason text, p_idempotency_key text'),
            ('admin_approve_stock_adjustment', 'p_adjustment_id uuid, p_idempotency_key text'),
            ('admin_reject_stock_adjustment',  'p_adjustment_id uuid, p_reason text, p_idempotency_key text'),
            ('staff_enter_production_batch',   'p_location_code text, p_moulded_at timestamp with time zone, p_inputs jsonb, p_outputs jsonb, p_yield_note text, p_idempotency_key text'),
            ('staff_approve_production_batch', 'p_batch_id uuid, p_idempotency_key text'),
            ('staff_reject_production_batch',  'p_batch_id uuid, p_reason text, p_idempotency_key text'),
            ('staff_inspect_curing_lot',       'p_lot_id uuid, p_accepted bigint, p_rejected bigint, p_reject_reason text, p_idempotency_key text'))
     and x.proname in ('admin_add_supplier', 'admin_set_supplier_active', 'admin_record_opening_stock',
                       'staff_enter_stock_receipt', 'staff_approve_stock_receipt', 'staff_reject_stock_receipt',
                       'staff_enter_stock_transfer', 'staff_approve_stock_transfer', 'staff_reject_stock_transfer',
                       'staff_enter_stock_adjustment', 'admin_approve_stock_adjustment', 'admin_reject_stock_adjustment',
                       'staff_enter_production_batch', 'staff_approve_production_batch', 'staff_reject_production_batch',
                       'staff_inspect_curing_lot');

  if v_names <> '' then
    raise exception 'these api functions changed their argument list: %', v_names;
  end if;

  -- All sixteen still THERE, not merely unchanged where present.
  select count(*) into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'api'
     and p.proname in ('admin_add_supplier', 'admin_set_supplier_active', 'admin_record_opening_stock',
                       'staff_enter_stock_receipt', 'staff_approve_stock_receipt', 'staff_reject_stock_receipt',
                       'staff_enter_stock_transfer', 'staff_approve_stock_transfer', 'staff_reject_stock_transfer',
                       'staff_enter_stock_adjustment', 'admin_approve_stock_adjustment', 'admin_reject_stock_adjustment',
                       'staff_enter_production_batch', 'staff_approve_production_batch', 'staff_reject_production_batch',
                       'staff_inspect_curing_lot');

  if v_count <> 16 then
    raise exception 'expected the 16 re-issued api commands, found %', v_count;
  end if;

  -- The audience rule, which is what the prefix promises. A wrapper that arrived without its grant
  -- would refuse every signed-in person, and one that arrived with too many would be a hole.
  select coalesce(string_agg(p.proname, ', ' order by p.proname), '') into v_names
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'api'
     and (p.proname like 'admin\_%' or p.proname like 'staff\_%' or p.proname like 'self\_%')
     and (not has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('service_role', p.oid, 'execute'));

  if v_names <> '' then
    raise exception 'these api functions lost the audience their prefix promises: %', v_names;
  end if;

  select coalesce(string_agg(p.proname, ', ' order by p.proname), '') into v_names
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'api' and p.proname like 'service\_%'
     and (not has_function_privilege('service_role', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('anon', p.oid, 'execute'));

  if v_names <> '' then
    raise exception 'these service functions lost their audience: %', v_names;
  end if;

  -- Ownership and hardening, over BOTH schemas, because sixteen functions just changed schema and
  -- eight were created from nothing.
  select coalesce(string_agg(n.nspname || '.' || p.proname, ', ' order by p.proname), '')
    into v_names
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    join pg_roles r on r.oid = p.proowner
   where n.nspname in ('api', 'private')
     and (r.rolname <> 'fv_definer_owner'
          or (p.prosecdef and (p.proconfig is null
                               or not ('search_path=' || '""') = any(p.proconfig))));

  if v_names <> '' then
    raise exception 'these functions are not owned or hardened as required: %', v_names;
  end if;

  -- PUBLIC holds EXECUTE on nothing, and `proacl is null` IS public execute.
  select coalesce(string_agg(n.nspname || '.' || p.proname, ', ' order by p.proname), '')
    into v_names
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('api', 'private')
     and (p.proacl is null
          or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0));

  if v_names <> '' then
    raise exception 'PUBLIC can execute these: %', v_names;
  end if;

  -- -------------------------------------------------------------------------
  -- AND NOTHING FROM ANOTHER TICKET CAME WITH IT
  --
  -- The branch this was extracted from carried imprest migrations and, further along, a scheduled
  -- report with its Cron job. Neither is in this release, and the cheapest way for either to arrive
  -- unnoticed is exactly this kind of extraction.
  -- -------------------------------------------------------------------------
  select coalesce(string_agg(c.relname, ', ' order by c.relname), '') into v_names
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and (c.relname like 'imprest%' or c.relname like 'report_%' or c.relname = 'daily_reports');

  if v_names <> '' then
    raise exception 'objects from an excluded ticket arrived: %', v_names;
  end if;

  select coalesce(string_agg(p.proname, ', ' order by p.proname), '') into v_names
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('api', 'private')
     and (p.proname like '%imprest%' or p.proname like '%scheduled_report%'
          or p.proname like '%report_content%');

  if v_names <> '' then
    raise exception 'functions from an excluded ticket arrived: %', v_names;
  end if;

  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron is installed, and no part of this release schedules anything';
  end if;

  -- -------------------------------------------------------------------------
  -- The v0.0.5 behaviour this release must not have altered
  -- -------------------------------------------------------------------------
  if not exists (select 1 from public.production_lots
                  where inspected_at is not null and accepted_quantity > 0) then
    raise exception 'the inspected lot did not survive the upgrade';
  end if;

  if not exists (select 1 from public.production_batches where status = 'approved') then
    raise exception 'the approved batch did not survive the upgrade';
  end if;

  -- 72 hours, unchanged. Read from the function the command calls rather than asserted about a row,
  -- so a migration that quietly shortened curing is caught even with no lot in that window.
  -- `prokind = 'f'` because `pg_get_functiondef` raises on an aggregate, and `private` holds one.
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'private' and p.prokind = 'f'
                    and pg_get_functiondef(p.oid) like '%72 hours%') then
    raise exception 'nothing in private still names the 72-hour curing period (§11.4)';
  end if;
end
$$;

\echo 'migration-chain: v0.0.6 installed the stock invariant, kept the api surface, and brought nothing else'
