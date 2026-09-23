import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  PUBLISHABLE_KEY,
  SUPABASE_URL,
  createLiveStaff,
  ensureDirector,
  type Fixture,
} from "@/tests/integration/helpers";
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

/**
 * Issue #51 · The same read with the API's ceiling LOWERED on the real server, and a later page
 * failing over a real session.
 *
 * `max_rows` is lowered through PostgREST's in-database configuration — `pgrst.db_max_rows` on the
 * role PostgREST connects as, then a config reload — so the server itself answers 300 rows to a
 * request for 1,000, with HTTP 200 and no error. That is the case "a short page is the last page"
 * gets wrong, proved against the real API rather than a fake client. The setting is removed and
 * reloaded afterwards, and the wait for each reload is measured rather than slept.
 */
async function servedRowsFor(client: SupabaseClient): Promise<number> {
  const { data } = await client
    .from("report_failure_alerts")
    .select("id")
    .order("business_date", { ascending: false })
    .limit(1000);
  return data?.length ?? -1;
}

async function setServerRowCap(cap: number | null): Promise<void> {
  runSql(
    cap === null
      ? "alter role authenticator reset pgrst.db_max_rows;"
      : `alter role authenticator set pgrst.db_max_rows = '${cap}';`,
  );
  runSql("notify pgrst, 'reload config';");
  // Measured, not slept: the reload is asynchronous, so wait until the server really answers
  // with the new ceiling, and fail loudly if it never does.
  const expected = cap ?? 1000;
  const deadline = Date.now() + 20_000;
  let served = await servedRowsFor(director.read);
  while (served !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    served = await servedRowsFor(director.read);
  }
  if (served !== expected) {
    throw new Error(`the API still serves ${served} rows, not ${expected}, after the config reload`);
  }
}

describe("reading every alert when the server's own row cap is lower than the page asked for", () => {
  beforeAll(async () => {
    await setServerRowCap(300);
  });

  afterAll(async () => {
    await setServerRowCap(null);
  });

  it("really is capped: the server answers 300 rows to a request for 1,000", async () => {
    expect(await servedRowsFor(director.read)).toBe(300);
  });

  it("still hands a Director every alert, in order, with none repeated", async () => {
    session.client = director.read;
    const alerts = await loadReportFailureAlerts();
    const ids = alerts.map((alert) => alert.id);
    expect(ids).toEqual(expectedIds());
    expect(new Set(ids).size).toBe(ids.length);
    expect(alerts.filter((alert) => alert.businessDate.startsWith("199"))).toHaveLength(COUNT);
  });

  it("fails the whole read when a LATER page fails, rather than returning the pages before it", async () => {
    // The Director's own session over real HTTP. The first page really comes back from the server;
    // every request after it is answered with a 503 in transport. EVERY one, not only the next:
    // supabase-js retries a failed GET by itself, so a single injected failure was simply retried
    // away and the read completed — which proved the client's retry, not the loader's refusal.
    let alertRequests = 0;
    const failing = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { Authorization: `Bearer ${director.accessToken}` },
        fetch: async (input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (url.includes("/report_failure_alerts")) {
            alertRequests += 1;
            if (alertRequests >= 2) {
              return new Response(JSON.stringify({ message: "service unavailable" }), {
                status: 503,
                headers: { "content-type": "application/json" },
              });
            }
          }
          return fetch(input, init);
        },
      },
    });

    session.client = failing;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(loadReportFailureAlerts()).rejects.toThrow("data_unavailable: reports.failureAlerts");
    expect(alertRequests).toBeGreaterThanOrEqual(2);
  });
});
