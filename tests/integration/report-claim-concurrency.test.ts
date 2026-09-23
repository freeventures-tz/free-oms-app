import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runSql } from "@/tests/support/database";
import { openPsqlSession, settledWithin, type PsqlSession } from "@/tests/support/psql-session";
import {
  FAILURE_AUDIT_STALL_LOCK,
  GENERATED_AUDIT_STALL_LOCK,
  installFailureAuditStall,
  installGeneratedAuditStall,
  installSnapshotStall,
  removeFailureAuditStall,
  removeGeneratedAuditStall,
  removeSnapshotStall,
  resetScheduledReportDay,
  setReportLease,
  SNAPSHOT_STALL_LOCK,
} from "@/tests/support/scheduled-report";

/**
 * A stalled worker must not stand in the way of the slot sent to replace it — proved with live
 * database sessions, at both moments where it could.
 *
 * WHY THIS FILE EXISTS AND pgTAP COULD NOT HOLD IT. `017_scheduled_report_retries.sql` proves the
 * claim RULES, and it proves them well: which ordinal may continue, which lease may be taken, that
 * a superseded worker records nothing. It cannot prove what is here, for two reasons that are both
 * structural rather than a matter of effort:
 *
 *   1. pgTAP runs inside one transaction and rolls it back. `private.run_scheduled_report` is a
 *      procedure whose whole point is that it COMMITS, and transaction control is illegal inside a
 *      transaction block — so the real entry point cannot be called there at all.
 *   2. One session cannot watch another session's uncommitted work. Every question below is a
 *      question about what a SECOND connection can see and do while a FIRST one is stuck.
 *
 * FOUR STALLS, BECAUSE THERE ARE FOUR PLACES A WORKER CAN BE STUCK, and each was found only
 * after the one before it was fixed:
 *
 *   · BEFORE IT WRITES ANYTHING — stuck building the report. It holds nothing. This is the common
 *     case and it was the only one covered at first.
 *   · AFTER IT HAS WRITTEN ITS SNAPSHOT — it holds the snapshot's index entry and, through the
 *     foreign key, a `KEY SHARE` lock on the run row.
 *   · ON ITS LAST AUDIT EVENT — the narrowest window on the success path. Completing the run takes
 *     a `NO KEY UPDATE` lock held until commit, so while the audit was written AFTER the
 *     completion, a worker stuck on that one insert sat on the run row and the next slot skipped
 *     it. Completing is now the final statement of a successful attempt.
 *   · ON ITS FAILURE AUDIT — the same defect on the FAILURE path, and the last one found. Marking
 *     the run `failed` used to come FIRST, so a worker stuck writing the audit event about that
 *     failure sat on the run row for as long as it was stuck. Recording a failure is now ordered
 *     the same way a success is: the audit and the alert go in first, and the run's own status is
 *     the last statement there is.
 *
 * Each scenario keeps its own stall: they are different locks in different windows, and a fix for
 * one says nothing about the others.
 */

/** The day every slot reports on: yesterday in Dar es Salaam, derived the way the database does. */
function businessDate(): string {
  return runSql("select (private.business_date() - 1)::text;").trim();
}

function runRow(date: string): {
  status: string;
  attempt_ordinal: string;
  claim_token: string;
  expired: string;
} {
  const [status, attempt_ordinal, claim_token, expired] = runSql(`
    select status, attempt_ordinal, claim_token, (lease_expires_at <= now())
      from public.report_runs where business_date = date '${date}';`)
    .trim()
    .split("|");

  return {
    status: status ?? "",
    attempt_ordinal: attempt_ordinal ?? "",
    claim_token: claim_token ?? "",
    expired: expired ?? "",
  };
}

function countOf(what: string, where: string): number {
  return Number(runSql(`select count(*) from ${what} where ${where};`).trim());
}

function runIdFor(date: string): string {
  return runSql(`select id from public.report_runs where business_date = date '${date}';`).trim();
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls a cheap SQL predicate until it holds, so no test step is timed by guesswork. */
async function until(predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(50);
  }
  return false;
}

describe("a worker that stalls before it writes anything", () => {
  const LEASE_SECONDS = 2;
  const date = businessDate();

  let blocker: PsqlSession;
  let firstWorker: PsqlSession;
  let laterSlot: PsqlSession;
  let firstResult = "";
  let laterResult = "";
  let tokenWhileStalled = "";

  /**
   * THE STALL IS A REAL ONE. A third session takes an `access exclusive` lock on `public.orders`,
   * which `private.report_content` reads, so slot 1 stops where a slow generation really stops —
   * after the claim, before any write. There is no fault switch in production code.
   *
   * THE LEASE EXPIRES BY ITSELF. `lease_duration` is a column on the schedule row; the test sets it
   * short and then waits. Nothing here writes `lease_expires_at`.
   */
  beforeAll(async () => {
    resetScheduledReportDay(date);
    setReportLease(`${LEASE_SECONDS} seconds`);

    blocker = openPsqlSession();
    firstWorker = openPsqlSession();
    laterSlot = openPsqlSession();

    await blocker.send("begin;");
    await blocker.send("lock table public.orders in access exclusive mode;");

    const firstPending = firstWorker.send("call private.run_scheduled_report(1);");

    // The claim is visible from THIS session, a different connection, while slot 1 is still inside
    // its call. That is only possible if the claim was committed on its own.
    await until(() => countOf("public.report_runs", `business_date = date '${date}'`) === 1);
    tokenWhileStalled = runRow(date).claim_token;

    await wait((LEASE_SECONDS + 1) * 1000);

    const laterPending = laterSlot.send("call private.run_scheduled_report(2);");
    await until(() => runRow(date).attempt_ordinal === "2");

    expect(await settledWithin(firstPending, 0)).toBe(false);
    expect(await settledWithin(laterPending, 0)).toBe(false);

    await blocker.send("commit;");
    firstResult = await firstPending;
    laterResult = await laterPending;
  }, 120_000);

  afterAll(async () => {
    await Promise.all([blocker?.close(), firstWorker?.close(), laterSlot?.close()]);
    setReportLease("3 minutes");
    resetScheduledReportDay(date);
  });

  it("commits the claim before it generates anything, so a crash leaves something reclaimable", () => {
    expect(tokenWhileStalled).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("lets the later slot take the expired lease instead of blocking on the run row", () => {
    const row = runRow(date);
    expect(row.attempt_ordinal).toBe("2");
    expect(row.claim_token).not.toBe(tokenWhileStalled);
  });

  it("refuses the superseded worker its success: it is told the run is no longer its own", () => {
    const first = JSON.parse(firstResult) as { created?: boolean; reason?: string; status?: string };
    expect(first.created).not.toBe(true);
    expect(["lease_lost", undefined]).toContain(first.reason);
    if (first.status !== undefined) expect(first.status).toBe("not_owner");
  });

  it("leaves exactly one report for the night, written by the slot that owned the claim", () => {
    const row = runRow(date);
    expect(row.status).toBe("succeeded");
    expect(row.attempt_ordinal).toBe("2");
    expect(countOf("public.report_snapshots", `business_date = date '${date}'`)).toBe(1);

    const later = JSON.parse(laterResult) as { created?: boolean; attempt?: number };
    expect(later.created).toBe(true);
    expect(later.attempt).toBe(2);
  });

  it("writes no failure, no terminal state and no alert for a night that was reported", () => {
    const runId = runIdFor(date);
    expect(countOf("public.report_alerts", `business_date = date '${date}'`)).toBe(0);
    expect(
      countOf("public.report_runs", `id = '${runId}'::uuid and failure_diagnostic is not null`),
    ).toBe(0);
    expect(
      countOf(
        "public.audit_events",
        `action = 'scheduled_report_attempt_failed' and entity_id = '${runId}'::uuid`,
      ),
    ).toBe(0);
  });

  it("audits both claims and exactly one generation, so the night's history is complete", () => {
    // SCOPED TO THIS RUN ROW, not to the business date. `audit_events` is append-only and other
    // files in this suite report on the same night, so a count by date would include their history.
    const runId = runIdFor(date);

    expect(
      countOf(
        "public.audit_events",
        `action = 'scheduled_report_attempt_claimed' and entity_id = '${runId}'::uuid`,
      ),
    ).toBe(2);

    expect(
      countOf(
        "public.audit_events",
        `action = 'scheduled_report_generated' and correlation_id = ` +
          `(select correlation_id from public.report_runs where id = '${runId}'::uuid)`,
      ),
    ).toBe(1);
  });
});

describe("a worker that stalls AFTER writing its snapshot, holding the contested resources", () => {
  const LEASE_SECONDS = 4;
  const date = businessDate();

  let lockHolder: PsqlSession;
  let firstWorker: PsqlSession;
  let laterSlot: PsqlSession;

  let firstResult = "";
  let laterResult = "";
  let laterTookMs = 0;
  let firstStillStalledWhenLaterFinished = false;
  let contestedWhileStalled = false;
  let tokenBeforeReclaim = "";

  /**
   * THE DEFECT THIS EXISTS FOR, reproduced before it was fixed and now guarded:
   *
   *   Attempt 1 claimed (committed), began generating, and stalled with its snapshot INSERT
   *   pending. Its lease expired. Attempt 2 fired — and `private.run_scheduled_report(2)` returned
   *   `lease_held` about a lease that had plainly expired, because the claim took the run row `FOR
   *   UPDATE SKIP LOCKED` and the foreign key from `report_snapshots` holds a conflicting
   *   `KEY SHARE` on it. The night then died: attempt 3 found a gap and refused in turn.
   *
   *   Fixing only the lock mode was not enough. Attempt 2 could then take ownership, but its own
   *   snapshot insert queued behind attempt 1's on `report_snapshots_run_id_key`, so it took
   *   ownership and went nowhere. Both halves are needed, and both are exercised here.
   *
   * THE STALL IS INSTRUMENTATION, NOT A PRODUCTION SWITCH: a trigger this test creates and drops,
   * which waits on an advisory lock this test holds. See `installSnapshotStall`.
   */
  beforeAll(async () => {
    resetScheduledReportDay(date);
    setReportLease(`${LEASE_SECONDS} seconds`);
    installSnapshotStall(1);

    lockHolder = openPsqlSession();
    firstWorker = openPsqlSession();
    laterSlot = openPsqlSession();

    await lockHolder.send("begin;");
    await lockHolder.send(`select pg_advisory_xact_lock(${SNAPSHOT_STALL_LOCK});`);

    const firstPending = firstWorker.send("call private.run_scheduled_report(1);");

    // Attempt 1 is inside the trigger — therefore PAST its snapshot insert — exactly when its
    // backend is waiting on the advisory lock this test holds. Waiting on that is the signal; no
    // step here is timed by guesswork.
    await until(
      () =>
        Number(
          runSql(`
            select count(*) from pg_stat_activity
             where query like '%run_scheduled_report(1)%'
               and wait_event_type = 'Lock' and wait_event = 'advisory';`).trim(),
        ) === 1,
    );

    expect(runRow(date).status).toBe("claimed");
    tokenBeforeReclaim = runRow(date).claim_token;

    // AND IT REALLY IS HOLDING THE CONTESTED RESOURCES, read straight out of `pg_locks` for the
    // stalled backend. Two locks say it: `RowExclusiveLock` on `report_snapshots` is the write it
    // has in flight, and `RowShareLock` on `report_runs` is what the foreign key takes on the run
    // row for it — the very lock that used to make the next slot skip the row it was sent to
    // reclaim.
    //
    // READ RATHER THAN PROVOKED, after two earlier versions of this probe were unreliable in ways
    // worth recording. Racing a conflicting INSERT and matching psql's `ERROR: canceling statement
    // due to statement timeout` failed intermittently, because that text goes to stderr while the
    // marker ending a `send` goes to stdout and two pipes have no ordering. Moving the INSERT
    // inside a `do` block to return its outcome as a row was worse: `statement_timeout` applies to
    // the top-level statement, and the DO block WAS that statement, so the timer never fired and
    // the probe hung until the hook timed out. `pg_locks` answers the same question with no
    // blocking, no timeout and no second stream.
    const contested = runSql(`
      select count(*) filter (where l.relation = 'public.report_snapshots'::regclass
                                and l.mode = 'RowExclusiveLock')
          || '/' ||
             count(*) filter (where l.relation = 'public.report_runs'::regclass
                                and l.mode = 'RowShareLock')
        from pg_stat_activity a
        join pg_locks l on l.pid = a.pid
       where a.query like '%run_scheduled_report(1)%'
         and a.wait_event_type = 'Lock' and a.wait_event = 'advisory';`).trim();

    const [onSnapshots, onRuns] = contested.split("/").map(Number);
    contestedWhileStalled = onSnapshots >= 1 && onRuns >= 1;

    // The lease runs out by itself while attempt 1 sits on those resources.
    await until(() => runRow(date).expired === "t");

    // ATTEMPT 2, THROUGH THE REAL ENTRY POINT, WHILE ATTEMPT 1 IS STILL STUCK.
    const startedAt = Date.now();
    const laterPending = laterSlot.send("call private.run_scheduled_report(2);");
    laterResult = await laterPending;
    laterTookMs = Date.now() - startedAt;

    // It finished while attempt 1 had not moved, which is what "without waiting for it" means.
    firstStillStalledWhenLaterFinished = !(await settledWithin(firstPending, 0));

    await lockHolder.send("commit;");
    firstResult = await firstPending;
  }, 180_000);

  afterAll(async () => {
    await Promise.all([lockHolder?.close(), firstWorker?.close(), laterSlot?.close()]);
    removeSnapshotStall();
    setReportLease("3 minutes");
    resetScheduledReportDay(date);
  });

  it("really is stalled inside the contested phase, holding both contested locks", () => {
    expect(contestedWhileStalled).toBe(true);
  });

  it("lets attempt 2 take ownership and finish without waiting for the stale worker", () => {
    expect(firstStillStalledWhenLaterFinished).toBe(true);

    const later = JSON.parse(laterResult) as { created?: boolean; attempt?: number };
    expect(later.created).toBe(true);
    expect(later.attempt).toBe(2);

    // Generation is well under a second; the stale worker was stuck for the whole of this and
    // beyond. A run that queued behind it could not have come back in this time.
    expect(laterTookMs).toBeLessThan(LEASE_SECONDS * 1000);

    const row = runRow(date);
    expect(row.attempt_ordinal).toBe("2");
    expect(row.claim_token).not.toBe(tokenBeforeReclaim);
  });

  it("commits exactly one snapshot, and it is attempt 2's", () => {
    expect(countOf("public.report_snapshots", `business_date = date '${date}'`)).toBe(1);
    expect(
      countOf("public.report_snapshots", `business_date = date '${date}' and attempt_ordinal = 2`),
    ).toBe(1);
    expect(runRow(date).status).toBe("succeeded");
  });

  it("serves that one report, and the archive shows one row for the night", () => {
    expect(countOf("public.daily_reports", `business_date = date '${date}'`)).toBe(1);
    expect(
      countOf("public.daily_reports", `business_date = date '${date}' and integrity_ok`),
    ).toBe(1);
  });

  it("lets the stale worker record NOTHING once it wakes: no success and no failure", () => {
    const first = JSON.parse(firstResult) as {
      ok?: boolean;
      created?: boolean;
      reason?: string;
      status?: string;
    };

    expect(first.created).not.toBe(true);
    expect(["lease_lost", undefined]).toContain(first.reason);
    if (first.status !== undefined) expect(first.status).toBe("not_owner");

    const runId = runIdFor(date);
    expect(runRow(date).attempt_ordinal).toBe("2");
    expect(
      countOf("public.report_runs", `id = '${runId}'::uuid and failure_diagnostic is not null`),
    ).toBe(0);
  });

  it("leaves no terminal state, no alert and no final audit event from the stale worker", () => {
    const runId = runIdFor(date);

    expect(countOf("public.report_runs", `id = '${runId}'::uuid and status = 'terminally_failed'`))
      .toBe(0);
    expect(countOf("public.report_alerts", `business_date = date '${date}'`)).toBe(0);
    expect(
      countOf(
        "public.audit_events",
        `action = 'scheduled_report_attempt_failed' and entity_id = '${runId}'::uuid`,
      ),
    ).toBe(0);

    // Exactly one generation was audited, and it carries attempt 2's ordinal — the stale worker
    // wrote no final audit event of its own.
    expect(
      countOf(
        "public.audit_events",
        `action = 'scheduled_report_generated' and correlation_id = ` +
          `(select correlation_id from public.report_runs where id = '${runId}'::uuid) ` +
          `and (after_state ->> 'attempt_ordinal')::int = 2`,
      ),
    ).toBe(1);
  });

  it("still audits both claims, because both attempts genuinely began", () => {
    const runId = runIdFor(date);
    expect(
      countOf(
        "public.audit_events",
        `action = 'scheduled_report_attempt_claimed' and entity_id = '${runId}'::uuid`,
      ),
    ).toBe(2);
  });
});

describe("a worker that stalls on its LAST audit event, one statement from finishing", () => {
  const LEASE_SECONDS = 4;
  const date = businessDate();

  let lockHolder: PsqlSession;
  let firstWorker: PsqlSession;
  let laterSlot: PsqlSession;

  let firstResult = "";
  let laterResult = "";
  let laterTookMs = 0;
  let firstStillStalledWhenLaterFinished = false;
  let generatedAuditsWhileStalled = -1;
  let statusWhileStalled = "";
  let tokenBeforeReclaim = "";
  let deliveriesForWinner = -1;
  let eligibleRecipients = -1;

  /**
   * THE NARROWEST WINDOW, AND THE LAST ONE TO CLOSE.
   *
   * The two scenarios above catch a worker holding nothing and a worker holding the snapshot's key.
   * This one catches what was left after both were fixed: `private.complete_report_run` takes a
   * `NO KEY UPDATE` lock on the run row and holds it until the entry point commits. While the
   * `scheduled_report_generated` audit event was written AFTER that call, a worker stuck on that
   * single insert sat on the run row — so once its lease expired, the real next attempt still came
   * back `lease_held`. One statement wide, and enough to take the night down.
   *
   * The fix is an ordering rule rather than a lock change: the audit goes in BEFORE the completion,
   * and the completion is the last database statement a successful attempt makes. Both are inside
   * one subtransaction, so a worker that turns out not to own the run any more discards that audit
   * event along with its snapshot and its deliveries.
   *
   * THE STALL IS INSTRUMENTATION, NOT A PRODUCTION SWITCH: an `after insert` trigger on
   * `audit_events` that this test creates and drops, keyed on `after_state.attempt_ordinal` so it
   * stops attempt 1 and lets attempt 2 write its own audit event unhindered.
   */
  beforeAll(async () => {
    resetScheduledReportDay(date);
    setReportLease(`${LEASE_SECONDS} seconds`);
    installGeneratedAuditStall(1);

    lockHolder = openPsqlSession();
    firstWorker = openPsqlSession();
    laterSlot = openPsqlSession();

    await lockHolder.send("begin;");
    await lockHolder.send(`select pg_advisory_xact_lock(${GENERATED_AUDIT_STALL_LOCK});`);

    const firstPending = firstWorker.send("call private.run_scheduled_report(1);");

    // Attempt 1 is inside the trigger — therefore past its snapshot, past its deliveries, and on
    // its audit insert — exactly when its backend waits on the advisory lock this test holds.
    await until(
      () =>
        Number(
          runSql(`
            select count(*) from pg_stat_activity
             where query like '%run_scheduled_report(1)%'
               and wait_event_type = 'Lock' and wait_event = 'advisory';`).trim(),
        ) === 1,
    );

    statusWhileStalled = runRow(date).status;
    tokenBeforeReclaim = runRow(date).claim_token;

    // Everything it has written is uncommitted, and this connection proves it by seeing none of it.
    //
    // SCOPED TO THIS ATTEMPT'S CORRELATION ID, not to the business date. `audit_events` is
    // append-only and the two scenarios above reported on the same night, so a count by date would
    // include their history and this assertion would be about the file's order rather than about
    // attempt 1.
    generatedAuditsWhileStalled = countOf(
      "public.audit_events",
      `action = 'scheduled_report_generated' and correlation_id = ` +
        `(select correlation_id from public.report_runs where business_date = date '${date}')`,
    );

    await until(() => runRow(date).expired === "t");

    // ATTEMPT 2, THROUGH THE REAL ENTRY POINT, WHILE ATTEMPT 1 IS ONE STATEMENT FROM FINISHING.
    const startedAt = Date.now();
    const laterPending = laterSlot.send("call private.run_scheduled_report(2);");
    laterResult = await laterPending;
    laterTookMs = Date.now() - startedAt;

    firstStillStalledWhenLaterFinished = !(await settledWithin(firstPending, 0));

    await lockHolder.send("commit;");
    firstResult = await firstPending;

    eligibleRecipients = Number(
      runSql(`
        select count(*) from public.profiles p
          join public.user_roles r on r.user_id = p.id
         where p.is_active and r.role in ('director', 'manager');`).trim(),
    );

    deliveriesForWinner = countOf(
      "public.report_deliveries d",
      `d.snapshot_id in (select s.id from public.report_snapshots s
                          where s.business_date = date '${date}' and s.attempt_ordinal = 2)`,
    );
  }, 180_000);

  afterAll(async () => {
    await Promise.all([lockHolder?.close(), firstWorker?.close(), laterSlot?.close()]);
    removeGeneratedAuditStall();
    setReportLease("3 minutes");
    resetScheduledReportDay(date);
  });

  it("is stalled with the run still claimed and everything it wrote uncommitted", () => {
    expect(statusWhileStalled).toBe("claimed");
    expect(generatedAuditsWhileStalled).toBe(0);
  });

  it("lets attempt 2 take ownership and finish without waiting for attempt 1", () => {
    expect(firstStillStalledWhenLaterFinished).toBe(true);

    const later = JSON.parse(laterResult) as { created?: boolean; attempt?: number };
    expect(later.created).toBe(true);
    expect(later.attempt).toBe(2);
    expect(laterTookMs).toBeLessThan(LEASE_SECONDS * 1000);

    const row = runRow(date);
    expect(row.status).toBe("succeeded");
    expect(row.attempt_ordinal).toBe("2");
    expect(row.claim_token).not.toBe(tokenBeforeReclaim);
  });

  it("commits exactly one snapshot and one report, both attempt 2's", () => {
    expect(countOf("public.report_snapshots", `business_date = date '${date}'`)).toBe(1);
    expect(
      countOf("public.report_snapshots", `business_date = date '${date}' and attempt_ordinal = 2`),
    ).toBe(1);
    expect(countOf("public.daily_reports", `business_date = date '${date}'`)).toBe(1);
    expect(countOf("public.daily_reports", `business_date = date '${date}' and integrity_ok`)).toBe(
      1,
    );
  });

  it("delivers attempt 2's report to every active Director and Manager, and to nobody else", () => {
    // A report that reached nobody would make the comparison vacuous, so the eligible count is
    // checked to be real as well as equal.
    expect(eligibleRecipients).toBeGreaterThan(0);
    expect(deliveriesForWinner).toBe(eligibleRecipients);
  });

  it("lets the stale worker record NOTHING: no success, no failure, no snapshot, no delivery", () => {
    const first = JSON.parse(firstResult) as { created?: boolean; reason?: string; status?: string };

    expect(first.created).not.toBe(true);
    expect(["lease_lost", undefined]).toContain(first.reason);
    if (first.status !== undefined) expect(first.status).toBe("not_owner");

    const runId = runIdFor(date);
    expect(
      countOf("public.report_snapshots", `business_date = date '${date}' and attempt_ordinal = 1`),
    ).toBe(0);
    expect(
      countOf("public.report_runs", `id = '${runId}'::uuid and failure_diagnostic is not null`),
    ).toBe(0);
  });

  it("leaves no terminal state, no alert and exactly one final audit event — attempt 2's", () => {
    const runId = runIdFor(date);

    expect(
      countOf("public.report_runs", `id = '${runId}'::uuid and status = 'terminally_failed'`),
    ).toBe(0);
    expect(countOf("public.report_alerts", `business_date = date '${date}'`)).toBe(0);
    expect(
      countOf(
        "public.audit_events",
        `action = 'scheduled_report_attempt_failed' and entity_id = '${runId}'::uuid`,
      ),
    ).toBe(0);

    // The premature audit attempt 1 wrote went with its subtransaction. Exactly one survives for
    // this run, and it is attempt 2's. Counted by the run's correlation id, which is attempt 2's
    // now, so the earlier scenarios' audits for the same night are not swept in.
    const correlated =
      `action = 'scheduled_report_generated' and correlation_id = ` +
      `(select correlation_id from public.report_runs where id = '${runId}'::uuid)`;

    expect(countOf("public.audit_events", correlated)).toBe(1);
    expect(
      countOf("public.audit_events", `${correlated} and (after_state ->> 'attempt_ordinal')::int = 2`),
    ).toBe(1);
  });

  it("still audits both accepted claims, because both attempts genuinely began", () => {
    const runId = runIdFor(date);
    expect(
      countOf(
        "public.audit_events",
        `action = 'scheduled_report_attempt_claimed' and entity_id = '${runId}'::uuid`,
      ),
    ).toBe(2);
  });
});

describe("a worker that stalls on the audit event for its OWN FAILURE", () => {
  const LEASE_SECONDS = 4;
  const date = businessDate();

  let lockHolder: PsqlSession;
  let firstWorker: PsqlSession;
  let laterSlot: PsqlSession;

  let firstResult = "";
  let laterResult = "";
  let laterTookMs = 0;
  let firstStillStalledWhenLaterFinished = false;
  let statusWhileStalled = "";
  let tokenBeforeReclaim = "";
  let heldRunRowWhileStalled = true;
  let deliveriesForWinner = -1;
  let eligibleRecipients = -1;

  /**
   * THE DEFECT THIS EXISTS FOR, and it is the success path's defect wearing the other hat.
   *
   *   `private.run_report_attempt` recorded a failure by calling `private.fail_report_run` FIRST.
   *   That is an UPDATE of `report_runs`, so it takes a `NO KEY UPDATE` lock on the run row and
   *   holds it until the entry point commits — and the failure audit event, and the terminal alert
   *   after it, were both written while that lock was held. A worker stalled on either of them sat
   *   on the run row exactly as the pre-fix success path did: once its lease expired, the next
   *   scheduled slot's claim skipped the row it had been sent to reclaim and came back
   *   `lease_held`. The retry sequence then stopped, which is the one thing retries exist to
   *   prevent.
   *
   * THE FIX IS THE SAME ORDERING RULE, applied to the other outcome: the failure audit and the
   * alert go in BEFORE the run's status, the token-guarded update is the last database statement
   * there is, and all of it is one subtransaction — so a worker that turns out not to own the run
   * any more discards its premature audit and alert along with everything else.
   *
   * THE STALL IS INSTRUMENTATION, NOT A PRODUCTION SWITCH: two triggers this test creates and
   * drops. See `installFailureAuditStall`.
   */
  beforeAll(async () => {
    resetScheduledReportDay(date);
    setReportLease(`${LEASE_SECONDS} seconds`);
    installFailureAuditStall(1);

    lockHolder = openPsqlSession();
    firstWorker = openPsqlSession();
    laterSlot = openPsqlSession();

    await lockHolder.send("begin;");
    await lockHolder.send(`select pg_advisory_xact_lock(${FAILURE_AUDIT_STALL_LOCK});`);

    const firstPending = firstWorker.send("call private.run_scheduled_report(1);");

    // Attempt 1 is inside the trigger — therefore its generation has already failed and it is on
    // the audit event announcing that failure — exactly when its backend waits on the advisory
    // lock this test holds. No step here is timed by guesswork.
    await until(
      () =>
        Number(
          runSql(`
            select count(*) from pg_stat_activity
             where query like '%run_scheduled_report(1)%'
               and wait_event_type = 'Lock' and wait_event = 'advisory';`).trim(),
        ) === 1,
    );

    // The claim is committed and visible from this third connection, and the run still says
    // `claimed` — the failure has not reached it yet, which is the whole point.
    statusWhileStalled = runRow(date).status;
    tokenBeforeReclaim = runRow(date).claim_token;

    // AND IT IS NOT SITTING ON THE RUN ROW, read straight out of `pg_locks` for the stalled
    // backend. `RowExclusiveLock` on `public.report_runs` is what an UPDATE of that table takes,
    // so its ABSENCE is the direct evidence that no status update has happened yet. Before the
    // fix this probe found the lock, and attempt 2 below came back `lease_held` because of it.
    // A plain `AccessShareLock` from reading the row is expected and is not what is counted.
    heldRunRowWhileStalled =
      Number(
        runSql(`
          select count(*) from pg_stat_activity a
            join pg_locks l on l.pid = a.pid
           where a.query like '%run_scheduled_report(1)%'
             and a.wait_event_type = 'Lock' and a.wait_event = 'advisory'
             and l.relation = 'public.report_runs'::regclass
             and l.mode = 'RowExclusiveLock';`).trim(),
      ) > 0;

    // The lease runs out by itself while attempt 1 sits on its failure audit. Nothing here writes
    // `lease_expires_at`.
    await until(() => runRow(date).expired === "t");

    // ATTEMPT 2, THROUGH THE REAL ENTRY POINT, WHILE ATTEMPT 1 IS STILL STUCK.
    const startedAt = Date.now();
    const laterPending = laterSlot.send("call private.run_scheduled_report(2);");
    laterResult = await laterPending;
    laterTookMs = Date.now() - startedAt;

    firstStillStalledWhenLaterFinished = !(await settledWithin(firstPending, 0));

    await lockHolder.send("commit;");
    firstResult = await firstPending;

    eligibleRecipients = Number(
      runSql(`
        select count(*) from public.profiles p
          join public.user_roles r on r.user_id = p.id
         where p.is_active and r.role in ('director', 'manager');`).trim(),
    );

    deliveriesForWinner = countOf(
      "public.report_deliveries d",
      `d.snapshot_id in (select s.id from public.report_snapshots s
                          where s.business_date = date '${date}' and s.attempt_ordinal = 2)`,
    );
  }, 180_000);

  afterAll(async () => {
    await Promise.all([lockHolder?.close(), firstWorker?.close(), laterSlot?.close()]);
    removeFailureAuditStall();
    setReportLease("3 minutes");
    resetScheduledReportDay(date);
  });

  it("is stalled with its claim committed, the run still claimed, and no lock on the run row", () => {
    expect(statusWhileStalled).toBe("claimed");
    expect(tokenBeforeReclaim).toMatch(/^[0-9a-f-]{36}$/);
    expect(heldRunRowWhileStalled).toBe(false);
  });

  it("lets attempt 2 take ownership and finish without waiting for the failing worker", () => {
    expect(firstStillStalledWhenLaterFinished).toBe(true);

    const later = JSON.parse(laterResult) as {
      created?: boolean;
      attempt?: number;
      reason?: string;
    };

    // Before the fix this came back `{"reason": "lease_held"}` about a lease that had plainly
    // gone, and the night died there.
    expect(later.reason).toBeUndefined();
    expect(later.created).toBe(true);
    expect(later.attempt).toBe(2);
    expect(laterTookMs).toBeLessThan(LEASE_SECONDS * 1000);

    const row = runRow(date);
    expect(row.status).toBe("succeeded");
    expect(row.attempt_ordinal).toBe("2");
    expect(row.claim_token).not.toBe(tokenBeforeReclaim);
  });

  it("commits exactly one snapshot and one report, both attempt 2's", () => {
    expect(countOf("public.report_snapshots", `business_date = date '${date}'`)).toBe(1);
    expect(
      countOf("public.report_snapshots", `business_date = date '${date}' and attempt_ordinal = 2`),
    ).toBe(1);
    expect(countOf("public.daily_reports", `business_date = date '${date}'`)).toBe(1);
    expect(countOf("public.daily_reports", `business_date = date '${date}' and integrity_ok`)).toBe(
      1,
    );
  });

  it("delivers attempt 2's report to every active Director and Manager, and to nobody else", () => {
    expect(eligibleRecipients).toBeGreaterThan(0);
    expect(deliveriesForWinner).toBe(eligibleRecipients);
  });

  it("discards the premature failure audit the superseded worker had already written", () => {
    const runId = runIdFor(date);

    const first = JSON.parse(firstResult) as { created?: boolean; reason?: string; status?: string };
    expect(first.created).not.toBe(true);
    expect(["lease_lost", undefined]).toContain(first.reason);
    if (first.status !== undefined) expect(first.status).toBe("not_owner");

    // The audit event went in before the run status did, and the ownership check then rolled the
    // whole subtransaction back. Nothing about attempt 1's failure survives.
    expect(
      countOf(
        "public.audit_events",
        `action = 'scheduled_report_attempt_failed' and entity_id = '${runId}'::uuid`,
      ),
    ).toBe(0);
    expect(
      countOf("public.report_runs", `id = '${runId}'::uuid and failure_diagnostic is not null`),
    ).toBe(0);
  });

  it("leaves the stale worker no snapshot, no delivery, no terminal state and no alert", () => {
    const runId = runIdFor(date);

    expect(
      countOf("public.report_snapshots", `business_date = date '${date}' and attempt_ordinal = 1`),
    ).toBe(0);
    expect(
      countOf(
        "public.report_deliveries d",
        `d.snapshot_id in (select s.id from public.report_snapshots s
                            where s.business_date = date '${date}' and s.attempt_ordinal = 1)`,
      ),
    ).toBe(0);
    expect(
      countOf("public.report_runs", `id = '${runId}'::uuid and status = 'terminally_failed'`),
    ).toBe(0);
    expect(countOf("public.report_alerts", `business_date = date '${date}'`)).toBe(0);
  });

  it("audits exactly one generation — attempt 2's — and both accepted claims", () => {
    const runId = runIdFor(date);

    // Counted by the run's correlation id, which is attempt 2's now, so the earlier scenarios'
    // audits for the same night are not swept in.
    const correlated =
      `action = 'scheduled_report_generated' and correlation_id = ` +
      `(select correlation_id from public.report_runs where id = '${runId}'::uuid)`;

    expect(countOf("public.audit_events", correlated)).toBe(1);
    expect(
      countOf(
        "public.audit_events",
        `${correlated} and (after_state ->> 'attempt_ordinal')::int = 2`,
      ),
    ).toBe(1);

    expect(
      countOf(
        "public.audit_events",
        `action = 'scheduled_report_attempt_claimed' and entity_id = '${runId}'::uuid`,
      ),
    ).toBe(2);
  });
});
