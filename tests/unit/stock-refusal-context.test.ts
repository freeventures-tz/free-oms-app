import { describe, expect, it } from "vitest";

import { approveStockAdjustment, approveStockTransfer } from "@/lib/inventory/commands";
import { approveProductionBatch, enterProductionBatch } from "@/lib/production/commands";
import { STOCK_REFUSAL_FIELDS } from "@/lib/stock-refusal";

/**
 * A stock refusal has to reach the screen with the numbers that explain it (issue #7).
 *
 * The database returns two different refusals for two different rules, and the difference is the
 * point. `insufficient_stock` means the yard is full of goods that belong to a customer;
 * `insufficient_stock_at_location` means the business has the goods somewhere else. A command layer
 * that flattened both to "available and requested" would leave the interface unable to tell a
 * Manager which of those two things happened — and they need opposite actions.
 *
 * These run against an injected api, so they test the mapping and nothing else. That the DATABASE
 * returns these shapes is pgTAP 014's job; that the mapping does not drop them is this file's.
 */

/** An api that answers one canned refusal, so the mapping is the only thing under test. */
function refusing(payload: Record<string, unknown>) {
  return {
    rpc: async () => ({ data: { ok: false, ...payload }, error: null }),
  };
}

const PROMISED_REFUSAL = {
  reason: "insufficient_stock",
  product_id: "11111111-1111-1111-1111-111111111111",
  physical: 100,
  promised: 80,
  available: 20,
  requested: 50,
};

const LOCATION_REFUSAL = {
  reason: "insufficient_stock_at_location",
  product_id: "11111111-1111-1111-1111-111111111111",
  location: "store",
  available: 0,
  requested: 10,
};

describe("a refused production batch", () => {
  it("carries what is promised, so the screen can say why a full yard is not enough", async () => {
    const result = await approveProductionBatch(
      { batchId: "b", idempotencyKey: "k" },
      refusing(PROMISED_REFUSAL),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.reason).toBe("insufficient_stock");
    expect(result.context).toMatchObject({
      available: 20,
      promised: 80,
      physical: 100,
      requested: 50,
    });
  });

  it("carries the location when it is the location that refused", async () => {
    const result = await approveProductionBatch(
      { batchId: "b", idempotencyKey: "k" },
      refusing(LOCATION_REFUSAL),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.reason).toBe("insufficient_stock_at_location");
    expect(result.context).toMatchObject({ location: "store", available: 0, requested: 10 });
  });
});

describe("a refused stock command", () => {
  it("carries the promise figures through the inventory mapping too", async () => {
    const result = await approveStockAdjustment(
      { adjustmentId: "a", idempotencyKey: "k" },
      refusing(PROMISED_REFUSAL),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.context).toMatchObject({ available: 20, promised: 80, requested: 50 });
  });

  it("keeps the location as text rather than coercing it to a number", async () => {
    const result = await approveStockTransfer(
      { transferId: "t", idempotencyKey: "k" },
      refusing(LOCATION_REFUSAL),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // `Number("store")` is NaN, and NaN rendered into a sentence is worse than no sentence.
    expect(result.context?.location).toBe("store");
    expect(result.context?.available).toBe(0);
  });

  it("omits what a refusal did not carry, rather than inventing NaN for it", async () => {
    // Not every refusal is about stock. `already_settled` has no numbers, and the screen must get
    // no numbers rather than a set of them reading NaN.
    const result = await approveStockTransfer(
      { transferId: "t", idempotencyKey: "k" },
      refusing({ reason: "already_settled", status: "approved" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.reason).toBe("already_settled");
    expect(result.context).toBeUndefined();
  });

  it("carries the same stock fields whichever module asked", async () => {
    // The two modules kept their own copy of this list once, and the copies had already drifted.
    // Asserting the SHARED list reaches both is what stops one of them quietly losing `promised`
    // and leaving the interface with a refusal it cannot explain.
    const [production, inventory] = await Promise.all([
      approveProductionBatch({ batchId: "b", idempotencyKey: "k" }, refusing(PROMISED_REFUSAL)),
      approveStockAdjustment({ adjustmentId: "a", idempotencyKey: "k" }, refusing(PROMISED_REFUSAL)),
    ]);

    if (production.ok || inventory.ok) throw new Error("both should have been refused");

    for (const field of STOCK_REFUSAL_FIELDS) {
      if (!(field in PROMISED_REFUSAL)) continue;
      expect(production.context, field).toHaveProperty(field);
      expect(inventory.context, field).toHaveProperty(field);
    }
  });

  it("refuses an impossible moulding time before it reaches the database", async () => {
    // 31 February passes the field's shape regex and `new Date` silently answers 3 March.
    const result = await enterProductionBatch(
      {
        locationCode: "yard",
        mouldedAt: "2026-02-31T10:00",
        inputs: [],
        outputs: [],
        yieldNote: null,
        idempotencyKey: "k",
      },
      { rpc: async () => { throw new Error("the command must not be issued at all"); } },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("moulded_at_invalid");
  });

  it("drops a null figure rather than rendering it as a confident zero", async () => {
    // `Number(null)` is 0, and a 0 in a sentence about stock is a statement, not an absence. A
    // refusal that carried an explicit null must reach the screen without that number at all.
    const result = await approveStockTransfer(
      { transferId: "t", idempotencyKey: "k" },
      refusing({ reason: "insufficient_stock_at_location", available: null, requested: 5 }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.context).not.toHaveProperty("available");
    expect(result.context).toMatchObject({ requested: 5 });
  });

  it("does not treat a zero balance as a missing one", async () => {
    // `available: 0` is the commonest refusal there is — the place is empty. A truthiness check
    // would drop it and leave the screen saying nothing.
    const result = await approveStockTransfer(
      { transferId: "t", idempotencyKey: "k" },
      refusing({ reason: "insufficient_stock_at_location", available: 0, requested: 5 }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.context).toMatchObject({ available: 0, requested: 5 });
  });
});
