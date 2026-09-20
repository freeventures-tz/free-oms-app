import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_UNAVAILABLE } from "@/lib/supabase/query";

/**
 * `loadOrder` and the settlement it must not make up.
 *
 * The invoice card needs one row of `invoice_settlement`, and there are exactly three things that
 * row can be. It is there, and the card states it. The caller's role may not read settlement facts
 * at all — `api.staff_settlement_readable` says so, the view returns nothing, and the card says it
 * is not shown. Or the read did not work: the row is absent, the money is not a number, the status
 * is a word nobody wrote. That third case is the dangerous one, because the natural shape of it —
 * `?? { amountPaid: 0, status: "unpaid" }` — reads as prudence and produces a screen that tells a
 * Cashier an invoice they were just paid for is unpaid.
 *
 * The settlement queue HAS that fallback and is right to: it renders a page of invoices and one
 * missing row must not blank the page. This read has one invoice, already in hand, and a role that
 * has already been told it may see the figures. Nothing is left for "no settlement" to mean except
 * "we could not find out" (memory.md §6).
 */

const createServerSupabase = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: () => createServerSupabase(),
}));

const { loadOrder } = await import("@/lib/sales/sales");

const ORDER_ID = "8c2f4d6e-1a3b-4c5d-8e9f-0a1b2c3d4e5f";
const INVOICE_ID = "7a6b5c4d-3e2f-4109-8a7b-6c5d4e3f2a1b";

const ORDER_ROW = {
  id: ORDER_ID,
  order_no: "FV-ORD-20260901-0007",
  customer_id: "6b5a4c3d-2e1f-4a09-8b7c-6d5e4f3a2b1c",
  status: "confirmed",
  is_cash_sale: false,
  discount_percent: 0,
  discount_reason: null,
  created_role: "sales_rep",
  created_at: "2026-09-01T08:00:00.000Z",
  cancel_reason: null,
  customers: { name: "Juma Builders" },
  invoices: { id: INVOICE_ID },
};

const INVOICE_ROW = {
  id: INVOICE_ID,
  invoice_no: "FV-INV-20260901-0007",
  subtotal_tzs: 600_000,
  discount_tzs: 0,
  total_tzs: 600_000,
  business_date: "2026-09-01",
  issued_at: "2026-09-01T08:00:00.000Z",
  cancelled_at: null,
  cancel_reason: null,
};

const SETTLEMENT_ROW = {
  invoice_id: INVOICE_ID,
  total_tzs: 600_000,
  amount_paid_tzs: 200_000,
  approved_credit_tzs: 400_000,
  outstanding_tzs: 400_000,
  status: "partially_paid",
};

type Answer = { data: unknown; error: { message: string } | null };

const OK = (data: unknown): Answer => ({ data, error: null });

/**
 * A client shaped like PostgREST's builder, with one canned answer per relation and one per `api`
 * function. Every step returns itself; awaiting it — or calling `maybeSingle()` — hands the answer
 * back, exactly as the real builder does.
 */
function fakeClient(tables: Record<string, Answer>, functions: Record<string, Answer>) {
  const rpc = vi.fn().mockImplementation((name: string) =>
    Promise.resolve(functions[name] ?? { data: null, error: { message: `no answer for ${name}` } }),
  );

  function builder(table: string) {
    const answer = tables[table] ?? OK([]);
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

  return { from: (table: string) => builder(table), schema: () => ({ rpc }) };
}

/** A confirmed order with an invoice, and whatever the settlement read is made to answer. */
function withSettlement(
  settlement: Answer,
  options: {
    readable?: Answer;
    order?: Answer;
    invoice?: Answer;
  } = {},
) {
  createServerSupabase.mockResolvedValue(
    fakeClient(
      {
        orders: options.order ?? OK(ORDER_ROW),
        invoices: options.invoice ?? OK(INVOICE_ROW),
        invoice_settlement: settlement,
      },
      {
        staff_order_creator_name: OK("Asha Mushi"),
        staff_settlement_readable: options.readable ?? OK(true),
      },
    ),
  );
}

const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => createServerSupabase.mockReset());
afterEach(() => consoleError.mockClear());

describe("the settlement an order's invoice carries", () => {
  it("reports the view's own figures, unchanged", async () => {
    withSettlement(OK(SETTLEMENT_ROW));

    const order = await loadOrder(ORDER_ID);

    expect(order?.invoice?.settlement).toEqual({
      totalTzs: 600_000,
      amountPaidTzs: 200_000,
      approvedCreditTzs: 400_000,
      outstandingTzs: 400_000,
      status: "partially_paid",
    });
  });

  it("reads zero money as zero money, not as a missing answer", async () => {
    withSettlement(
      OK({ ...SETTLEMENT_ROW, amount_paid_tzs: 0, approved_credit_tzs: 0, outstanding_tzs: 600_000, status: "unpaid" }),
    );

    const order = await loadOrder(ORDER_ID);

    expect(order?.invoice?.settlement?.amountPaidTzs).toBe(0);
    expect(order?.invoice?.settlement?.status).toBe("unpaid");
  });

  it("carries a reversal through, because the view already nets it off", async () => {
    // A reversal is a negative payment row, so the sum falls and the status follows it back down.
    withSettlement(
      OK({ ...SETTLEMENT_ROW, amount_paid_tzs: 0, approved_credit_tzs: 0, outstanding_tzs: 600_000, status: "unpaid" }),
    );

    const first = await loadOrder(ORDER_ID);
    expect(first?.invoice?.settlement?.amountPaidTzs).toBe(0);

    withSettlement(
      OK({ ...SETTLEMENT_ROW, amount_paid_tzs: 600_000, approved_credit_tzs: 0, outstanding_tzs: 0, status: "paid" }),
    );
    const paid = await loadOrder(ORDER_ID);
    expect(paid?.invoice?.settlement?.status).toBe("paid");
  });

  it("is null — not zero — for a role that may not read settlement facts", async () => {
    // The view answers a Sales Representative with no row at all. That is a refusal, and the only
    // thing that tells it apart from a broken read is the question the database was asked first.
    withSettlement(OK(null), { readable: OK(false) });

    const order = await loadOrder(ORDER_ID);

    expect(order?.invoice).not.toBeNull();
    expect(order?.invoice?.settlement).toBeNull();
  });

  it("accepts the identity embed whether PostgREST sends one row or a list of one", async () => {
    // `invoices.order_id` is unique, so PostgREST resolves this to-one — but the shape of a
    // reverse embed has changed across versions, and a wrong guess here would silently cost the
    // screen its status on every confirmed order.
    withSettlement(OK(SETTLEMENT_ROW), {
      order: OK({ ...ORDER_ROW, invoices: [{ id: INVOICE_ID }] }),
    });

    const order = await loadOrder(ORDER_ID);

    expect(order?.invoice?.settlement?.status).toBe("partially_paid");
  });

  it("asks nothing about settlement when the order has no invoice", async () => {
    withSettlement(OK(null), { order: OK({ ...ORDER_ROW, status: "proforma", invoices: null }), invoice: OK(null) });

    const order = await loadOrder(ORDER_ID);

    expect(order?.invoice).toBeNull();
  });
});

describe("a settlement read that did not work", () => {
  it("fails the page when the two reads of the same invoice disagree", async () => {
    // Identified but not read: the settlement was asked for, and the screen would otherwise have
    // rendered a confirmed order with no invoice on it at all.
    withSettlement(OK(SETTLEMENT_ROW), { invoice: OK(null) });
    await expect(loadOrder(ORDER_ID)).rejects.toThrow(`${DATA_UNAVAILABLE}: sales.invoice`);

    // Read but not identified: the settlement was never asked for, and the invoice would have
    // arrived on the screen with no status behind it.
    withSettlement(OK(null), { order: OK({ ...ORDER_ROW, invoices: null }) });
    await expect(loadOrder(ORDER_ID)).rejects.toThrow(`${DATA_UNAVAILABLE}: sales.invoice`);
  });

  it("fails the page when the row is missing for a role entitled to it", async () => {
    withSettlement(OK(null));

    await expect(loadOrder(ORDER_ID)).rejects.toThrow(
      `${DATA_UNAVAILABLE}: sales.invoice_settlement`,
    );
  });

  it("fails the page when the provider refuses, and keeps its words out of the error", async () => {
    const leaky = 'permission denied for view invoice_settlement: user "sb_x" at 10.0.0.4';
    withSettlement({ data: null, error: { message: leaky } });

    let thrown: unknown;
    try {
      await loadOrder(ORDER_ID);
    } catch (error) {
      thrown = error;
    }

    expect(String(thrown)).toContain("sales.invoice_settlement");
    expect(String(thrown)).not.toContain(leaky);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(leaky));
  });

  it("refuses money that is not a whole number, however coercible it looks", async () => {
    for (const amount of [null, undefined, "", "  ", "many", Number.NaN, 1.5, {}]) {
      withSettlement(OK({ ...SETTLEMENT_ROW, amount_paid_tzs: amount }));

      await expect(loadOrder(ORDER_ID), `amount_paid_tzs: ${String(amount)}`).rejects.toThrow(
        `${DATA_UNAVAILABLE}: sales.invoice_settlement`,
      );
    }
  });

  it("fails the page for money this machine cannot hold exactly", async () => {
    // Reviewed as F1 on PR #46. `Number.isInteger` is true for every value at or above 2^53, so a
    // figure that rounds on the way in — or overflows to `Infinity` — reached the card as settled
    // money. The boundary itself is covered in `settlement-money-range.test.ts`; this proves the
    // whole read path refuses rather than just the parser in isolation.
    const unholdable: [string, unknown][] = [
      ["2^53 as a number", 2 ** 53],
      ["integer text that rounds", "9007199254740993"],
      ["integer text that overflows", "9".repeat(400)],
    ];

    for (const [label, amount] of unholdable) {
      withSettlement(OK({ ...SETTLEMENT_ROW, outstanding_tzs: amount }));

      await expect(loadOrder(ORDER_ID), label).rejects.toThrow(
        `${DATA_UNAVAILABLE}: sales.invoice_settlement`,
      );
    }
  });

  it("refuses a status nobody in product.md §12.3 wrote", async () => {
    for (const status of [null, "", "PAID", "settled", 7]) {
      withSettlement(OK({ ...SETTLEMENT_ROW, status }));

      await expect(loadOrder(ORDER_ID), `status: ${String(status)}`).rejects.toThrow(
        `${DATA_UNAVAILABLE}: sales.invoice_settlement`,
      );
    }
  });

  it("never writes the value it rejected into the log", async () => {
    withSettlement(OK({ ...SETTLEMENT_ROW, amount_paid_tzs: "17431 secret" }));

    await expect(loadOrder(ORDER_ID)).rejects.toThrow(DATA_UNAVAILABLE);
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("17431 secret"));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("amount_paid_tzs"));
  });

  it("fails the page when the access question itself cannot be answered", async () => {
    // Neither true nor false is knowable, so neither "here are the figures" nor "they are not
    // shown to you" may be printed. Both would be an assertion the system cannot support.
    for (const answer of [
      { data: null, error: { message: "could not connect" } },
      OK(null),
      OK("true"),
    ]) {
      withSettlement(OK(SETTLEMENT_ROW), { readable: answer });

      await expect(loadOrder(ORDER_ID)).rejects.toThrow(
        `${DATA_UNAVAILABLE}: sales.settlement_access`,
      );
    }
  });
});
