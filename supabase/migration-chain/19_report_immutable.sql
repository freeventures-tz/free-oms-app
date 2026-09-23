-- A snapshot refuses to be changed or removed — asserted on BOTH sides of the migration.
--
-- Run before issue #19 to establish that the guarantee was there, and again afterwards to establish
-- that it survived. The second run is the one that matters: the backfill this migration performs
-- exists precisely because a snapshot may not be updated, and the tempting ways to get around that
-- — disabling the trigger, setting `session_replication_role = replica`, dropping and re-creating
-- it — all leave a database where the refusal is weaker than it was. This file would still pass if
-- the trigger had merely been re-created, so it checks the trigger is enabled as well as effective.
do $$
declare
  v_enabled char;
begin
  begin
    update public.report_snapshots set business_date = date '2020-01-01';
    raise exception 'a snapshot accepted an UPDATE, so immutability is gone'
      using errcode = 'assert_failure';
  exception
    when sqlstate '23001' then null;   -- refused, which is the point
  end;

  begin
    delete from public.report_snapshots;
    raise exception 'a snapshot accepted a DELETE, so immutability is gone'
      using errcode = 'assert_failure';
  exception
    when sqlstate '23001' then null;
  end;

  select tgenabled into v_enabled
    from pg_trigger where tgname = 'report_snapshots_immutable';

  if v_enabled is null then
    raise exception 'report_snapshots_immutable does not exist';
  end if;

  -- 'O' is origin, the ordinary enabled state. 'D' is disabled, and would mean a migration turned
  -- the guarantee off and left it off.
  if v_enabled <> 'O' then
    raise exception 'report_snapshots_immutable is in state "%", not enabled', v_enabled;
  end if;

  raise notice 'snapshot immutability: UPDATE refused, DELETE refused, trigger enabled';
end $$;
