-- v0.0.5 · Migration chain, step 4: what the upgrade added, and everything it left alone
--
-- Runs after `supabase migration up` has applied migrations 33 and 34 on top of the populated
-- v0.0.4 database built by step 3. The preservation query has already been compared before and
-- after by the harness; this file asserts the two things a digest cannot say on its own:
--
--   · the production objects the release claims, and NOTHING from a later release;
--   · that every released command, grant and policy still exists with the same definition — and
--     that an old command still WORKS, which is the only proof that matters to an application
--     that has not been redeployed yet.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- The exact production delta
-- ---------------------------------------------------------------------------
do $$
declare
  v_missing text;
  v_count   integer;
begin
  for v_missing in
    select name from (values
      ('public.production_recipe_inputs'), ('public.production_yield_ranges'),
      ('public.production_batches'), ('public.production_batch_inputs'),
      ('public.production_lots'), ('public.curing_lots')
    ) as t(name)
    where to_regclass(name) is null
  loop
    raise exception 'the upgrade did not create %', v_missing;
  end loop;

  select count(*) into v_count
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and c.relname like 'production%' and not c.relrowsecurity;

  if v_count > 0 then
    raise exception '% production table(s) have no row-level security', v_count;
  end if;

  select count(*) into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'api' and p.proname in (
     'staff_enter_production_batch', 'staff_approve_production_batch',
     'staff_reject_production_batch', 'staff_inspect_curing_lot');

  if v_count <> 4 then
    raise exception 'expected the four production commands, found %', v_count;
  end if;

  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'public' and t.typname = 'brick_reject_reason'
  ) then
    raise exception 'the four preset reject reasons of product.md §11.5 are missing';
  end if;

  if (select count(*) from public.production_recipe_inputs) <> 3
     or (select count(*) from public.production_yield_ranges) <> 2 then
    raise exception 'the recipe and yield reference data did not seed onto a populated database';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Nothing from a later release came with it
-- ---------------------------------------------------------------------------
do $$
declare v_found text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into v_found
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and (c.relname like 'imprest%' or c.relname like 'report%'
          or c.relname like '%reconciliation%' or c.relname like '%alert%');

  if v_found is not null then
    raise exception 'the upgrade brought objects from a later release: %', v_found;
  end if;

  select string_agg(p.proname, ', ' order by p.proname) into v_found
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('api', 'private')
     and (p.proname like '%imprest%' or p.proname like '%scheduled_report%'
          or p.proname like '%available_for_production%');

  if v_found is not null then
    raise exception 'the upgrade brought commands from a later release: %', v_found;
  end if;

  -- The promised-stock correction belongs to v0.0.6, and its deferred constraint is the thing that
  -- would give this release a false claim to enforce §8.1.
  if exists (
    select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
     where t.relname = 'inventory_ledger' and c.conname ilike '%availab%'
  ) then
    raise exception 'the promised-stock availability constraint is a v0.0.6 object';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Every released command, grant and policy, unchanged
-- ---------------------------------------------------------------------------
do $$
declare v_changed text;
begin
  select string_agg(b.name || '(' || b.args || ')', ', ' order by b.name) into v_changed
    from migration_chain.api_before b
    left join (
      select p.proname as name,
             pg_get_function_identity_arguments(p.oid) as args,
             md5(pg_get_functiondef(p.oid)) as definition,
             pg_catalog.pg_get_userbyid(p.proowner) as owner,
             coalesce(array_to_string(p.proacl::text[], ','), '') as acl
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'api'
    ) a on a.name = b.name and a.args = b.args
   where a.name is null
      or a.definition is distinct from b.definition
      or a.owner is distinct from b.owner
      or a.acl is distinct from b.acl;

  if v_changed is not null then
    raise exception 'released api commands changed across the upgrade: %', v_changed;
  end if;

  select string_agg(g.table_name || '/' || g.grantee || '/' || g.privilege_type, ', '
                    order by g.table_name, g.grantee, g.privilege_type) into v_changed
    from migration_chain.grants_before g
   where not exists (
     select 1 from information_schema.table_privileges t
      where t.table_schema = 'public'
        and t.table_name = g.table_name
        and t.grantee = g.grantee
        and t.privilege_type = g.privilege_type);

  if v_changed is not null then
    raise exception 'released table grants disappeared across the upgrade: %', v_changed;
  end if;

  select string_agg(p.tablename || '/' || p.policyname, ', ' order by p.tablename, p.policyname)
    into v_changed
    from migration_chain.policies_before p
   where not exists (
     select 1 from pg_policies q
      where q.schemaname = 'public'
        and q.tablename = p.tablename
        and q.policyname = p.policyname
        and q.cmd = p.cmd
        and q.roles::text = p.roles
        and coalesce(q.qual, '') = p.using_clause
        and coalesce(q.with_check, '') = p.check_clause);

  if v_changed is not null then
    raise exception 'released row-level security policies changed across the upgrade: %', v_changed;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- An old command still WORKS, which is what "the v0.0.4 application keeps serving" means
--
-- Between applying these migrations and deploying the new code, the running application is still
-- v0.0.4. A schema that is structurally intact and refuses the commands that application makes
-- would be an outage with a green migration behind it.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims',
  json_build_object('sub', 'c0000000-0000-0000-0000-000000000003', 'role', 'authenticated')::text,
  false);

do $$
declare v_result jsonb;
begin
  -- The Cashier takes money on the invoice the fixture deliberately left unpaid, exactly as the
  -- v0.0.4 screen would.
  select api.staff_record_payment(
           (select id from migration_chain.invoices where label = 'unpaid'),
           'cash',
           (select total_tzs from migration_chain.invoices where label = 'unpaid'),
           'chain-post-upgrade-payment')
    into v_result;

  if coalesce(v_result ->> 'reason', '') <> 'recorded' then
    raise exception 'a released payment command stopped working after the upgrade: %', v_result;
  end if;
end
$$;

select set_config('request.jwt.claims',
  json_build_object('sub', 'c0000000-0000-0000-0000-000000000002', 'role', 'authenticated')::text,
  false);

do $$
declare v_result jsonb;
begin
  -- …and a released Manager command that touches the ledger the production commands now share.
  select api.staff_enter_stock_transfer(
           'yard', 'warehouse', 'a transfer entered after the upgrade',
           jsonb_build_array(jsonb_build_object(
             'product_id', migration_chain.product('Dangote Cement 42R'), 'quantity', 1)),
           'chain-post-upgrade-transfer')
    into v_result;

  if coalesce(v_result ->> 'reason', '') <> 'entered' then
    raise exception 'a released transfer command stopped working after the upgrade: %', v_result;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The batch numbering kind was added without disturbing the counters that exist
-- ---------------------------------------------------------------------------
do $$
declare v_definition text := (
  select pg_get_constraintdef(c.oid)
    from pg_constraint c
    join pg_class t     on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public' and t.relname = 'document_sequences'
     and c.conname = 'document_sequences_kind_check');
declare v_kind text;
begin
  foreach v_kind in array array['order', 'proforma', 'invoice', 'batch'] loop
    if position('''' || v_kind || '''' in v_definition) = 0 then
      raise exception 'the % numbering kind is missing after the upgrade: %', v_kind, v_definition;
    end if;
  end loop;
end
$$;

\echo 'migration-chain: the v0.0.5 upgrade added production and changed nothing released'
