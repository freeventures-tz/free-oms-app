import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

import {
  PUBLISHABLE_KEY,
  SECRET_KEY,
  SUPABASE_URL,
  callApiRpc,
  createLiveStaff,
  ensureDirector,
  type Fixture,
} from "@/tests/integration/helpers";
import {
  clearTerminalReportFailure,
  runScheduledReport,
  seedTerminalReportFailure,
  type ScheduledReportResult,
} from "@/tests/support/scheduled-report";

/**
 * The daily report, over real HTTP through PostgREST.
 *
 * pgTAP already proves the rules inside the database. These tests prove the same rules survive the
 * journey a browser actually takes, and they cover the two things a direct SQL session structurally
 * cannot see:
 *
 *   1. WHAT THE DATA API EXPOSES. `private.run_scheduled_report(attempt)` must be unreachable over
 *      HTTP — not merely ungranted, but absent from every callable surface. A pgTAP session running
 *      as the table owner would never notice a schema that had been exposed by accident.
 *
 *   2. WHAT A REAL SESSION IS HANDED. A Cashier signed in with a genuine token asking PostgREST for
 *      `daily_reports` is the exact request the route guard is NOT protecting against, because the
 *      route guard is not in that path at all.
 */
let director: Fixture;
let manager: Fixture;
let cashier: Fixture;
let salesRep: Fixture;

let generated: ScheduledReportResult;

beforeAll(async () => {
  director = await ensureDirector();
  manager = await createLiveStaff(director, "manager");
  cashier = await createLiveStaff(director, "cashier");
  salesRep = await createLiveStaff(director, "sales_rep");

  // Everybody exists BEFORE the report is generated, because §18.1's recipients are the accounts
  // present at generation. Creating them afterwards would prove nothing about the delivery rule.
  generated = runScheduledReport();
  expect(generated.ok, JSON.stringify(generated)).toBe(true);
});

describe("the scheduled generator", () => {
  it("writes the previous business day's report with a digest and its recipients", async () => {
    expect(generated.created).toBe(true);
    expect(generated.business_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(generated.content_sha256).toMatch(/^[0-9a-f]{64}$/);

    // Counted rather than hard-coded: this file shares one database with every other integration
    // file, so how many Directors and Managers exist depends on what ran before it. What must hold
    // is that the report reached ALL of them.
    const { data: holders } = await director.read
      .from("user_roles")
      .select("user_id, role")
      .in("role", ["director", "manager"]);

    const { data: live } = await director.read.from("profiles").select("id").eq("is_active", true);

    const active = new Set((live ?? []).map((row) => row.id));
    const recipients = (holders ?? []).filter((row) => active.has(row.user_id));

    expect(recipients.length).toBeGreaterThanOrEqual(2);
    expect(generated.recipient_count).toBe(recipients.length);
  });

  it("does nothing at all when the slot is replayed", () => {
    const again = runScheduledReport();
    expect(again.created).toBe(false);
    expect(again.reason).toBe("already_generated");
    expect(again.business_date).toBe(generated.business_date);
  });

  it("cannot be called through the Data API by any key", async () => {
    for (const name of ["run_scheduled_report", "run_report_attempt", "report_content"]) {
      const asUser = await callApiRpc(name, {}, PUBLISHABLE_KEY, director.accessToken);
      const asService = await callApiRpc(name, {}, SECRET_KEY);

      // PostgREST answers PGRST202 for a function that is not on the exposed surface at all.
      expect(asUser.status, `${name} as a Director`).toBeGreaterThanOrEqual(400);
      expect(asService.status, `${name} with the secret key`).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("who may read a report", () => {
  it("hands a Director the day, the time and the integrity finding", async () => {
    const { data, error } = await director.read
      .from("daily_reports")
      .select("run_id, business_date, generated_at, integrity_ok")
      .order("business_date", { ascending: false });

    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.[0].business_date).toBe(generated.business_date);
    expect(data?.[0].integrity_ok).toBe(true);
  });

  it("hands the Manager the same report", async () => {
    const { data, error } = await manager.read
      .from("daily_reports")
      .select("run_id, business_date, integrity_ok")
      .eq("run_id", generated.run_id!);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0].integrity_ok).toBe(true);
  });

  it("hands a Cashier nothing, without them having to be stopped at a route", async () => {
    const { data, error } = await cashier.read.from("daily_reports").select("run_id");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("hands a Sales Representative nothing, through the view or the tables beneath it", async () => {
    const relations: [string, string][] = [
      ["daily_reports", "run_id"],
      ["report_snapshots", "id"],
      ["report_runs", "id"],
      ["report_deliveries", "id"],
    ];

    for (const [relation, column] of relations) {
      const { data, error } = await salesRep.read.from(relation).select(column);
      expect(error, `${relation} errored instead of returning nothing`).toBeNull();
      expect(data, relation).toEqual([]);
    }
  });

  it("hands an anonymous caller nothing", async () => {
    const anonymous = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await anonymous.from("daily_reports").select("run_id");
    // `anon` holds no grant on the view at all, so this is refused before RLS is even consulted.
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  it("is not reachable with the secret key either", async () => {
    const service = createClient(SUPABASE_URL, SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await service.from("daily_reports").select("run_id");
    // A leaked secret key reaches `api.service_*` and nothing else. Reports are not its business.
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });
});

describe("what the report says", () => {
  async function content(): Promise<Record<string, Record<string, Record<string, unknown>>>> {
    const { data, error } = await director.read
      .from("daily_reports")
      .select("content, schema_version, content_sha256")
      .eq("run_id", generated.run_id!)
      .single();

    expect(error).toBeNull();
    return data!.content as Record<string, Record<string, Record<string, unknown>>>;
  }

  it("carries every approved pilot section", async () => {
    expect(Object.keys((await content()).sections).sort()).toEqual([
      "cashier_reconciliation",
      "discounts_and_approvals",
      "imprest",
      "inventory_variances",
      "invoices",
      "outstanding_credit",
      "paid_but_unreleased",
      "payments_by_method",
      "pending_approvals",
      "production_batches",
      "production_output",
      "released_stock",
      "sales",
      "supplier_shortages",
    ]);
  });

  it("says the till was not counted, and says it with nulls rather than zeroes", async () => {
    const till = (await content()).sections.cashier_reconciliation;

    expect(till.state).toBe("not_counted");
    expect(till.counted_tzs).toBeNull();
    expect(till.expected_tzs).toBeNull();
    expect(till.variance_tzs).toBeNull();
    expect(till.missing_reason).toBe("no_cash_reconciliation_record");
  });

  // Issue #51: which state this is depends on whether an earlier integration file opened the fund
  // (files run in order, and `imprest-funding.test.ts` does). Both are legitimate, so the test asks
  // the database which one is true and requires the report to say exactly that — and in NEITHER may
  // an imprest count, an expense or a balance appear as a number.
  it("says the imprest count was not taken, and names the fund only by its real identity", async () => {
    const imprest = (await content()).sections.imprest as unknown as Record<string, unknown>;
    const count = imprest.reconciliation as Record<string, unknown>;

    const { data: funds, error } = await director.read
      .from("imprest_funds")
      .select("id")
      .eq("is_active", true);
    expect(error).toBeNull();

    expect(count.state).toBe("not_counted");
    expect(count.counted_tzs).toBeNull();
    expect(count.variance_tzs).toBeNull();
    expect(imprest.fund_no).toBeNull();
    expect(imprest.approved_expenses).toBeNull();
    expect(imprest.position).toBeNull();
    expect(imprest.unavailable).toEqual({
      approved_expenses: "imprest_spending_not_built",
      position: "imprest_spending_not_built",
    });

    if ((funds ?? []).length === 0) {
      expect(imprest.state).toBe("no_fund");
      expect(imprest.fund_id).toBeNull();
      expect(count.missing_reason).toBe("no_imprest_fund");
    } else {
      const funding = imprest.funding as Record<string, unknown>;
      expect(imprest.state).toBe("active");
      expect(imprest.fund_id).toBe(funds![0].id);
      expect(count.missing_reason).toBe("no_reconciliation_record");
      expect(funding.approved_tzs).toBeNull();
      expect(funding.provided_tzs).toBeNull();
      expect(typeof funding.received_tzs).toBe("number");
    }
  });

  it("names the business day and the clock it was built against", async () => {
    const document = (await content()) as unknown as Record<string, unknown>;
    expect(document.business_date).toBe(generated.business_date);
    expect(document.time_zone).toBe("Africa/Dar_es_Salaam");
    expect(document.schema_version).toBe(1);
  });
});

describe("delivery", () => {
  it("records one for every active Director and Manager and nobody else", async () => {
    const { data, error } = await director.read
      .from("report_deliveries")
      .select("recipient_id, recipient_role")
      .eq("snapshot_id", generated.snapshot_id!);

    expect(error).toBeNull();

    const roles = new Set((data ?? []).map((row) => row.recipient_role));
    expect([...roles].sort()).toEqual(["director", "manager"]);

    const recipients = (data ?? []).map((row) => row.recipient_id);
    expect(recipients).toContain(director.userId);
    expect(recipients).toContain(manager.userId);
    expect(recipients).not.toContain(cashier.userId);
    expect(recipients).not.toContain(salesRep.userId);
  });
});

describe("a report cannot be changed from outside", () => {
  it("refuses a Director's own attempt to edit or remove a snapshot", async () => {
    const edit = await director.read
      .from("report_snapshots")
      .update({ business_date: "2020-01-01" })
      .eq("run_id", generated.run_id!);

    const removal = await director.read
      .from("report_snapshots")
      .delete()
      .eq("run_id", generated.run_id!);

    // No UPDATE or DELETE grant exists for `authenticated`, so PostgREST never reaches the trigger.
    expect(edit.error).not.toBeNull();
    expect(removal.error).not.toBeNull();

    const { data } = await director.read
      .from("daily_reports")
      .select("business_date, integrity_ok")
      .eq("run_id", generated.run_id!)
      .single();

    expect(data?.business_date).toBe(generated.business_date);
    expect(data?.integrity_ok).toBe(true);
  });
});

/**
 * Issue #19 · the alert a night with no report at all leaves behind.
 *
 * The path TO a terminal failure is proved in `017_scheduled_report_retries.sql`, where all four
 * slots are really driven and really fail. What only a real HTTP test can see is the other half:
 * WHO IS HANDED THE ALERT once it exists. A route guard is not in this path at all — these are the
 * requests a signed-in session makes of PostgREST directly, which is exactly what a route guard
 * cannot protect.
 *
 * The failure is seeded against an OLDER business date, because the one the scheduler is on already
 * has the report generated at the top of this file, and a business date cannot be both reported and
 * terminally failed. `seedTerminalReportFailure` explains why no scheduled entry point can be
 * pointed at another day — it is the feature working.
 */
describe("who may read a report-failure alert", () => {
  const FAILED_DATE = "2026-01-09";

  let inactiveManager: Fixture;
  let seeded: { runId: string; alertId: string };

  beforeAll(async () => {
    seeded = seedTerminalReportFailure(FAILED_DATE);

    inactiveManager = await createLiveStaff(director, "manager");
    const { data: deactivated } = await director.api.rpc("admin_set_account_active", {
      p_target_user_id: inactiveManager.userId,
      p_is_active: false,
    });
    expect(deactivated.ok).toBe(true);
  });

  afterAll(() => {
    clearTerminalReportFailure(FAILED_DATE);
  });

  it("shows a Director the night that has no report, at high priority", async () => {
    const { data, error } = await director.read
      .from("report_failure_alerts")
      .select("id, business_date, alert_type, priority")
      .eq("business_date", FAILED_DATE);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]).toMatchObject({
      id: seeded.alertId,
      business_date: FAILED_DATE,
      alert_type: "scheduled_report_failed",
      priority: "high",
    });
  });

  it("shows the Manager the same one", async () => {
    const { data, error } = await manager.read
      .from("report_failure_alerts")
      .select("id")
      .eq("business_date", FAILED_DATE);

    expect(error).toBeNull();
    expect(data?.map((row) => row.id)).toEqual([seeded.alertId]);
  });

  it("hands a Cashier nothing, through the view or the table beneath it", async () => {
    const view = await cashier.read.from("report_failure_alerts").select("id");
    const table = await cashier.read.from("report_alerts").select("id");

    expect(view.error).toBeNull();
    expect(view.data).toEqual([]);
    expect(table.error).toBeNull();
    expect(table.data).toEqual([]);
  });

  it("hands a Sales Representative nothing either", async () => {
    const { data, error } = await salesRep.read.from("report_failure_alerts").select("id");

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("hands a deactivated Manager nothing, though their token is still valid", async () => {
    const { data, error } = await inactiveManager.read
      .from("report_failure_alerts")
      .select("id");

    // The session is intact; the authority is not. `private.authorize` re-checks the account on
    // every candidate row rather than trusting the role the token was minted with.
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("hands an anonymous caller nothing", async () => {
    const anonymous = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const view = await anonymous.from("report_failure_alerts").select("id");
    const table = await anonymous.from("report_alerts").select("id");

    // `anon` holds no grant at all, so both are refused before RLS is even consulted.
    expect(view.error).not.toBeNull();
    expect(table.error).not.toBeNull();
  });

  it("is not reachable with the secret key either, and cannot be written with it", async () => {
    const service = createClient(SUPABASE_URL, SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const read = await service.from("report_failure_alerts").select("id");
    const write = await service.from("report_alerts").insert({
      business_date: FAILED_DATE,
      alert_type: "scheduled_report_failed",
      priority: "high",
    });

    expect(read.error).not.toBeNull();
    expect(write.error).not.toBeNull();
  });

  it("cannot be raised, resolved or removed by a Director's own session", async () => {
    const raise = await director.read.from("report_alerts").insert({
      business_date: FAILED_DATE,
      alert_type: "scheduled_report_failed",
      priority: "high",
    });
    const removal = await director.read.from("report_alerts").delete().eq("id", seeded.alertId);

    // Read and nothing else. Issue #19 keeps the alert read-only: nobody makes a missing night go
    // away by acting on the warning about it.
    expect(raise.error).not.toBeNull();
    expect(removal.error).not.toBeNull();

    const { data } = await director.read
      .from("report_failure_alerts")
      .select("id")
      .eq("business_date", FAILED_DATE);
    expect(data).toHaveLength(1);
  });

  it("does not show a night that has a report, however the alert got there", async () => {
    // The generated report at the top of this file is the resolved case: its business date has a
    // successful run, so an alert naming it would not be unresolved. There is no such alert, and
    // the archive read proves the same date is genuinely reported.
    const { data: alerts } = await director.read
      .from("report_failure_alerts")
      .select("business_date");

    expect(alerts?.map((row) => row.business_date)).not.toContain(generated.business_date);

    const { data: reports } = await director.read
      .from("daily_reports")
      .select("business_date")
      .eq("business_date", generated.business_date!);

    expect(reports).toHaveLength(1);
  });

  it("keeps the private retry functions off every Data API surface", async () => {
    for (const name of [
      "generate_scheduled_report",
      "claim_report_attempt",
      "complete_report_run",
      "fail_report_run",
      "raise_report_failure_alert",
    ]) {
      const asUser = await callApiRpc(name, {}, PUBLISHABLE_KEY, director.accessToken);
      const asService = await callApiRpc(name, {}, SECRET_KEY);

      expect(asUser.status, `${name} as a signed-in Director`).toBeGreaterThanOrEqual(400);
      expect(asService.status, `${name} with the secret key`).toBeGreaterThanOrEqual(400);
    }
  });
});
