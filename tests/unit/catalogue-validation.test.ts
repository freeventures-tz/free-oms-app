import { describe, expect, it } from "vitest";

import { fieldErrors } from "@/lib/validation/auth";
import { addProductSchema, setPriceSchema } from "@/lib/validation/catalogue";

/**
 * Catalogue input rules (architecture.md §5.11).
 *
 * Every message is a TRANSLATION KEY, never an English sentence — the same rule the authentication
 * schemas follow, and the reason a Swahili-speaking Director never sees an English validation
 * error (design.md §8.2).
 *
 * None of this is the authority check. A Manager submitting a perfectly valid price passes every
 * rule here and is refused by the database, where "Directors only" actually lives.
 */

const KEY = "9f1c2b7a-4d3e-4b8a-9c21-8b5d4f0a6c11";

describe("adding a product", () => {
  it("accepts a product with no specification, and stores the absence as null", () => {
    const parsed = addProductSchema.safeParse({
      name: "  Timber 2 × 4  ",
      specification: "   ",
      unitCode: "piece_12ft",
      idempotencyKey: KEY,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.name).toBe("Timber 2 × 4");
    // Not `""`. Identity is the pair (name, specification), and two spellings of "none" would be
    // two identities for one product.
    expect(parsed.data?.specification).toBeNull();
  });

  it("keeps a grade, because grade is part of what the product IS", () => {
    const parsed = addProductSchema.safeParse({
      name: "Nondo 12 mm",
      specification: "BS 500",
      unitCode: "bar",
      idempotencyKey: KEY,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.specification).toBe("BS 500");
  });

  it("refuses an empty name and an over-long one, by key", () => {
    const blank = addProductSchema.safeParse({
      name: "   ",
      specification: "",
      unitCode: "piece",
      idempotencyKey: KEY,
    });
    expect(fieldErrors(blank.error!).name).toBe("catalogueErrors.name.tooShort");

    const long = addProductSchema.safeParse({
      name: "x".repeat(81),
      specification: "",
      unitCode: "piece",
      idempotencyKey: KEY,
    });
    expect(fieldErrors(long.error!).name).toBe("catalogueErrors.name.tooLong");
  });

  it("requires a unit, because a product with no unit cannot be counted or sold", () => {
    const parsed = addProductSchema.safeParse({
      name: "Something",
      specification: "",
      unitCode: "",
      idempotencyKey: KEY,
    });
    expect(fieldErrors(parsed.error!).unitCode).toBe("catalogueErrors.unit.required");
  });
});

describe("setting a price", () => {
  const base = { productId: "0f6c2a5e-1d3b-4c7a-9e21-8b5d4f0a6c11", idempotencyKey: KEY };

  it("accepts whole shillings as typed, separators and all", () => {
    const parsed = setPriceSchema.safeParse({
      ...base,
      price: "1,250,000",
      reason: "  Supplier raised prices  ",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.price).toBe(1250000);
    expect(parsed.data?.reason).toBe("Supplier raised prices");
  });

  it("tells a cents mistake apart from a too-large one", () => {
    const cents = setPriceSchema.safeParse({ ...base, price: "12500.60", reason: "why not" });
    expect(fieldErrors(cents.error!).price).toBe("catalogueErrors.price.invalid");

    // A slipped keypress, which needs a different sentence: the figure is well formed and wrong.
    const huge = setPriceSchema.safeParse({ ...base, price: "999999999", reason: "why not" });
    expect(fieldErrors(huge.error!).price).toBe("catalogueErrors.price.tooLarge");
  });

  it("requires a reason, because product.md §4.4 makes it part of the record", () => {
    const missing = setPriceSchema.safeParse({ ...base, price: "5000", reason: "  " });
    expect(fieldErrors(missing.error!).reason).toBe("catalogueErrors.reason.tooShort");

    const long = setPriceSchema.safeParse({ ...base, price: "5000", reason: "x".repeat(501) });
    expect(fieldErrors(long.error!).reason).toBe("catalogueErrors.reason.tooLong");
  });

  it("refuses a price of zero — free is not a price", () => {
    const zero = setPriceSchema.safeParse({ ...base, price: "0", reason: "giving it away" });
    expect(fieldErrors(zero.error!).price).toBe("catalogueErrors.price.invalid");
  });

  it("returns keys rather than sentences, for every failure", () => {
    const parsed = setPriceSchema.safeParse({ ...base, price: "abc", reason: "" });
    for (const message of Object.values(fieldErrors(parsed.error!))) {
      expect(message).toMatch(/^catalogueErrors\./);
    }
  });
});
