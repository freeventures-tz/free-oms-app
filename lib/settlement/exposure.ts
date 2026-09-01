/**
 * What one customer already owes on approved credit (design.md §7.8).
 *
 * §7.8 puts customer credit exposure third in the approval screen's hierarchy, after the requested
 * amount and the limit result, and the reason is the decision it informs: a Manager asked to
 * approve TZS 400,000 is inside their limit on THIS invoice and may still be handing the same
 * customer their fourth unpaid balance of the week. The per-invoice limit of product.md §4 cannot
 * see that; only a total across the customer can.
 *
 * WHAT COUNTS, and why it is not simply the sum of the approvals. An approved credit is a decision;
 * exposure is money still out. A customer who was granted 800 000 on credit and has since paid
 * 300 000 of it is exposed for 500 000, not 800 000 — so each invoice contributes
 * `min(approved credit, outstanding)`: never more than was approved, and never more than is still
 * owed. A cancelled invoice contributes nothing, because it is owed by nobody.
 *
 * It lives apart from `settlement.ts` for the reason `methods.ts` does: that file imports the
 * server Supabase client, which imports `next/headers`, so a client component importing this
 * through it would drag the whole server client into the browser bundle.
 */

/** The parts of an invoice this calculation reads, and nothing else. */
export type ExposureInput = {
  customerId: string;
  cancelledAt: string | null;
  settlement: { approvedCreditTzs: number; outstandingTzs: number };
};

/** How much of one invoice is money out on approved credit. Never negative. */
export function creditExposureOf(invoice: ExposureInput): number {
  if (invoice.cancelledAt !== null) return 0;

  const { approvedCreditTzs, outstandingTzs } = invoice.settlement;
  return Math.max(0, Math.min(approvedCreditTzs, outstandingTzs));
}

/**
 * Every customer's exposure, keyed by customer.
 *
 * A customer with no approved credit is absent rather than zero, so a caller reads
 * `map.get(id) ?? 0` and gets the same answer either way.
 */
export function creditExposureByCustomer(invoices: ExposureInput[]): Map<string, number> {
  const total = new Map<string, number>();

  for (const invoice of invoices) {
    const owed = creditExposureOf(invoice);
    if (owed === 0) continue;
    total.set(invoice.customerId, (total.get(invoice.customerId) ?? 0) + owed);
  }

  return total;
}
