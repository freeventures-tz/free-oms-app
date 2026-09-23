import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runSql } from "@/tests/support/database";
import { openPsqlSession, type PsqlSession } from "@/tests/support/psql-session";
import {
  failScheduledReport,
  FAILURE_AUDIT_STALL_LOCK,
  installFailureAuditStall,
  installSnapshotStall,
  removeFailureAuditStall,
  removeSnapshotStall,
  resetScheduledReportDay,
  runScheduledReport,
  setReportLease,
  SNAPSHOT_STALL_LOCK,
  type ScheduledReportResult,
} from "@/tests/support/scheduled-report";

/**
 * A generation that is CANCELLED — by `statement_timeout` or by an operator — is a failure like any
 * other, and the night's retry and alert rules still hold.
 *
 * THE DEFECT THIS EXISTS FOR (review F1 at `04d5ab0`). PL/pgSQL's `WHEN OTHERS` matches every error
 * EXCEPT `query_canceled`. So a generation cancelled mid-report skipped the failure path entirely:
 * the error escaped `private.run_report_attempt`, rolled back transaction 2, and left the run
 * `claimed` with no diagnostic. On attempts 1-3 the lease eventually rescued the night. On attempt 4
 * nothing could: the ordinal was spent, there is no fifth slot, and no alert was ever written.
 *
 * EVERY CANCELLATION HERE IS A REAL ONE, through the real entry point. The worker's own session
 * sets `statement_timeout`, or another session calls `pg_cancel_backend`, while the generation is
 * held by a lock this test owns. Nothing in `supabase/migrations/` knows the test exists.
 *
 * WHY THESE ARE INTEGRATION TESTS AND NOT pgTAP, for the reasons `report-claim-concurrency.test.ts`
 * gives: the procedure commits, which pgTAP's single transaction cannot host, and a cancelled
 * statement inside pgTAP would cancel the test itself.
 */

function businessDate(): string {
  return runSql("select (private.business_date() - 1)::text;").trim();
}

function runRow(date: string): {
  status: string;
  attempt_ordinal: string;
  completed: string;
  diagnostic: string;
  expired: string;
} {
  const [status, attempt_ordinal, completed, diagnostic, expired] = runSql(`
    select status, attempt_ordinal, (completed_at is not null),
           coalesce(failure_diagnostic, ''), (lease_expires_at <= now())
      from public.report_runs where business_date = date '${date}';`)
    .trim()
    .split("|");

  return {
    status: status ?? "",
    attempt_ordinal: attempt_ordinal ?? "",
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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(50);
  }
  return false;
}

/**
 * What the call printed, as the procedure's result.
 *
 * A CANCELLATION THAT ESCAPED prints nothing on stdout and an `ERROR:` on stderr, so there is no
 * JSON to parse — which is exactly the defect. The session's transcript goes into the failure so
 * the test says what the database said rather than `Unexpected end of JSON input`.
 */
function resultOf(printed: string, session: PsqlSession): ScheduledReportResult {
  const line = printed.split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) {
    throw new Error(`the call returned no result; the session printed:\n${session.transcript()}`);
  }
  return JSON.parse(line) as ScheduledReportResult;
}

/** Waits until a call for this slot is parked on a lock, so no step is timed by guesswork. */
function slotIsWaiting(attempt: number, waitEvent: "advisory" | "relation"): boolean {
  return (
    Number(
      runSql(`
        select count(*) from pg_stat_activity
         where query like '%run_scheduled_report(${attempt})%'
           and query not like '%pg_stat_activity%'
           and wait_event_type = 'Lock' and wait_event = '${waitEvent}';`).trim(),
    ) === 1
  );
}

const TIMEOUT_DIAGNOSTIC = /^57014: canceling statement due to statement timeout$/;

describe("an earlier attempt that times out after writing its snapshot", () => {
  const date = businessDate();

  let lockHolder: PsqlSession;
  let worker: PsqlSession;
  let workerResult: ScheduledReportResult;
  let stalledAfterSnapshot = false;
  let retry: ScheduledReportResult;
  let leaseStillRunningAtRetry = "";

  /**
   * The worker writes its snapshot and is then held on an advisory lock this test owns. Its own
   * `statement_timeout` cancels it THERE — after the snapshot and its deliveries exist inside the
   * generation's subtransaction — which is the partial work that must not survive.
   *
   * THE LEASE IS LEFT AT ITS PRODUCTION THREE MINUTES, so the slot that follows can only take the
   * run because the failure was recorded. Before the fix the run stayed `claimed` inside a live
   * lease and the retry was refused as `lease_held`.
   */
  beforeAll(async () => {
    resetScheduledReportDay(date);
    setReportLease("3 minutes");
    installSnapshotStall(1);

    lockHolder = openPsqlSession();
    worker = openPsqlSession();

    await lockHolder.send("begin;");
    await lockHolder.send(`select pg_advisory_xact_lock(${SNAPSHOT_STALL_LOCK});`);

    await worker.send("set statement_timeout = '4s';");
    const pending = worker.send("call private.run_scheduled_report(1);");

    stalledAfterSnapshot = await until(() => slotIsWaiting(1, "advisory"));
    workerResult = resultOf(await pending, worker);

    await lockHolder.send("commit;");
    removeSnapshotStall();

    leaseStillRunningAtRetry = runRow(date).expired;
    retry = runScheduledReport(2);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([lockHolder?.close(), worker?.close()]);
    removeSnapshotStall();
    resetScheduledReportDay(date);
  });

  it("really was cancelled after its snapshot was written", () => {
    expect(stalledAfterSnapshot).toBe(true);
  });

  it("returns a recorded, non-terminal failure with a bounded timeout diagnostic", () => {
    expect(workerResult.ok).toBe(false);
    expect(workerResult.created).toBe(false);
    expect(workerResult.attempt).toBe(1);
    expect(workerResult.status).toBe("failed");
    expect(workerResult.terminal).toBe(false);
    expect(workerResult.alert_id).toBeNull();
    expect(workerResult.diagnostic).toMatch(TIMEOUT_DIAGNOSTIC);
  });

  it("rolls the partial work back: no snapshot, no delivery and no generation audit survive", () => {
    const runId = runIdFor(date);
    expect(countOf("public.report_snapshots", `business_date = date '${date}' and attempt_ordinal = 1`))
      .toBe(0);
    expect(
      countOf(
        "public.report_deliveries d join public.report_snapshots s on s.id = d.snapshot_id",
        `s.business_date = date '${date}' and s.attempt_ordinal = 1`,
      ),
    ).toBe(0);
    expect(
      countOf(
        "public.audit_events",
        `action = 'scheduled_report_generated' and (after_state ->> 'attempt_ordinal')::int = 1 ` +
          `and correlation_id in (select correlation_id from public.audit_events ` +
          `where entity_id = '${runId}'::uuid)`,
      ),
    ).toBe(0);
  });

  it("audits the timed-out attempt's failure exactly once", () => {
    expect(auditCount(runIdFor(date), "scheduled_report_attempt_failed", 1)).toBe(1);
  });

  it("lets the next slot retry at once, inside the unexpired lease, and report the night", () => {
    expect(leaseStillRunningAtRetry).toBe("f");
    expect(retry.created).toBe(true);
    expect(retry.attempt).toBe(2);

    const row = runRow(date);
    expect(row.status).toBe("succeeded");
    expect(row.attempt_ordinal).toBe("2");
    expect(countOf("public.report_snapshots", `business_date = date '${date}'`)).toBe(1);
    expect(countOf("public.daily_reports", `business_date = date '${date}' and integrity_ok`))
      .toBe(1);
  });

  it("raises no alert for a night that was reported", () => {
    expect(countOf("public.report_alerts", `business_date = date '${date}'`)).toBe(0);
  });
});

describe("the final attempt timing out after three ordinary failures", () => {
  const date = businessDate();

  let blocker: PsqlSession;
  let worker: PsqlSession;
  let finalResult: ScheduledReportResult;
  let replay: ScheduledReportResult;
  let replayUnderTimeout: ScheduledReportResult;
  let auditBeforeReplays = 0;
  let auditAfterReplays = 0;

  /**
   * The review's reproduction, on the real schema. Attempts 1-3 fail where a generation really
   * fails (the definer owner loses `insert` on the snapshot table). Attempt 4 then blocks on an
   * `access exclusive` lock on `public.orders`, which `private.report_content` reads, and its own
   * `statement_timeout` cancels it.
   */
  beforeAll(async () => {
    resetScheduledReportDay(date);
    setReportLease("3 minutes");

    for (const attempt of [1, 2, 3]) failScheduledReport(attempt);

    blocker = openPsqlSession();
    worker = openPsqlSession();

    await blocker.send("begin;");
    await blocker.send("lock table public.orders in access exclusive mode;");

    await worker.send("set statement_timeout = '1500ms';");
    finalResult = resultOf(await worker.send("call private.run_scheduled_report(4);"), worker);

    const runId = runIdFor(date);
    auditBeforeReplays = countOf("public.audit_events", `entity_id = '${runId}'::uuid`) +
      countOf("public.audit_events", `action = 'scheduled_report_alert_raised'`);

    // A replay of the final slot, both plainly and cancelled the same way again.
    replay = runScheduledReport(4);
    replayUnderTimeout = resultOf(
      await worker.send("call private.run_scheduled_report(4);"),
      worker,
    );

    auditAfterReplays = countOf("public.audit_events", `entity_id = '${runId}'::uuid`) +
      countOf("public.audit_events", `action = 'scheduled_report_alert_raised'`);

    await blocker.send("commit;");
  }, 120_000);

  afterAll(async () => {
    await Promise.all([blocker?.close(), worker?.close()]);
    resetScheduledReportDay(date);
  });

  it("returns the terminal failure, its alert and a bounded timeout diagnostic", () => {
    expect(finalResult.ok).toBe(false);
    expect(finalResult.attempt).toBe(4);
    expect(finalResult.status).toBe("terminally_failed");
    expect(finalResult.terminal).toBe(true);
    expect(finalResult.alert_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(finalResult.diagnostic).toMatch(TIMEOUT_DIAGNOSTIC);
  });

  it("commits the run as terminally failed at ordinal 4, with its completion and diagnostic", () => {
    const row = runRow(date);
    expect(row.status).toBe("terminally_failed");
    expect(row.attempt_ordinal).toBe("4");
    expect(row.completed).toBe("t");
    expect(row.diagnostic).toMatch(TIMEOUT_DIAGNOSTIC);
  });

  it("commits exactly one high-priority alert, audited once, and shows it to the screen", () => {
    expect(countOf("public.report_alerts", `business_date = date '${date}' and priority = 'high'`))
      .toBe(1);
    expect(
      countOf(
        "public.audit_events",
        `action = 'scheduled_report_alert_raised' and entity_id = '${finalResult.alert_id}'::uuid`,
      ),
    ).toBe(1);
    expect(countOf("public.report_failure_alerts", `business_date = date '${date}'`)).toBe(1);
  });

  it("records all four failures, one per attempt", () => {
    const runId = runIdFor(date);
    for (const attempt of [1, 2, 3, 4]) {
      expect(auditCount(runId, "scheduled_report_attempt_failed", attempt)).toBe(1);
    }
  });

  it("refuses a replay of the final slot, cancelled or not, and it adds nothing", () => {
    expect(replay.reason).toBe("already_terminal");
    expect(replayUnderTimeout.reason).toBe("already_terminal");
    expect(auditAfterReplays).toBe(auditBeforeReplays);
    expect(countOf("public.report_alerts", `business_date = date '${date}'`)).toBe(1);
  });
});

describe("the final attempt's timeout landing while its failure is being recorded", () => {
  const TIMEOUT_MS = 2_000;
  const date = businessDate();

  let lockHolder: PsqlSession;
  let worker: PsqlSession;
  let finalResult: ScheduledReportResult;
  let waitingAgainAfterTimeout = false;

  /**
   * The generation fails ORDINARILY — the snapshot is refused for ordinal 4 — and the worker is
   * then held on its own failure audit by an advisory lock this test owns. Its `statement_timeout`
   * fires THERE, inside the failure record rather than inside the generation. That is the same
   * missing alert by a second route: an ordinary failure that finishes just before the timer does.
   *
   * The timer is one-shot per `CALL`, so a recording that is retried waits on the lock again and
   * completes once the test lets it go.
   */
  beforeAll(async () => {
    resetScheduledReportDay(date);
    setReportLease("3 minutes");
    for (const attempt of [1, 2, 3]) failScheduledReport(attempt);
    installFailureAuditStall(4);

    lockHolder = openPsqlSession();
    worker = openPsqlSession();

    await lockHolder.send("begin;");
    await lockHolder.send(`select pg_advisory_xact_lock(${FAILURE_AUDIT_STALL_LOCK});`);

    await worker.send(`set statement_timeout = '${TIMEOUT_MS}ms';`);
    const startedAt = Date.now();
    const pending = worker.send("call private.run_scheduled_report(4);");

    await until(() => slotIsWaiting(4, "advisory"));
    await wait(Math.max(0, TIMEOUT_MS + 1_000 - (Date.now() - startedAt)));
    waitingAgainAfterTimeout = await until(() => slotIsWaiting(4, "advisory"), 5_000);

    await lockHolder.send("commit;");
    finalResult = resultOf(await pending, worker);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([lockHolder?.close(), worker?.close()]);
    removeFailureAuditStall();
    resetScheduledReportDay(date);
  });

  it("survives the timeout and goes back to recording the failure", () => {
    expect(waitingAgainAfterTimeout).toBe(true);
  });

  it("commits the terminal failure with the generation's own diagnostic", () => {
    expect(finalResult.status).toBe("terminally_failed");
    expect(finalResult.terminal).toBe(true);
    expect(finalResult.diagnostic).toMatch(/refuses attempt 4 its snapshot/);

    const row = runRow(date);
    expect(row.status).toBe("terminally_failed");
    expect(row.attempt_ordinal).toBe("4");
    expect(row.completed).toBe("t");
  });

  it("commits exactly one alert and one failure audit for the final attempt", () => {
    expect(finalResult.alert_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(countOf("public.report_alerts", `business_date = date '${date}'`)).toBe(1);
    expect(
      countOf(
        "public.audit_events",
        `action = 'scheduled_report_alert_raised' and entity_id = '${finalResult.alert_id}'::uuid`,
      ),
    ).toBe(1);
    expect(auditCount(runIdFor(date), "scheduled_report_attempt_failed", 4)).toBe(1);
  });
});

describe("an earlier attempt cancelled by an operator", () => {
  const date = businessDate();

  let blocker: PsqlSession;
  let worker: PsqlSession;
  let cancelled: ScheduledReportResult;
  let retry: ScheduledReportResult;

  beforeAll(async () => {
    resetScheduledReportDay(date);
    setReportLease("3 minutes");

    blocker = openPsqlSession();
    worker = openPsqlSession();

    await blocker.send("begin;");
    await blocker.send("lock table public.orders in access exclusive mode;");

    const pending = worker.send("call private.run_scheduled_report(1);");
    await until(() => slotIsWaiting(1, "relation"));

    runSql(`
      select pg_cancel_backend(pid) from pg_stat_activity
       where query like '%run_scheduled_report(1)%'
         and query not like '%pg_stat_activity%'
         and wait_event_type = 'Lock';`);

    cancelled = resultOf(await pending, worker);
    await blocker.send("commit;");

    retry = runScheduledReport(2);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([blocker?.close(), worker?.close()]);
    resetScheduledReportDay(date);
  });

  it("records the cancellation as an ordinary failure, naming it as one", () => {
    expect(cancelled.status).toBe("failed");
    expect(cancelled.terminal).toBe(false);
    expect(cancelled.alert_id).toBeNull();
    expect(cancelled.diagnostic).toBe("57014: canceling statement due to user request");
    expect(auditCount(runIdFor(date), "scheduled_report_attempt_failed", 1)).toBe(1);
  });

  it("lets the next slot report the night", () => {
    expect(retry.created).toBe(true);
    expect(runRow(date).status).toBe("succeeded");
    expect(countOf("public.report_alerts", `business_date = date '${date}'`)).toBe(0);
  });
});

describe("a superseded worker that times out, and the final worker that replaced it", () => {
  const LEASE_SECONDS = 2;
  const date = businessDate();

  let blocker: PsqlSession;
  let staleWorker: PsqlSession;
  let finalWorker: PsqlSession;
  let staleResult: ScheduledReportResult;
  let finalResult: ScheduledReportResult;
  let alertsWhenStaleReturned = -1;
  let staleFailuresWhenStaleReturned = -1;
  let statusWhenStaleReturned = "";

  /**
   * Attempt 3 blocks on the report read and its lease runs out. Attempt 4 takes the run and blocks
   * too. Attempt 3's `statement_timeout` fires FIRST, while attempt 4 still owns the run — so the
   * stale worker is cancelled into a failure handler whose token no longer matches. It must record
   * nothing: no failure, no terminal state and, above all, no alert. Attempt 4's own timeout then
   * fires, and that is the one failure that alerts.
   */
  beforeAll(async () => {
    resetScheduledReportDay(date);
    for (const attempt of [1, 2]) failScheduledReport(attempt);
    setReportLease(`${LEASE_SECONDS} seconds`);

    blocker = openPsqlSession();
    staleWorker = openPsqlSession();
    finalWorker = openPsqlSession();

    await blocker.send("begin;");
    await blocker.send("lock table public.orders in access exclusive mode;");

    await staleWorker.send("set statement_timeout = '6s';");
    const stalePending = staleWorker.send("call private.run_scheduled_report(3);");
    await until(() => runRow(date).attempt_ordinal === "3" && runRow(date).status === "claimed");
    await until(() => runRow(date).expired === "t");

    await finalWorker.send("set statement_timeout = '6s';");
    const finalPending = finalWorker.send("call private.run_scheduled_report(4);");
    await until(() => runRow(date).attempt_ordinal === "4");

    staleResult = resultOf(await stalePending, staleWorker);
    alertsWhenStaleReturned = countOf("public.report_alerts", `business_date = date '${date}'`);
    staleFailuresWhenStaleReturned =
      auditCount(runIdFor(date), "scheduled_report_attempt_failed", 3);
    statusWhenStaleReturned = runRow(date).status;

    finalResult = resultOf(await finalPending, finalWorker);
    await blocker.send("commit;");
  }, 120_000);

  afterAll(async () => {
    await Promise.all([blocker?.close(), staleWorker?.close(), finalWorker?.close()]);
    setReportLease("3 minutes");
    resetScheduledReportDay(date);
  });

  it("tells the stale worker the run is no longer its own", () => {
    expect(staleResult.status).toBe("not_owner");
    expect(staleResult.terminal).toBe(false);
    expect(staleResult.alert_id).toBeNull();
  });

  it("lets the stale worker record no failure and raise no alert", () => {
    expect(statusWhenStaleReturned).toBe("claimed");
    expect(alertsWhenStaleReturned).toBe(0);
    expect(staleFailuresWhenStaleReturned).toBe(0);
  });

  it("terminates the night on the final worker's own timeout, with exactly one alert", () => {
    expect(finalResult.status).toBe("terminally_failed");
    expect(finalResult.alert_id).toMatch(/^[0-9a-f-]{36}$/);

    const runId = runIdFor(date);
    expect(runRow(date).status).toBe("terminally_failed");
    expect(countOf("public.report_alerts", `business_date = date '${date}'`)).toBe(1);
    expect(auditCount(runId, "scheduled_report_attempt_failed", 3)).toBe(0);
    expect(auditCount(runId, "scheduled_report_attempt_failed", 4)).toBe(1);
  });
});
