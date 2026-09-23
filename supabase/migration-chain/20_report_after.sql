-- What issue #19 is allowed to have changed, and the shape it had to leave behind.
--
-- Run only after the migration, because every column named here is one it adds. The Owner approved
-- the relational key change on 30 August 2026 and nothing else, so this file checks the key and the
-- backfill — and `18_report_capture.sql` checks that everything outside the approval is untouched.
do $$
declare
  v_ordinal    integer;
  v_default    text;
  v_new_key    integer;
  v_old_key    integer;
  v_snapshots  integer;
begin
  select count(*) into v_snapshots from public.report_snapshots;

  -- BACKFILLED TO 1, and by the catalogue rather than by an UPDATE. Issue #18 had exactly one
  -- attempt, so every row that can predate this migration belongs to it.
  select count(*) into v_ordinal
    from public.report_snapshots where attempt_ordinal = 1;

  if v_ordinal <> v_snapshots then
    raise exception 'only % of % snapshots backfilled to attempt 1', v_ordinal, v_snapshots;
  end if;

  -- THE DEFAULT IS GONE. It was a migration device. Left in place it would quietly label a third
  -- attempt's snapshot as the first one's, and the unique key below would stop doing its job.
  select column_default into v_default
    from information_schema.columns
   where table_schema = 'public' and table_name = 'report_snapshots'
     and column_name = 'attempt_ordinal';

  if v_default is not null then
    raise exception 'attempt_ordinal still defaults to "%", so an insert need not state it', v_default;
  end if;

  -- A new insert must therefore name its attempt. Asserted from the catalogue, so the empty
  -- scenario proves it too, and then exercised for real wherever there is a run to hang it on.
  if (select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'report_snapshots'
         and column_name = 'attempt_ordinal') <> 'NO' then
    raise exception 'attempt_ordinal is nullable, so a snapshot need not say which attempt wrote it';
  end if;

  if exists (select 1 from public.report_runs) then
    begin
      insert into public.report_snapshots (run_id, business_date, schema_version, content)
      select id, business_date, 1, '{}'::jsonb from public.report_runs limit 1;
      raise exception 'a snapshot was accepted without an attempt ordinal'
        using errcode = 'assert_failure';
    exception
      when not_null_violation then null;
    end;
  end if;

  select count(*) into v_new_key
    from pg_constraint
   where conrelid = 'public.report_snapshots'::regclass
     and conname = 'report_snapshots_run_attempt_key';

  select count(*) into v_old_key
    from pg_constraint
   where conrelid = 'public.report_snapshots'::regclass
     and conname = 'report_snapshots_run_id_key';

  if v_new_key <> 1 then
    raise exception 'the (run_id, attempt_ordinal) key is missing';
  end if;

  if v_old_key <> 0 then
    raise exception 'the old run_id-only key is still there, so a stalled attempt still blocks its replacement';
  end if;

  raise notice 'issue #19 shape: attempt_ordinal backfilled to 1, no default, keyed on (run, attempt)';
end $$;
