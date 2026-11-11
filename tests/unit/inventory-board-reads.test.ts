import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reading EVERY line of the deliveries and transfers a board shows, through the API's per-response
 * row limit.
 *
 * PostgREST answers at most `max_rows` rows with HTTP 200 and no error. The boards used to read all
 * lines in one request, and then a hundred parents' lines in one request: a hundred deliveries of
 * eleven lines each is 1,100 rows, the API returned 1,000, nine deliveries showed no items and a
 * tenth showed some. These tests drive the real loaders through the real Supabase client and
 * replace only the network, with a PostgREST stand-in that honours the same filters, ordering, row
 * cap and exact count the real one does (the method of `report-alerts-loader.test.ts`).
 */

type Line = { id: string; parent: string };

type Server = {
  parents: string[];
  lines: Line[];
  /** The API's own `max_rows`: no response carries more rows than this, whatever was asked. */
  cap: number;
  /** Line requests, in order: the cursor each asked to start after, and how many rows it got. */
  lineRequests: Array<{ after: string | null; returned: number; parents: number }>;
  /** Replaces the response to one line request, by its zero-based position. */
  override?: (index: number) => Response | undefined;
  /** Whether line pages carry an exact count. */
  counted: boolean;
};

const server = vi.hoisted(() => ({ current: null as unknown as Server }));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () =>
    createClient("http://postgrest.test", "unit-test-key", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => respond(new URL(String(input)), init) },
    }),
}));

const { LINE_PAGE_SIZE, loadReceipts, loadTransfers } = await import("@/lib/inventory/inventory");

/** A valid uuid whose text order is its number's order. */
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const json = (rows: unknown[], headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json", ...headers } });

/** `in.(a,b,c)` as PostgREST writes it. */
function inList(value: string | null): Set<string> {
  const match = /^in\.\((.*)\)$/.exec(value ?? "");
  if (!match) throw new Error(`expected an in.() filter, got ${value}`);
  return new Set(match[1]!.split(",").map((id) => id.replace(/"/g, "")));
}

async function respond(url: URL, init?: RequestInit): Promise<Response> {
  const current = server.current;
  const prefer = new Headers(init?.headers).get("prefer") ?? "";
  const table = url.pathname.replace("/rest/v1/", "");

  if (table === "stock_receipts" || table === "stock_transfers") {
    const limit = Math.min(Number(url.searchParams.get("limit")), current.cap);
    return json(
      current.parents.slice(0, limit).map((id, at) => ({
        id,
        supplier_id: uuid(900_000),
        location_code: "main_yard",
        from_location: "main_yard",
        to_location: "shop",
        note: null,
        delivery_note_ref: `DN-${at}`,
        delivery_date: "2026-11-01",
        entered_role: "manager",
        entered_at: "2026-11-01T08:00:00Z",
        suppliers: { name: "Simba Yard" },
        profiles: { full_name: "Asha Manager" },
      })),
    );
  }

  if (table === "stock_receipt_lines" || table === "stock_transfer_lines") {
    const key = table === "stock_receipt_lines" ? "receipt_id" : "transfer_id";
    // Deterministic order, and the cursor is strictly after the last id read.
    expect(url.searchParams.get("order")).toBe("id.asc");
    expect(Number(url.searchParams.get("limit"))).toBe(LINE_PAGE_SIZE);
    const wanted = inList(url.searchParams.get(key));
    const cursor = url.searchParams.get("id");
    const after = cursor ? (/^gt\.(.+)$/.exec(cursor)?.[1] ?? null) : null;
    if (cursor && !after) throw new Error(`unexpected id filter: ${cursor}`);

    const matching = current.lines
      .filter((line) => wanted.has(line.parent) && (after === null || line.id > after))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const page = matching.slice(0, Math.min(LINE_PAGE_SIZE, current.cap));
    const index = current.lineRequests.push({ after, returned: page.length, parents: wanted.size }) - 1;

    const replaced = current.override?.(index);
    if (replaced) return replaced;

    const range = page.length === 0 ? "*" : `0-${page.length - 1}`;
    const total = current.counted && prefer.includes("count=exact") ? String(matching.length) : "*";
    return json(
      page.map((line) => ({
        id: line.id,
        [key]: line.parent,
        product_id: uuid(800_000),
        quantity: 5,
        expected_quantity: 5,
        received_quantity: 5,
        damaged_quantity: 0,
        short_quantity: 0,
        excess_quantity: 0,
        accepted_quantity: 5,
        damage_note: null,
      })),
      { "content-range": `${range}/${total}` },
    );
  }

  if (table === "approval_requests") {
    return json([...inList(url.searchParams.get("entity_id"))].map((id) => ({ entity_id: id, status: "pending", approved_at: null, approved_role: null, profiles: null })));
  }
  if (table === "approval_decisions") return json([]);
  if (table === "rpc/staff_stock_receipt_imprest_links") return json([]);
  throw new Error(`unexpected request to ${url.pathname}`);
}

/** `parents` records with `each` lines apiece. Line ids interleave the parents, as real ones do. */
function serve(parents: number, each: number, options: Partial<Pick<Server, "cap" | "override" | "counted">> = {}): Server {
  const ids = Array.from({ length: parents }, (_, at) => uuid(at + 1));
  const lines: Line[] = [];
  for (let round = 0; round < each; round += 1) {
    ids.forEach((parent, at) => lines.push({ id: uuid(100_000 + round * parents + at), parent }));
  }
  server.current = { parents: ids, lines, cap: 1000, lineRequests: [], counted: true, ...options };
  return server.current;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

for (const [name, load] of [
  ["deliveries", loadReceipts],
  ["transfers", loadTransfers],
] as const) {
  describe(`every line of the ${name} a board shows`, () => {
    it("reads all 1,100 lines of a hundred records, where one request returns 1,000", async () => {
      const api = serve(100, 11);
      const records = await load();

      expect(records).toHaveLength(100);
      // No record is empty and none is short: the defect was nine with no lines and one with some.
      expect(records.map((record) => record.lines.length)).toEqual(Array.from({ length: 100 }, () => 11));
      expect(records.reduce((sum, record) => sum + record.lines.length, 0)).toBe(1100);
      // Two pages: the first full at the cap, the second starting strictly after its last id.
      expect(api.lineRequests.map((request) => request.returned)).toEqual([1000, 100]);
      expect(api.lineRequests[0]!.after).toBeNull();
      expect(api.lineRequests[1]!.after).toBe(uuid(100_000 + 999));
    });

    it("returns no line twice and loses none, across both batches of parents", async () => {
      // Two hundred records in two batches of a hundred, twelve lines each: 2,400 lines.
      const api = serve(200, 12);
      const records = await load();

      const ids = records.flatMap((record) => record.lines.map((line) => line.id));
      expect(ids).toHaveLength(2400);
      expect(new Set(ids).size).toBe(2400);
      expect(records.every((record) => record.lines.length === 12)).toBe(true);
      expect(api.lineRequests.every((request) => request.parents === 100)).toBe(true);
    });

    it("is complete whatever the API's own row cap is, because the count decides, not the page size", async () => {
      const api = serve(100, 11, { cap: 250 });
      const records = await load();

      expect(records.reduce((sum, record) => sum + record.lines.length, 0)).toBe(1100);
      expect(api.lineRequests.map((request) => request.returned)).toEqual([250, 250, 250, 250, 100]);
    });

    it("asks once when everything fits in one page", async () => {
      const api = serve(3, 2);
      const records = await load();

      expect(records.map((record) => record.lines.length)).toEqual([2, 2, 2]);
      expect(api.lineRequests).toHaveLength(1);
    });

    it("fails the whole board when a later page is refused, and never draws part of it", async () => {
      serve(100, 11, { override: (index) => (index === 1 ? new Response(JSON.stringify({ message: "upstream" }), { status: 500 }) : undefined) });
      await expect(load()).rejects.toThrow(/^data_unavailable: inventory\./);
    });

    it("fails when a page carries no exact count, since a short page then proves nothing", async () => {
      serve(100, 11, { counted: false });
      await expect(load()).rejects.toThrow(/^data_unavailable: inventory\./);
    });

    it("fails when a page is empty while the count says rows remain", async () => {
      serve(100, 11, {
        override: (index) => (index === 1 ? new Response("[]", { status: 200, headers: { "content-type": "application/json", "content-range": "*/100" } }) : undefined),
      });
      await expect(load()).rejects.toThrow(/^data_unavailable: inventory\./);
    });
  });
}
