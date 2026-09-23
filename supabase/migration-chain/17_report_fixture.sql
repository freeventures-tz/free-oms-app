-- A DATA-BEARING ISSUE #18 DATABASE: a real report, written by the real generator.
--
-- Issue #51: runs against a database reset to `20260923000100_scheduled_report`, the integrated
-- success migration, which is the state a hosted apply passes through between the two reporting
-- files. It first asserts that NO Cron job exists there, because the release unit must never run a
-- success-only scheduler, even for that moment.
--
-- Every earlier fixture in this harness proved a migration against a catalogue. This one proves it
-- against a REPORT, and it exists because the empty local database hid a failure that a hosted
-- database would have hit on its first night: issue #19's backfill was an `UPDATE`, and issue #18
-- protects a snapshot with a BEFORE UPDATE trigger that refuses everybody. A migration cannot be
-- called safe for existing reports until it has met one.
--
-- THE REPORT IS GENERATED, NOT WRITTEN BY HAND. `private.generate_scheduled_report()` is issue
-- #18's own entry point, so the content, the digest stamped by its trigger and the delivery rows
-- are the ones production would hold. A fixture that inserted its own snapshot would prove the
-- migration preserves something the application never produced.
--
-- A RECIPIENT EXISTS FIRST, so the run has deliveries to preserve. §18.1 delivers to active
-- Directors and the Manager present at generation, and a report with no recipients would leave the
-- delivery half of this proof asserting nothing.

do $$
begin
  if to_regclass('public.report_runs') is null then
    raise exception 'the database is not at the integrated success migration: report_runs is missing';
  end if;
  if to_regclass('public.report_alerts') is not null then
    raise exception 'the database is already past the success migration: report_alerts exists';
  end if;
  -- pg_cron arrives with the retry migration. If it is here, something could already be
  -- scheduled against the success-only generator.
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron is installed at the success migration, so a success-only job could be registered';
  end if;
end
$$;

-- The account is created the way `supabase/tests/database/` creates one: `profiles` references
-- `auth.users`, so the Auth row has to exist before the profile does.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        created_at, updated_at)
values ('c9000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'chain-director@test.local',
        extensions.crypt('x', extensions.gen_salt('bf')), now(), now());

insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password)
values ('c9000000-0000-0000-0000-000000000001', 'Chain Director', '+255700000901', true, false);

insert into public.user_roles (user_id, role)
values ('c9000000-0000-0000-0000-000000000001', 'director');

-- The real 00:01 job, run as Supabase Cron runs it.
select private.generate_scheduled_report();

do $$
declare
  v_snapshots  integer;
  v_deliveries integer;
begin
  select count(*) into v_snapshots  from public.report_snapshots;
  select count(*) into v_deliveries from public.report_deliveries;

  if v_snapshots <> 1 then
    raise exception 'the fixture should hold exactly one issue #18 snapshot, and holds %', v_snapshots;
  end if;

  -- Without this the delivery comparison either side of the migration compares nothing to nothing.
  if v_deliveries < 1 then
    raise exception 'the fixture should hold at least one delivery, and holds %', v_deliveries;
  end if;

  raise notice 'issue #18 fixture: % snapshot, % delivery row(s)', v_snapshots, v_deliveries;
end $$;
