import { z } from "zod";

import {
  IMPREST_CATEGORIES,
  LINE_PURPOSE_MAX,
  MAX_LINES,
  NO_RECEIPT_REASONS,
  PURPOSE_MAX,
  REASONS_NEEDING_NOTE,
  RECEIPT_MAX_BYTES,
  RECEIPT_TYPES,
  RECIPIENT_MAX,
  settlementFigures,
} from "@/lib/imprest/spending";
import { COUNT_EXPLANATIONS, EXPLANATIONS_NEEDING_NOTE } from "@/lib/imprest/counting";
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

// Hand-out and settlement (issue #62).

const recipientField = z
  .string()
  .transform((value) => value.replace(/\s+/g, " ").trim())
  .refine((value) => value.length >= 2 && value.length <= RECIPIENT_MAX, {
    message: "spendingErrors.recipient_invalid",
  });

/**
 * Verification (issue #64). There is no amount: the Manager verifies the settlement they were
 * shown, exactly as the Cashier submitted it, and the database refuses any other settlement.
 */
export const verifyDisbursementSchema = z.object({
  disbursementId,
  expectedVersion: spendingVersion,
  settlementId: z.string().uuid({ message: "spendingErrors.settlement_not_latest" }),
  idempotencyKey: spendingKey,
});

/**
 * Send back (issue #65): the cycle the Manager was shown and a written reason of 3 to 500
 * characters. There is no amount; the Cashier corrects their own figures in a new cycle.
 */
export const sendBackSchema = z.object({
  disbursementId,
  expectedVersion: spendingVersion,
  settlementId: z.string().uuid({ message: "spendingErrors.settlement_not_latest" }),
  reason: textField(true, "spendingErrors.reason_required"),
  idempotencyKey: spendingKey,
});

/** There is no amount: the approved amount is always what goes out. */
export const handOutSchema = z.object({
  disbursementId,
  expectedVersion: spendingVersion,
  recipient: recipientField,
  idempotencyKey: spendingKey,
});

export const registerReceiptSchema = z.object({
  disbursementId,
  fileName: z
    .string()
    .transform((value) => value.replace(/\s+/g, " ").trim().slice(0, 200))
    .refine((value) => value.length >= 1, { message: "spendingErrors.receipt_name_invalid" }),
  contentType: z.enum(RECEIPT_TYPES, { message: "spendingErrors.receipt_type_invalid" }),
  byteSize: z.coerce
    .number()
    .int()
    .min(1, { message: "spendingErrors.receipt_too_large" })
    .max(RECEIPT_MAX_BYTES, { message: "spendingErrors.receipt_too_large" }),
  idempotencyKey: spendingKey,
});

const lineSchema = z
  .object({
    amount: tzsField(false, "spendingErrors"),
    purpose: z
      .string()
      .transform((value) => value.replace(/\s+/g, " ").trim())
      .refine((value) => value.length >= 2 && value.length <= LINE_PURPOSE_MAX, {
        message: "spendingErrors.line_purpose_invalid",
      }),
    receiptId: z.string().uuid().nullable(),
    reason: z.enum(NO_RECEIPT_REASONS, { message: "spendingErrors.no_receipt_reason_invalid" }).nullable(),
    note: textField(false, "spendingErrors.no_receipt_note_required"),
  })
  .superRefine((line, ctx) => {
    if (line.receiptId === null && line.reason === null) {
      ctx.addIssue({ code: "custom", path: ["evidence"], message: "spendingErrors.line_evidence_required" });
    }
    if (line.receiptId !== null && (line.reason !== null || line.note !== "")) {
      ctx.addIssue({ code: "custom", path: ["evidence"], message: "spendingErrors.line_evidence_both" });
    }
    if (line.reason && REASONS_NEEDING_NOTE.includes(line.reason) && line.note === "") {
      ctx.addIssue({ code: "custom", path: ["note"], message: "spendingErrors.no_receipt_note_required" });
    }
  });

export type SettlementLineInput = z.input<typeof lineSchema>;

/**
 * One settlement: its lines (sent as JSON), the cash returned, and an explanation when the figures
 * leave a remainder. `approved` is only for answering beside the field; the database uses its own.
 */
export const settleSchema = z
  .object({
    disbursementId,
    expectedVersion: spendingVersion,
    approved: z.coerce.number().int().positive(),
    lines: z
      .string()
      .transform((value, ctx) => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          ctx.addIssue({ code: "custom", message: "spendingErrors.lines_invalid" });
          return z.NEVER;
        }
      })
      .pipe(z.array(lineSchema).max(MAX_LINES, { message: "spendingErrors.too_many_lines" })),
    returned: tzsField(true, "spendingErrors"),
    explanation: textField(false, "spendingErrors.explanation_required"),
    idempotencyKey: spendingKey,
  })
  .superRefine((input, ctx) => {
    const figures = settlementFigures(
      input.approved,
      input.lines.map((line) => line.amount),
      input.returned,
    );
    if (figures.over > 0) {
      ctx.addIssue({ code: "custom", path: ["returned"], message: "spendingErrors.over_approval_field" });
    } else if (figures.unexplained > 0 && input.explanation === "") {
      ctx.addIssue({ code: "custom", path: ["explanation"], message: "spendingErrors.explanation_required" });
    } else if (figures.unexplained === 0 && input.explanation !== "") {
      ctx.addIssue({ code: "custom", path: ["explanation"], message: "spendingErrors.explanation_not_needed" });
    }
    const seen = new Set<string>();
    input.lines.forEach((line, i) => {
      if (line.receiptId && seen.has(line.receiptId)) {
        ctx.addIssue({
          code: "custom",
          path: ["lines", i, "evidence"],
          message: "spendingErrors.receipt_cited_twice",
        });
      }
      if (line.receiptId) seen.add(line.receiptId);
    });
  });

// The daily count (issue #68). Its messages live in `countErrors`.

const countKey = z.string().uuid({ message: "countErrors.idempotency_key_conflict" });
const countVersion = z.coerce.number().int().min(1, { message: "countErrors.stale" });
const countId = z.string().uuid({ message: "countErrors.no_count" });

/** Empty is `null`, so the database is sent no note rather than an empty one. */
const optionalNote = (message: string) =>
  textField(false, message).transform((value) => (value === "" ? null : value));

/**
 * The Cashier's count: the cash in the tin, whole shillings of 0 or more, and an optional note.
 * There is no expected figure: the database calculates it and keeps it with the count. A recount
 * names the sent-back count it replaces, and the day the screen was showing.
 */
export const enterCountSchema = z.object({
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "countErrors.day_changed" }),
  previousCountId: z
    .union([z.literal(""), z.string().uuid({ message: "countErrors.stale" })])
    .transform((value) => (value === "" ? null : value)),
  counted: tzsField(true, "countErrors"),
  note: optionalNote("countErrors.note_invalid"),
  idempotencyKey: countKey,
});

/**
 * A late count for a past Not counted day (issue #69): the same fields, and a reason of 3 to 500
 * characters for counting late, which is required.
 */
export const enterLateCountSchema = enterCountSchema.extend({
  lateReason: textField(true, "countErrors.late_reason_required"),
});

/**
 * The Manager's confirmation. There is no figure. `variance` is the one the Manager was shown, so a
 * missing explanation is answered beside the choices; the database decides again from the count
 * itself, and `variance` is not sent to it.
 */
export const confirmCountSchema = z
  .object({
    countId,
    expectedVersion: countVersion,
    variance: z.coerce.number().int(),
    explanation: z.string().transform((value) => (value === "" ? null : value)),
    note: optionalNote("countErrors.explanation_note_required"),
    idempotencyKey: countKey,
  })
  .superRefine((input, ctx) => {
    if (input.variance === 0) {
      if (input.explanation !== null || input.note !== null) {
        ctx.addIssue({ code: "custom", path: ["explanation"], message: "countErrors.explanation_not_needed" });
      }
    } else if (input.explanation === null) {
      ctx.addIssue({ code: "custom", path: ["explanation"], message: "countErrors.explanation_required" });
    } else if (!(COUNT_EXPLANATIONS as readonly string[]).includes(input.explanation)) {
      ctx.addIssue({ code: "custom", path: ["explanation"], message: "countErrors.explanation_invalid" });
    } else if (
      (EXPLANATIONS_NEEDING_NOTE as readonly string[]).includes(input.explanation) &&
      input.note === null
    ) {
      ctx.addIssue({ code: "custom", path: ["note"], message: "countErrors.explanation_note_required" });
    }
  })
  .transform((input) => ({
    countId: input.countId,
    expectedVersion: input.expectedVersion,
    explanation: input.explanation,
    note: input.note,
    idempotencyKey: input.idempotencyKey,
  }));

/** Send a count back for a recount: a reason of 3 to 500 characters, and no figure. */
export const sendBackCountSchema = z.object({
  countId,
  expectedVersion: countVersion,
  reason: textField(true, "countErrors.reason_required"),
  idempotencyKey: countKey,
});
