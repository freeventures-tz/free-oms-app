import { describe, expect, it } from "vitest";

import {
  BRICK_REJECT_REASONS,
  batchOutputSchema,
  enterBatchSchema,
  inspectLotSchema,
  mouldedAtField,
  parseQuantity,
} from "@/lib/validation/production";

const CEMENT = "11111111-1111-4111-8111-111111111111";
const SAND = "22222222-2222-4222-8222-222222222222";
const BRICK = "44444444-4444-4444-8444-444444444444";
const KEY = "33333333-3333-4333-8333-333333333333";

/**
 * The rules a batch has to obey before it ever reaches the database, and why each one exists.
 *
 * None of this is the boundary — the database enforces every one of these again, and a caller that
 * skips this file is refused there. What this buys is a refusal that names the field the person can
 * fix, instead of a whole-form failure after a round trip.
 */

function output(overrides: Record<string, unknown> = {}) {
  return {
    productId: BRICK,
    quantityMoulded: "22",
    rejectedQuantity: "0",
    rejectReason: "",
    ...overrides,
  };
}

function batch(overrides: Record<string, unknown> = {}) {
  return {
    locationCode: "yard",
    mouldedAt: "2026-08-22T09:30",
    inputs: [
      { productId: CEMENT, actualQuantity: "1" },
      { productId: SAND, actualQuantity: "5" },
    ],
    outputs: [output()],
    yieldNote: "",
    idempotencyKey: KEY,
    ...overrides,
  };
}

describe("the shape of a batch", () => {
  it("accepts a batch that used the recipe and produced bricks", () => {
    const result = enterBatchSchema.safeParse(batch());
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect(result.data?.inputs[1]?.actualQuantity).toBe(5);
  });

  it("refuses a batch that recorded no materials and one that produced nothing", () => {
    expect(enterBatchSchema.safeParse(batch({ inputs: [] })).success).toBe(false);
    expect(enterBatchSchema.safeParse(batch({ outputs: [] })).success).toBe(false);
  });

  it("refuses the same material twice, which would make one of the two invisible", () => {
    const result = enterBatchSchema.safeParse(
      batch({
        inputs: [
          { productId: SAND, actualQuantity: "5" },
          { productId: SAND, actualQuantity: "6" },
        ],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("productionErrors.duplicate_product_line");
  });

  it("REFUSES half a bucket rather than rounding it away", () => {
    // §11.1 consumes bags and buckets, and AC-120 is explicit that what one HOLDS is not a
    // quantity. Silently truncating a fraction is how a ledger stops reconciling.
    const result = enterBatchSchema.safeParse(
      batch({ inputs: [{ productId: SAND, actualQuantity: "2.5" }] }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("productionErrors.quantity.invalid");
  });

  it("accepts zero of a material, because a batch may genuinely have used none", () => {
    const result = enterBatchSchema.safeParse(
      batch({ inputs: [{ productId: SAND, actualQuantity: "0" }] }),
    );
    expect(result.success).toBe(true);
  });

  it("carries no field for the variance at all", () => {
    // §5.2 and §11.1: the difference is a generated column. A schema that accepted one, even to
    // throw it away, is the first step towards a screen that lets somebody type it.
    const parsed = enterBatchSchema.parse(
      batch({ inputs: [{ productId: SAND, actualQuantity: "6", varianceQuantity: "1" }] }),
    );
    expect(parsed.inputs[0]).not.toHaveProperty("varianceQuantity");
    expect(parsed.inputs[0]).not.toHaveProperty("standardQuantity");
  });
});

/**
 * ONE READING OF A TYPED FIGURE, shared with the screen.
 *
 * The board derives a variance, an out-of-range warning, an accounted-for total and whether a
 * reject reason is even offered, all from characters somebody is still typing. If it reads them
 * differently from the schema that captures them, the screen describes a request that is not the
 * one being sent -- which is exactly what a leading zero used to do.
 */
describe("how a typed quantity is read", () => {
  it("reads a leading zero as the number somebody meant", () => {
    // A numeric keypad produces these by accident and nobody means anything else by them. The
    // board's old `Number.parseInt` round-trip guard called all three "not a number yet" while the
    // schema captured 0, 2 and 18.
    expect(parseQuantity("00")).toBe(0);
    expect(parseQuantity("02")).toBe(2);
    expect(parseQuantity("018")).toBe(18);
  });

  it("reads a count written with separators the way it was written", () => {
    expect(parseQuantity("1,000")).toBe(1000);
    expect(parseQuantity(" 42 ")).toBe(42);
  });

  it("READS NOTHING AT ALL from input that is not a whole count", () => {
    // Unchanged, and the point of the alignment: a screen that cannot read a figure must show
    // nothing rather than a guess, and the schema must still refuse it.
    for (const value of ["", "   ", "abc", "1.5", "-1", "+1", "1e3", "12abc", "0x10", "٤٢"]) {
      expect(parseQuantity(value), value).toBeNull();
    }
  });

  it("is the reading the schema captures with", () => {
    const parsed = enterBatchSchema.parse(
      batch({ inputs: [{ productId: SAND, actualQuantity: "018" }] }),
    );
    expect(parsed.inputs[0]!.actualQuantity).toBe(18);
    expect(parsed.inputs[0]!.actualQuantity).toBe(parseQuantity("018"));
  });

  it("still refuses what it always refused, with the message that names the field", () => {
    for (const value of ["", "abc", "1.5", "-1"]) {
      const result = enterBatchSchema.safeParse(
        batch({ inputs: [{ productId: SAND, actualQuantity: value }] }),
      );
      expect(result.success, value).toBe(false);
      expect(result.error?.issues[0]?.message).toBe("productionErrors.quantity.invalid");
    }
  });

  it("still calls an impossible figure too large rather than unreadable", () => {
    // `99999999999999999999` reads as a number and is refused for its SIZE, which is a different
    // message from "that is not a count". Sharing the reading must not blur the two.
    const result = enterBatchSchema.safeParse(
      batch({ inputs: [{ productId: SAND, actualQuantity: "99999999999999999999" }] }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("productionErrors.quantity.tooLarge");
  });
});

describe("what came out of the mould", () => {
  it("refuses more rejects than bricks", () => {
    const result = batchOutputSchema.safeParse(
      output({ quantityMoulded: "20", rejectedQuantity: "30", rejectReason: "broken" }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("productionErrors.rejects_exceed_output");
  });

  it("refuses a reject count with no reason, which is a number nobody can act on", () => {
    const result = batchOutputSchema.safeParse(output({ rejectedQuantity: "2" }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("productionErrors.reject_reason_required");
  });

  it("refuses a reason with nothing to explain", () => {
    const result = batchOutputSchema.safeParse(output({ rejectReason: "broken" }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      "productionErrors.reject_reason_without_rejects",
    );
  });

  it("takes only the four preset reasons of §11.5, never a typed one", () => {
    for (const reason of BRICK_REJECT_REASONS) {
      const ok = batchOutputSchema.safeParse(
        output({ rejectedQuantity: "2", rejectReason: reason }),
      );
      expect(ok.success, reason).toBe(true);
    }

    const typed = batchOutputSchema.safeParse(
      output({ rejectedQuantity: "2", rejectReason: "looked wrong to me" }),
    );
    expect(typed.success).toBe(false);
    expect(typed.error?.issues[0]?.message).toBe("productionErrors.reject_reason_invalid");
  });

  it("refuses a lot that moulded nothing — that is not an output", () => {
    expect(batchOutputSchema.safeParse(output({ quantityMoulded: "0" })).success).toBe(false);
  });
});

describe("the moulding time", () => {
  it("accepts what the browser's datetime-local control produces, with or without seconds", () => {
    expect(mouldedAtField.safeParse("2026-08-22T09:30").success).toBe(true);
    expect(mouldedAtField.safeParse("2026-08-22T09:30:00").success).toBe(true);
  });

  it("refuses anything that is not a wall-clock time", () => {
    expect(mouldedAtField.safeParse("2026-08-22").success).toBe(false);
    expect(mouldedAtField.safeParse("yesterday").success).toBe(false);
    expect(mouldedAtField.safeParse("").success).toBe(false);
  });

  it("does NOT refuse a time in the past, because §11.4 expects one", () => {
    // Curing starts when moulding finished, not at data entry. A Manager recording Monday's batch
    // on Thursday is ordinary use; only a FUTURE time is wrong, and the business clock that decides
    // that lives in the database (§15.3).
    expect(mouldedAtField.safeParse("2020-01-01T06:00").success).toBe(true);
  });

  it("refuses a well-formed string that is not a day, rather than rolling it forward", () => {
    // `2026-02-30T08:00` matches the pattern and does not exist. A runtime that rolled it into
    // 2 March would store a moulding time nobody entered, and start a permanent curing clock
    // from it. The same check runs in the command adapter, against the same function.
    expect(mouldedAtField.safeParse("2026-02-30T08:00").success).toBe(false);
    expect(mouldedAtField.safeParse("2026-13-01T08:00").success).toBe(false);
    expect(mouldedAtField.safeParse("2026-08-22T25:00").success).toBe(false);
    // …and a leap day that DOES exist is accepted, so the check is a calendar and not a guess.
    expect(mouldedAtField.safeParse("2028-02-29T08:00").success).toBe(true);
  });
});

describe("the inspection", () => {
  it("accepts a split between accepted and rejected", () => {
    const result = inspectLotSchema.safeParse({
      lotId: BRICK,
      acceptedQuantity: "18",
      rejectedQuantity: "2",
      rejectReason: "cracked",
      idempotencyKey: KEY,
    });
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("refuses rejects without a reason, and a reason without rejects", () => {
    const noReason = inspectLotSchema.safeParse({
      lotId: BRICK,
      acceptedQuantity: "18",
      rejectedQuantity: "2",
      rejectReason: "",
      idempotencyKey: KEY,
    });
    expect(noReason.error?.issues[0]?.message).toBe("productionErrors.reject_reason_required");

    const noRejects = inspectLotSchema.safeParse({
      lotId: BRICK,
      acceptedQuantity: "20",
      rejectedQuantity: "0",
      rejectReason: "cracked",
      idempotencyKey: KEY,
    });
    expect(noRejects.error?.issues[0]?.message).toBe(
      "productionErrors.reject_reason_without_rejects",
    );
  });

  it("does not carry its own copy of what is curing", () => {
    // The curing quantity is a sum of the ledger, and the database refuses a total that does not
    // match it. A form field holding a second copy could disagree with the ledger it is checked
    // against, so there is no field for it here at all.
    const parsed = inspectLotSchema.parse({
      lotId: BRICK,
      acceptedQuantity: "18",
      rejectedQuantity: "2",
      rejectReason: "cracked",
      curingQuantity: "20",
      idempotencyKey: KEY,
    });
    expect(parsed).not.toHaveProperty("curingQuantity");
  });
});
