import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reading EVERY unresolved alert, through the API's per-response row limit (issue #19, F3).
 *
 * PostgREST answers at most `max_rows` rows with HTTP 200 and no error. One unpaged read of 1,001
 * alerts therefore returned 1,000 and looked complete. These tests drive the real loader through
 * the real Supabase client, and replace only the network: a small PostgREST stand-in that honours
 * the same ordering, keyset filter, row cap and exact count the real one does, so each boundary
 * can be hit exactly and each failure injected on exactly the page it matters on.
 *
 * `tests/integration/reports.test.ts` proves the same thing against the real local API as a real
 * Director; this file covers the edges that are impractical to stage there.
 */

type Row = {
  id: string;
  business_date: string;
  alert_type: string;
  priority: string;
  raised_at: string;
};

type Request = { url: URL; prefer: string };

type Server = {
  rows: Row[];
  /** The API's own `max_rows`: no response carries more rows than this, whatever was asked. */
  cap: number;
  requests: Request[];
  /** Replaces the response for one request, by its zero-based position. */
  override?: (index: number, rows: Row[], total: number) => Response | undefined;
};

const server = vi.hoisted(() => ({ current: null as unknown as Server }));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () =>
    createClient("http://postgrest.test", "unit-test-key", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => respond(new URL(String(input)), init) },
    }),
}));

const { ALERT_PAGE_SIZE, loadReportFailureAlerts } = await import("@/lib/reports/alerts");

/** Newest night first, then by id — the order the loader asks for and the view index serves. */
function ordered(rows: Row[]): Row[] {
  return [...rows].sort((a, b) =>
    a.business_date === b.business_date
      ? a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      : a.business_date < b.business_date ? 1 : -1,
  );
}

/** The one keyset filter the loader writes: after (date, id) in the list's order. */
function afterCursor(filter: string | null): (row: Row) => boolean {
  if (filter === null) return () => true;
  const match = /^\(business_date\.lt\.(\d{4}-\d{2}-\d{2}),and\(business_date\.eq\.\1,id\.gt\.([0-9a-f-]{36})\)\)$/.exec(
    filter,
  );
  if (!match) throw new Error(`unexpected filter: ${filter}`);
  const [, date, id] = match;
  return (row) => row.business_date < date! || (row.business_date === date && row.id > id!);
}

async function respond(url: URL, init?: RequestInit): Promise<Response> {
  const current = server.current;
  const prefer = new Headers(init?.headers).get("prefer") ?? "";
  const index = current.requests.push({ url, prefer }) - 1;

  expect(url.pathname).toBe("/rest/v1/report_failure_alerts");
  expect(url.searchParams.get("order")).toBe("business_date.desc,id.asc");

  const matching = ordered(current.rows).filter(afterCursor(url.searchParams.get("or")));
  const limit = Math.min(Number(url.searchParams.get("limit")), current.cap);
  const page = matching.slice(0, limit);

  const replaced = current.override?.(index, page, matching.length);
  if (replaced) return replaced;

  const range = page.length === 0 ? "*" : `0-${page.length - 1}`;
  const total = prefer.includes("count=exact") ? String(matching.length) : "*";
  return new Response(JSON.stringify(page), {
    status: 200,
    headers: { "content-type": "application/json", "content-range": `${range}/${total}` },
  });
}

/** A valid uuid whose text order is its number's order. */
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** `count` alerts on consecutive nights counting back from 2026-08-27, one per night. */
function nights(count: number, start = 0): Row[] {
  const base = Date.UTC(2026, 7, 27);
  return Array.from({ length: count }, (_, i) => ({
    id: uuid(start + i + 1),
    business_date: new Date(base - (start + i) * 86_400_000).toISOString().slice(0, 10),
    alert_type: "scheduled_report_failed",
    priority: "high",
    raised_at: "2026-08-28T21:30:00Z",
  }));
}

function serve(rows: Row[], options: Partial<Omit<Server, "rows" | "requests">> = {}): Server {
  server.current = { rows, cap: 1000, requests: [], ...options };
  return server.current;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("reading every unresolved alert", () => {
  it("asks for no more than the API's own row limit per request", () => {
    expect(ALERT_PAGE_SIZE).toBe(1000);
  });

  it("returns an empty list after one request when no night is unresolved", async () => {
    const api = serve([]);

    await expect(loadReportFailureAlerts()).resolves.toEqual([]);
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]!.prefer).toContain("count=exact");
    expect(api.requests[0]!.url.searchParams.get("limit")).toBe("1000");
  });

  it("reads a list that fits one page in one request", async () => {
    const api = serve(nights(3));

    const alerts = await loadReportFailureAlerts();
    expect(alerts.map((a) => a.businessDate)).toEqual(["2026-08-27", "2026-08-26", "2026-08-25"]);
    expect(api.requests).toHaveLength(1);
  });

  it.each([
    [999, 1],
    [1000, 1],
    [1001, 2],
    [2000, 2],
    [2001, 3],
  ])("returns all %i alerts in %i requests at the 1,000-row limit", async (count, requests) => {
    const rows = nights(count);
    const api = serve(rows);

    const alerts = await loadReportFailureAlerts();

    expect(alerts).toHaveLength(count);
    expect(alerts.map((a) => a.id)).toEqual(ordered(rows).map((r) => r.id));
    expect(new Set(alerts.map((a) => a.id)).size).toBe(count);
    expect(api.requests).toHaveLength(requests);
  });

  it("starts each later page strictly after the last alert already read", async () => {
    const rows = nights(1001);
    const api = serve(rows);

    await loadReportFailureAlerts();

    const lastOfFirstPage = ordered(rows)[999]!;
    expect(api.requests[0]!.url.searchParams.get("or")).toBeNull();
    expect(api.requests[1]!.url.searchParams.get("or")).toBe(
      `(business_date.lt.${lastOfFirstPage.business_date},` +
        `and(business_date.eq.${lastOfFirstPage.business_date},id.gt.${lastOfFirstPage.id}))`,
    );
  });

  it("still returns everything when the API's limit is lower than the page it was asked for", async () => {
    // A short page is not the last page. Were `max_rows` lowered to 250, a loader that stopped at
    // the first page shorter than 1,000 would return 250 alerts and call the list complete.
    const rows = nights(1001);
    const api = serve(rows, { cap: 250 });

    const alerts = await loadReportFailureAlerts();

    expect(alerts).toHaveLength(1001);
    expect(alerts.at(-1)!.id).toBe(ordered(rows).at(-1)!.id);
    expect(api.requests).toHaveLength(5);
  });

  it("orders nights that share a date by id, and neither skips nor repeats one across a page boundary", async () => {
    // More than one alert can name the same night (one per schedule), and a page boundary can fall
    // between them. The id is the tie-break that makes the cursor exact.
    const sameNight = Array.from({ length: 5 }, (_, i) => ({
      ...nights(1)[0]!,
      id: uuid(9000 - i),
      business_date: "2022-06-01",
    }));
    const rows = [...nights(998), ...sameNight, ...nights(2, 2000)];
    serve(rows);
    // Positions 998 to 1002: the first page ends two alerts into the shared night.
    expect(ordered(rows).slice(998, 1003).every((r) => r.business_date === "2022-06-01")).toBe(true);

    const alerts = await loadReportFailureAlerts();
    const ids = alerts.map((a) => a.id);

    expect(ids).toEqual(ordered(rows).map((r) => r.id));
    expect(new Set(ids).size).toBe(rows.length);
    const shared = alerts.filter((a) => a.businessDate === "2022-06-01").map((a) => a.id);
    expect(shared).toEqual([...shared].sort());
    for (let i = 1; i < alerts.length; i++) {
      expect(alerts[i]!.businessDate <= alerts[i - 1]!.businessDate).toBe(true);
    }
  });
});

describe("a read that cannot be trusted fails as a whole", () => {
  it("fails when a later page is refused, rather than returning the first page", async () => {
    serve(nights(1500), {
      override: (index) =>
        index === 1
          ? new Response(JSON.stringify({ code: "57014", message: "canceling statement" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            })
          : undefined,
    });

    await expect(loadReportFailureAlerts()).rejects.toThrow("data_unavailable: reports.failureAlerts");
  });

  it("fails when a later page carries a row this build cannot read", async () => {
    // The oldest night, so it is on the second page; the value is refused, not the position.
    const rows = nights(1500);
    rows[1499] = { ...rows[1499]!, raised_at: "2026-08-28T21:30:00" };
    serve(rows);

    await expect(loadReportFailureAlerts()).rejects.toThrow("data_unavailable: reports.failureAlerts");
  });

  it("fails when a later page repeats a row the first page already returned", async () => {
    const rows = nights(1500);
    const repeated = ordered(rows)[999]!;
    serve(rows, {
      override: (index, page, total) =>
        index === 1
          ? new Response(JSON.stringify([repeated, ...page]), {
              status: 200,
              headers: { "content-range": `0-${page.length}/${total}` },
            })
          : undefined,
    });

    await expect(loadReportFailureAlerts()).rejects.toThrow("data_unavailable: reports.failureAlerts");
  });

  it("fails when a page's rows are not in the order they were asked for", async () => {
    serve(nights(10), {
      override: (_index, page, total) =>
        new Response(JSON.stringify([page[1], page[0], ...page.slice(2)]), {
          status: 200,
          headers: { "content-range": `0-${page.length - 1}/${total}` },
        }),
    });

    await expect(loadReportFailureAlerts()).rejects.toThrow("data_unavailable: reports.failureAlerts");
  });

  it("fails when a page arrives without an exact count, because completion cannot then be known", async () => {
    serve(nights(10), {
      override: (_index, page) =>
        new Response(JSON.stringify(page), {
          status: 200,
          headers: { "content-range": `0-${page.length - 1}/*` },
        }),
    });

    await expect(loadReportFailureAlerts()).rejects.toThrow("data_unavailable: reports.failureAlerts");
  });

  it("fails when a page is empty while its count says rows remain", async () => {
    serve(nights(1500), {
      override: (index, _page, total) =>
        index === 1
          ? new Response("[]", { status: 200, headers: { "content-range": `*/${total}` } })
          : undefined,
    });

    await expect(loadReportFailureAlerts()).rejects.toThrow("data_unavailable: reports.failureAlerts");
  });

  it("fails when a page holds more rows than its count", async () => {
    serve(nights(3), {
      override: (_index, page) =>
        new Response(JSON.stringify(page), {
          status: 200,
          headers: { "content-range": `0-${page.length - 1}/2` },
        }),
    });

    await expect(loadReportFailureAlerts()).rejects.toThrow("data_unavailable: reports.failureAlerts");
  });
});
