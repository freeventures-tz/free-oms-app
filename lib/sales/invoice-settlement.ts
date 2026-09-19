import { DATA_UNAVAILABLE, type ScalarResult } from "@/lib/supabase/query";

/**
 * One invoice's CURRENT settlement, read for the order screen.
 *
 * The invoice itself is immutable and already on the order (AC-12). What it is worth to the
 * business changes every time money moves, and that figure lives in `public.invoice_settlement` —
 * a `security_invoker` view that sums the payments, nets off the reversals, and derives the status
 * from the money alone (product.md §12.3, §12.5). Nothing here recalculates any of it: the view is
 * the arithmetic, and this module's whole job is to refuse to invent a substitute for it.
 *
 * That refusal is the point. `invoice_settlement` LEFT JOINs tables a Sales Representative cannot
 * read, so it carries its own guard and answers them with NO ROW rather than with zeroes. A reader
 * that treats a missing row as "nothing has been paid" would therefore report every invoice in the
 * business as unpaid to that role — and would report the same thing during an outage, to everyone.
 * So the caller asks `api.staff_settlement_readable` first, and the two silences are told apart:
 * one is a boundary and the other is a broken read.
 */

export const SETTLEMENT_STATUSES = ["unpaid", "partially_paid", "paid", "cancelled"] as const;

export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export type InvoiceSettlement = {
  /** The invoice total, from the view rather than the snapshot, so the two can be compared. */
  totalTzs: number;
  /** Money actually received, reversals already netted off (§12.5). Never includes credit. */
  amountPaidTzs: number;
  /** An approved unpaid balance. A decision, not a tender — shown beside the money, never added. */
  approvedCreditTzs: number;
  /** Total less money received. Negative if more was tendered than billed. */
  outstandingTzs: number;
  /** Calculated, never chosen (AC-14). */
  status: SettlementStatus;
};

/** The columns the order screen reads. Narrowed in the SELECT, not mapped down afterwards. */
export const SETTLEMENT_COLUMNS =
  "invoice_id, total_tzs, amount_paid_tzs, approved_credit_tzs, outstanding_tzs, status";

const MONEY_FIELDS = {
  totalTzs: "total_tzs",
  amountPaidTzs: "amount_paid_tzs",
  approvedCreditTzs: "approved_credit_tzs",
  outstandingTzs: "outstanding_tzs",
} as const;

/**
 * What a value WAS, for the log — never what it said.
 *
 * A rejected settlement field is still a figure about somebody's money, so the log records its
 * shape and the column it came from. That is what a person diagnosing this needs, and all of it.
 */
function shapeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "a number that is not finite";
    return Number.isInteger(value) ? "a number" : "a fractional number";
  }
  if (typeof value === "string") return value.trim().length === 0 ? "blank text" : "text";
  return typeof value;
}

function fail(what: string, detail: string): never {
  console.error(`[data] ${what} ${detail}`);
  throw new Error(`${DATA_UNAVAILABLE}: ${what}`);
}

/**
 * Whole shillings, or nothing.
 *
 * `Number(value)` is the shape this has to refuse. It turns null into 0, an empty string into 0
 * and a missing column into NaN, and every one of those would land on the screen as a statement
 * that no money has been received. Only a whole number — or the digits of one, in case PostgREST
 * is ever configured to send `bigint` as text — is an answer.
 */
function money(row: Record<string, unknown>, column: string, what: string): number {
  const value = row[column];

  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);

  return fail(what, `returned ${shapeOf(value)} for ${column} where whole shillings were expected`);
}

/**
 * Whether the caller may read settlement facts at all (design.md §4.2).
 *
 * `api.staff_settlement_readable` answers one question about the caller's own session and nothing
 * about any row — the same bounded definer call the view itself makes. An unanswerable question is
 * a failed read, not a "no": printing "not shown to you" to a Director during an outage would be
 * as false as printing "unpaid".
 */
export function requireSettlementAccess(result: ScalarResult, what: string): boolean {
  if (result.error) fail(what, `failed: ${result.error.message}`);

  if (typeof result.data !== "boolean") {
    return fail(what, `returned ${shapeOf(result.data)} where a yes or no was expected`);
  }

  return result.data;
}

/**
 * The settlement of an invoice the caller has already read and is already entitled to see.
 *
 * There is no empty answer to return. The invoice row is in hand, so the view has a row for it;
 * the access question has been asked and answered yes. Absence, a status outside §12.3 or money
 * that is not money therefore all mean one thing, and it is not zero.
 */
export function requireSettlement(result: ScalarResult, what: string): InvoiceSettlement {
  if (result.error) fail(what, `failed: ${result.error.message}`);

  if (result.data === null || typeof result.data !== "object" || Array.isArray(result.data)) {
    return fail(what, `returned ${shapeOf(result.data)} where one settlement row was expected`);
  }

  const row = result.data as Record<string, unknown>;
  const status = row.status;

  if (
    typeof status !== "string" ||
    !(SETTLEMENT_STATUSES as readonly string[]).includes(status)
  ) {
    return fail(what, `returned ${shapeOf(status)} for status, which product.md §12.3 does not define`);
  }

  return {
    totalTzs: money(row, MONEY_FIELDS.totalTzs, what),
    amountPaidTzs: money(row, MONEY_FIELDS.amountPaidTzs, what),
    approvedCreditTzs: money(row, MONEY_FIELDS.approvedCreditTzs, what),
    outstandingTzs: money(row, MONEY_FIELDS.outstandingTzs, what),
    status: status as SettlementStatus,
  };
}
