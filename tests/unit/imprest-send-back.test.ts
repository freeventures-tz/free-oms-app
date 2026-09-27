import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import sw from "@/messages/sw.json";
import { earlierReceipts, type SettlementCycle } from "@/lib/imprest/disbursements";
import { fieldErrors } from "@/lib/validation/auth";
import { sendBackSchema } from "@/lib/validation/imprest";

/**
 * Issue #65: what the browser checks before the Manager's send-back reaches the database, which
 * checks it all again; which receipts the Cashier may cite again; and the words the screens use.
 */

const ID = "7d4f5b1e-3c1a-4a55-9a53-2f4c9e1d2b10";
const SETTLEMENT = "0b8e6c2a-5d44-4f0e-8a61-9b1c3d2e4f50";
const KEY = "9f1b8d1c-6e0a-4d6f-9d5a-1c7b3e2a4f60";

const sendBack = (overrides: Record<string, unknown> = {}) =>
  sendBackSchema.safeParse({
    disbursementId: ID,
    expectedVersion: "4",
    settlementId: SETTLEMENT,
    reason: "  The fuel   receipt is unreadable ",
    idempotencyKey: KEY,
    ...overrides,
  });

describe("the send-back input", () => {
  it("carries the cycle the Manager was shown and the reason, tidied", () => {
    const parsed = sendBack();
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      disbursementId: ID,
      expectedVersion: 4,
      settlementId: SETTLEMENT,
      reason: "The fuel receipt is unreadable",
      idempotencyKey: KEY,
    });
  });

  it("has no amount: the Manager never corrects a figure", () => {
    const parsed = sendBack({ amount: "1000", used: "5" });
    expect(parsed.success).toBe(true);
    expect(Object.keys(parsed.data ?? {}).sort()).toEqual(
      ["disbursementId", "expectedVersion", "idempotencyKey", "reason", "settlementId"].sort(),
    );
  });

  it.each([
    ["missing", ""],
    ["only spaces", "    "],
    ["under 3 characters", "no"],
    ["over 500 characters", "x".repeat(501)],
  ])("refuses a reason that is %s", (_what, reason) => {
    const parsed = sendBack({ reason });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(fieldErrors(parsed.error).reason).toBe("spendingErrors.reason_required");
  });

  it("accepts a reason of exactly 3 and exactly 500 characters", () => {
    expect(sendBack({ reason: "abc" }).success).toBe(true);
    expect(sendBack({ reason: "x".repeat(500) }).success).toBe(true);
  });

  it("refuses a missing cycle as one that is no longer the latest", () => {
    const parsed = sendBack({ settlementId: "" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(fieldErrors(parsed.error).settlementId).toBe("spendingErrors.settlement_not_latest");
    }
  });
});

const cycle = (n: number, receipts: (string | null)[]): SettlementCycle => ({
  id: `s${n}`,
  cycle: n,
  used: 0,
  returned: 0,
  unaccounted: 0,
  explanation: null,
  lineCount: receipts.length,
  noReceiptLines: receipts.filter((r) => r === null).length,
  settledAt: "2026-09-28T08:00:00Z",
  sentBack: null,
  lines: receipts.map((id, i) => ({
    lineNo: i + 1,
    amount: 1000,
    purpose: `Line ${i + 1}`,
    receipt: id ? { id, fileName: `${id}.jpg`, contentType: "image/jpeg" } : null,
    reason: id ? null : "transport_fare",
    note: null,
  })),
});

describe("the receipts a later cycle may cite again", () => {
  it("offers every receipt an earlier cycle cited, once, from the newest cycle first", () => {
    const offered = earlierReceipts([cycle(1, ["fuel", null, "tolls"]), cycle(2, ["fuel", "parking"])]);
    expect(offered.map((r) => [r.id, r.cycle])).toEqual([
      ["fuel", 2],
      ["parking", 2],
      ["tolls", 1],
    ]);
  });

  it("offers nothing when no cycle cited a receipt", () => {
    expect(earlierReceipts([cycle(1, [null, null])])).toEqual([]);
    expect(earlierReceipts([])).toEqual([]);
  });
});

describe("the words", () => {
  it("say sent back, and settle again, in both languages", () => {
    for (const messages of [en, sw]) {
      const s = messages.imprest.spending;
      for (const text of [
        s.status.sent_back,
        s.history.sent_back,
        s.lists.sentBack,
        s.lists.nextSettleAgain,
        s.sendBack.open,
        s.sendBack.confirm,
        s.success.sentBack,
        s.settleAgain.title,
        s.settleAgain.reasonHeading,
        s.settle.earlier,
        s.settle.preparing,
      ]) {
        expect(text.trim().length).toBeGreaterThan(2);
      }
    }
    expect(en.imprest.spending.lists.nextSettleAgain).toBe("Next: settle again");
    expect(en.imprest.spending.settleAgain.title).toBe("Settle again");
    expect(en.imprest.spending.lists.sentBack).toBe("Sent back, waiting for the Cashier ({count})");
  });
});
