import { describe, expect, it, vi } from "vitest";

import {
  approveProductionBatch,
  enterProductionBatch,
  inspectCuringLot,
  type ProductionApi,
} from "@/lib/production/commands";

/**
 * What the production adapter does with an answer that is not the shape it expected.
 *
 * The source this was extracted from read `key in data!` over the refusal keys. `data` is `null`
 * whenever PostgREST answers a raised exception, and a proxy or a dropped connection can produce a
 * null body with no error at all — and `'available' in null` is a TypeError, not a refusal. The
 * Server Action would have thrown where it meant to return a message, the whole form would have been
 * replaced by the route's error boundary, and everything the Manager had typed would be gone.
 *
 * That is the failure this file exists to prevent, and it is the same rule the rest of the codebase
 * spends its care on: a read or a write that did not work is reported as one, and never as an
 * answer about the business.
 */

const KEY = "33333333-3333-4333-8333-333333333333";
const BATCH = "44444444-4444-4444-8444-444444444444";
const LOT = "55555555-5555-4555-8555-555555555555";

function apiAnswering(
  data: unknown,
  error: { message: string } | null = null,
): { api: ProductionApi; rpc: ReturnType<typeof vi.fn> } {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { api: { rpc } as unknown as ProductionApi, rpc };
}

describe("an answer that is not an object", () => {
  it("treats a null body as a failure, not as a refusal to read fields out of", async () => {
    const { api } = apiAnswering(null);
    const result = await approveProductionBatch({ batchId: BATCH, idempotencyKey: KEY }, api);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("generic");
  });

  it("treats an array or a bare value the same way", async () => {
    for (const body of [[], ["approved"], 42, "approved", true]) {
      const { api } = apiAnswering(body);
      const result = await inspectCuringLot(
        {
          lotId: LOT,
          acceptedQuantity: 18,
          rejectedQuantity: 2,
          rejectReason: "cracked",
          idempotencyKey: KEY,
        },
        api,
      );
      expect(result.ok, JSON.stringify(body)).toBe(false);
      expect(result.ok === false && result.reason).toBe("generic");
    }
  });

  it("does not read a success out of a body with no `ok` in it", async () => {
    const { api } = apiAnswering({ reason: "approved" });
    const result = await approveProductionBatch({ batchId: BATCH, idempotencyKey: KEY }, api);

    expect(result.ok).toBe(false);
  });

  it("maps a refused RPC to `not_permitted` rather than to a database sentence", async () => {
    const { api } = apiAnswering(null, {
      message: "permission denied: this user may not perform this command",
    });
    const result = await approveProductionBatch({ batchId: BATCH, idempotencyKey: KEY }, api);

    expect(result.ok === false && result.reason).toBe("not_permitted");
  });
});

describe("a refusal that carries numbers", () => {
  it("keeps the ones that make it actionable and invents none", async () => {
    const { api } = apiAnswering({
      ok: false,
      reason: "insufficient_stock",
      available: 12,
      requested: 30,
      product_id: BATCH,
    });
    const result = await approveProductionBatch({ batchId: BATCH, idempotencyKey: KEY }, api);

    expect(result.ok === false && result.context).toEqual({ available: 12, requested: 30 });
  });

  it("carries the recipe count on an incomplete confirmation", async () => {
    const { api } = apiAnswering({
      ok: false,
      reason: "incomplete_recipe_inputs",
      expected: 3,
      confirmed: 2,
    });
    const result = await enterProductionBatch(
      {
        locationCode: "yard",
        mouldedAt: "2026-08-22T09:30",
        inputs: [],
        outputs: [],
        yieldNote: null,
        idempotencyKey: KEY,
      },
      api,
    );

    expect(result.ok === false && result.reason).toBe("incomplete_recipe_inputs");
    expect(result.ok === false && result.context).toEqual({ expected: 3, confirmed: 2 });
  });

  it("drops a null-valued key rather than showing a blank number", async () => {
    const { api } = apiAnswering({ ok: false, reason: "still_curing", ready_at: null });
    const result = await inspectCuringLot(
      {
        lotId: LOT,
        acceptedQuantity: 18,
        rejectedQuantity: 0,
        rejectReason: null,
        idempotencyKey: KEY,
      },
      api,
    );

    expect(result.ok === false && result.context).toBeUndefined();
  });
});

describe("the moulding time the adapter sends", () => {
  it("is the typed wall clock read in the yard's zone", async () => {
    const { api, rpc } = apiAnswering({ ok: true, reason: "entered" });

    await enterProductionBatch(
      {
        locationCode: "yard",
        mouldedAt: "2026-08-22T09:30",
        inputs: [{ productId: BATCH, actualQuantity: 5 }],
        outputs: [
          { productId: LOT, quantityMoulded: 22, rejectedQuantity: 0, rejectReason: null },
        ],
        yieldNote: null,
        idempotencyKey: KEY,
      },
      api,
    );

    expect(rpc.mock.calls[0]?.[1]?.p_moulded_at).toBe("2026-08-22T06:30:00.000Z");
  });

  it("refuses a date that does not exist instead of sending a rolled-forward instant", async () => {
    const { api, rpc } = apiAnswering({ ok: true, reason: "entered" });

    const result = await enterProductionBatch(
      {
        locationCode: "yard",
        mouldedAt: "2026-02-30T09:30",
        inputs: [{ productId: BATCH, actualQuantity: 5 }],
        outputs: [
          { productId: LOT, quantityMoulded: 22, rejectedQuantity: 0, rejectReason: null },
        ],
        yieldNote: null,
        idempotencyKey: KEY,
      },
      api,
    );

    expect(result.ok === false && result.reason).toBe("moulded_at_invalid");
    // Nothing was sent at all: a refusal here costs no idempotency key and no round trip.
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sends the same request under the same key when a retry repeats it", async () => {
    // The retry in the interface re-runs the action with the payload it already has, and the key is
    // only regenerated after a SUCCESS. Two identical calls therefore have to be byte-identical, or
    // the database sees a changed payload under a used key and refuses the retry as a conflict.
    const { api, rpc } = apiAnswering({ ok: false, reason: "generic" });

    const payload = {
      locationCode: "yard",
      mouldedAt: "2026-08-22T09:30",
      inputs: [{ productId: BATCH, actualQuantity: 6 }],
      outputs: [
        { productId: LOT, quantityMoulded: 22, rejectedQuantity: 2, rejectReason: "broken" },
      ],
      yieldNote: null,
      idempotencyKey: KEY,
    };

    await enterProductionBatch(payload, api);
    await enterProductionBatch(payload, api);

    expect(rpc.mock.calls[0]?.[1]).toEqual(rpc.mock.calls[1]?.[1]);
  });
});
