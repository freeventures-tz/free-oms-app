import { describe, expect, it, vi } from "vitest";

import { DATA_UNAVAILABLE } from "@/lib/supabase/query";

/**
 * The two production work queues, and the reason they are read on their own.
 *
 * The source this was extracted from read "the latest fifty batches" once and picked the drafts and
 * the uninspected lots out of that list. Fifty-one batches later, a draft nobody had decided was
 * simply gone from the screen, and the section above it said there was nothing waiting — which is
 * the record a work queue exists to surface. Raising the limit moves the cliff; it does not remove
 * it.
 *
 * It also read every `production_batch_inputs` and `production_lots` row in the database with no
 * filter at all. The Data API caps a response at a thousand rows and says nothing about having done
 * so, so the materials of the oldest cards would have quietly disappeared from the page first.
 *
 * What is asserted here: the queues are separate counted reads, child rows are scoped to the page
 * and read until a short batch comes back, a page past the end shows the last page rather than an
 * empty one, and a read that did not work is never an empty yard.
 */

const createServerSupabase = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: () => createServerSupabase(),
}));

const { loadOpenCuringLots, loadProductionDrafts, loadSettledBatches } = await import(
  "@/lib/production/production"
);

type Answer = {
  data: Record<string, unknown>[] | null;
  error: { message: string; code?: string } | null;
  count?: number | null;
};

type Call = { table: string; ops: [string, unknown[]][] };

/**
 * A client shaped like PostgREST's builder: every step records itself and returns the chain, and
 * awaiting it hands back the next canned answer for that table.
 */
function fakeClient(plan: Record<string, Answer[]>) {
  const calls: Call[] = [];

  function from(table: string) {
    const record: Call = { table, ops: [] };
    calls.push(record);
    const nth = calls.filter((call) => call.table === table).length - 1;
    const answers = plan[table] ?? [];
    const answer: Answer = answers[Math.min(nth, answers.length - 1)] ?? {
      data: [],
      error: null,
      count: 0,
    };

    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get(_target, property: string) {
          if (property === "then") {
            return (resolve: (value: Answer) => unknown, reject?: (reason: unknown) => unknown) =>
              Promise.resolve(answer).then(resolve, reject);
          }
          return (...args: unknown[]) => {
            record.ops.push([property, args]);
            return chain;
          };
        },
      },
    );

    return chain;
  }

  createServerSupabase.mockResolvedValue({ from });
  return calls;
}

function batchRow(id: string) {
  return {
    id,
    batch_no: `FV-BAT-20260822-${id}`,
    location_code: "yard",
    status: "draft",
    moulded_at: "2026-08-22T06:30:00.000Z",
    yield_note: null,
    entered_role: "manager",
    entered_at: "2026-08-22T06:35:00.000Z",
    decided_role: null,
    decided_at: null,
    decision_reason: null,
    entered: { full_name: "Yard Manager" },
    decided: null,
  };
}

function curingRow(overrides: Record<string, unknown> = {}) {
  return {
    lot_id: "aaaa",
    batch_id: "bbbb",
    batch_no: "FV-BAT-20260822-0001",
    product_id: "cccc",
    location_code: "yard",
    quantity_curing: 20,
    quantity_moulded: 22,
    rejected_at_moulding: 2,
    moulding_reject_reason: "broken",
    curing_started_at: "2026-08-22T06:30:00.000Z",
    ready_at: "2026-08-25T06:30:00.000Z",
    ready_for_inspection: false,
    ...overrides,
  };
}

function opsFor(calls: Call[], table: string, nth = 0): [string, unknown[]][] {
  return calls.filter((call) => call.table === table)[nth]?.ops ?? [];
}

describe("the drafts queue is its own read", () => {
  it("asks for drafts only, counted, ordered on a unique column and ranged", async () => {
    const calls = fakeClient({
      production_batches: [{ data: [batchRow("0001")], error: null, count: 1 }],
      production_batch_inputs: [{ data: [], error: null }],
      production_lots: [{ data: [], error: null }],
    });

    const page = await loadProductionDrafts(1);

    const ops = opsFor(calls, "production_batches");
    expect(ops.find(([name]) => name === "eq")?.[1]).toEqual(["status", "draft"]);
    expect(ops.some(([name]) => name === "neq")).toBe(false);
    expect(ops.filter(([name]) => name === "order").map(([, args]) => args[0])).toEqual([
      "entered_at",
      "id",
    ]);
    expect(ops.find(([name]) => name === "range")?.[1]).toEqual([0, 24]);
    expect(page.total).toBe(1);
    expect(page.rows[0]?.batchNo).toBe("FV-BAT-20260822-0001");
  });

  it("reads the history as everything that is NOT a draft, so neither can hide the other", async () => {
    const calls = fakeClient({
      production_batches: [{ data: [], error: null, count: 0 }],
    });

    await loadSettledBatches(1);

    const ops = opsFor(calls, "production_batches");
    expect(ops.find(([name]) => name === "neq")?.[1]).toEqual(["status", "draft"]);
    expect(ops.some(([name]) => name === "eq")).toBe(false);
  });

  it("shows the last page when the number in the address bar is past the end", async () => {
    // A hand-edited `?drafts=999`, or page two of a queue that has since become one page. Either
    // way PostgREST answers with an empty range and a positive count, and a screen that believed it
    // would say "nothing is waiting" over the top of work that exists.
    const calls = fakeClient({
      production_batches: [
        { data: [], error: null, count: 30 },
        { data: [batchRow("0001")], error: null, count: 30 },
        { data: [batchRow("0002")], error: null, count: 30 },
      ],
      production_batch_inputs: [{ data: [], error: null }],
      production_lots: [{ data: [], error: null }],
    });

    const page = await loadProductionDrafts(999);

    expect(page.page).toBe(2);
    expect(page.rows).toHaveLength(1);
    expect(opsFor(calls, "production_batches", 2).find(([name]) => name === "range")?.[1]).toEqual([
      25, 49,
    ]);
  });

  it("scopes the materials to this page's batches and keeps asking until a short batch comes back", async () => {
    const full = Array.from({ length: 1000 }, (_, index) => ({
      batch_id: "0001",
      product_id: `p${index}`,
      standard_quantity: 5,
      actual_quantity: 5,
      variance_quantity: 0,
      products: { id: `p${index}`, name: `Material ${index}`, unit_code: "bucket" },
    }));

    const calls = fakeClient({
      production_batches: [{ data: [batchRow("0001")], error: null, count: 1 }],
      production_batch_inputs: [
        { data: full, error: null },
        { data: [full[0]!], error: null },
      ],
      production_lots: [{ data: [], error: null }],
    });

    const page = await loadProductionDrafts(1);

    // A thousand rows came back, which is exactly the Data API's cap and therefore says nothing
    // about whether there are more. The second request is what settles it.
    const inputCalls = calls.filter((call) => call.table === "production_batch_inputs");
    expect(inputCalls).toHaveLength(2);
    expect(inputCalls[0]?.ops.find(([name]) => name === "in")?.[1]).toEqual(["batch_id", ["0001"]]);
    expect(inputCalls[1]?.ops.find(([name]) => name === "range")?.[1]).toEqual([1000, 1999]);
    expect(page.rows[0]?.inputs).toHaveLength(1001);
  });

  it("asks for nothing at all when the page is empty, rather than sending `in.()`", async () => {
    const calls = fakeClient({
      production_batches: [{ data: [], error: null, count: 0 }],
    });

    const page = await loadProductionDrafts(1);

    expect(page.rows).toEqual([]);
    expect(page.total).toBe(0);
    expect(calls.some((call) => call.table === "production_batch_inputs")).toBe(false);
  });

  it("reports a failed read as a failure, never as an empty queue", async () => {
    fakeClient({
      production_batches: [{ data: null, error: { message: "connection reset" }, count: null }],
    });

    await expect(loadProductionDrafts(1)).rejects.toThrow(DATA_UNAVAILABLE);
  });
});

describe("the inspection queue", () => {
  it("asks the view for uninspected lots, oldest first", async () => {
    const calls = fakeClient({
      curing_lots: [{ data: [curingRow()], error: null, count: 1 }],
      products: [{ data: [{ id: "cccc", name: 'Tofali 6"' }], error: null }],
    });

    const page = await loadOpenCuringLots(1);

    const ops = opsFor(calls, "curing_lots");
    expect(ops.find(([name]) => name === "is")?.[1]).toEqual(["inspected_at", null]);
    expect(ops.filter(([name]) => name === "order").map(([, args]) => args[0])).toEqual([
      "curing_started_at",
      "lot_id",
    ]);
    expect(page.rows[0]).toMatchObject({
      productName: 'Tofali 6"',
      quantityCuring: 20,
      readyForInspection: false,
      readyAt: "2026-08-25T06:30:00.000Z",
    });
  });

  it("refuses to turn a missing quantity into a zero somebody would act on", async () => {
    fakeClient({
      curing_lots: [{ data: [curingRow({ quantity_curing: null })], error: null, count: 1 }],
      products: [{ data: [{ id: "cccc", name: 'Tofali 6"' }], error: null }],
    });

    await expect(loadOpenCuringLots(1)).rejects.toThrow(DATA_UNAVAILABLE);
  });

  it("refuses to turn a missing readiness into a boolean", async () => {
    // "Not ready" and "we could not find out" are different answers, and only one of them may
    // disable an inspection control with an explanation under it.
    fakeClient({
      curing_lots: [{ data: [curingRow({ ready_for_inspection: null })], error: null, count: 1 }],
      products: [{ data: [{ id: "cccc", name: 'Tofali 6"' }], error: null }],
    });

    await expect(loadOpenCuringLots(1)).rejects.toThrow(DATA_UNAVAILABLE);
  });

  it("refuses a deadline that is not a time", async () => {
    fakeClient({
      curing_lots: [{ data: [curingRow({ ready_at: "soon" })], error: null, count: 1 }],
      products: [{ data: [{ id: "cccc", name: 'Tofali 6"' }], error: null }],
    });

    await expect(loadOpenCuringLots(1)).rejects.toThrow(DATA_UNAVAILABLE);
  });

  it("answers an empty queue with an empty page and no product read", async () => {
    const calls = fakeClient({ curing_lots: [{ data: [], error: null, count: 0 }] });

    const page = await loadOpenCuringLots(1);

    expect(page.rows).toEqual([]);
    expect(page.total).toBe(0);
    expect(calls.some((call) => call.table === "products")).toBe(false);
  });
});
