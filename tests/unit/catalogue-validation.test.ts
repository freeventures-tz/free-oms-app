import { describe, expect, it } from "vitest";

import { fieldErrors } from "@/lib/validation/auth";
import { addProductSchema, addUnitSchema, setPriceSchema } from "@/lib/validation/catalogue";

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

/**
 * Counting units and content (Stage 10 Part C, product.md §6).
 *
 * Two rules carry the weight here. A unit needs BOTH labels, because a unit with no Swahili name
 * is unusable to half the yard and there is no message file to fall back on: the labels are
 * business data. And blank content is the same answer as no content, so the identity rule never
 * has to know about two spellings of "none".
 */
describe("creating a counting unit", () => {
  const KEY2 = "3c2f9a1b-7d4e-4a6b-8c31-9d5e4f0a7c22";

  it("keeps both labels, trimmed and collapsed", () => {
    const parsed = addUnitSchema.safeParse({
      labelEn: "  drum ",
      labelSw: " ngoma  ",
      idempotencyKey: KEY2,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.labelEn).toBe("drum");
    expect(parsed.data?.labelSw).toBe("ngoma");
  });

  it("requires the English label", () => {
    const parsed = addUnitSchema.safeParse({
      labelEn: "   ",
      labelSw: "ngoma",
      idempotencyKey: KEY2,
    });
    expect(fieldErrors(parsed.error!).labelEn).toBe("catalogueErrors.unitLabelEn.tooShort");
  });

  it("requires the Swahili label just as firmly", () => {
    const parsed = addUnitSchema.safeParse({
      labelEn: "drum",
      labelSw: "",
      idempotencyKey: KEY2,
    });
    expect(fieldErrors(parsed.error!).labelSw).toBe("catalogueErrors.unitLabelSw.tooShort");
  });

  it("refuses a label longer than the column holds", () => {
    const parsed = addUnitSchema.safeParse({
      labelEn: "x".repeat(41),
      labelSw: "ngoma",
      idempotencyKey: KEY2,
    });
    expect(fieldErrors(parsed.error!).labelEn).toBe("catalogueErrors.unitLabelEn.tooLong");
  });

  it("returns keys rather than sentences, for every failure", () => {
    const parsed = addUnitSchema.safeParse({ labelEn: "", labelSw: "", idempotencyKey: KEY2 });
    for (const message of Object.values(fieldErrors(parsed.error!))) {
      expect(message).toMatch(/^catalogueErrors\./);
    }
  });
});

describe("content per counting unit", () => {
  it("is optional, and blank means the product has none", () => {
    for (const content of ["", "   "]) {
      const parsed = addProductSchema.safeParse({
        name: "Test Plank",
        specification: "",
        unitCode: "piece",
        unitContent: content,
        idempotencyKey: KEY,
      });
      expect(parsed.success).toBe(true);
      // `null`, never `""`. Two spellings of "none" would be two product identities for one thing.
      expect(parsed.data?.unitContent).toBeNull();
    }
  });

  it("keeps what was typed, trimmed", () => {
    const parsed = addProductSchema.safeParse({
      name: "Dangote Cement 42R",
      specification: "",
      unitCode: "bag",
      unitContent: "  50 kg  ",
      idempotencyKey: KEY,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.unitContent).toBe("50 kg");
  });

  it("refuses a content longer than the column holds", () => {
    const parsed = addProductSchema.safeParse({
      name: "Something",
      specification: "",
      unitCode: "piece",
      unitContent: "x".repeat(41),
      idempotencyKey: KEY,
    });
    expect(fieldErrors(parsed.error!).unitContent).toBe("catalogueErrors.unitContent.tooLong");
  });

  it("is absent entirely when the form does not send it", () => {
    const parsed = addProductSchema.safeParse({
      name: "Something Else",
      specification: "",
      unitCode: "piece",
      unitContent: "",
      idempotencyKey: KEY,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.unitContent).toBeNull();
  });
});
