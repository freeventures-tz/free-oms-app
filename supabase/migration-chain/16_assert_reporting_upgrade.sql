-- Issue #51 · Migration chain, step 16: what the reporting release added to a populated v0.1.0
-- database, and proof that it runs against one
--
-- The preservation query has already required every released row, grant, policy, constraint,
-- trigger and function body to be identical. This file checks the other half: what arrived, that
-- nothing old came back with it, and that the report really executes against the data this fixture
-- built. A function that merely CREATES is not evidence; one that returns the fixture's own figures
-- is.
--
-- NOT IN A TRANSACTION BLOCK, deliberately. The scheduled entry point is a procedure that commits
-- its claim before generating, and a CALL inside `begin` could not. Each statement below is its own
-- simple query, exactly as a Cron command is.

-- ---------------------------------------------------------------------------
-- 1. The chain, the objects, and the schedule
-- ---------------------------------------------------------------------------
do $$
declare
  v_jobs  integer;
  v_bad   text;
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 41 then
    raise exception 'expected the 39 released migrations and the two reporting ones, found %',
      (select count(*) from supabase_migrations.schema_migrations);
  end if;

  if (select max(version) from supabase_migrations.schema_migrations) <> '20260923000200' then
    raise exception 'the chain does not end at the retry migration';
  end if;

  -- No unshipped imprest object arrived with the report.
  if to_regclass('public.imprest_reconciliations') is not null
     or to_regclass('public.imprest_expenses') is not null
     or to_regclass('public.imprest_position') is not null then
    raise exception 'an unreleased imprest object exists after the reporting upgrade';
  end if;

  -- The success-only generator is gone; only the retrying entry point remains.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'private' and p.proname = 'generate_scheduled_report') then
    raise exception 'private.generate_scheduled_report still exists, so a success-only path could be scheduled';
  end if;

  select count(*) into v_jobs from cron.job where jobname like 'fv-daily-pilot-report%';
  if v_jobs <> 4 then
    raise exception 'expected four report jobs, found %', v_jobs;
  end if;

  select string_agg(jobname || '=' || schedule || ' ' || command, '; ' order by jobname) into v_bad
    from cron.job
   where jobname like 'fv-daily-pilot-report%'
     and (jobname, schedule, command) not in (
           ('fv-daily-pilot-report',         '1 21 * * *',  'call private.run_scheduled_report(1);'),
           ('fv-daily-pilot-report-retry-1', '5 21 * * *',  'call private.run_scheduled_report(2);'),
           ('fv-daily-pilot-report-retry-2', '15 21 * * *', 'call private.run_scheduled_report(3);'),
           ('fv-daily-pilot-report-retry-3', '30 21 * * *', 'call private.run_scheduled_report(4);'));
  if v_bad is not null then
    raise exception 'a report job is not one of the four approved definitions: %', v_bad;
  end if;

  -- Every new public table has RLS, and every new exposed view is security_invoker.
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'report\_%'
     and not c.relrowsecurity;
  if v_bad is not null then
    raise exception 'report tables without row-level security: %', v_bad;
  end if;

  select string_agg(c.relname, ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v'
     and c.relname in ('daily_reports', 'report_failure_alerts')
     and not coalesce(c.reloptions @> array['security_invoker=true'], false);
  if v_bad is not null then
    raise exception 'report views that are not security_invoker: %', v_bad;
  end if;

  -- Application roles read and never write; the secret key reaches nothing.
  select string_agg(g.grantee || ' ' || g.privilege_type || ' ' || g.table_name, ', ') into v_bad
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.table_name ~ '^(report_|daily_reports$)'
     and ((g.grantee = 'authenticated' and g.privilege_type <> 'SELECT')
          or g.grantee in ('anon', 'service_role'));
  if v_bad is not null then
    raise exception 'an application role holds more than SELECT on reporting data: %', v_bad;
  end if;

  if has_function_privilege('authenticated', 'private.run_scheduled_report(integer, jsonb)', 'execute')
     or has_function_privilege('service_role', 'private.run_scheduled_report(integer, jsonb)', 'execute')
     or has_function_privilege('anon', 'private.run_scheduled_report(integer, jsonb)', 'execute') then
    raise exception 'a Data API role can invoke the report writer';
  end if;

  raise notice 'reporting upgrade: 41 migrations, 4 jobs, RLS and grants as approved, no unshipped imprest object';
end
$$;

-- ---------------------------------------------------------------------------
-- 2. The content executes against the populated database, every section of it
--
-- The fixture's records were written today, so today is the date asked about. The scheduled entry
-- point cannot be aimed at today (it reports yesterday, by design), so the reader it calls is
-- asked directly, as the pgTAP suite does.
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb := private.report_content(private.business_date()) -> 'sections';
  v_missing text;
begin
  select string_agg(k, ', ') into v_missing
    from unnest(array['sales', 'invoices', 'payments_by_method', 'outstanding_credit',
                      'discounts_and_approvals', 'paid_but_unreleased', 'released_stock',
                      'inventory_variances', 'supplier_shortages', 'production_batches',
                      'production_output', 'cashier_reconciliation', 'pending_approvals',
                      'imprest']) k
   where v -> k is null or v -> k = 'null'::jsonb;
  if v_missing is not null then
    raise exception 'sections missing from the populated report: %', v_missing;
  end if;

  -- Figures the fixture really produced. RLS applies to the definer owner, so a policy that hid a
  -- table from it would show here as a zero rather than as an error.
  if (v -> 'sales' ->> 'orders_created')::int < 1 then
    raise exception 'the report sees no order, though the fixture created several: %', v -> 'sales';
  end if;
  if (v -> 'invoices' ->> 'issued_count')::int < 1 then
    raise exception 'the report sees no invoice: %', v -> 'invoices';
  end if;
  if (v -> 'payments_by_method' ->> 'count')::int < 1 then
    raise exception 'the report sees no payment: %', v -> 'payments_by_method';
  end if;
  if (v -> 'supplier_shortages' ->> 'receipt_count')::int < 1 then
    raise exception 'the report sees no supplier receipt: %', v -> 'supplier_shortages';
  end if;
  if (v -> 'production_batches' ->> 'entered')::int < 1 then
    raise exception 'the report sees no production batch: %', v -> 'production_batches';
  end if;

  -- The approved funding presentation, on the fixture's own history.
  if v -> 'imprest' ->> 'state' <> 'active'
     or (v -> 'imprest' ->> 'fund_id')::uuid is distinct from
        (select id from public.imprest_funds where is_active)
     or (v -> 'imprest' -> 'fund_no') <> 'null'::jsonb then
    raise exception 'the imprest fund is not reported by its real identity: %', v -> 'imprest';
  end if;
  if (v -> 'imprest' -> 'funding' ->> 'requested_count')::int <> 4
     or (v -> 'imprest' -> 'funding' ->> 'requested_tzs')::bigint <> 200000 then
    raise exception 'requests are not the four made: %', v -> 'imprest' -> 'funding';
  end if;
  if (v -> 'imprest' -> 'funding' ->> 'received_tzs')::bigint <> 95000 then
    raise exception 'received is not the two confirmed receipts: %', v -> 'imprest' -> 'funding';
  end if;
  if (v -> 'imprest' -> 'funding' -> 'approved_tzs') <> 'null'::jsonb
     or (v -> 'imprest' -> 'funding' -> 'provided_tzs') <> 'null'::jsonb
     or (v -> 'imprest' -> 'approved_expenses') <> 'null'::jsonb
     or (v -> 'imprest' -> 'position') <> 'null'::jsonb then
    raise exception 'a withheld imprest figure was given a value: %', v -> 'imprest';
  end if;
  if v -> 'imprest' -> 'reconciliation' ->> 'state' <> 'not_counted'
     or (v -> 'imprest' -> 'reconciliation' -> 'counted_tzs') <> 'null'::jsonb then
    raise exception 'the imprest count is not NOT COUNTED: %', v -> 'imprest' -> 'reconciliation';
  end if;

  raise notice 'report content executes on the populated database; imprest requested 200,000, received 95,000';
end
$$;

-- ---------------------------------------------------------------------------
-- 3. The real entry point, on the populated database
-- ---------------------------------------------------------------------------
call private.run_scheduled_report(1);
call private.run_scheduled_report(1);

do $$
declare
  v_expected integer;
begin
  select count(*) into v_expected
    from public.profiles p join public.user_roles r on r.user_id = p.id
   where p.is_active and r.role in ('director', 'manager');

  if (select count(*) from public.report_runs where status = 'succeeded') <> 1
     or (select count(*) from public.report_snapshots) <> 1 then
    raise exception 'two calls of slot 1 should leave exactly one succeeded run and one snapshot';
  end if;
  if (select count(*) from public.report_deliveries) <> v_expected or v_expected < 2 then
    raise exception 'deliveries % do not match the % active Directors and Managers',
      (select count(*) from public.report_deliveries), v_expected;
  end if;
  if not (select integrity_ok from public.daily_reports) then
    raise exception 'the report generated on the populated database fails its own integrity check';
  end if;

  raise notice 'the real procedure wrote one report with % deliveries; the replayed slot wrote nothing', v_expected;
end
$$;
