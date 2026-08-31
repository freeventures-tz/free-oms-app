import { describe, expect, it } from "vitest";

import {
  enterAdjustmentSchema,
  enterReceiptSchema,
  enterTransferSchema,
  openingStockSchema,
  quantityAtLeastOne,
  quantityAtLeastZero,
  signedQuantity,
} from "@/lib/validation/inventory";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const KEY = "33333333-3333-4333-8333-333333333333";

/**
 * The rules a quantity has to obey before it ever reaches the database, and why each one exists.
 *
 * None of this is the boundary — the database enforces every one of these again, and a caller that
 * skips this file is refused there. What this buys is a refusal that names the field the person can
 * fix, instead of a whole-form failure after a round trip.
 */
describe("a counting-unit quantity", () => {
  it("accepts a whole number of units", () => {
    expect(quantityAtLeastZero.parse("40")).toBe(40);
    expect(quantityAtLeastZero.parse("0")).toBe(0);
  });

  it("accepts the separators people actually type on a phone", () => {
    expect(quantityAtLeastZero.parse(" 1 200 ")).toBe(1200);
    expect(quantityAtLeastZero.parse("1,200")).toBe(1200);
  });

  it("REFUSES a fraction rather than rounding it away", () => {
    // product.md §6.1 rule 1: a product is COUNTED in its unit. Half a bag is not a quantity this
    // system can express, and silently truncating one is how a ledger stops reconciling.
    const result = quantityAtLeastZero.safeParse("2.5");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("inventoryErrors.quantity.invalid");
  });

  it("refuses a quantity above the bound the database also enforces", () => {
    const result = quantityAtLeastZero.safeParse("10000001");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("inventoryErrors.quantity.tooLarge");
  });

  it("refuses a negative where zero is the floor, and empty everywhere", () => {
    expect(quantityAtLeastZero.safeParse("-1").success).toBe(false);
    expect(quantityAtLeastOne.safeParse("0").success).toBe(false);
    expect(quantityAtLeastZero.safeParse("").success).toBe(false);
    expect(quantityAtLeastZero.safeParse("   ").success).toBe(false);
  });

  it("refuses anything that is not digits, however plausible it looks", () => {
    for (const value of ["forty", "4e2", "0x10", "1/2", "40 bags"]) {
      expect(quantityAtLeastZero.safeParse(value).success, value).toBe(false);
    }
  });
});

describe("a stock correction's signed quantity", () => {
  it("takes a loss as a negative and a gain as a positive", () => {
    expect(signedQuantity.parse("-5")).toBe(-5);
    expect(signedQuantity.parse("+5")).toBe(5);
    expect(signedQuantity.parse("5")).toBe(5);
  });

  it("refuses zero, because no change is not a correction", () => {
    const result = signedQuantity.safeParse("0");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("inventoryErrors.quantity.zero");
  });
});

describe("a supplier receipt", () => {
  const base = {
    supplierId: UUID_A,
    locationCode: "store",
    deliveryDate: "2026-08-22",
    deliveryNoteRef: "DN-100",
    idempotencyKey: KEY,
  };

  function line(overrides: Record<string, string> = {}) {
    return {
      productId: UUID_A,
      expectedQuantity: "100",
      receivedQuantity: "100",
      damagedQuantity: "0",
      damageNote: "",
      ...overrides,
    };
  }

  it("accepts a delivery that arrived complete", () => {
    const result = enterReceiptSchema.safeParse({ ...base, lines: [line()] });
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("has no field for short, excess or accepted", () => {
    // They are GENERATED columns in the database (product.md §5.2, AC-27, AC-28). Accepting them
    // here, even to ignore them, would be the first step towards a screen that lets somebody type
    // one — so the schema strips them and the parsed object never carries one.
    const result = enterReceiptSchema.parse({
      ...base,
      lines: [{ ...line(), shortQuantity: "0", excessQuantity: "0", acceptedQuantity: "100" }],
    });
    expect(result.lines[0]).not.toHaveProperty("shortQuantity");
    expect(result.lines[0]).not.toHaveProperty("excessQuantity");
    expect(result.lines[0]).not.toHaveProperty("acceptedQuantity");
  });

  it("refuses more damaged than arrived", () => {
    const result = enterReceiptSchema.safeParse({
      ...base,
      lines: [line({ receivedQuantity: "5", damagedQuantity: "9" })],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("inventoryErrors.damaged_exceeds_received");
  });

  it("refuses the same product on two lines", () => {
    const result = enterReceiptSchema.safeParse({
      ...base,
      lines: [line(), line()],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.message === "inventoryErrors.duplicate_product_line"))
      .toBe(true);
  });

  it("refuses a receipt with no lines, which records nothing", () => {
    const result = enterReceiptSchema.safeParse({ ...base, lines: [] });
    expect(result.success).toBe(false);
  });

  it("requires the delivery note reference (product.md §9, §5.3)", () => {
    const result = enterReceiptSchema.safeParse({
      ...base,
      deliveryNoteRef: "   ",
      lines: [line()],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("inventoryErrors.deliveryNote.tooShort");
  });

  it("keeps a shortage and an excess as separate facts on separate lines", () => {
    // AC-28: a shortage is never netted against an excess. There is no single field in which one
    // could cancel the other, because the person supplies expected and received per line.
    const result = enterReceiptSchema.parse({
      ...base,
      lines: [
        line({ productId: UUID_A, expectedQuantity: "100", receivedQuantity: "90" }),
        line({ productId: UUID_B, expectedQuantity: "100", receivedQuantity: "110" }),
      ],
    });
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0].receivedQuantity).toBe(90);
    expect(result.lines[1].receivedQuantity).toBe(110);
  });
});

describe("an internal transfer", () => {
  const base = { note: "", idempotencyKey: KEY };

  it("refuses a move from a place to itself", () => {
    const result = enterTransferSchema.safeParse({
      ...base,
      fromLocation: "store",
      toLocation: "store",
      lines: [{ productId: UUID_A, quantity: "5" }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.message === "inventoryErrors.same_location")).toBe(
      true,
    );
  });

  it("refuses a quantity of zero, which moves nothing", () => {
    const result = enterTransferSchema.safeParse({
      ...base,
      fromLocation: "store",
      toLocation: "yard",
      lines: [{ productId: UUID_A, quantity: "0" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("opening stock", () => {
  it("accepts zero, because 'we counted and found none' is a real answer", () => {
    const result = openingStockSchema.safeParse({
      productId: UUID_A,
      locationCode: "yard",
      quantity: "0",
      note: "",
      idempotencyKey: KEY,
    });
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect(result.data?.quantity).toBe(0);
    // Blank and absent are one answer, so the identity of "no note" has exactly one spelling.
    expect(result.data?.note).toBeNull();
  });
});

describe("a stock correction", () => {
  it("requires a reason, because nothing else explains the movement", () => {
    const result = enterAdjustmentSchema.safeParse({
      productId: UUID_A,
      locationCode: "yard",
      quantityDelta: "-5",
      reason: "x",
      idempotencyKey: KEY,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("inventoryErrors.reason.tooShort");
  });
});
