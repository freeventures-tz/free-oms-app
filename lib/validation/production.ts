import { z } from "zod";

import { instantFromBusinessLocal } from "@/lib/time/business-date";

/**
 * Zod 4 schemas for the production Server Actions (architecture.md §5.11).
 *
 * Failures return TRANSLATION KEYS, never English sentences (design.md §8.2), matching the pattern
 * `lib/validation/inventory.ts` established.
 *
 * None of this is the authority check. A Cashier who submits a perfectly valid batch passes every
 * rule here and is refused by the database, which is where "Managers only" actually lives (§4.1).
 *
 * TWO FIELDS ARE DELIBERATELY ABSENT, and their absence is the rule:
 *
 *   · `varianceQuantity` — §11.1 records the difference between the standard and the actual, and it
 *     is a GENERATED column. Accepting it here, even to throw it away, is the first step towards a
 *     screen that lets somebody type one.
 *   · `standardQuantity` — snapshotted by the database from the recipe. A form that submitted it
 *     could quietly change what a batch was measured against.
 */

/** The upper bounds the database's own check constraints use, so the two agree. Typo guards. */
export const MAX_INPUT_QUANTITY = 10_000;
export const MAX_MOULDED_QUANTITY = 100_000;

/**
 * THE ONE READING OF A TYPED QUANTITY. Exported because the screen must read it the same way.
 *
 * The form computes a variance, an out-of-range warning, an "everything must be accounted for"
 * total, and whether a reject reason is even asked for -- all from characters somebody is still
 * typing. If the screen reads those characters differently from the schema that captures them, the
 * screen is describing a request that is not the one being sent.
 *
 * `Number.parseInt` with a round-trip guard, which is what the board used to do, is a DIFFERENT
 * reading: `00`, `02` and `018` are all rejected by it as "not a number yet" and all accepted here
 * as 0, 2 and 18. A Manager typing `018` bricks moulded therefore saw no variance, was never asked
 * for the explanation an out-of-range figure needs, and had 18 captured anyway; one typing `00`
 * rejects had the reason buttons disappear while the reason was still sent, and was refused with
 * `reject_reason_without_rejects` -- a refusal about something the screen was not showing.
 *
 * Leading zeros are a whole number written with leading zeros. A numeric keypad produces them by
 * accident and nobody means anything else by them.
 *
 * Returns `null` for anything that is not a whole count -- empty, signed, fractional, exponential,
 * or any non-digit -- so a screen that cannot read a figure shows nothing rather than a guess, and
 * the schema refuses it. BOUNDS ARE NOT APPLIED HERE: what a figure MEANS is shared, what is
 * ALLOWED belongs to the schema and, finally, to the database.
 */
export function parseQuantity(value: string): number | null {
  // Spaces and thousands separators are how people write four-figure counts, not part of the number.
  const trimmed = value.trim().replace(/[\s ,]/g, "");

  if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) return null;

  const parsed = Number(trimmed);

  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A counting-unit quantity as typed.
 *
 * Whole numbers only. §11.1 consumes bags and buckets, and AC-120 is explicit that what one of them
 * CONTAINS is not a quantity — so half a bag is not something this system can express, and silently
 * rounding one is how a ledger stops reconciling.
 */
function quantityField(options: { min: number; max: number }) {
  return z.string().transform((value, ctx) => {
    const parsed = parseQuantity(value);

    if (parsed === null) {
      ctx.addIssue({ code: "custom", message: "productionErrors.quantity.invalid" });
      return z.NEVER;
    }

    if (!Number.isSafeInteger(parsed) || parsed > options.max) {
      ctx.addIssue({ code: "custom", message: "productionErrors.quantity.tooLarge" });
      return z.NEVER;
    }

    if (parsed < options.min) {
      ctx.addIssue({ code: "custom", message: "productionErrors.quantity.invalid" });
      return z.NEVER;
    }

    return parsed;
  });
}

/** The four reject reasons of product.md §11.5, and nothing else. Chosen, never typed (AC-3). */
export const BRICK_REJECT_REASONS = ["broken", "cracked", "undersized", "weak"] as const;
export type BrickRejectReason = (typeof BRICK_REJECT_REASONS)[number];

const rejectReasonField = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = (value ?? "").trim();
    return trimmed.length === 0 ? null : trimmed;
  })
  .refine((value) => value === null || BRICK_REJECT_REASONS.includes(value as BrickRejectReason), {
    message: "productionErrors.reject_reason_invalid",
  });

/**
 * The explanation §11.2 requires when output fell outside the approved range.
 *
 * Optional here rather than conditional, because whether it is REQUIRED depends on the yield ranges
 * and the database owns those. Sending an explanation nobody needed is refused there with
 * `yield_within_range`, which is the same rule stated once.
 */
export const yieldNoteField = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = (value ?? "").trim();
    return trimmed.length === 0 ? null : trimmed;
  })
  .refine((value) => value === null || (value.length >= 3 && value.length <= 500), {
    message: "productionErrors.yield_note.invalid",
  });

export const decisionReasonField = z
  .string()
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(3, { message: "productionErrors.reason.tooShort" })
      .max(500, { message: "productionErrors.reason.tooLong" }),
  );

/**
 * The moulding-completion time, as `<input type="datetime-local">` produces it.
 *
 * §11.4: curing starts when moulding finished, not at data entry. The form pre-fills the yard's
 * current time and the Manager confirms or corrects it, so this is their answer rather than a clock
 * reading. The "not in the future" rule lives in the database, where the business clock is (§15.3).
 *
 * The SHAPE is checked here, and so is the CALENDAR: `2026-02-30T08:00` matches the pattern and is
 * not a day, and a runtime that rolls it into 2 March would store a moulding time nobody entered.
 * `instantFromBusinessLocal` is the same function the command adapter parses with, so a value this
 * schema accepts is a value that reaches the database as the instant the Manager meant.
 */
export const mouldedAtField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, {
    message: "productionErrors.moulded_at_invalid",
  })
  .refine((value) => instantFromBusinessLocal(value) !== null, {
    message: "productionErrors.moulded_at_invalid",
  });

const idempotencyKeyField = z
  .string()
  .uuid({ message: "productionErrors.idempotency_key_conflict" });

/** One material line: what the recipe expects is the database's business, what was used is ours. */
export const batchInputSchema = z.object({
  productId: z.string().uuid({ message: "productionErrors.no_product" }),
  actualQuantity: quantityField({ min: 0, max: MAX_INPUT_QUANTITY }),
});

/** One output lot: what came out of the mould, and what was thrown away there and then (§11.3). */
export const batchOutputSchema = z
  .object({
    productId: z.string().uuid({ message: "productionErrors.no_product" }),
    quantityMoulded: quantityField({ min: 1, max: MAX_MOULDED_QUANTITY }),
    rejectedQuantity: quantityField({ min: 0, max: MAX_MOULDED_QUANTITY }),
    rejectReason: rejectReasonField,
  })
  .refine((value) => value.rejectedQuantity <= value.quantityMoulded, {
    message: "productionErrors.rejects_exceed_output",
    path: ["rejectedQuantity"],
  })
  // §11.5, AC-45: a reject count with no reason is a number nobody can act on, and a reason with no
  // rejects is a claim about nothing. Checked here so the message names the field, not the form.
  .refine((value) => value.rejectedQuantity === 0 || value.rejectReason !== null, {
    message: "productionErrors.reject_reason_required",
    path: ["rejectReason"],
  })
  .refine((value) => value.rejectedQuantity > 0 || value.rejectReason === null, {
    message: "productionErrors.reject_reason_without_rejects",
    path: ["rejectReason"],
  });

export const enterBatchSchema = z
  .object({
    locationCode: z.string().min(1, { message: "productionErrors.location.required" }),
    mouldedAt: mouldedAtField,
    inputs: z.array(batchInputSchema).min(1, { message: "productionErrors.inputs_required" }),
    outputs: z.array(batchOutputSchema).min(1, { message: "productionErrors.outputs_required" }),
    yieldNote: yieldNoteField,
    idempotencyKey: idempotencyKeyField,
  })
  .refine(
    (value) => new Set(value.inputs.map((line) => line.productId)).size === value.inputs.length,
    { message: "productionErrors.duplicate_product_line", path: ["inputs"] },
  )
  .refine(
    (value) => new Set(value.outputs.map((line) => line.productId)).size === value.outputs.length,
    { message: "productionErrors.duplicate_product_line", path: ["outputs"] },
  );

export const batchDecisionSchema = z.object({
  batchId: z.string().uuid({ message: "productionErrors.no_batch" }),
  idempotencyKey: idempotencyKeyField,
});

export const batchRejectionSchema = z.object({
  batchId: z.string().uuid({ message: "productionErrors.no_batch" }),
  reason: decisionReasonField,
  idempotencyKey: idempotencyKeyField,
});

/**
 * The inspection (§11.4).
 *
 * Everything that went into curing has to be accounted for, and the database refuses a total that
 * does not match. It is not re-checked here: the curing quantity is a ledger sum, and a form that
 * carried its own copy could disagree with it.
 */
export const inspectLotSchema = z
  .object({
    lotId: z.string().uuid({ message: "productionErrors.no_lot" }),
    acceptedQuantity: quantityField({ min: 0, max: MAX_MOULDED_QUANTITY }),
    rejectedQuantity: quantityField({ min: 0, max: MAX_MOULDED_QUANTITY }),
    rejectReason: rejectReasonField,
    idempotencyKey: idempotencyKeyField,
  })
  .refine((value) => value.rejectedQuantity === 0 || value.rejectReason !== null, {
    message: "productionErrors.reject_reason_required",
    path: ["rejectReason"],
  })
  .refine((value) => value.rejectedQuantity > 0 || value.rejectReason === null, {
    message: "productionErrors.reject_reason_without_rejects",
    path: ["rejectReason"],
  });
