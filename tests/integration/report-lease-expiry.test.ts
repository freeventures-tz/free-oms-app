import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runSql } from "@/tests/support/database";
import { openPsqlSession, settledWithin, type PsqlSession } from "@/tests/support/psql-session";
import {
  failScheduledReport,
  installSnapshotStall,
  removeSnapshotStall,
  resetScheduledReportDay,
  runScheduledReport,
  setReportLease,
  SNAPSHOT_STALL_LOCK,
  type ScheduledReportResult,
} from "@/tests/support/scheduled-report";

/**
 * A worker that RUNS PAST ITS LEASE is not the same as a worker that has been REPLACED, and the
 * night's retry and alert rules must tell them apart.
 *
 * THE DEFECT THIS EXISTS FOR (review F2 at `bf49437`). `private.complete_report_run` refuses a
 * stale token and an expired lease alike, and every refusal was answered `lease_lost` and recorded
 * nothing. That is right for a worker somebody else has taken the run from. It is wrong for a
 * worker nobody has: the last attempt, which has no later slot to replace it, finished its work
 * after its lease and left the run `claimed` at ordinal 4 — no completion, no diagnostic, no alert,
 * and a replay refused as `attempt_already_used`. The night was lost silently.
 *
 * NOTHING HERE IS CANCELLED. Every worker runs with `statement_timeout = 0`, so the only thing that
 * refuses its completion is the lease. The lease is shortened on the schedule row and then expires
 * by itself against real time; nothing writes `lease_expires_at` or a token. The worker is held
 * past its lease by an advisory lock this test owns, through a trigger this test creates and drops
 * — nothing in `supabase/migrations/` knows it exists.
 *
 * WHY INTEGRATION AND NOT pgTAP: the entry point commits between the claim and the work, and the
 * questions are about what a second session sees and does while the first is held.
 */

const LEASE_SECONDS = 2;
const LEASE_DIAGNOSTIC = /^ZR001: the attempt ran past its lease; its report was discarded$/;

function businessDate(): string {
  return runSql("select (private.business_date() - 1)::text;").trim();
}

function runRow(date: string): {
  status: string;
  attempt_ordinal: string;
  claim_token: string;
  completed: string;
  diagnostic: string;
  expired: string;
} {
  const [status, attempt_ordinal, claim_token, completed, diagnostic, expired] = runSql(`
    select status, attempt_ordinal, claim_token, (completed_at is not null),
           coalesce(failure_diagnostic, ''), (lease_expires_at <= clock_timestamp())
      from public.report_runs where business_date = date '${date}';`)
    .trim()
    .split("|");

  return {
    status: status ?? "",
    attempt_ordinal: attempt_ordinal ?? "",
    claim_token: claim_token ?? "",
    completed: completed ?? "",
    diagnostic: diagnostic ?? "",
    expired: expired ?? "",
  };
}

function countOf(what: string, where: string): number {
  return Number(runSql(`select count(*) from ${what} where ${where};`).trim());
}

function runIdFor(date: string): string {
  return runSql(`select id from public.report_runs where business_date = date '${date}';`).trim();
}

/** Every audit row this run has, of one action — scoped to the run, never to the date. */
function auditCount(runId: string, action: string, attempt?: number): number {
  const ordinal =
    attempt === undefined ? "" : ` and (after_state ->> 'attempt_ordinal')::int = ${attempt}`;
  return countOf(
    "public.audit_events",
    `action = '${action}' and entity_id = '${runId}'::uuid${ordinal}`,
  );
}

/** Generation audits carry the snapshot as their entity, so they are found by the attempt's ordinal
 * and the correlation ids this run's claims were audited under. */
function generatedAuditCount(runId: string, attempt: number): number {
  return countOf(
    "public.audit_events",
    `action = 'scheduled_report_generated' and (after_state ->> 'attempt_ordinal')::int = ${attempt} ` +
      `and correlation_id in (select correlation_id from public.audit_events ` +
      `where entity_id = '${runId}'::uuid)`,
  );
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(50);
  }
  return false;
}

function resultOf(printed: string, session: PsqlSession): ScheduledReportResult {
  const line = printed.split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) {
    throw new Error(`the call returned no result; the session printed:\n${session.transcript()}`);
  }
  return JSON.parse(line) as ScheduledReportResult;
}

/**
 * A call for this slot is parked on THIS advisory lock — the signal, so no step is timed by
 * guesswork. Keyed on the lock and not just "some advisory lock", because the takeover case holds
 * one worker on two locks in turn and must know it has moved from the first to the second.
 */
function slotIsWaiting(attempt: number, lockKey: number): boolean {
  return (
    Number(
      runSql(`
        select count(*) from pg_stat_activity a
          join pg_locks l on l.pid = a.pid
         where a.query like '%run_scheduled_report(${attempt})%'
           and a.query not like '%pg_stat_activity%'
           and l.locktype = 'advisory' and not l.granted
           and l.objid = ${lockKey};`).trim(),
    ) === 1
  );
}

/** The worker's own session, with cancellation ruled out rather than assumed. */
async function openUncancellableWorker(): Promise<{ session: PsqlSession; timeout: string }> {
  const session = openPsqlSession();
  await session.send("set statement_timeout = 0;");
  const timeout = (await session.send("show statement_timeout;")).trim();
  return { session, timeout };
}

describe("the final attempt running past its lease, with nobody to replace it", () => {
  const date = businessDate();

  let lockHolder: PsqlSession;
  let worker: PsqlSession;
  let workerTimeout = "";
  let stalled = false;
  let expiredWhileStalled = "";
  let tokenAtClaim = "";
  let duplicateFinal: ScheduledReportResult;
  let duplicateThird: ScheduledReportResult;
  let finalResult: ScheduledReportResult;
  let replay: ScheduledReportResult;
  let historyBeforeReplay = -1;
  let historyAfterReplay = -1;

  /**
   * The review's reproduction. Attempts 1-3 fail where a generation really fails. Attempt 4 then
   * writes its snapshot and is held after it, uncancelled, until its lease has run out by itself.
   * No other attempt can take the run: there is no fifth slot, and a duplicate of the fourth finds
   * its own ordinal already spent. Released, the worker reaches `complete_report_run` and is
   * refused on the deadline alone.
   */
  beforeAll(async () => {
    resetScheduledReportDay(date);
    setReportLease("3 minutes");
    for (const attempt of [1, 2, 3]) failScheduledReport(attempt);

    setReportLease(`${LEASE_SECONDS} seconds`);
    installSnapshotStall(4);

    lockHolder = openPsqlSession();
    ({ session: worker, timeout: workerTimeout } = await openUncancellableWorker());

    await lockHolder.send("begin;");
    await lockHolder.send(`select pg_advisory_xact_lock(${SNAPSHOT_STALL_LOCK});`);

    const pending = worker.send("call private.run_scheduled_report(4);");
    stalled = await until(() => slotIsWaiting(4, SNAPSHOT_STALL_LOCK));
    tokenAtClaim = runRow(date).claim_token;

    await until(() => runRow(date).expired === "t");
    expiredWhileStalled = runRow(date).expired;

    // DUPLICATE DELIVERIES WHILE THE LEASE IS GONE. Neither may take the run: the fourth slot's
    // ordinal is already spent, and the third is behind it.
    duplicateFinal = runScheduledReport(4);
    duplicateThird = runScheduledReport(3);

    await lockHolder.send("commit;");
    finalResult = resultOf(await pending, worker);

    const runId = runIdFor(date);
    historyBeforeReplay =
      countOf("public.audit_events", `entity_id = '${runId}'::uuid`) +
      countOf("public.report_alerts", `business_date = date '${date}'`);
    replay = runScheduledReport(4);
    historyAfterReplay =
      countOf("public.audit_events", `entity_id = '${runId}'::uuid`) +
      countOf("public.report_alerts", `business_date = date '${date}'`);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([lockHolder?.close(), worker?.close()]);
    removeSnapshotStall();
    setReportLease("3 minutes");
    resetScheduledReportDay(date);
  });

  it("really ran past its lease with no statement timeout and no replacement", () => {
    expect(workerTimeout).toBe("0");
    expect(stalled).toBe(true);
    expect(expiredWhileStalled).toBe("t");
  });

  it("refuses duplicate deliveries of the last slots, and they take nothing", () => {
    expect(duplicateFinal.reason).toBe("attempt_already_used");
    expect(duplicateFinal.created).toBe(false);
    expect(duplicateThird.reason).toBe("attempt_already_used");
    expect(runRow(date).claim_token).toBe(tokenAtClaim);
  });

  it("returns the terminal failure and its alert, saying the lease ran out", () => {
    expect(finalResult.ok).toBe(false);
    expect(finalResult.created).toBe(false);
    expect(finalResult.reason).toBeUndefined();
    expect(finalResult.attempt).toBe(4);
    expect(finalResult.status).toBe("terminally_failed");
    expect(finalResult.terminal).toBe(true);
    expect(finalResult.alert_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(finalResult.diagnostic).toMatch(LEASE_DIAGNOSTIC);
  });

  it("commits the run terminally failed at ordinal 4, with its completion and diagnostic", () => {
    const row = runRow(date);
    expect(row.status).toBe("terminally_failed");
    expect(row.attempt_ordinal).toBe("4");
    expect(row.claim_token).toBe(tokenAtClaim);
    expect(row.completed).toBe("t");
    expect(row.diagnostic).toMatch(LEASE_DIAGNOSTIC);
  });

  it("commits exactly one high-priority alert, audited once, and shows it to the screen", () => {
    expect(countOf("public.report_alerts", `business_date = date '${date}'`)).toBe(1);
    expect(
      countOf("public.report_alerts", `business_date = date '${date}' and priority = 'high'`),
    ).toBe(1);
    expect(
      countOf(
        "public.audit_events",
        `action = 'scheduled_report_alert_raised' and entity_id = '${finalResult.alert_id}'::uuid`,
      ),
    ).toBe(1);
    expect(countOf("public.report_failure_alerts", `business_date = date '${date}'`)).toBe(1);
  });

  it("keeps the expired report rolled back: no snapshot, delivery or generation audit", () => {
    expect(countOf("public.report_snapshots", `business_date = date '${date}'`)).toBe(0);
    expect(
      countOf(
        "public.report_deliveries d join public.report_snapshots s on s.id = d.snapshot_id",
        `s.business_date = date '${date}'`,
      ),
    ).toBe(0);
    expect(generatedAuditCount(runIdFor(date), 4)).toBe(0);
    expect(countOf("public.daily_reports", `business_date = date '${date}'`)).toBe(0);
  });

  it("records all four failures, one per attempt", () => {
    const runId = runIdFor(date);
    for (const attempt of [1, 2, 3, 4]) {
      expect(auditCount(runId, "scheduled_report_attempt_failed", attempt)).toBe(1);
    }
  });

  it("refuses a replay of the final slot as already terminal, and it adds nothing", () => {
    expect(replay.reason).toBe("already_terminal");
    expect(historyAfterReplay).toBe(historyBeforeReplay);
  });
});

describe("an earlier attempt running past its lease, with nobody to replace it", () => {
  const date = businessDate();

  let lockHolder: PsqlSession;
  let worker: PsqlSession;
  let workerTimeout = "";
  let stalled = false;
  let expiredWhileStalled = "";
  let overrun: ScheduledReportResult;
  let retry: ScheduledReportResult;

  /**
   * The same overrun on the first attempt. It must not be silent either: left `claimed`, the run
   * would wait for the next slot to notice the expired lease; recorded as `failed`, it says why the
   * attempt was lost and the next slot takes it on the ordinary rule.
   */
  beforeAll(async () => {
    resetScheduledReportDay(date);
    setReportLease(`${LEASE_SECONDS} seconds`);
    installSnapshotStall(1);

    lockHolder = openPsqlSession();
    ({ session: worker, timeout: workerTimeout } = await openUncancellableWorker());

    await lockHolder.send("begin;");
    await lockHolder.send(`select pg_advisory_xact_lock(${SNAPSHOT_STALL_LOCK});`);

    const pending = worker.send("call private.run_scheduled_report(1);");
    stalled = await until(() => slotIsWaiting(1, SNAPSHOT_STALL_LOCK));
    await until(() => runRow(date).expired === "t");
    expiredWhileStalled = runRow(date).expired;

    await lockHolder.send("commit;");
    overrun = resultOf(await pending, worker);

    removeSnapshotStall();
    setReportLease("3 minutes");
    retry = runScheduledReport(2);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([lockHolder?.close(), worker?.close()]);
    removeSnapshotStall();
    setReportLease("3 minutes");
    resetScheduledReportDay(date);
  });

  it("really ran past its lease with no statement timeout", () => {
    expect(workerTimeout).toBe("0");
    expect(stalled).toBe(true);
    expect(expiredWhileStalled).toBe("t");
  });

  it("records a non-terminal failure saying the lease ran out, and raises no alert", () => {
    expect(overrun.ok).toBe(false);
    expect(overrun.reason).toBeUndefined();
    expect(overrun.attempt).toBe(1);
    expect(overrun.status).toBe("failed");
    expect(overrun.terminal).toBe(false);
    expect(overrun.alert_id).toBeNull();
    expect(overrun.diagnostic).toMatch(LEASE_DIAGNOSTIC);
    expect(auditCount(runIdFor(date), "scheduled_report_attempt_failed", 1)).toBe(1);
  });

  it("keeps the overrunning attempt's report rolled back", () => {
    expect(
      countOf("public.report_snapshots", `business_date = date '${date}' and attempt_ordinal = 1`),
    ).toBe(0);
    expect(generatedAuditCount(runIdFor(date), 1)).toBe(0);
  });

  it("lets the next slot take the failed run and report the night", () => {
    expect(retry.created).toBe(true);
    expect(retry.attempt).toBe(2);

    const row = runRow(date);
    expect(row.status).toBe("succeeded");
    expect(row.attempt_ordinal).toBe("2");
    expect(row.diagnostic).toBe("");
    expect(countOf("public.report_snapshots", `business_date = date '${date}'`)).toBe(1);
    expect(countOf("public.daily_reports", `business_date = date '${date}' and integrity_ok`))
      .toBe(1);
  });

  it("raises no alert for a night that was reported", () => {
    expect(countOf("public.report_alerts", `business_date = date '${date}'`)).toBe(0);
  });
});

/** Advisory-lock keys for this file's own instrument, distinct from the shared stalls. */
const OVERRUN_LOCK = 646_464;
const FAILURE_RECORD_LOCK = 555_555;

/**
 * THE TAKEOVER RACE, AT ITS NARROWEST. Attempt 3 is held after its snapshot until its lease has
 * gone, then released into the failure path — where it is held AGAIN, after its ownership read has
 * found the run still its own and after it has written its failure audit, but before its
 * token-guarded UPDATE. Attempt 4 takes the run in that gap and fails for real on the last ordinal.
 *
 * Three triggers, one instrument, created and dropped by this file:
 *
 *   · after insert on `report_snapshots`, ordinal 3: wait on `OVERRUN_LOCK`.
 *   · before insert on `report_snapshots`, ordinal 4: raise, so the final attempt genuinely fails.
 *   · after insert on `audit_events`, attempt 3's failure audit: wait on `FAILURE_RECORD_LOCK`.
 */
function installTakeoverInstrument(): void {
  runSql(`
    create schema if not exists test_instrumentation;

    create or replace function test_instrumentation.hold_attempt_three()
    returns trigger language plpgsql as $hold$
    begin
      if new.attempt_ordinal = 3 then
        perform pg_advisory_xact_lock(${OVERRUN_LOCK});
      end if;
      return null;
    end $hold$;

    create trigger zz_test_hold_attempt_three
      after insert on public.report_snapshots
      for each row execute function test_instrumentation.hold_attempt_three();

    create or replace function test_instrumentation.refuse_attempt_four()
    returns trigger language plpgsql as $refuse$
    begin
      if new.attempt_ordinal = 4 then
        raise exception 'the test refuses attempt % its snapshot', new.attempt_ordinal;
      end if;
      return new;
    end $refuse$;

    create trigger zz_test_refuse_attempt_four
      before insert on public.report_snapshots
      for each row execute function test_instrumentation.refuse_attempt_four();

    create or replace function test_instrumentation.hold_failure_record_three()
    returns trigger language plpgsql as $hold$
    begin
      if new.action = 'scheduled_report_attempt_failed'
         and (new.after_state ->> 'attempt_ordinal')::int = 3 then
        perform pg_advisory_xact_lock(${FAILURE_RECORD_LOCK});
      end if;
      return null;
    end $hold$;

    create trigger zz_test_hold_failure_record_three
      after insert on public.audit_events
      for each row execute function test_instrumentation.hold_failure_record_three();`);
}

function removeTakeoverInstrument(): void {
  runSql(`
    drop trigger if exists zz_test_hold_attempt_three on public.report_snapshots;
    drop trigger if exists zz_test_refuse_attempt_four on public.report_snapshots;
    drop trigger if exists zz_test_hold_failure_record_three on public.audit_events;
    drop schema if exists test_instrumentation cascade;`);
}

describe("an overrunning worker replaced between its ownership read and its failure record", () => {
  const date = businessDate();

  let overrunHolder: PsqlSession;
  let recordHolder: PsqlSession;
  let staleWorker: PsqlSession;
  let staleTimeout = "";
  let heldInFailurePath = false;
  let statusWhileHeld = "";
  let finalResult: ScheduledReportResult;
  let staleResult: ScheduledReportResult;
  let staleStillHeldWhenFinalReturned = false;
  let tokenAtOverrun = "";

  beforeAll(async () => {
    resetScheduledReportDay(date);
    setReportLease("3 minutes");
    for (const attempt of [1, 2]) failScheduledReport(attempt);

    setReportLease(`${LEASE_SECONDS} seconds`);
    installTakeoverInstrument();

    overrunHolder = openPsqlSession();
    recordHolder = openPsqlSession();
    ({ session: staleWorker, timeout: staleTimeout } = await openUncancellableWorker());

    await overrunHolder.send("begin;");
    await overrunHolder.send(`select pg_advisory_xact_lock(${OVERRUN_LOCK});`);
    await recordHolder.send("begin;");
    await recordHolder.send(`select pg_advisory_xact_lock(${FAILURE_RECORD_LOCK});`);

    const stalePending = staleWorker.send("call private.run_scheduled_report(3);");
    await until(() => slotIsWaiting(3, OVERRUN_LOCK));
    tokenAtOverrun = runRow(date).claim_token;
    await until(() => runRow(date).expired === "t");

    // Released past its lease: the completion is refused, the report discarded, and the worker
    // goes down the failure path — where it finds the run still its own, writes its failure audit
    // and is held again, before its UPDATE.
    await overrunHolder.send("commit;");
    heldInFailurePath = await until(() => slotIsWaiting(3, FAILURE_RECORD_LOCK));
    statusWhileHeld = runRow(date).status;

    // THE TAKEOVER. The final slot claims the expired run and fails for real, while attempt 3 is
    // still held with its ownership already checked.
    finalResult = runScheduledReport(4);
    staleStillHeldWhenFinalReturned = !(await settledWithin(stalePending, 0));

    await recordHolder.send("commit;");
    staleResult = resultOf(await stalePending, staleWorker);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([overrunHolder?.close(), recordHolder?.close(), staleWorker?.close()]);
    removeTakeoverInstrument();
    setReportLease("3 minutes");
    resetScheduledReportDay(date);
  });

  it("really held the overrunning worker inside its failure path, with the run still claimed", () => {
    expect(staleTimeout).toBe("0");
    expect(heldInFailurePath).toBe(true);
    expect(statusWhileHeld).toBe("claimed");
  });

  it("lets the final slot take the run and fail it terminally, with one alert", () => {
    expect(staleStillHeldWhenFinalReturned).toBe(true);
    expect(finalResult.attempt).toBe(4);
    expect(finalResult.status).toBe("terminally_failed");
    expect(finalResult.alert_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(finalResult.diagnostic).toMatch(/refuses attempt 4 its snapshot/);

    const row = runRow(date);
    expect(row.status).toBe("terminally_failed");
    expect(row.attempt_ordinal).toBe("4");
    expect(row.claim_token).not.toBe(tokenAtOverrun);
    expect(row.diagnostic).toMatch(/refuses attempt 4 its snapshot/);
  });

  it("tells the replaced worker it lost the lease, exactly as a superseded worker always was", () => {
    expect(staleResult.ok).toBe(true);
    expect(staleResult.created).toBe(false);
    expect(staleResult.reason).toBe("lease_lost");
    expect(staleResult.attempt).toBe(3);
  });

  it("lets the replaced worker write nothing: its failure audit is discarded", () => {
    const runId = runIdFor(date);
    expect(auditCount(runId, "scheduled_report_attempt_failed", 3)).toBe(0);
    expect(auditCount(runId, "scheduled_report_attempt_failed", 4)).toBe(1);
    expect(
      countOf("public.report_snapshots", `business_date = date '${date}' and attempt_ordinal = 3`),
    ).toBe(0);
    expect(generatedAuditCount(runId, 3)).toBe(0);
  });

  it("commits exactly one alert for the night, the final worker's", () => {
    expect(countOf("public.report_alerts", `business_date = date '${date}'`)).toBe(1);
    expect(
      countOf(
        "public.audit_events",
        `action = 'scheduled_report_alert_raised' and entity_id = '${finalResult.alert_id}'::uuid`,
      ),
    ).toBe(1);
  });
});
