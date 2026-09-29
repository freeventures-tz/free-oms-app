-- Issue #71 · Migration chain, step 54: what the reversal migration added to a populated v0.9.0
-- database, and proof that it works against one
--
-- The preservation query has already required every released row, file, report, Cron job, grant,
-- policy, constraint, trigger, function body, enum, column, view and index to be identical, apart
-- from the three functions and the posting constraint this release replaces, the unique constraint
-- it drops, and what it adds. This file checks the other half: what arrived, that every posting
-- already recorded reads as an original and the figures did not move, and that postings verified
-- before the upgrade are reversed and posted again, committed:
--
--   H  the 6,000 expense verified in step 53 (after a raise) -> corrected to 5,500
--   B  the 1,000 unexplained loss verified since v0.5.0      -> undone (correct amount 0)

-- ---------------------------------------------------------------------------
-- 1. The chain, the objects, and what was replaced
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 52
     or (select max(version) from supabase_migrations.schema_migrations) <> '20261003000100' then
    raise exception 'expected the 51 released migrations and the reversal one, found % ending at %',
      (select count(*) from supabase_migrations.schema_migrations),
      (select max(version) from supabase_migrations.schema_migrations);
  end if;

  -- The three released functions were replaced: none still has its v0.9.0 body.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p
   where md5(replace(p.prosrc, E'\r', '')) in ('28a6da0d625f9e8e131d941fe6c93a14',
                                                'c44efcaccafa870e5b9758152acbd116',
                                                '59d377ee65f8621a7002f70af91c873d');
  if v_bad is not null then
    raise exception 'released posting functions were not replaced: %', v_bad;
  end if;

  -- The released unique constraint is gone, a partial index keeps one original of each kind per
  -- verification, and the loss shape now lets a reversal wait for nothing.
  if exists (select 1 from pg_constraint
              where conrelid = 'public.imprest_postings'::regclass
                and conname = 'imprest_postings_verification_id_kind_key') then
    raise exception 'the released unique constraint on postings is still there';
  end if;
  if (select indexdef from pg_indexes where indexname = 'imprest_postings_original_idx')
     is distinct from 'CREATE UNIQUE INDEX imprest_postings_original_idx ON public.imprest_postings '
                      'USING btree (verification_id, kind) WHERE (entry = ''original''::imprest_posting_entry)' then
    raise exception 'one original of each kind per verification is no longer enforced';
  end if;
  if (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = 'public.imprest_postings'::regclass and conname = 'posting_loss_shape')
     not like '%entry <> ''reversal''%' then
    raise exception 'the loss shape was not replaced';
  end if;

  -- Nothing already recorded was corrected, and the request table holds nothing yet.
  if (select count(*) from public.imprest_posting_reversals) <> 0 then
    raise exception 'the migration wrote a reversal request into a database that had none';
  end if;
  if exists (select 1 from public.imprest_postings
              where entry <> 'original' or reversal_id is not null or corrects_posting_id is not null) then
    raise exception 'a posting recorded before the upgrade does not read as an original';
  end if;

  -- The table is written by the commands alone, and read by the readers of the disbursement.
  if has_table_privilege('authenticated', 'public.imprest_posting_reversals', 'insert')
     or has_table_privilege('authenticated', 'public.imprest_posting_reversals', 'update')
     or has_table_privilege('authenticated', 'public.imprest_posting_reversals', 'delete')
     or not has_table_privilege('authenticated', 'public.imprest_posting_reversals', 'select')
     or has_table_privilege('service_role', 'public.imprest_posting_reversals', 'select')
     or has_table_privilege('anon', 'public.imprest_posting_reversals', 'select')
     or has_table_privilege('fv_definer_owner', 'public.imprest_postings', 'update') then
    raise exception 'the reversal table or the postings have the wrong grants';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.imprest_posting_reversals'::regclass) then
    raise exception 'the reversal table has no row-level security';
  end if;

  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where ((n.nspname = 'api'
           and p.proname in ('staff_request_imprest_reversal', 'admin_decide_imprest_reversal'))
       or (n.nspname = 'private'
           and p.proname in ('check_imprest_verification_target', 'check_imprest_verification_complete',
                             'guard_imprest_posting_reversal', 'check_imprest_posting_reversal_target',
                             'check_imprest_posting_reversal_complete', 'imprest_spending_figures',
                             'imprest_reversal_result', 'imprest_reversal_audit',
                             'impl_staff_request_imprest_reversal', 'impl_admin_decide_imprest_reversal')))
     and (pg_get_userbyid(p.proowner) <> 'fv_definer_owner'
          or has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('service_role', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute') <> (n.nspname = 'api'));
  if v_bad is not null then
    raise exception 'reversal functions with the wrong owner or grants: %', v_bad;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. The figures did not move
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
  if v is distinct from '95000/70000/25000/45000/15000' then
    raise exception 'the upgrade moved the figures: expected 95000/70000/25000/45000/15000, found %', v;
  end if;
end
$$;

create table migration_chain.reversals (name text primary key, res jsonb not null);

create or replace function migration_chain.reverse(p_name text, p_res jsonb, p_reason text)
returns jsonb language plpgsql as $$
begin
  perform migration_chain.expect(p_res, p_reason, 'imprest reversal ' || p_name);
  insert into migration_chain.reversals values (p_name, p_res)
    on conflict (name) do update set res = excluded.res;
  return p_res;
end
$$;

create or replace function migration_chain.rvid(p_name text) returns uuid language sql stable as $$
  select (res -> 'reversal' ->> 'id')::uuid from migration_chain.reversals where name = p_name;
$$;

create or replace function migration_chain.original_posting(p_disbursement uuid, p_kind text)
returns uuid language sql stable as $$
  select id from public.imprest_postings
   where disbursement_id = p_disbursement and kind::text = p_kind and entry = 'original';
$$;

-- ---------------------------------------------------------------------------
-- 3. H's expense, verified before the upgrade: 6,000 corrected to 5,500
-- ---------------------------------------------------------------------------
begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000003');
select migration_chain.reverse('h.request', api.staff_request_imprest_reversal(
  migration_chain.original_posting(migration_chain.did('h'), 'expense'), 5500,
  'The stamp was 500 less than the receipt said', 'chain-rev-h-request'), 'requested');
-- B's loss, verified since v0.5.0: the Manager asks for it to be undone.
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000002');
select migration_chain.reverse('b.request', api.staff_request_imprest_reversal(
  migration_chain.original_posting(migration_chain.did('b'), 'unexplained_loss'), 0,
  'The 1,000 was found in the van', 'chain-rev-b-request'), 'requested');
commit;

begin;
select migration_chain.acting_as('c0000000-0000-0000-0000-000000000001');
select migration_chain.reverse('h.approve', api.admin_decide_imprest_reversal(
  migration_chain.rvid('h.request'), 1, true, null, 'chain-rev-h-approve'), 'approved');
select migration_chain.reverse('b.approve', api.admin_decide_imprest_reversal(
  migration_chain.rvid('b.request'), 1, true, null, 'chain-rev-b-approve'), 'approved');
-- Committed, so the deferred checks that each approval carries its postings really run.
commit;

do $$
declare
  v text;
begin
  select s.posted_funding_tzs || '/' || s.posted_balance_tzs || '/' || s.set_aside_tzs || '/'
         || s.free_to_approve_tzs || '/' || private.imprest_awaiting_verification_tzs(f.id)
    into v
    from public.imprest_funds f cross join lateral private.imprest_spending_figures(f.id) s
   where f.is_active;
  if v is distinct from '95000/71500/25000/46500/15000' then
    raise exception 'the corrections should raise the balance by 500 and 1,000 to '
                    '95000/71500/25000/46500/15000, found %', v;
  end if;

  if (select string_agg(entry::text || ':' || kind::text || ':' || amount_tzs, ',' order by entry, kind)
        from public.imprest_postings where disbursement_id = migration_chain.did('h'))
     is distinct from 'original:expense:6000,reversal:expense:6000,replacement:expense:5500' then
    raise exception 'H should read its 6,000 original, a 6,000 reversal and a 5,500 replacement';
  end if;
  if (select string_agg(entry::text || ':' || kind::text || ':' || amount_tzs, ',' order by entry, kind)
        from public.imprest_postings where disbursement_id = migration_chain.did('b'))
     is distinct from 'original:expense:17000,original:unexplained_loss:1000,reversal:unexplained_loss:1000' then
    raise exception 'B should read its two originals and the reversal of its loss, with no replacement';
  end if;

  -- Both requests name the Director who approved them, for good.
  if (select string_agg(status::text || ':' || decided_by::text, ',' order by requested_at)
        from public.imprest_posting_reversals)
     is distinct from 'approved:c0000000-0000-0000-0000-000000000001,'
                      'approved:c0000000-0000-0000-0000-000000000001' then
    raise exception 'both requests should be approved by the Chain Director';
  end if;

  if (select count(*) from public.audit_events
       where action in ('imprest_reversal_requested', 'imprest_reversal_approved')
         and entity_type = 'imprest_posting_reversal') <> 4 then
    raise exception 'the audit trail should hold four reversal events';
  end if;
end
$$;

-- A posting is still never changed, even by the table's owner, and a request keeps what was asked.
do $$
begin
  begin
    update public.imprest_postings set amount_tzs = 1;
    raise exception 'a posting was rewritten';
  exception when restrict_violation then
    null;
  end;
  begin
    update public.imprest_posting_reversals set reason = 'Rewritten';
    raise exception 'a reversal request was rewritten';
  exception when restrict_violation then
    null;
  end;
end
$$;

\echo 'migration-chain: the reversal migration upgraded a populated v0.9.0 database and works on it'
