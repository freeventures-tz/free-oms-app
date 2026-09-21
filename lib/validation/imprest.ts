import { z } from "zod";

import { MAX_PRICE_TZS, parseTzs } from "@/lib/money";

/**
 * Imprest funding inputs (product.md §13.2, issue #48).
 *
 * These mirror the database's own checks so a mistake is answered beside the field instead of
 * after a round trip. They are never the control: every command re-checks the same rules.
 */

/** Whole shillings as typed. `allowZero` is for a count, where zero records that nothing arrived. */
function tzsField(allowZero: boolean) {
  return z.string().transform((value, ctx) => {
    // `parseTzs` is written for prices and refuses zero. A count may be zero.
    const zero = allowZero && /^0+$/.test(value.replace(/[\s ,]/g, ""));
    const parsed = zero ? 0 : parseTzs(value);
    if (parsed === null || (!allowZero && parsed === 0)) {
      const digitsOnly = value.replace(/[\s ,]/g, "");
      ctx.addIssue({
        code: "custom",
        message:
          /^\d+$/.test(digitsOnly) && Number(digitsOnly) > MAX_PRICE_TZS
            ? "imprestErrors.amount_too_large"
            : "imprestErrors.amount_invalid",
      });
      return z.NEVER;
    }
    return parsed;
  });
}

function textField(required: boolean, message: string) {
  return z
    .string()
    .transform((value) => value.replace(/\s+/g, " ").trim())
    .refine((value) => (value.length === 0 ? !required : value.length >= 3 && value.length <= 500), {
      message,
    });
}

const fundingId = z.string().uuid({ message: "imprestErrors.no_funding" });
const handoverId = z.string().uuid({ message: "imprestErrors.stale" });
const expectedVersion = z.coerce.number().int().min(1, { message: "imprestErrors.stale" });
const idempotencyKey = z.string().uuid({ message: "imprestErrors.idempotency_key_conflict" });

export const requestFundingSchema = z.object({
  amount: tzsField(false),
  reason: textField(true, "imprestErrors.reason_required"),
  idempotencyKey,
});

export const approveFundingSchema = z.object({
  fundingId,
  expectedVersion,
  amount: tzsField(false),
  idempotencyKey,
});

export const rejectFundingSchema = z.object({
  fundingId,
  expectedVersion,
  reason: textField(true, "imprestErrors.reason_required"),
  idempotencyKey,
});

export const increaseApprovalSchema = z.object({
  fundingId,
  expectedVersion,
  amount: tzsField(false),
  note: textField(false, "imprestErrors.note_invalid"),
  idempotencyKey,
});

export const provideFundingSchema = z.object({
  fundingId,
  expectedVersion,
  amount: tzsField(false),
  idempotencyKey,
});

export const confirmReceivedSchema = z.object({
  fundingId,
  expectedVersion,
  handoverId,
  idempotencyKey,
});

export const reportMismatchSchema = z.object({
  fundingId,
  expectedVersion,
  handoverId,
  counted: tzsField(true),
  note: textField(false, "imprestErrors.note_invalid"),
  idempotencyKey,
});

export const correctHandoverSchema = z.object({
  fundingId,
  expectedVersion,
  amount: tzsField(false),
  explanation: textField(true, "imprestErrors.explanation_required"),
  idempotencyKey,
});
