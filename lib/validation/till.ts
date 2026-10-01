import { z } from "zod";

import { PAYMENT_METHODS, type PaymentMethod } from "@/lib/settlement/methods";
import { MAX_TILL_TZS, REASONS_NEEDING_NOTE, VARIANCE_REASONS } from "@/lib/till/counting";

/**
 * Till count inputs (issue #83). They mirror the database's own checks so a mistake is answered
 * beside the field instead of after a round trip. They are never the control: every command checks
 * the same rules again.
 */

const key = z.string().uuid({ message: "till.errors.idempotency_key_conflict" });
const version = z.coerce.number().int().min(1, { message: "till.errors.stale" });
const countId = z.string().uuid({ message: "till.errors.no_count" });

function text(required: boolean, message: string) {
  return z
    .string()
    .transform((value) => value.replace(/\s+/g, " ").trim())
    .refine((value) => (value.length === 0 ? !required : value.length >= 3 && value.length <= 500), {
      message,
    });
}
const optionalText = (message: string) => text(false, message).transform((v) => (v === "" ? null : v));

/**
 * One counted figure, whole shillings of 0 or more, with the separators people type on a phone. A
 * blank is not a zero: a method nobody counted is refused beside its field, never sent as 0.
 */
const figure = z.string().transform((value, ctx) => {
  const cleaned = value.replace(/[\s ,]/g, "");
  if (cleaned.length === 0) {
    ctx.addIssue({ code: "custom", message: "till.errors.amount_required" });
    return z.NEVER;
  }
  if (!/^\d+$/.test(cleaned)) {
    ctx.addIssue({ code: "custom", message: "till.errors.amount_invalid" });
    return z.NEVER;
  }
  const amount = Number(cleaned);
  if (!Number.isSafeInteger(amount) || amount > MAX_TILL_TZS) {
    ctx.addIssue({ code: "custom", message: "till.errors.amount_too_large" });
    return z.NEVER;
  }
  return amount;
});

const counted = z.object(
  Object.fromEntries(PAYMENT_METHODS.map((m) => [m, figure])) as Record<PaymentMethod, typeof figure>,
);

/**
 * The Cashier's count: a figure for every payment method and an optional note. There is no expected
 * figure: the database calculates it and keeps it with the count. A recount names the sent-back
 * count it replaces, and the day the screen was showing.
 */
export const enterTillCountSchema = z.object({
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "till.errors.day_changed" }),
  previousCountId: z
    .union([z.literal(""), z.string().uuid({ message: "till.errors.stale" })])
    .transform((v) => (v === "" ? null : v)),
  counted,
  note: optionalText("till.errors.note_invalid"),
  idempotencyKey: key,
});

/** A past Not counted day, counted late: the same fields, and a reason that is required. */
export const enterLateTillCountSchema = enterTillCountSchema.extend({
  lateReason: text(true, "till.errors.late_reason_required"),
});

/**
 * The Manager's confirmation. There is no figure. `short` and `over` are what the Manager was shown,
 * so a missing reason is answered beside the choices; the database decides again from the count
 * itself, and neither is sent to it.
 */
export const confirmTillCountSchema = z
  .object({
    countId,
    expectedVersion: version,
    short: z.coerce.number().int().min(0),
    over: z.coerce.number().int().min(0),
    explanation: z.string().transform((value) => (value === "" ? null : value)),
    note: optionalText("till.errors.explanation_note_required"),
    idempotencyKey: key,
  })
  .superRefine((input, ctx) => {
    if (input.short === 0 && input.over === 0) {
      if (input.explanation !== null || input.note !== null) {
        ctx.addIssue({ code: "custom", path: ["explanation"], message: "till.errors.explanation_not_needed" });
      }
    } else if (input.explanation === null) {
      ctx.addIssue({ code: "custom", path: ["explanation"], message: "till.errors.explanation_required" });
    } else if (!(VARIANCE_REASONS as readonly string[]).includes(input.explanation)) {
      ctx.addIssue({ code: "custom", path: ["explanation"], message: "till.errors.explanation_invalid" });
    } else if ((REASONS_NEEDING_NOTE as readonly string[]).includes(input.explanation) && input.note === null) {
      ctx.addIssue({ code: "custom", path: ["note"], message: "till.errors.explanation_note_required" });
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
export const sendBackTillCountSchema = z.object({
  countId,
  expectedVersion: version,
  reason: text(true, "till.errors.reason_required"),
  idempotencyKey: key,
});
