import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_UNAVAILABLE } from "@/lib/supabase/query";

/**
 * `loadOrder` and the one field it cannot shrug off.
 *
 * The creator's name comes from `api.staff_order_creator_name`, because `profiles` admits a Manager
 * and a Director alone and the order screen has to name the writer to everybody allowed to open the
 * order. That call was made and its `error` was never read: a refusal, a null or anything that was
 * not text became an empty string, and the page rendered "Created by  (Sales Representative)" — a
 * confident sentence with a hole in it, built out of a read that did not work.
 *
 * It is the `data ?? []` mistake one field down. An empty result and a failed result are different
 * answers (memory.md §6), and this field has no empty result to return: the order row is already in
 * hand, so its creator exists, and reading the order at all required the live role the command
 * answers. Nothing is left for "no name" to mean except "we could not find out".
 */

const createServerSupabase = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: () => createServerSupabase(),
}));

const { loadOrder } = await import("@/lib/sales/sales");

const ORDER_ID = "8c2f4d6e-1a3b-4c5d-8e9f-0a1b2c3d4e5f";

const ORDER_ROW = {
  id: ORDER_ID,
  order_no: "FV-ORD-20260831-0001",
  customer_id: "6b5a4c3d-2e1f-4a09-8b7c-6d5e4f3a2b1c",
  status: "proforma",
  is_cash_sale: false,
  discount_percent: 0,
  discount_reason: null,
  created_role: "sales_rep",
  created_at: "2026-08-31T08:00:00.000Z",
  cancel_reason: null,
  customers: { name: "Juma Builders" },
};

type Answer = { data: unknown; error: { message: string } | null };

/**
 * A client shaped like PostgREST's builder: every step returns itself, and awaiting it — or calling
 * `maybeSingle()` — hands back the canned answer for that table.
 */
function fakeClient(answers: Record<string, Answer>, creator: Answer) {
  const rpc = vi.fn().mockImplementation(() => Promise.resolve(creator));

  function builder(table: string) {
    const answer = answers[table] ?? { data: [], error: null };
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      maybeSingle: () => Promise.resolve(answer),
      then: (resolve: (value: Answer) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(answer).then(resolve, reject),
    };
    return chain;
  }

  return {
    client: { from: (table: string) => builder(table), schema: () => ({ rpc }) },
    rpc,
  };
}

function withCreator(creator: Answer, overrides: Record<string, Answer> = {}) {
  const { client, rpc } = fakeClient(
    {
      orders: { data: ORDER_ROW, error: null },
      invoices: { data: null, error: null },
      ...overrides,
    },
    creator,
  );
  createServerSupabase.mockResolvedValue(client);
  return rpc;
}

const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  createServerSupabase.mockReset();
});

afterEach(() => consoleError.mockClear());

describe("reading who wrote an order", () => {
  it("returns the creator when the command answers", async () => {
    const rpc = withCreator({ data: "Asha Mushi", error: null });

    const order = await loadOrder(ORDER_ID);

    expect(order?.createdByName).toBe("Asha Mushi");
    expect(order?.orderNo).toBe("FV-ORD-20260831-0001");
    expect(rpc).toHaveBeenCalledWith("staff_order_creator_name", { p_order_id: ORDER_ID });
  });

  it("throws the safe failure when the provider refuses", async () => {
    withCreator({ data: null, error: { message: "permission denied for function" } });

    await expect(loadOrder(ORDER_ID)).rejects.toThrow(`${DATA_UNAVAILABLE}: sales.order_creator`);
  });

  it("keeps the provider's own words out of the thrown error, and in the log", async () => {
    const leaky = 'permission denied for function api.staff_order_creator_name: user "sb_x" at 10.0.0.4';
    withCreator({ data: null, error: { message: leaky } });

    let thrown: unknown;
    try {
      await loadOrder(ORDER_ID);
    } catch (error) {
      thrown = error;
    }

    expect(String(thrown)).not.toContain(leaky);
    expect(String(thrown)).toContain("sales.order_creator");
    // Still diagnosable — the detail goes to the server log, which is the one place it belongs.
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(leaky));
  });

  it("treats a null name on an order that EXISTS as the same failed read", async () => {
    withCreator({ data: null, error: null });

    await expect(loadOrder(ORDER_ID)).rejects.toThrow(`${DATA_UNAVAILABLE}: sales.order_creator`);
  });

  it("treats an empty or blank name the same way", async () => {
    for (const value of ["", "   "]) {
      withCreator({ data: value, error: null });
      await expect(loadOrder(ORDER_ID)).rejects.toThrow(
        `${DATA_UNAVAILABLE}: sales.order_creator`,
      );
    }
  });

  it("treats a value that is not text the same way, and logs no value", async () => {
    withCreator({ data: { full_name: "Asha Mushi" }, error: null });

    await expect(loadOrder(ORDER_ID)).rejects.toThrow(`${DATA_UNAVAILABLE}: sales.order_creator`);
    // The shape is enough to diagnose it; the value itself is never written down.
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("where text was expected"));
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("Asha Mushi"));
  });

  it("still answers NOT FOUND for an order that does not exist", async () => {
    // No creator is read at all: the absence is settled before the second round of queries, and a
    // missing order is a 404, not a failure. Turning it into one would send a person to a retry
    // screen for a page that is never going to exist.
    const rpc = withCreator(
      { data: null, error: { message: "should never be asked" } },
      { orders: { data: null, error: null } },
    );

    await expect(loadOrder(ORDER_ID)).resolves.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
});
