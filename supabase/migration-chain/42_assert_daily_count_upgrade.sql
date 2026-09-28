-- Issue #68 · Migration chain, step 42: what the daily count migration added to a populated v0.6.0
-- database, and proof that it works against one
--
-- The preservation query has already required every released row, file, report, Cron job, grant,
-- policy, constraint, trigger, function body, enum, column, view and index to be identical, apart
-- from the spending figures, which this release replaces. This file checks the other half: what
-- arrived, that the figures read the same through the replaced function, and that a count is
-- entered, sent back, counted again and confirmed as a shortage that posts, all committed.

-- ---------------------------------------------------------------------------
-- 1. The chain, the objects, and the replaced function
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 49
     or (select max(version) from supabase_migrations.schema_migrations) <> '20260930000100' then
    raise exception 'expected the 48 released migrations and the count one, found % ending at %',
      (select count(*) from supabase_migrations.schema_migrations),
      (select max(version) from supabase_migrations.schema_migrations);
  end if;

  select string_agg(t, ', ') into v_bad
    from unnest(array['public.imprest_counts', 'public.imprest_count_returns',
                      'public.imprest_count_confirmations', 'public.imprest_count_postings',
                      'public.imprest_count_flags']) t
   where to_regclass(t) is null
      or not (select relrowsecurity from pg_class where oid = to_regclass(t));
  if v_bad is not null then
    raise exception 'count tables missing or without row-level security: %', v_bad;
  end if;

  if (select md5(replace(p.prosrc, E'\r', '')) from pg_proc p
       where p.oid = 'private.imprest_spending_figures(uuid)'::regprocedure)
     = '4df056dbd8ecc751a61140393b81c672' then
    raise exception 'the spending figures were not replaced';
  end if;

  -- Application roles read and never write the new tables; the secret key and anon reach nothing.
  select string_agg(g.table_name || ' ' || g.grantee || ' ' || g.privilege_type, ', ') into v_bad
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.table_name in ('imprest_counts', 'imprest_count_returns', 'imprest_count_confirmations',
                          'imprest_count_postings', 'imprest_count_flags')
     and ((g.grantee = 'authenticated' and g.privilege_type <> 'SELECT')
          or (g.grantee = 'fv_definer_owner'
              and g.privilege_type not in ('SELECT', 'INSERT')
              and not (g.table_name = 'imprest_counts' and g.privilege_type = 'UPDATE'))
          or g.grantee in ('anon', 'service_role'));
  if v_bad is not null then
    raise exception 'a role holds more than it should on the count tables: %', v_bad;
  end if;

  -- The posted balance and awaiting verification kept with a count are never a column a Cashier's
  -- session can select.
  if has_column_privilege('authenticated', 'public.imprest_counts', 'posted_balance_tzs', 'select')
     or has_column_privilege('authenticated', 'public.imprest_counts', 'awaiting_verification_tzs', 'select')
     or not has_column_privilege('authenticated', 'public.imprest_counts', 'expected_tzs', 'select') then
    raise exception 'the count columns a session may select are not the intended ones';
  end if;

  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where ((n.nspname = 'api'
           and p.proname in ('staff_enter_imprest_count', 'staff_send_back_imprest_count',
                             'staff_confirm_imprest_count', 'staff_imprest_counts'))
       or (n.nspname = 'private'
           and p.proname in ('imprest_spending_figures', 'imprest_business_date',
                             'check_imprest_count_entry', 'guard_imprest_count_progress',
                             'check_imprest_count_decision', 'check_imprest_count_complete',
                             'imprest_count_json', 'imprest_count_result', 'imprest_count_audit',
                             'imprest_count_open', 'impl_staff_enter_imprest_count',
                             'impl_staff_send_back_imprest_count',
                             'impl_staff_confirm_imprest_count')))
     and (pg_get_userbyid(p.proowner) <> 'fv_definer_owner'
          or has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('service_role', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute') <> (n.nspname = 'api'));
  if v_bad is not null then
    raise exception 'count functions with the wrong owner or grants: %', v_bad;
  end if;

  -- Nothing was counted by the migration itself.
  if exists (select 1 from public.imprest_counts) or exists (select 1 from public.imprest_count_postings) then
    raise exception 'the migration counted something on its own';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. The same figures, read through the replaced function
-- ---------------------------------------------------------------------------
begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
do $$
declare
  v text;
begin
  select posted_funding_tzs || '/' || posted_balance_tzs || '/' || set_aside_tzs || '/'
         || free_to_approve_tzs || '/' || awaiting_verification_tzs
    into v from api.staff_imprest_spending_position();
  if v is distinct from '95000/77000/29000/48000/19000' then
    raise exception 'the upgraded position should read 95000/77000/29000/48000/19000, found %', v;
  end if;
end
$$;
commit;

-- ---------------------------------------------------------------------------
-- 3. The Cashier counts TZS 56,000 against the 58,000 expected; the Manager sends it back
-- ---------------------------------------------------------------------------
begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.spend('count.1', api.staff_enter_imprest_count(
  private.imprest_business_date(), null, 56000, 'Notes only', 'chain-count-1'), 'counted');
commit;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.spend('count.1.back', api.staff_send_back_imprest_count(
  (select (res -> 'count' ->> 'id')::uuid from migration_chain.disbursements where name = 'count.1'),
  1, 'Count the coin bag too', 'chain-count-1-back'), 'sent_back');
-- Committed, so the deferred check that the return leaves the count sent back really runs.
commit;

-- ---------------------------------------------------------------------------
-- 4. The Cashier counts again, TZS 57,000; the Manager confirms the 1,000 shortage, committed
-- ---------------------------------------------------------------------------
begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.spend('count.2', api.staff_enter_imprest_count(
  private.imprest_business_date(),
  (select (res -> 'count' ->> 'id')::uuid from migration_chain.disbursements where name = 'count.1'),
  57000, null, 'chain-count-2'), 'counted');
commit;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.spend('count.2.confirmed', api.staff_confirm_imprest_count(
  (select (res -> 'count' ->> 'id')::uuid from migration_chain.disbursements where name = 'count.2'),
  1, 'counting_error', null, 'chain-count-2-confirm'), 'confirmed');
-- Committed, so the deferred check that the confirmation carries its posting and flag really runs,
-- as the Manager's own session.
commit;

do $$
declare
  v text;
begin
  if (select string_agg(attempt::text || ':' || status::text || ':' || expected_tzs || ':'
                        || variance_tzs, ',' order by attempt)
        from public.imprest_counts)
     is distinct from '1:sent_back:58000:-2000,2:confirmed:58000:-1000' then
    raise exception 'the counts should read 1:sent_back:58000:-2000,2:confirmed:58000:-1000, found %',
      (select string_agg(attempt::text || ':' || status::text || ':' || expected_tzs || ':'
                         || variance_tzs, ',' order by attempt) from public.imprest_counts);
  end if;

  select string_agg(kind::text || ':' || amount_tzs || ':' || needs_director_decision, ',')
    into v from public.imprest_count_postings;
  if v is distinct from 'count_shortage:1000:true' then
    raise exception 'the confirmation should post one 1000 count shortage for a Director, found %', v;
  end if;

  if (select count(*) from public.imprest_count_flags where kind = 'count_shortage') <> 1 then
    raise exception 'the confirmation should raise one flag to the Directors';
  end if;

  -- 77,000 − 1,000 = 76,000 posted; set aside and awaiting verification unmoved.
  select s.posted_balance_tzs || '/' || s.set_aside_tzs || '/' || s.free_to_approve_tzs || '/'
         || private.imprest_awaiting_verification_tzs(f.id)
    into v
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active;
  if v is distinct from '76000/29000/47000/19000' then
    raise exception 'after the shortage posts the figures should read 76000/29000/47000/19000, found %', v;
  end if;
end
$$;

-- A count's figures and its posting never change, even by the tables' owner.
do $$
begin
  begin
    update public.imprest_counts set counted_tzs = 58000;
    raise exception 'a count was rewritten';
  exception when restrict_violation then
    null;
  end;
  begin
    update public.imprest_count_postings set amount_tzs = 1;
    raise exception 'a count posting was rewritten';
  exception when restrict_violation then
    null;
  end;
end
$$;

\echo 'migration-chain: the daily count migration upgraded a populated v0.6.0 database and works on it'
