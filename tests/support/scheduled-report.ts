import { runSql } from "@/tests/support/database";

/**
 * Firing a scheduled slot on demand, from a test — and taking the report read away again.
 *
 * THERE IS NO OTHER WAY IN, and that is the feature working. `private.run_scheduled_report()` takes
 * its slot ordinal and nothing else, lives in a schema the Data API does not expose, and is granted
 * to no Data API role, so a test cannot reach it over HTTP any more than an attacker could. What a
 * test CAN do is what Supabase Cron does: run it as the database role that owns the jobs.
 * `tests/support/database.ts` explains why that position is the honest one to test from.
 *
 * IT IS A PROCEDURE AND IT IS CALLED, NOT SELECTED, because it commits its claim before generating
 * anything. Each call therefore has to be its own simple query — one `psql -c`, one statement — for
 * the same reason each Cron command is a single `CALL`: several statements in one query become an
 * implicit transaction block, and transaction control is illegal inside one.
 */

export type ScheduledReportResult = {
  ok: boolean;
  created?: boolean;
  reason?: string;
  attempt?: number;
  business_date?: string;
  run_id?: string;
  snapshot_id?: string;
  content_sha256?: string;
  recipient_count?: number;
  status?: "claimed" | "succeeded" | "failed" | "terminally_failed" | "not_owner";
  terminal?: boolean;
  alert_id?: string | null;
  diagnostic?: string;
};

/**
 * Runs one scheduled slot and returns what the function returned.
 *
 * The ordinal is the slot, 1 through 4 — 00:01, 00:05, 00:15 and 00:30 Africa/Dar_es_Salaam. It
 * defaults to the first, because most callers only want the report that the night would normally
 * have produced.
 *
 * Calling it twice with the same ordinal is deliberate in some tests: the second call must do
 * nothing, which is the duplicate-invocation rule of product.md §18.2 seen from outside the
 * database.
 */
export function runScheduledReport(attempt = 1): ScheduledReportResult {
  return JSON.parse(
    runSql(`call private.run_scheduled_report(${Number(attempt)});`),
  ) as ScheduledReportResult;
}

/**
 * Runs one slot with the generator genuinely unable to write, so the attempt really fails.
 *
 * NO FAULT SWITCH IN THE APPLICATION. Taking `insert` on `public.report_snapshots` away from the
 * definer owner breaks the generator where it really breaks — between the function and the table —
 * and is deterministic: the attempt fails every time until the grant comes back. A flag inside the
 * function would be a production back door kept alive by a test.
 *
 * The grant is restored in a `finally`, because a run that failed with it still revoked would leave
 * every later report test failing for a reason that has nothing to do with what it was testing.
 */
export function failScheduledReport(attempt: number): ScheduledReportResult {
  runSql("revoke insert on public.report_snapshots from fv_definer_owner;");
  try {
    return runScheduledReport(attempt);
  } finally {
    runSql("grant insert on public.report_snapshots to fv_definer_owner;");
  }
}

/**
 * Drives every slot of the night to failure, so the day ends terminal with its one alert.
 *
 * The four calls are the four the scheduler makes, in the order it makes them, and the terminal
 * state and the alert are produced by the database's own rules rather than written here.
 */
export function failEveryScheduledAttempt(): ScheduledReportResult {
  runSql("revoke insert on public.report_snapshots from fv_definer_owner;");
  try {
    let last = runScheduledReport(1);
    for (const attempt of [2, 3, 4]) last = runScheduledReport(attempt);
    return last;
  } finally {
    runSql("grant insert on public.report_snapshots to fv_definer_owner;");
  }
}

/** psql prints a command tag beside a returned row; the value is the first line, not the lot. */
function firstLine(output: string): string {
  return output.split("\n")[0]?.replace("\r", "").trim() ?? "";
}

/**
 * A terminally failed night for a business date OTHER than the one the scheduler is on.
 *
 * WHY IT IS SEEDED RATHER THAN DRIVEN. Every slot derives the same business date — yesterday — and
 * a business date cannot be both reported and terminally failed. A suite that needs an archive with
 * reports in it AND an unresolved failure therefore needs a second date, and no scheduled entry
 * point can be aimed at one. That is the feature working, so the run row is written from the
 * operator's own psql prompt instead.
 *
 * THE ALERT ITSELF IS STILL THE DATABASE'S. `private.raise_report_failure_alert` is called, not
 * imitated, so the deduplication, the priority and the audit row are all the real ones. What is
 * being tested by the callers of this helper is the screen and the role boundary; the path TO
 * terminal is proved in `017_scheduled_report_retries.sql`, where it is driven for real.
 */
export function seedTerminalReportFailure(businessDate: string): {
  runId: string;
  alertId: string;
} {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    throw new Error(`a business date is YYYY-MM-DD, not ${businessDate}`);
  }

  // `psql` prints the command tag as well as the returned row, so the row is the FIRST line rather
  // than the whole answer. Taking the whole answer produced a uuid with `INSERT 0 1` glued to it.
  // The TOKEN comes back with the id because raising the alert requires it: the alert is guarded by
  // the claim token exactly as the success and the failure are, so a seeded run has to hand over
  // the token it was written with rather than being taken on trust.
  const [runId, claimToken] = firstLine(runSql(`
    insert into public.report_runs (
        schedule_id, business_date, attempt_ordinal, status,
        claim_token, claimed_at, lease_expires_at, completed_at,
        failure_diagnostic, correlation_id)
    select s.id, date '${businessDate}',
           s.final_attempt_ordinal, 'terminally_failed',
           gen_random_uuid(), now(), now(), now(),
           '42501: permission denied for table report_snapshots', gen_random_uuid()
      from public.report_schedules s
     where s.code = 'daily_pilot_report'
    returning id, claim_token;`)).split("|");

  if (!runId || !claimToken) throw new Error("the seeded run returned no id and token");

  const alertId = firstLine(
    runSql(`select private.raise_report_failure_alert('${runId}'::uuid, '${claimToken}'::uuid);`),
  );
  if (!alertId) throw new Error(`no alert was raised for the seeded run ${runId}`);

  return { runId, alertId };
}

/**
 * Puts a business date back to never-attempted, so a test that needs the night for itself has it.
 *
 * THE IMMUTABILITY TRIGGER IS TURNED OFF FOR THE DELETE AND NOTHING ELSE. `report_snapshots`
 * refuses `delete` to everybody including its own definer owner, which is the guarantee issue #18
 * built and which must stay true — so this does not weaken it, it steps outside it for one
 * statement from the operator's own session. `session_replication_role` is per-session and this
 * session is a fresh `psql` that exits immediately, so there is no way for it to leak.
 */
export function resetScheduledReportDay(businessDate: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    throw new Error(`a business date is YYYY-MM-DD, not ${businessDate}`);
  }

  runSql(`
    set session_replication_role = replica;
    delete from public.report_deliveries d
      using public.report_snapshots s
     where s.id = d.snapshot_id and s.business_date = date '${businessDate}';
    delete from public.report_snapshots where business_date = date '${businessDate}';
    delete from public.report_alerts    where business_date = date '${businessDate}';
    delete from public.report_runs      where business_date = date '${businessDate}';
    set session_replication_role = default;`);
}

/**
 * The advisory-lock key the snapshot stall waits on. Arbitrary, and shared by the trigger below and
 * the session that holds it.
 */
export const SNAPSHOT_STALL_LOCK = 919_191;

/**
 * Stops one attempt dead AFTER it has written its snapshot — the contested phase — and nowhere else.
 *
 * WHY THIS EXISTS AT ALL. The property under test is that a worker which has run over its lease
 * cannot keep a later slot waiting. The dangerous moment is not while the report is being built,
 * which touches nothing; it is the instant AFTER the snapshot row exists, when the worker holds
 * `report_snapshots_run_attempt_key` and a `KEY SHARE` lock on the run row through the foreign key.
 * That state lasts milliseconds in production and cannot be hit by timing a test.
 *
 * WHY IT IS AN `after insert` TRIGGER AND NOT `before`. A `before` trigger fires while the row is
 * still nothing: no heap tuple, no index entry, no foreign-key lock. Stalling there would prove the
 * uncontested case and call it the contested one. Measured on this schema, a worker stalled by the
 * trigger below holds `RowShareLock` on `public.report_runs`, and a competing insert for the same
 * `(run_id, attempt_ordinal)` blocks with `while inserting index tuple in relation
 * "report_snapshots_run_attempt_key"`.
 *
 * WHY IT IS NOT A FAULT SWITCH. It is created by a test and dropped by the same test, in its own
 * schema, and nothing in `supabase/migrations/` knows it exists. The production path has no flag,
 * no hook and no branch that a test can reach — which is the same rule `failScheduledReport`
 * follows when it revokes a real grant instead of asking the generator to pretend.
 *
 * IT STALLS ONE ORDINAL. The slot sent to reclaim the run must be able to write its own snapshot,
 * so the trigger has to let it past — which is only possible because a snapshot is keyed on the
 * attempt now, and is itself part of what is being proved.
 */
export function installSnapshotStall(attempt: number): void {
  runSql(`
    create schema if not exists test_instrumentation;

    create or replace function test_instrumentation.stall_after_snapshot()
    returns trigger language plpgsql as $stall$
    begin
      if new.attempt_ordinal = ${Number(attempt)} then
        -- Transaction-scoped, so it cannot outlive the worker even if the worker is killed.
        perform pg_advisory_xact_lock(${SNAPSHOT_STALL_LOCK});
      end if;
      return null;
    end $stall$;

    create trigger zz_test_stall_after_snapshot
      after insert on public.report_snapshots
      for each row execute function test_instrumentation.stall_after_snapshot();`);
}

export function removeSnapshotStall(): void {
  runSql(`
    drop trigger if exists zz_test_stall_after_snapshot on public.report_snapshots;
    drop schema if exists test_instrumentation cascade;`);
}

/** The advisory-lock key the generated-audit stall waits on. Separate, so the two can coexist. */
export const GENERATED_AUDIT_STALL_LOCK = 828_282;

/**
 * Stops one attempt on its `scheduled_report_generated` audit insert — the LAST place it could
 * still be holding the run row.
 *
 * A DIFFERENT LOCK WINDOW FROM `installSnapshotStall`, and the reason both exist. That one catches
 * a worker holding the snapshot's index entry and the run's foreign-key lock. This one catches the
 * window that opened after those were fixed: `complete_report_run` takes a `NO KEY UPDATE` lock on
 * the run row and holds it to commit, so with the audit written AFTER the completion, a worker
 * stuck on that single insert sat on the run row and the next slot's claim skipped it. The audit is
 * now written BEFORE completion, and completion is the last statement there is.
 *
 * IT KEYS ON THE ORDINAL IN `after_state`, not on the run, so the slot sent to replace the stalled
 * worker writes its own audit event unhindered. Keying on anything coarser would stall both and
 * prove nothing.
 *
 * Created and dropped by the test, in its own schema. Nothing in `supabase/migrations/` knows it
 * exists, and the production path has no flag a test can reach.
 */
export function installGeneratedAuditStall(attempt: number): void {
  runSql(`
    create schema if not exists test_instrumentation;

    create or replace function test_instrumentation.stall_on_generated_audit()
    returns trigger language plpgsql as $stall$
    begin
      if new.action = 'scheduled_report_generated'
         and (new.after_state ->> 'attempt_ordinal')::int = ${Number(attempt)} then
        perform pg_advisory_xact_lock(${GENERATED_AUDIT_STALL_LOCK});
      end if;
      return null;
    end $stall$;

    create trigger zz_test_stall_on_generated_audit
      after insert on public.audit_events
      for each row execute function test_instrumentation.stall_on_generated_audit();`);
}

export function removeGeneratedAuditStall(): void {
  runSql(`
    drop trigger if exists zz_test_stall_on_generated_audit on public.audit_events;
    drop schema if exists test_instrumentation cascade;`);
}

/** The advisory-lock key the failure-audit stall waits on. Separate again, so all three coexist. */
export const FAILURE_AUDIT_STALL_LOCK = 737_373;

/**
 * Makes one attempt fail for real, then stops it on the failure audit it writes about itself.
 *
 * THE FOURTH WINDOW, and the only one on the FAILURE path. The three stalls above all catch a
 * worker on its way to a report. This one catches the worker that is never going to produce one:
 * recording a failure means writing an audit event, possibly an alert, and the run's own status,
 * and whichever of those comes first is what the next slot has to get past.
 *
 * TWO TRIGGERS, BECAUSE A FAILURE AUDIT CANNOT BE STALLED ON AN ATTEMPT THAT SUCCEEDED. They are
 * one instrument and are installed and removed together:
 *
 *   · A `before insert` trigger on `report_snapshots` that raises for this ordinal alone, so the
 *     attempt fails where a generation really fails — between the function and the table. It
 *     cannot be `failScheduledReport`'s revoked grant, which would fail the reclaiming slot too.
 *   · An `after insert` trigger on `audit_events` that waits on an advisory lock this test holds,
 *     keyed on `scheduled_report_attempt_failed` AND the ordinal, so the reclaiming slot writes
 *     its own audit events unhindered.
 *
 * Created and dropped by the test, in its own schema. Nothing in `supabase/migrations/` knows it
 * exists, and the production path has no flag a test can reach.
 */
export function installFailureAuditStall(attempt: number): void {
  runSql(`
    create schema if not exists test_instrumentation;

    create or replace function test_instrumentation.refuse_snapshot()
    returns trigger language plpgsql as $refuse$
    begin
      if new.attempt_ordinal = ${Number(attempt)} then
        raise exception 'the test refuses attempt % its snapshot', new.attempt_ordinal;
      end if;
      return new;
    end $refuse$;

    create trigger zz_test_refuse_snapshot
      before insert on public.report_snapshots
      for each row execute function test_instrumentation.refuse_snapshot();

    create or replace function test_instrumentation.stall_on_failure_audit()
    returns trigger language plpgsql as $stall$
    begin
      if new.action = 'scheduled_report_attempt_failed'
         and (new.after_state ->> 'attempt_ordinal')::int = ${Number(attempt)} then
        perform pg_advisory_xact_lock(${FAILURE_AUDIT_STALL_LOCK});
      end if;
      return null;
    end $stall$;

    create trigger zz_test_stall_on_failure_audit
      after insert on public.audit_events
      for each row execute function test_instrumentation.stall_on_failure_audit();`);
}

export function removeFailureAuditStall(): void {
  runSql(`
    drop trigger if exists zz_test_refuse_snapshot on public.report_snapshots;
    drop trigger if exists zz_test_stall_on_failure_audit on public.audit_events;
    drop schema if exists test_instrumentation cascade;`);
}

/**
 * Shortens the lease so a test can watch one expire, and puts it back.
 *
 * NOT A FAULT SWITCH. `lease_duration` is a column on the schedule row precisely so that "this
 * worker has stopped" is a stated bound rather than a constant buried in a function — the
 * production value is three minutes, and a test that had to wait three real minutes to see a lease
 * expire would not be run. The expiry itself is still the database's own, by the passage of real
 * time against a real claim, which is the difference between this and writing an expired row.
 */
export function setReportLease(duration: string): void {
  runSql(
    `update public.report_schedules set lease_duration = interval '${duration}' ` +
    `where code = 'daily_pilot_report';`,
  );
}

/** Removes a seeded failure and its alert, so one file's fixture is not another file's surprise. */
export function clearTerminalReportFailure(businessDate: string): void {
  runSql(
    `delete from public.report_alerts where business_date = date '${businessDate}';` +
    `delete from public.report_runs   where business_date = date '${businessDate}';`,
  );
}

/**
 * Takes the report read away from every signed-in session, and gives it back.
 *
 * ONE GRANT, NOT THE WHOLE DATABASE. `public.daily_reports` is the first read the archive and the
 * report screen both make, so revoking it fails exactly the read under test and leaves sign-in, the
 * navigation and every other screen working — which is what makes the resulting page a FAILED READ
 * rather than a broken session.
 *
 * The browser suite runs with one worker and no parallelism (`playwright.config.ts`), so no other
 * test is mid-read while the grant is away. Restoring it belongs in a `finally`: a run that failed
 * with the grant still revoked would leave every later report test failing for a reason that has
 * nothing to do with what it was testing.
 */
export function revokeReportRead(): void {
  runSql("revoke select on public.daily_reports from authenticated;");
}

export function restoreReportRead(): void {
  runSql("grant select on public.daily_reports to authenticated;");
}

/**
 * The same, for the alert read.
 *
 * A SEPARATE GRANT ON PURPOSE. The alerts and the archive are two reads on one page, and issue #19
 * asks that a failed ALERT read is a page-level failure rather than an empty alert region above a
 * perfectly good list of reports. Breaking only this one is what proves that, and it could not be
 * proved by breaking both.
 */
export function revokeReportAlertRead(): void {
  runSql("revoke select on public.report_failure_alerts from authenticated;");
}

export function restoreReportAlertRead(): void {
  runSql("grant select on public.report_failure_alerts to authenticated;");
}
