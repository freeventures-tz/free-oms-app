import { z } from "zod";

/**
 * Zod 4 schemas for the stock Server Actions (architecture.md §5.11).
 *
 * Failures return TRANSLATION KEYS, never English sentences (design.md §8.2), matching the pattern
 * `lib/validation/auth.ts` established and `lib/validation/catalogue.ts` repeated.
 *
 * None of this is the authority check. A Cashier who submits a perfectly valid approval passes
 * every rule here and is refused by the database, which is where "Managers only" actually lives.
 */

/** The upper bound the database's own check constraints use, so the two agree rather than the
 *  server discovering it second. A typo guard, not a business rule. */
export const MAX_QUANTITY = 10_000_000;

/**
 * A counting-unit quantity as typed.
 *
 * Whole numbers only, because product.md §6.1 rule 1 says a product is COUNTED in its unit. Half a
 * bag is not a quantity this system can express, and silently rounding one is how a ledger stops
 * reconciling. A decimal point is refused rather than truncated, for the same reason `parseTzs`
 * refuses cents rather than dropping them.
 */
function quantityField(options: { min: number; messagePrefix: string }) {
  return z.string().transform((value, ctx) => {
    const trimmed = value.trim().replace(/[\s ,]/g, "");

    if (trimmed.length === 0 || !/^-?\d+$/.test(trimmed)) {
      ctx.addIssue({ code: "custom", message: `${options.messagePrefix}.invalid` });
      return z.NEVER;
    }

    const parsed = Number(trimmed);

    if (!Number.isSafeInteger(parsed) || Math.abs(parsed) > MAX_QUANTITY) {
      ctx.addIssue({ code: "custom", message: `${options.messagePrefix}.tooLarge` });
      return z.NEVER;
    }

    if (parsed < options.min) {
      ctx.addIssue({ code: "custom", message: `${options.messagePrefix}.invalid` });
      return z.NEVER;
    }

    return parsed;
  });
}

export const quantityAtLeastZero = quantityField({ min: 0, messagePrefix: "inventoryErrors.quantity" });
export const quantityAtLeastOne = quantityField({ min: 1, messagePrefix: "inventoryErrors.quantity" });

/** A signed adjustment. Zero is refused separately, because "no change" is not a correction. */
export const signedQuantity = z.string().transform((value, ctx) => {
  const trimmed = value.trim().replace(/[\s ,]/g, "");

  if (trimmed.length === 0 || !/^[+-]?\d+$/.test(trimmed)) {
    ctx.addIssue({ code: "custom", message: "inventoryErrors.quantity.invalid" });
    return z.NEVER;
  }

  const parsed = Number(trimmed);

  if (!Number.isSafeInteger(parsed) || Math.abs(parsed) > MAX_QUANTITY) {
    ctx.addIssue({ code: "custom", message: "inventoryErrors.quantity.tooLarge" });
    return z.NEVER;
  }

  if (parsed === 0) {
    ctx.addIssue({ code: "custom", message: "inventoryErrors.quantity.zero" });
    return z.NEVER;
  }

  return parsed;
});

export const supplierNameField = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(1, { message: "inventoryErrors.supplierName.tooShort" })
      .max(120, { message: "inventoryErrors.supplierName.tooLong" }),
  );

/**
 * Supporting delivery information (product.md §9), and one of the few genuinely required text
 * inputs (design.md §10.2). §5.3: reducing typing must not reduce accountability.
 */
export const deliveryNoteField = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(1, { message: "inventoryErrors.deliveryNote.tooShort" })
      .max(60, { message: "inventoryErrors.deliveryNote.tooLong" }),
  );

/** Required on every decision (product.md §4.3) and on every adjustment (§4.1). */
export const decisionReasonField = z
  .string()
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(3, { message: "inventoryErrors.reason.tooShort" })
      .max(500, { message: "inventoryErrors.reason.tooLong" }),
  );

export const optionalNoteField = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = (value ?? "").trim();
    return trimmed.length === 0 ? null : trimmed;
  })
  .refine((value) => value === null || value.length <= 500, {
    message: "inventoryErrors.note.tooLong",
  });

/**
 * An ISO date as the browser's `<input type="date">` produces it.
 *
 * The future check lives in the database, where `Africa/Dar_es_Salaam` is the business day
 * (§15.3). Doing it here as well would need the browser's clock, which is not the business's.
 */
export const isoDateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "inventoryErrors.deliveryDate.invalid" });

const idempotencyKeyField = z
  .string()
  .uuid({ message: "inventoryErrors.idempotency_key_conflict" });

export const addSupplierSchema = z.object({
  name: supplierNameField,
  idempotencyKey: idempotencyKeyField,
});

export const setSupplierActiveSchema = z.object({
  supplierId: z.string().uuid({ message: "inventoryErrors.no_supplier" }),
  isActive: z.enum(["true", "false"]).transform((value) => value === "true"),
  idempotencyKey: idempotencyKeyField,
});

export const openingStockSchema = z.object({
  productId: z.string().uuid({ message: "inventoryErrors.no_product" }),
  locationCode: z.string().min(1, { message: "inventoryErrors.location.required" }),
  quantity: quantityAtLeastZero,
  note: optionalNoteField,
  idempotencyKey: idempotencyKeyField,
});

/**
 * One receipt line, as the form submits it.
 *
 * `shortQuantity`, `excessQuantity` and `acceptedQuantity` are absent on purpose. They are
 * GENERATED columns in the database (product.md §5.2, AC-27, AC-28) — accepting them here, even to
 * ignore them, would be the first step towards a screen that lets somebody type one.
 */
export const receiptLineSchema = z.object({
  productId: z.string().uuid({ message: "inventoryErrors.no_product" }),
  expectedQuantity: quantityAtLeastZero,
  receivedQuantity: quantityAtLeastZero,
  damagedQuantity: quantityAtLeastZero,
  damageNote: optionalNoteField,
});

export const enterReceiptSchema = z
  .object({
    supplierId: z.string().uuid({ message: "inventoryErrors.no_supplier" }),
    locationCode: z.string().min(1, { message: "inventoryErrors.location.required" }),
    deliveryDate: isoDateField,
    deliveryNoteRef: deliveryNoteField,
    lines: z.array(receiptLineSchema).min(1, { message: "inventoryErrors.lines_required" }),
    idempotencyKey: idempotencyKeyField,
  })
  // Checked here as well as in the database so the message names the field the person can fix,
  // rather than arriving as a whole-form refusal after a round trip.
  .refine(
    (value) => value.lines.every((line) => line.damagedQuantity <= line.receivedQuantity),
    { message: "inventoryErrors.damaged_exceeds_received", path: ["lines"] },
  )
  .refine(
    (value) => new Set(value.lines.map((line) => line.productId)).size === value.lines.length,
    { message: "inventoryErrors.duplicate_product_line", path: ["lines"] },
  );

export const transferLineSchema = z.object({
  productId: z.string().uuid({ message: "inventoryErrors.no_product" }),
  quantity: quantityAtLeastOne,
});

export const enterTransferSchema = z
  .object({
    fromLocation: z.string().min(1, { message: "inventoryErrors.location.required" }),
    toLocation: z.string().min(1, { message: "inventoryErrors.location.required" }),
    note: optionalNoteField,
    lines: z.array(transferLineSchema).min(1, { message: "inventoryErrors.lines_required" }),
    idempotencyKey: idempotencyKeyField,
  })
  .refine((value) => value.fromLocation !== value.toLocation, {
    message: "inventoryErrors.same_location",
    path: ["toLocation"],
  })
  .refine(
    (value) => new Set(value.lines.map((line) => line.productId)).size === value.lines.length,
    { message: "inventoryErrors.duplicate_product_line", path: ["lines"] },
  );

export const enterAdjustmentSchema = z.object({
  productId: z.string().uuid({ message: "inventoryErrors.no_product" }),
  locationCode: z.string().min(1, { message: "inventoryErrors.location.required" }),
  quantityDelta: signedQuantity,
  reason: decisionReasonField,
  idempotencyKey: idempotencyKeyField,
});

export const decisionSchema = z.object({
  entityId: z.string().uuid({ message: "inventoryErrors.generic" }),
  idempotencyKey: idempotencyKeyField,
});

export const rejectionSchema = z.object({
  entityId: z.string().uuid({ message: "inventoryErrors.generic" }),
  reason: decisionReasonField,
  idempotencyKey: idempotencyKeyField,
});
