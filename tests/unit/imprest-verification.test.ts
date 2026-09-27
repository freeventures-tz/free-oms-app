import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import sw from "@/messages/sw.json";
import { fieldErrors } from "@/lib/validation/auth";
import { verifyDisbursementSchema } from "@/lib/validation/imprest";

/**
 * Issue #64: what the browser checks before the Manager's verification reaches the database, which
 * checks it all again, and the words the screens use for it.
 */

const ID = "7d4f5b1e-3c1a-4a55-9a53-2f4c9e1d2b10";
const SETTLEMENT = "0b8e6c2a-5d44-4f0e-8a61-9b1c3d2e4f50";
const KEY = "9f1b8d1c-6e0a-4d6f-9d5a-1c7b3e2a4f60";

const verify = (overrides: Record<string, unknown> = {}) =>
  verifyDisbursementSchema.safeParse({
    disbursementId: ID,
    expectedVersion: "4",
    settlementId: SETTLEMENT,
    idempotencyKey: KEY,
    ...overrides,
  });

describe("the verify input", () => {
  it("carries the disbursement, the version and the settlement the Manager was shown", () => {
    const parsed = verify();
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      disbursementId: ID,
      expectedVersion: 4,
      settlementId: SETTLEMENT,
      idempotencyKey: KEY,
    });
  });

  it("has no amount: one sent along is dropped, never passed on", () => {
    const parsed = verify({ amount: "1000", used: "5", unaccounted: "0" });
    expect(parsed.success).toBe(true);
    expect(Object.keys(parsed.data ?? {}).sort()).toEqual(
      ["disbursementId", "expectedVersion", "idempotencyKey", "settlementId"].sort(),
    );
  });

  it("refuses a missing settlement as a settlement that is no longer the latest", () => {
    const parsed = verify({ settlementId: "" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(fieldErrors(parsed.error).settlementId).toBe("spendingErrors.settlement_not_latest");
    }
  });

  it("refuses a version that isn't one", () => {
    const parsed = verify({ expectedVersion: "0" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(fieldErrors(parsed.error).expectedVersion).toBe("spendingErrors.stale");
  });
});

describe("the words for verification", () => {
  it("say what the first figure is, in the ticket's words", () => {
    expect(en.imprest.total.label).toBe("Posted balance");
    expect(en.imprest.total.help).toMatch(/^Confirmed funding minus verified spending and losses\./);
  });

  it("name what is posted and what comes back, with the amount on the one confirmation", () => {
    const v = en.imprest.spending.verify;
    expect(v.expense).toContain("{amount}");
    expect(v.loss).toContain("{amount}");
    expect(v.released).toContain("{amount}");
    expect(v.confirm).toContain("{amount}");
    expect(en.imprest.spending.posted.lossNote).toBe("Awaiting a Director's decision");
    expect(en.imprest.spending.status.verified).toBe("Verified");
  });

  it("carry the same placeholders in Swahili", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en.imprest.spending.verify) as (keyof typeof en.imprest.spending.verify)[]) {
      expect(placeholders(sw.imprest.spending.verify[key])).toEqual(placeholders(en.imprest.spending.verify[key]));
    }
    expect(placeholders(sw.imprest.spending.posted.verifiedBy)).toEqual(["at", "name"]);
  });

  it("tell the Manager plainly what a refusal means", () => {
    expect(en.spendingErrors.not_settled).toBeTruthy();
    expect(en.spendingErrors.settlement_not_latest).toMatch(/Reload/);
    expect(sw.spendingErrors.not_settled).toBeTruthy();
    expect(sw.spendingErrors.settlement_not_latest).toBeTruthy();
  });

  it("no longer say that checking a settlement isn't built", () => {
    const text = JSON.stringify([en.imprest, sw.imprest]);
    expect(text).not.toMatch(/isn't built|haujajengwa|ikishajengwa|once that step is built/);
    expect(text).not.toMatch(/encumb/i);
  });
});
