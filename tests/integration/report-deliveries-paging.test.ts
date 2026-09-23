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
 * PR #52, F2 · every delivery is counted and listed, however many there are.
 *
 * The archive once counted deliveries with one unpaged read. The local API's `max_rows` is 1,000,
 * as it is in production, so 60 reports with 17 recipients each came back as 1,000 of 1,020 rows
 * with HTTP 200 and no error, and the last cards read 14 and 0 recipients instead of 17. This drives
 * the REAL loaders through the real local PostgREST, signed in as a real Director. Only
 * `createServerSupabase` is replaced, because it reads the request's cookies; the client it returns
 * is that Director's own session, so RLS decides what comes back exactly as it does in the browser.
 *
 * THE REPORTS ARE WRITTEN DIRECTLY, from the operator's psql prompt, because 60 nights cannot be
 * driven through the scheduler in a test. What is under test is the read. They sit in 2099, which
 * nothing else uses and which makes them the newest 60 the archive shows, and their 17 recipients
 * are inactive accounts with no role, so no other test counts them as staff. All of it is removed
 * afterwards, with the snapshot trigger stepped around for that one operator session exactly as
 * `resetScheduledReportDay` does.
 */

const FIRST = "2099-01-01";
const REPORTS = 60;
const RECIPIENTS = 17;
const RECIPIENT_PREFIX = "f2000000-0000-4000-8000-";

const session = vi.hoisted(() => ({ client: null as SupabaseClient | null }));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => {
    if (!session.client) throw new Error("no session was chosen for the loader");
    return session.client;
  },
}));

const { loadReport, loadReportSummaries } = await import("@/lib/reports/reports");

let director: Fixture;
let manager: Fixture;

function recipientId(n: number): string {
  return `${RECIPIENT_PREFIX}${n.toString(16).padStart(12, "0")}`;
}

function removeSeededReports(): void {
  runSql(`
    set session_replication_role = replica;
    delete from public.report_deliveries d
      using public.report_snapshots s
     where s.id = d.snapshot_id
       and s.business_date between date '${FIRST}' and date '${FIRST}' + ${REPORTS - 1};
    delete from public.report_snapshots
     where business_date between date '${FIRST}' and date '${FIRST}' + ${REPORTS - 1};
    delete from public.report_runs
     where business_date between date '${FIRST}' and date '${FIRST}' + ${REPORTS - 1};
    delete from public.profiles where id::text like '${RECIPIENT_PREFIX}%';
    delete from auth.users      where id::text like '${RECIPIENT_PREFIX}%';
    set session_replication_role = default;`);
}

/** The run id of the seeded report for one night, read as the owner with no API in between. */
function seededRunId(offset: number): string {
  return runSql(`
    select id from public.report_runs where business_date = date '${FIRST}' + ${offset};`);
}

beforeAll(async () => {
  director = await ensureDirector();
  manager = await createLiveStaff(director, "manager");

  removeSeededReports();
  runSql(`
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
    select ('${RECIPIENT_PREFIX}' || lpad(to_hex(g), 12, '0'))::uuid,
           '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'f2-recipient-' || g || '@test.local', extensions.crypt('x', extensions.gen_salt('bf')),
           now(), now()
      from generate_series(1, ${RECIPIENTS}) g;

    insert into public.profiles (id, full_name, phone_e164, is_active, must_change_password)
    select ('${RECIPIENT_PREFIX}' || lpad(to_hex(g), 12, '0'))::uuid,
           'F2 Recipient ' || lpad(g::text, 2, '0'), '+2557999900' || lpad(g::text, 2, '0'),
           false, false
      from generate_series(1, ${RECIPIENTS}) g;

    insert into public.report_runs (schedule_id, business_date, correlation_id, status, generated_at,
                                    claim_token, claimed_at, lease_expires_at, completed_at)
    select s.id, date '${FIRST}' + g, gen_random_uuid(), 'succeeded', now(),
           gen_random_uuid(), now(), now(), now()
      from public.report_schedules s, generate_series(0, ${REPORTS - 1}) g
     where s.code = 'daily_pilot_report';

    insert into public.report_snapshots (run_id, business_date, attempt_ordinal, schema_version,
                                         content, content_sha256)
    select r.id, r.business_date, 1, 1, '{}'::jsonb, repeat('0', 64)
      from public.report_runs r
     where r.business_date between date '${FIRST}' and date '${FIRST}' + ${REPORTS - 1};

    insert into public.report_deliveries (snapshot_id, recipient_id, recipient_role)
    select s.id, ('${RECIPIENT_PREFIX}' || lpad(to_hex(g), 12, '0'))::uuid,
           case when g = 1 then 'manager'::public.app_role else 'director' end
      from public.report_snapshots s, generate_series(1, ${RECIPIENTS}) g
     where s.business_date between date '${FIRST}' and date '${FIRST}' + ${REPORTS - 1};`);
});

afterAll(() => {
  session.client = null;
  removeSeededReports();
});

/** How many delivery rows the server hands back to one request for 1,000 of them. */
async function servedRowsFor(client: SupabaseClient): Promise<number> {
  const { data } = await client.from("report_deliveries").select("snapshot_id").limit(1000);
  return data?.length ?? -1;
}

/**
 * `max_rows` lowered on the real server through PostgREST's in-database configuration, then a
 * reload, as `report-alerts-paging.test.ts` does. The wait is measured rather than slept.
 */
async function setServerRowCap(cap: number | null): Promise<void> {
  runSql(
    cap === null
      ? "alter role authenticator reset pgrst.db_max_rows;"
      : `alter role authenticator set pgrst.db_max_rows = '${cap}';`,
  );
  runSql("notify pgrst, 'reload config';");
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

function seededCards(summaries: Awaited<ReturnType<typeof loadReportSummaries>>) {
  return summaries.filter((summary) => summary.businessDate.startsWith("2099-"));
}

describe("counting more deliveries than one API response carries", () => {
  it("is genuinely past the API's row limit, so one request would have been short", async () => {
    const total = Number(
      runSql(`
        select count(*) from public.report_deliveries d
          join public.report_snapshots s on s.id = d.snapshot_id
         where s.business_date between date '${FIRST}' and date '${FIRST}' + ${REPORTS - 1};`),
    );
    expect(total).toBe(REPORTS * RECIPIENTS);
    expect(total).toBeGreaterThan(1000);
    expect(await servedRowsFor(director.read)).toBe(1000);
  });

  it("shows a Director all 17 recipients on every one of the 60 newest cards", async () => {
    session.client = director.read;
    const cards = seededCards(await loadReportSummaries());
    expect(cards).toHaveLength(REPORTS);
    expect(cards.map((card) => card.recipientCount)).toEqual(Array(REPORTS).fill(RECIPIENTS));
  });

  it("shows the Manager the same counts", async () => {
    session.client = manager.read;
    const cards = seededCards(await loadReportSummaries());
    expect(cards.map((card) => card.recipientCount)).toEqual(Array(REPORTS).fill(RECIPIENTS));
  });
});

describe("counting and listing deliveries when the server's own row cap is lower", () => {
  afterAll(async () => {
    await setServerRowCap(null);
  });

  it("still counts every recipient on every card at a cap of 300", async () => {
    await setServerRowCap(300);
    expect(await servedRowsFor(director.read)).toBe(300);

    session.client = director.read;
    const cards = seededCards(await loadReportSummaries());
    expect(cards.map((card) => card.recipientCount)).toEqual(Array(REPORTS).fill(RECIPIENTS));
  });

  it("still lists every recipient of one report at a cap of 5, none repeated", async () => {
    await setServerRowCap(5);

    session.client = director.read;
    const report = await loadReport(seededRunId(0));
    const ids = report?.recipients.map((recipient) => recipient.id) ?? [];
    expect(ids).toHaveLength(RECIPIENTS);
    expect(new Set(ids)).toEqual(new Set(Array.from({ length: RECIPIENTS }, (_, i) => recipientId(i + 1))));
  });

  it("fails the whole count when a LATER page fails, rather than counting the pages before it", async () => {
    await setServerRowCap(300);

    // The first delivery page really comes back from the server; every delivery request after it
    // is answered with a 503 in transport. EVERY one, because supabase-js retries a failed GET by
    // itself and a single injected failure would simply be retried away.
    let deliveryRequests = 0;
    const failing = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { Authorization: `Bearer ${director.accessToken}` },
        fetch: async (input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (url.includes("/report_deliveries")) {
            deliveryRequests += 1;
            if (deliveryRequests >= 2) {
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
    await expect(loadReportSummaries()).rejects.toThrow("data_unavailable: reports.deliveryCounts");
    expect(deliveryRequests).toBeGreaterThanOrEqual(2);
  });
});
