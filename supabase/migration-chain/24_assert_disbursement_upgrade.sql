-- Issue #55 · Migration chain, step 24: what the disbursement migration added to a populated v0.2.0
-- database, and proof that it works against one
--
-- The preservation query has already required every released row, report, Cron job, grant, policy,
-- constraint, trigger, function body, enum, column, view and index to be identical. This file checks
-- the other half: what arrived, the one released constraint that was allowed to change and exactly
-- how, and that the new commands really run against the fixture's own funding.

-- ---------------------------------------------------------------------------
-- 1. The chain, the objects, and the one replaced constraint
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad   text;
  v_kinds text;
  v_fns   integer;
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 42
     or (select max(version) from supabase_migrations.schema_migrations) <> '20260925000100' then
    raise exception 'expected the 41 released migrations and the disbursement one, found % ending at %',
      (select count(*) from supabase_migrations.schema_migrations),
      (select max(version) from supabase_migrations.schema_migrations);
  end if;

  if to_regclass('public.imprest_disbursements') is null then
    raise exception 'public.imprest_disbursements was not created';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.imprest_disbursements'::regclass) then
    raise exception 'public.imprest_disbursements has no row-level security';
  end if;

  -- The released text plus `disbursement`, and nothing else. Step 22 pinned the before side.
  select pg_get_constraintdef(c.oid) into v_kinds
    from pg_constraint c
   where c.conrelid = 'public.document_sequences'::regclass
     and c.conname = 'document_sequences_kind_check';
  if v_kinds is distinct from
     'CHECK ((kind = ANY (ARRAY[''order''::text, ''proforma''::text, ''invoice''::text, '
     '''batch''::text, ''imprest''::text, ''disbursement''::text])))' then
    raise exception 'the numbering constraint is not the released one plus disbursement: %', v_kinds;
  end if;

  -- Application roles read and never write the table; the secret key and anon reach nothing.
  select string_agg(g.grantee || ' ' || g.privilege_type, ', ') into v_bad
    from information_schema.role_table_grants g
   where g.table_schema = 'public' and g.table_name = 'imprest_disbursements'
     and ((g.grantee = 'authenticated' and g.privilege_type <> 'SELECT')
          or g.grantee in ('anon', 'service_role'));
  if v_bad is not null then
    raise exception 'an application role holds more than SELECT on disbursements: %', v_bad;
  end if;

  -- Fourteen functions, all owned by the definer owner. The five `api` ones are the only ones an
  -- application role may call, and only `authenticated` may call them.
  select count(*) into v_fns
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where (n.nspname = 'api'
          and (p.proname like '%imprest\_disbursement' or p.proname = 'staff_imprest_spending_position'))
      or (n.nspname = 'private'
          and (p.proname like '%imprest\_disbursement%' or p.proname = 'imprest_spending_figures'));
  if v_fns <> 14 then
    raise exception 'expected the fourteen disbursement functions, found %', v_fns;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where ((n.nspname = 'api'
           and (p.proname like '%imprest\_disbursement' or p.proname = 'staff_imprest_spending_position'))
       or (n.nspname = 'private'
           and (p.proname like '%imprest\_disbursement%' or p.proname = 'imprest_spending_figures')))
     and (pg_get_userbyid(p.proowner) <> 'fv_definer_owner'
          or has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('service_role', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute') <> (n.nspname = 'api'));
  if v_bad is not null then
    raise exception 'disbursement functions with the wrong owner or grants: %', v_bad;
  end if;

  -- Nothing was spent by the migration itself.
  if exists (select 1 from public.imprest_disbursements)
     or exists (select 1 from public.document_sequences where kind = 'disbursement') then
    raise exception 'the migration wrote a disbursement or a disbursement number on its own';
  end if;

  raise notice 'disbursement upgrade: 42 migrations, 14 functions, RLS and grants as approved, numbering extended by one kind';
end
$$;

-- ---------------------------------------------------------------------------
-- 2. The figures, on the fixture's own funding
--
-- Step 15 posted 95,000 through two receipts. Nothing is approved yet, so all of it is free.
-- ---------------------------------------------------------------------------
do $$
declare
  v record;
begin
  select * into v
    from private.imprest_spending_figures((select id from public.imprest_funds where is_active));
  if (v.posted_funding_tzs, v.set_aside_tzs, v.free_to_approve_tzs)
     is distinct from (95000::bigint, 0::bigint, 95000::bigint) then
    raise exception 'the spending figures on the fixture are not 95,000 / 0 / 95,000: %', v;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. The commands, on the populated database, under real sessions
--
-- Two proposals of 60,000 against 95,000 free: the first approval sets 60,000 aside, the second is
-- refused with the 35,000 that is actually left, and cancelling the first frees it again.
-- ---------------------------------------------------------------------------
begin;

create table migration_chain.disbursement (name text primary key, res jsonb not null);

create or replace function migration_chain.spend(p_name text, p_res jsonb, p_reason text)
returns jsonb language plpgsql as $$
begin
  perform migration_chain.expect(p_res, p_reason, 'imprest disbursement ' || p_name);
  insert into migration_chain.disbursement values (p_name, p_res);
  return p_res;
end
$$;

create or replace function migration_chain.did(p_name text) returns uuid language sql stable as $$
  select (res -> 'disbursement' ->> 'id')::uuid from migration_chain.disbursement where name = p_name;
$$;

-- The Cashier proposes.
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.spend('a.prop',
  api.staff_propose_imprest_disbursement(60000, 'fuel_and_lubricants', 'Chain diesel for the loader',
                                         'chain-dsb-a-prop'), 'proposed');
select migration_chain.spend('b.prop',
  api.staff_propose_imprest_disbursement(60000, 'materials_and_supplies', 'Chain sand top-up',
                                         'chain-dsb-b-prop'), 'proposed');

-- The Manager approves one, and cannot approve the other.
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.spend('a.app',
  api.staff_decide_imprest_disbursement(migration_chain.did('a.prop'), 1, true, null,
                                        'chain-dsb-a-app'), 'approved');

do $$
declare
  v_res jsonb := api.staff_decide_imprest_disbursement(migration_chain.did('b.prop'), 1, true, null,
                                                       'chain-dsb-b-app');
  v record;
begin
  if v_res ->> 'reason' <> 'insufficient_imprest'
     or (v_res ->> 'free_to_approve_tzs')::bigint <> 35000 then
    raise exception 'a second 60,000 approval against 35,000 free was not refused as it should be: %',
      v_res;
  end if;

  select * into v
    from private.imprest_spending_figures((select id from public.imprest_funds where is_active));
  if (v.posted_funding_tzs, v.set_aside_tzs, v.free_to_approve_tzs)
     is distinct from (95000::bigint, 60000::bigint, 35000::bigint) then
    raise exception 'after one approval the figures are not 95,000 / 60,000 / 35,000: %', v;
  end if;
end
$$;

-- And cancels the approval, which frees the money again.
select migration_chain.spend('a.can',
  api.staff_cancel_imprest_disbursement(migration_chain.did('a.prop'), 2, 'Loader repaired instead',
                                        'chain-dsb-a-can'), 'cancelled');

select set_config('request.jwt.claims', '', true);

do $$
declare
  v record;
begin
  select * into v
    from private.imprest_spending_figures((select id from public.imprest_funds where is_active));
  if v.free_to_approve_tzs <> 95000 then
    raise exception 'cancelling the approval did not free the money: %', v;
  end if;

  -- Numbered through the released counter under the one new kind.
  if (select count(*) from public.imprest_disbursements
       where disbursement_no ~ '^FV-DSB-[0-9]{8}-[0-9]{4}$') <> 2 then
    raise exception 'the two disbursements are not numbered FV-DSB-YYYYMMDD-NNNN';
  end if;

  -- The cancelled row still names who approved it.
  if (select approved_by from public.imprest_disbursements where id = migration_chain.did('a.prop'))
     is distinct from 'c0000000-0000-0000-0000-000000000002'::uuid then
    raise exception 'the cancelled disbursement lost its approver';
  end if;
end
$$;

commit;

-- ---------------------------------------------------------------------------
-- 4. The released report still runs on the upgraded database
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb := private.report_content(private.business_date()) -> 'sections';
begin
  if v -> 'imprest' ->> 'state' <> 'active'
     or (v -> 'imprest' -> 'funding' ->> 'received_tzs')::bigint <> 95000 then
    raise exception 'the report no longer reads the imprest fund after the upgrade: %', v -> 'imprest';
  end if;

  if not (select bool_and(integrity_ok) from public.daily_reports) then
    raise exception 'a stored report fails its integrity check after the upgrade';
  end if;

  raise notice 'disbursement commands ran on the populated database; the report still reads it';
end
$$;
