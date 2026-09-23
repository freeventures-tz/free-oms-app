import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Counting and listing EVERY delivery, through the API's per-response row limit (PR #52, F2).
 *
 * PostgREST answers at most `max_rows` rows with HTTP 200 and no error. The archive once counted
 * deliveries with one unpaged read, so 60 reports with 17 recipients each came back as 1,000 of
 * 1,020 rows, and the last two cards read 14 and 0 recipients instead of 17. These tests drive the
 * real loaders through the real Supabase client and replace only the network: a PostgREST stand-in
 * that honours the same ordering, keyset filter, row cap and exact count the real one does, so each
 * boundary can be hit exactly and each failure injected on exactly the page it matters on.
 */

type Report = {
  run_id: string;
  snapshot_id: string;
  business_date: string;
  generated_at: string;
  integrity_ok: boolean;
  content_sha256: string;
  content: unknown;
};

type Delivery = {
  snapshot_id: string;
  recipient_id: string;
  recipient_role: string;
  profiles: { full_name: string };
};

type Request = { url: URL; prefer: string };

type Server = {
  reports: Report[];
  deliveries: Delivery[];
  /** The API's own `max_rows`: no response carries more rows than this, whatever was asked. */
  cap: number;
  /** Every request to `report_deliveries`, in order. */
  requests: Request[];
  /** Replaces the response for one delivery request, by its zero-based position. */
  override?: (index: number, rows: Delivery[], total: number) => Response | undefined;
};

const server = vi.hoisted(() => ({ current: null as unknown as Server }));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () =>
    createClient("http://postgrest.test", "unit-test-key", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => respond(new URL(String(input)), init) },
    }),
}));

const { DELIVERY_PAGE_SIZE, loadReport, loadReportSummaries } = await import("@/lib/reports/reports");

function json(rows: unknown[], total: number | "*"): Response {
  const range = rows.length === 0 ? "*" : `0-${rows.length - 1}`;
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { "content-type": "application/json", "content-range": `${range}/${total}` },
  });
}

/** By snapshot, then by recipient — the order the loader asks for and the unique index serves. */
function ordered(rows: Delivery[]): Delivery[] {
  const key = (d: Delivery) => `${d.snapshot_id}/${d.recipient_id}`;
  return [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** The one keyset filter the loader writes: after (snapshot, recipient) in the list's order. */
function afterCursor(filter: string | null): (row: Delivery) => boolean {
  if (filter === null) return () => true;
  const match =
    /^\(snapshot_id\.gt\.([0-9a-f-]{36}),and\(snapshot_id\.eq\.\1,recipient_id\.gt\.([0-9a-f-]{36})\)\)$/.exec(
      filter,
    );
  if (!match) throw new Error(`unexpected filter: ${filter}`);
  const [, snapshot, recipient] = match;
  return (row) =>
    row.snapshot_id > snapshot! || (row.snapshot_id === snapshot && row.recipient_id > recipient!);
}

async function respond(url: URL, init?: RequestInit): Promise<Response> {
  const current = server.current;
  // A request with no `limit` still gets at most `max_rows` rows: the cap is the server's, not the
  // caller's.
  const asked = url.searchParams.get("limit");
  const limit = Math.min(asked === null ? Infinity : Number(asked), current.cap);

  if (url.pathname === "/rest/v1/daily_reports") {
    const runId = url.searchParams.get("run_id");
    const rows = runId
      ? current.reports.filter((r) => `eq.${r.run_id}` === runId)
      : current.reports;
    return json(rows.slice(0, limit), "*");
  }

  expect(url.pathname).toBe("/rest/v1/report_deliveries");

  const prefer = new Headers(init?.headers).get("prefer") ?? "";
  const index = current.requests.push({ url, prefer }) - 1;

  const filter = url.searchParams.get("snapshot_id") ?? "";
  const listed = /^in\.\((.*)\)$/.exec(filter) ?? /^eq\.(.*)$/.exec(filter);
  const wanted = new Set(listed ? listed[1]!.split(",") : []);

  const matching = ordered(current.deliveries)
    .filter((d) => wanted.has(d.snapshot_id))
    .filter(afterCursor(url.searchParams.get("or")));
  const page = matching.slice(0, limit);

  const replaced = current.override?.(index, page, matching.length);
  if (replaced) return replaced;

  return json(page, prefer.includes("count=exact") ? matching.length : "*");
}

/** A valid uuid whose text order is its number's order. */
function uuid(prefix: string, n: number): string {
  return `${prefix}000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** `count` reports, newest night first, each with `perReport` recipients. */
function archive(count: number, perReport: number): Pick<Server, "reports" | "deliveries"> {
  const reports = Array.from({ length: count }, (_, i) => ({
    run_id: uuid("a0", i + 1),
    snapshot_id: uuid("b0", i + 1),
    business_date: new Date(Date.UTC(2026, 8, 22) - i * 86_400_000).toISOString().slice(0, 10),
    generated_at: "2026-09-22T21:01:00Z",
    integrity_ok: true,
    content_sha256: "0".repeat(64),
    content: {},
  }));
  const deliveries = reports.flatMap((r) =>
    Array.from({ length: perReport }, (_, j) => ({
      snapshot_id: r.snapshot_id,
      recipient_id: uuid("c0", j + 1),
      recipient_role: j === 0 ? "manager" : "director",
      profiles: { full_name: `Recipient ${String(j + 1).padStart(4, "0")}` },
    })),
  );
  return { reports, deliveries };
}

function serve(
  data: Pick<Server, "reports" | "deliveries">,
  options: Partial<Pick<Server, "cap" | "override">> = {},
): Server {
  server.current = { ...data, cap: 1000, requests: [], ...options };
  return server.current;
}

const refused = () =>
  new Response(JSON.stringify({ code: "57014", message: "canceling statement" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("counting every delivery on the archive", () => {
  it("asks for no more than the API's own row limit per request", () => {
    expect(DELIVERY_PAGE_SIZE).toBe(1000);
  });

  it("counts all 17 recipients on each of 60 cards -- 1,020 rows, past one response", async () => {
    const api = serve(archive(60, 17));

    const summaries = await loadReportSummaries();

    expect(summaries).toHaveLength(60);
    expect(summaries.map((s) => s.recipientCount)).toEqual(Array(60).fill(17));
    expect(api.requests).toHaveLength(2);
    expect(api.requests.every((r) => r.prefer.includes("count=exact"))).toBe(true);
  });

  it("starts the later page strictly after the last delivery already read", async () => {
    const data = archive(60, 17);
    const api = serve(data);

    await loadReportSummaries();

    const last = ordered(data.deliveries)[999]!;
    for (const request of api.requests) {
      expect(request.url.searchParams.get("order")).toBe("snapshot_id.asc,recipient_id.asc");
    }
    expect(api.requests[0]!.url.searchParams.get("or")).toBeNull();
    expect(api.requests[1]!.url.searchParams.get("or")).toBe(
      `(snapshot_id.gt.${last.snapshot_id},` +
        `and(snapshot_id.eq.${last.snapshot_id},recipient_id.gt.${last.recipient_id}))`,
    );
  });

  it("still counts everything when the API's limit is lower than the page it asked for", async () => {
    // A short page is not the last page: at a cap of 250, stopping at the first short page would
    // count 250 deliveries and call the archive complete.
    const api = serve(archive(60, 17), { cap: 250 });

    const summaries = await loadReportSummaries();

    expect(summaries.map((s) => s.recipientCount)).toEqual(Array(60).fill(17));
    expect(api.requests).toHaveLength(5);
  });

  it("makes no delivery request at all for an empty archive", async () => {
    const api = serve({ reports: [], deliveries: [] });

    await expect(loadReportSummaries()).resolves.toEqual([]);
    expect(api.requests).toHaveLength(0);
  });

  it("reports zero recipients only for a report that really has none", async () => {
    const data = archive(3, 2);
    data.deliveries = data.deliveries.filter((d) => d.snapshot_id !== data.reports[1]!.snapshot_id);
    serve(data);

    const summaries = await loadReportSummaries();
    expect(summaries.map((s) => s.recipientCount)).toEqual([2, 0, 2]);
  });
});

describe("a delivery count that cannot be trusted fails as a whole", () => {
  it("fails when a LATER page is refused, rather than counting the first page", async () => {
    serve(archive(60, 17), { override: (index) => (index === 1 ? refused() : undefined) });

    await expect(loadReportSummaries()).rejects.toThrow("data_unavailable: reports.deliveryCounts");
  });

  it("fails when a later page is refused under a lowered cap", async () => {
    serve(archive(60, 17), { cap: 250, override: (index) => (index === 3 ? refused() : undefined) });

    await expect(loadReportSummaries()).rejects.toThrow("data_unavailable: reports.deliveryCounts");
  });

  it("fails when a page arrives without an exact count, because completion cannot then be known", async () => {
    serve(archive(60, 17), { override: (_index, page) => json(page, "*") });

    await expect(loadReportSummaries()).rejects.toThrow("data_unavailable: reports.deliveryCounts");
  });

  it("fails when a page is empty while its count says rows remain", async () => {
    serve(archive(60, 17), {
      override: (index, _page, total) => (index === 1 ? json([], total) : undefined),
    });

    await expect(loadReportSummaries()).rejects.toThrow("data_unavailable: reports.deliveryCounts");
  });

  it("fails when a later page repeats a delivery the first page already returned", async () => {
    const data = archive(60, 17);
    const repeated = ordered(data.deliveries)[999]!;
    serve(data, {
      override: (index, page, total) => (index === 1 ? json([repeated, ...page], total) : undefined),
    });

    await expect(loadReportSummaries()).rejects.toThrow("data_unavailable: reports.deliveryCounts");
  });

  it("fails when a page holds more rows than its count", async () => {
    serve(archive(3, 2), { override: (_index, page) => json(page, page.length - 1) });

    await expect(loadReportSummaries()).rejects.toThrow("data_unavailable: reports.deliveryCounts");
  });
});

describe("listing every recipient of one report", () => {
  it("lists all 1,001 recipients of one report, past one response, none repeated", async () => {
    const data = archive(1, 1001);
    const api = serve(data);

    const report = await loadReport(data.reports[0]!.run_id);

    expect(report?.recipients).toHaveLength(1001);
    expect(new Set(report?.recipients.map((r) => r.id)).size).toBe(1001);
    expect(report?.recipients[0]).toEqual({
      id: uuid("c0", 1),
      name: "Recipient 0001",
      role: "manager",
    });
    expect(api.requests).toHaveLength(2);
  });

  it("lists them all when the API's limit is lowered", async () => {
    const data = archive(1, 1001);
    serve(data, { cap: 300 });

    const report = await loadReport(data.reports[0]!.run_id);
    expect(report?.recipients).toHaveLength(1001);
  });

  it("fails the whole detail when a later page of recipients is refused", async () => {
    const data = archive(1, 1001);
    serve(data, { override: (index) => (index === 1 ? refused() : undefined) });

    await expect(loadReport(data.reports[0]!.run_id)).rejects.toThrow(
      "data_unavailable: reports.deliveries",
    );
  });
});
