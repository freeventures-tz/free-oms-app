import { z } from "zod";

import { MAX_PRICE_TZS, parseTzs } from "@/lib/money";
import { PAYMENT_METHODS } from "@/lib/settlement/methods";
import { quantityAtLeastOne } from "@/lib/validation/inventory";

/**
 * Zod 4 schemas for the settlement and dispatch Server Actions (architecture.md §5.11).
 *
 * Failures return TRANSLATION KEYS, never English sentences (design.md §8.2).
 *
 * None of this is the authority check. A Manager who submits a perfectly valid TZS 900,000 credit
 * approval passes every rule here and is refused by the database, which is where product.md §4's
 * TZS 500,000 limit actually lives.
 */

const idempotencyKeyField = z.string().uuid({
  message: "settlementErrors.idempotency_key_conflict",
});

/**
 * An amount of money as typed, in whole shillings.
 *
 * `parseTzs` refuses a decimal point rather than rounding it away, for the reason it always has:
 * `12,500.60` is either a mistake or a misunderstanding about what the field holds, and quietly
 * discarding the tail would hide both. On money that has physically changed hands, that matters
 * more here than anywhere else in the system.
 */
export const amountField = z.string().transform((value, ctx) => {
  const parsed = parseTzs(value);
  if (parsed === null) {
    const digitsOnly = value.replace(/[\s ,]/g, "");
    ctx.addIssue({
      code: "custom",
      message:
        /^\d+$/.test(digitsOnly) && Number(digitsOnly) > MAX_PRICE_TZS
          ? "settlementErrors.amount.tooLarge"
          : "settlementErrors.amount.invalid",
    });
    return z.NEVER;
  }
  return parsed;
});

/**
 * One of the six tenders (product.md §12.5).
 *
 * An enum rather than free text, and the list comes from the same constant the command layer uses,
 * so a seventh method cannot appear on a screen without appearing in the database's own enum too.
 * Credit is not here, and AC-92 is why: it records no money.
 */
export const paymentMethodField = z.enum(PAYMENT_METHODS, {
  message: "settlementErrors.method.required",
});

export const reasonField = z
  .string()
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(3, { message: "settlementErrors.reason.tooShort" })
      .max(500, { message: "settlementErrors.reason.tooLong" }),
  );

export const optionalNoteField = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = (value ?? "").trim();
    return trimmed.length === 0 ? null : trimmed;
  })
  .refine((value) => value === null || value.length <= 500, {
    message: "settlementErrors.note.tooLong",
  });

export const storekeeperNameField = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(2, { message: "settlementErrors.storekeeperName.tooShort" })
      .max(120, { message: "settlementErrors.storekeeperName.tooLong" }),
  );

/** Optional, and stored as typed: product.md §3.2 asks for a phone number, not a verified one. */
export const optionalPhoneField = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = (value ?? "").trim();
    return trimmed.length === 0 ? null : trimmed;
  })
  .refine((value) => value === null || value.length <= 30, {
    message: "settlementErrors.phone.tooLong",
  });

export const isoDateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "settlementErrors.startDate.invalid" });

/**
 * The physical dispatch-note number (product.md §14).
 *
 * One of the few genuinely required typed inputs (design.md §10.2), because the OMS does not
 * produce the note — the number comes off the four-copy carbon book in somebody's hand.
 */
export const dispatchNoteField = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(1, { message: "settlementErrors.dispatchNote.tooShort" })
      .max(40, { message: "settlementErrors.dispatchNote.tooLong" }),
  );

export const addStorekeeperSchema = z.object({
  fullName: storekeeperNameField,
  phone: optionalPhoneField,
  startDate: isoDateField,
  note: optionalNoteField,
  idempotencyKey: idempotencyKeyField,
});

export const setStorekeeperActiveSchema = z.object({
  storekeeperId: z.string().uuid({ message: "settlementErrors.no_storekeeper" }),
  isActive: z.enum(["true", "false"]).transform((value) => value === "true"),
  idempotencyKey: idempotencyKeyField,
});

export const recordPaymentSchema = z.object({
  invoiceId: z.string().uuid({ message: "settlementErrors.no_invoice" }),
  method: paymentMethodField,
  amount: amountField,
  idempotencyKey: idempotencyKeyField,
});

export const requestCreditSchema = z.object({
  invoiceId: z.string().uuid({ message: "settlementErrors.no_invoice" }),
  amount: amountField,
  reason: reasonField,
  idempotencyKey: idempotencyKeyField,
});

export const creditDecisionSchema = z.object({
  creditId: z.string().uuid({ message: "settlementErrors.no_credit_request" }),
  idempotencyKey: idempotencyKeyField,
});

export const creditRejectionSchema = z.object({
  creditId: z.string().uuid({ message: "settlementErrors.no_credit_request" }),
  reason: reasonField,
  idempotencyKey: idempotencyKeyField,
});

export const invoiceActionSchema = z.object({
  invoiceId: z.string().uuid({ message: "settlementErrors.no_invoice" }),
  idempotencyKey: idempotencyKeyField,
});

export const cashSaleSchema = z.object({
  orderId: z.string().uuid({ message: "settlementErrors.no_order" }),
  method: paymentMethodField,
  amount: amountField,
  idempotencyKey: idempotencyKeyField,
});

export const dispatchLineSchema = z.object({
  allocationId: z.string().uuid({ message: "settlementErrors.no_allocation" }),
  quantity: quantityAtLeastOne,
});

export const assignDispatchSchema = z.object({
  invoiceId: z.string().uuid({ message: "settlementErrors.no_invoice" }),
  storekeeperId: z.string().uuid({ message: "settlementErrors.no_storekeeper" }),
  sourceLocation: z.string().min(1, { message: "settlementErrors.location.required" }),
  lines: z.array(dispatchLineSchema).min(1, { message: "settlementErrors.lines_required" }),
  idempotencyKey: idempotencyKeyField,
});

export const recordNoteSchema = z.object({
  dispatchId: z.string().uuid({ message: "settlementErrors.no_dispatch" }),
  noteNo: dispatchNoteField,
  idempotencyKey: idempotencyKeyField,
});

export const dispatchActionSchema = z.object({
  dispatchId: z.string().uuid({ message: "settlementErrors.no_dispatch" }),
  idempotencyKey: idempotencyKeyField,
});

export const paymentReversalSchema = z.object({
  paymentId: z.string().uuid({ message: "settlementErrors.no_payment" }),
  reason: reasonField,
  idempotencyKey: idempotencyKeyField,
});

export const paymentReversalDecisionSchema = z.object({
  paymentId: z.string().uuid({ message: "settlementErrors.no_payment" }),
  idempotencyKey: idempotencyKeyField,
});
