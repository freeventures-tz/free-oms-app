import { describe, expect, it } from "vitest";

import { creditExposureByCustomer, creditExposureOf } from "@/lib/settlement/exposure";
import type { ExposureInput } from "@/lib/settlement/exposure";

/**
 * Customer credit exposure (design.md §7.8).
 *
 * The interesting cases are all about the difference between what was APPROVED and what is still
 * OWED. An approval is a decision and stays in the record; exposure is money out, and it falls as
 * the customer pays. Getting that backwards would show a Manager a debt the customer has already
 * cleared and refuse them a decision product.md §4 permits.
 */
function invoice(
  customerId: string,
  approvedCreditTzs: number,
  outstandingTzs: number,
  cancelledAt: string | null = null,
): ExposureInput {
  return { customerId, cancelledAt, settlement: { approvedCreditTzs, outstandingTzs } };
}

describe("what one invoice contributes", () => {
  it("is the approved credit while none of it has been paid", () => {
    expect(creditExposureOf(invoice("c1", 400_000, 400_000))).toBe(400_000);
  });

  it("falls as the customer pays, because exposure is money out and not a decision", () => {
    // 800 000 approved, 300 000 since paid: 500 000 is still out.
    expect(creditExposureOf(invoice("c1", 800_000, 500_000))).toBe(500_000);
  });

  it("never exceeds what was approved, when part of the bill was never on credit", () => {
    // A 600 000 invoice, 200 000 approved as credit and nothing paid: only 200 000 of the
    // 600 000 outstanding is credit the business agreed to carry.
    expect(creditExposureOf(invoice("c1", 200_000, 600_000))).toBe(200_000);
  });

  it("is nothing once the balance is cleared", () => {
    expect(creditExposureOf(invoice("c1", 400_000, 0))).toBe(0);
  });

  it("is nothing on an invoice nobody owes", () => {
    expect(creditExposureOf(invoice("c1", 400_000, 400_000, "2026-09-01T00:00:00Z"))).toBe(0);
  });

  it("is nothing where no credit was ever approved", () => {
    expect(creditExposureOf(invoice("c1", 0, 500_000))).toBe(0);
  });

  it("is never negative, whatever the figures say", () => {
    expect(creditExposureOf(invoice("c1", 400_000, -50_000))).toBe(0);
  });
});

describe("what a customer owes across every invoice", () => {
  it("adds one customer's invoices together and keeps another's apart", () => {
    const total = creditExposureByCustomer([
      invoice("juma", 400_000, 400_000),
      invoice("juma", 800_000, 500_000),
      invoice("asha", 100_000, 100_000),
    ]);

    // The point of the whole calculation: a Manager asked to approve a fourth balance for Juma is
    // inside their per-invoice limit and looking at 900 000 already out.
    expect(total.get("juma")).toBe(900_000);
    expect(total.get("asha")).toBe(100_000);
  });

  it("leaves a customer with nothing owed out of the map entirely", () => {
    const total = creditExposureByCustomer([
      invoice("juma", 400_000, 0),
      invoice("asha", 0, 300_000),
    ]);

    expect(total.has("juma")).toBe(false);
    expect(total.has("asha")).toBe(false);
    expect(total.get("juma") ?? 0).toBe(0);
  });

  it("ignores a cancelled invoice while counting the customer's live ones", () => {
    const total = creditExposureByCustomer([
      invoice("juma", 400_000, 400_000, "2026-09-01T00:00:00Z"),
      invoice("juma", 250_000, 250_000),
    ]);

    expect(total.get("juma")).toBe(250_000);
  });

  it("answers nothing for an empty queue", () => {
    expect(creditExposureByCustomer([]).size).toBe(0);
  });
});
