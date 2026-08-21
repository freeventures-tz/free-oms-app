import { z } from "zod";

import { MAX_PRICE_TZS, parseTzs } from "@/lib/money";

/**
 * Zod 4 schemas for the catalogue Server Actions (architecture.md §5.11).
 *
 * Failures return TRANSLATION KEYS, never English sentences (design.md §8.2), matching the pattern
 * `lib/validation/auth.ts` established.
 *
 * None of this is the authority check. A Manager who submits a perfectly valid price passes every
 * rule here and is refused by the database, which is where "Directors only" actually lives.
 */

export const productNameField = z
  .string()
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(1, { message: "catalogueErrors.name.tooShort" })
      .max(80, { message: "catalogueErrors.name.tooLong" }),
  );

/**
 * Grade or specification, and the empty string means "this product has none".
 *
 * Normalised to `null` rather than kept as `""`, because identity is the pair (name, specification)
 * and two spellings of "no specification" would be two identities for one product.
 */
export const specificationField = z
  .string()
  .transform((value) => {
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  })
  .refine((value) => value === null || value.length <= 40, {
    message: "catalogueErrors.specification.tooLong",
  });

/**
 * A price as typed, in whole shillings.
 *
 * `parseTzs` refuses a decimal point rather than rounding it away: `12,500.60` is either a mistake
 * or a misunderstanding about what this field holds, and quietly discarding the tail would hide
 * both. It also refuses anything outside the range the database's own check constraint allows, so
 * the two agree instead of the server discovering it second.
 */
export const priceField = z.string().transform((value, ctx) => {
  const parsed = parseTzs(value);
  if (parsed === null) {
    const digitsOnly = value.replace(/[\s ,]/g, "");
    ctx.addIssue({
      code: "custom",
      message:
        /^\d+$/.test(digitsOnly) && Number(digitsOnly) > MAX_PRICE_TZS
          ? "catalogueErrors.price.tooLarge"
          : "catalogueErrors.price.invalid",
    });
    return z.NEVER;
  }
  return parsed;
});

/**
 * What one counting unit contains: `50 kg`, `20 litres`, `12 ft` (product.md §6).
 *
 * Optional, and normalised to `null` for the same reason `specification` is: identity is the triple
 * (name, specification, content), and two spellings of "no content" would be two identities for one
 * product. Blank and absent are the same answer.
 *
 * It is stored as typed, deliberately. Nothing parses it, because nothing converts it — a system
 * that understood `50 kg` would be a system that could be asked how many kilograms are in the yard,
 * and the answer to that question is that the yard counts bags.
 */
export const unitContentField = z
  .string()
  .optional()
  .transform((value) => {
    // Absent, empty and blank are one answer. A caller that never sends the field — the database
    // command defaults it too — means exactly what a caller that sends spaces means.
    const trimmed = (value ?? "").trim();
    return trimmed.length === 0 ? null : trimmed;
  })
  .refine((value) => value === null || value.length <= 40, {
    message: "catalogueErrors.unitContent.tooLong",
  });

/**
 * A counting unit's label, in one language.
 *
 * Both are required. A unit created this morning has no message file behind it (design.md §8.2),
 * so a missing Swahili label is not a gap that falls back to English — it is a unit half the yard
 * cannot read, permanently, with no rename path in this slice to correct it.
 */
function unitLabelField(field: "unitLabelEn" | "unitLabelSw") {
  return z
    .string()
    .transform((value) => value.trim().replace(/\s+/g, " "))
    .pipe(
      z
        .string()
        .min(1, { message: `catalogueErrors.${field}.tooShort` })
        .max(40, { message: `catalogueErrors.${field}.tooLong` }),
    );
}

export const unitLabelEnField = unitLabelField("unitLabelEn");
export const unitLabelSwField = unitLabelField("unitLabelSw");

/** Required by product.md §4.4: a price entry without a reason is not a record of a decision. */
export const priceReasonField = z
  .string()
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(3, { message: "catalogueErrors.reason.tooShort" })
      .max(500, { message: "catalogueErrors.reason.tooLong" }),
  );

export const addUnitSchema = z.object({
  labelEn: unitLabelEnField,
  labelSw: unitLabelSwField,
  idempotencyKey: z.string().uuid({ message: "catalogueErrors.idempotency_key_conflict" }),
});

export const addProductSchema = z.object({
  name: productNameField,
  specification: specificationField,
  unitCode: z.string().min(1, { message: "catalogueErrors.unit.required" }),
  unitContent: unitContentField,
  // `z.string().uuid()` rather than the stricter `z.uuid()`, matching how the authentication
  // schemas validate the same kind of value. Two idempotency keys validated by two different rules
  // is a difference a reader would have to investigate and that buys nothing.
  idempotencyKey: z.string().uuid({ message: "catalogueErrors.idempotency_key_conflict" }),
});

export const setPriceSchema = z.object({
  productId: z.string().uuid({ message: "catalogueErrors.no_product" }),
  price: priceField,
  reason: priceReasonField,
  // `z.string().uuid()` rather than the stricter `z.uuid()`, matching how the authentication
  // schemas validate the same kind of value. Two idempotency keys validated by two different rules
  // is a difference a reader would have to investigate and that buys nothing.
  idempotencyKey: z.string().uuid({ message: "catalogueErrors.idempotency_key_conflict" }),
});
