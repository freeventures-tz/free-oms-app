import { z } from "zod";

import { IMPREST_CATEGORIES, PURPOSE_MAX } from "@/lib/imprest/spending";
import { MAX_PRICE_TZS, parseTzs } from "@/lib/money";

/**
 * Imprest funding inputs (product.md §13.2, issue #48).
 *
 * These mirror the database's own checks so a mistake is answered beside the field instead of
 * after a round trip. They are never the control: every command re-checks the same rules.
 */

/** Whole shillings as typed. `allowZero` is for a count, where zero records that nothing arrived. */
function tzsField(allowZero: boolean, namespace = "imprestErrors") {
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
            ? `${namespace}.amount_too_large`
            : `${namespace}.amount_invalid`,
      });
      return z.NEVER;
    }
    return parsed;
  });
}

function textField(required: boolean, message: string, max = 500) {
  return z
    .string()
    .transform((value) => value.replace(/\s+/g, " ").trim())
    .refine((value) => (value.length === 0 ? !required : value.length >= 3 && value.length <= max), {
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

// Disbursements (issue #55).

// Their messages live in `spendingErrors`, which speaks of payments rather than funding requests.
const spendingKey = z.string().uuid({ message: "spendingErrors.idempotency_key_conflict" });
const spendingVersion = z.coerce.number().int().min(1, { message: "spendingErrors.stale" });
const disbursementId = z.string().uuid({ message: "spendingErrors.no_disbursement" });

export const proposeDisbursementSchema = z.object({
  amount: tzsField(false, "spendingErrors"),
  category: z.enum(IMPREST_CATEGORIES, { message: "spendingErrors.category_invalid" }),
  purpose: textField(true, "spendingErrors.purpose_required", PURPOSE_MAX),
  idempotencyKey: spendingKey,
});

export const approveDisbursementSchema = z.object({
  disbursementId,
  expectedVersion: spendingVersion,
  idempotencyKey: spendingKey,
});

/** Reject, withdraw and cancel all take a written reason of 3 to 500 characters. */
export const disbursementReasonSchema = z.object({
  disbursementId,
  expectedVersion: spendingVersion,
  reason: textField(true, "spendingErrors.reason_required"),
  idempotencyKey: spendingKey,
});
