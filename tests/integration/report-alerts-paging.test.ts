import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createLiveStaff, ensureDirector, type Fixture } from "@/tests/integration/helpers";
import { runSql } from "@/tests/support/database";

/**
 * Issue #19, F3 · every unresolved alert reaches the screen, however many there are.
 *
 * The local API's `max_rows` is 1,000, as it is in production. A single request for the alert view
 * returned the first 1,000 rows with HTTP 200 and no error, so the oldest missing night vanished
 * from the one screen meant to name it while the read looked complete. This drives the REAL loader
 * through the real local PostgREST, signed in as a real Director, with more alerts than one
 * response can carry. Only `createServerSupabase` is replaced, because it reads the request's
 * cookies; the client it returns here is that Director's own session, so RLS decides what comes
 * back exactly as it does in the browser.
 *
 * THE ALERTS ARE WRITTEN DIRECTLY, from the operator's psql prompt, because 1,001 nights cannot be
 * driven through the scheduler in a test. What is under test is the read, not how an alert is
 * raised — that is proved in `017_scheduled_report_retries.sql`. They sit in 1990 and 1992, which
 * no other test uses, and are removed afterwards.
 */

const FIRST = "1990-01-01";
const COUNT = 1001;

const session = vi.hoisted(() => ({ client: null as SupabaseClient | null }));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => {
    if (!session.client) throw new Error("no session was chosen for the loader");
    return session.client;
  },
}));

const { loadReportFailureAlerts } = await import("@/lib/reports/alerts");

let director: Fixture;
let manager: Fixture;
let cashier: Fixture;

function removeSeededAlerts(): void {
  runSql(`
    delete from public.report_alerts
     where business_date between date '${FIRST}' and date '${FIRST}' + ${COUNT - 1};`);
}

/** The whole view as the database orders it, read as its owner, with no API in between. */
function expectedIds(): string[] {
  const listed = runSql(`
    select coalesce(string_agg(id::text, ',' order by business_date desc, id), '')
      from public.report_failure_alerts;`);
  return listed === "" ? [] : listed.split(",");
}

beforeAll(async () => {
  director = await ensureDirector();
  manager = await createLiveStaff(director, "manager");
  cashier = await createLiveStaff(director, "cashier");

  removeSeededAlerts();
  runSql(`
    insert into public.report_alerts (schedule_id, business_date, alert_type, priority, correlation_id)
    select s.id, date '${FIRST}' + g, 'scheduled_report_failed', 'high', gen_random_uuid()
      from public.report_schedules s, generate_series(0, ${COUNT - 1}) g
     where s.code = 'daily_pilot_report';`);
});

afterAll(() => {
  session.client = null;
  removeSeededAlerts();
});

describe("reading more unresolved alerts than one API response carries", () => {
  it("is genuinely past the API's row limit, so one request would have been short", async () => {
    const whole = expectedIds();
    expect(whole.length).toBeGreaterThan(1000);

    const single = await director.read
      .from("report_failure_alerts")
      .select("id", { count: "exact" })
      .order("business_date", { ascending: false });

    expect(single.error).toBeNull();
    expect(single.data).toHaveLength(1000);
    expect(single.count).toBe(whole.length);
  });

  it("hands a Director every alert, newest night first, with none repeated", async () => {
    session.client = director.read;
    const alerts = await loadReportFailureAlerts();

    const ids = alerts.map((alert) => alert.id);
    expect(ids).toEqual(expectedIds());
    expect(new Set(ids).size).toBe(ids.length);

    // The night one unpaged request lost is here, and it is the last one listed.
    expect(alerts.at(-1)!.businessDate).toBe(FIRST);
    const seeded = alerts.filter((alert) => alert.businessDate.startsWith("199"));
    expect(seeded).toHaveLength(COUNT);
  });

  it("hands the Manager the same complete list", async () => {
    session.client = manager.read;
    const alerts = await loadReportFailureAlerts();
    expect(alerts.map((alert) => alert.id)).toEqual(expectedIds());
  });

  it("still hands a Cashier nothing, however many pages there are", async () => {
    session.client = cashier.read;
    await expect(loadReportFailureAlerts()).resolves.toEqual([]);
  });

  it("fails the whole read when the grant is withdrawn, rather than returning nothing", async () => {
    session.client = director.read;
    vi.spyOn(console, "error").mockImplementation(() => {});
    runSql("revoke select on public.report_failure_alerts from authenticated;");
    try {
      await expect(loadReportFailureAlerts()).rejects.toThrow(
        "data_unavailable: reports.failureAlerts",
      );
    } finally {
      runSql("grant select on public.report_failure_alerts to authenticated;");
    }
  });
});
