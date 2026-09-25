import { describe, expect, it } from "vitest";

import { roleMayAccess } from "@/lib/auth/landing";
import { navItemsFor } from "@/lib/nav";
import {
  approveFundingSchema,
  confirmReceivedSchema,
  correctHandoverSchema,
  rejectFundingSchema,
  reportMismatchSchema,
  requestFundingSchema,
} from "@/lib/validation/imprest";

const KEY = "0b7b0a55-0000-4000-8000-000000000001";
const FUNDING = "0b7b0a55-0000-4000-8000-000000000002";

describe("imprest funding routes", () => {
  it("open the imprest screens to the Manager, the Directors and, for spending, the Cashier", () => {
    expect(roleMayAccess("manager", "/imprest")).toBe(true);
    expect(roleMayAccess("director", "/imprest/" + FUNDING)).toBe(true);
    expect(roleMayAccess("cashier", "/imprest")).toBe(true);
    expect(roleMayAccess("sales_rep", "/imprest")).toBe(false);
  });

  it("offer navigation to exactly those roles", () => {
    const has = (role: Parameters<typeof navItemsFor>[0]) =>
      navItemsFor(role).some((item) => item.href === "/imprest");
    expect([has("manager"), has("director"), has("cashier"), has("sales_rep")]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});

describe("imprest funding inputs", () => {
  it("take whole shillings with phone separators, and refuse zero or a decimal", () => {
    const ok = requestFundingSchema.safeParse({ amount: "100,000", reason: "Yard float", idempotencyKey: KEY });
    expect(ok.success && ok.data.amount).toBe(100000);
    expect(requestFundingSchema.safeParse({ amount: "0", reason: "Yard float", idempotencyKey: KEY }).success).toBe(false);
    expect(requestFundingSchema.safeParse({ amount: "12.5", reason: "Yard float", idempotencyKey: KEY }).success).toBe(false);
  });

  it("require a request reason and a rejection reason", () => {
    expect(requestFundingSchema.safeParse({ amount: "100", reason: "  ", idempotencyKey: KEY }).success).toBe(false);
    expect(
      rejectFundingSchema.safeParse({ fundingId: FUNDING, expectedVersion: "1", reason: "no", idempotencyKey: KEY })
        .success,
    ).toBe(false);
  });

  it("accept a zero count, because nothing may have arrived", () => {
    const parsed = reportMismatchSchema.safeParse({
      fundingId: FUNDING,
      expectedVersion: "3",
      handoverId: KEY,
      counted: "0",
      note: "",
      idempotencyKey: KEY,
    });
    expect(parsed.success && parsed.data.counted).toBe(0);
  });

  it("require an explanation for a corrected handover", () => {
    expect(
      correctHandoverSchema.safeParse({
        fundingId: FUNDING,
        expectedVersion: "4",
        amount: "75000",
        explanation: "",
        idempotencyKey: KEY,
      }).success,
    ).toBe(false);
  });

  it("carry the version and handover the screen showed, and refuse a missing one", () => {
    const confirm = confirmReceivedSchema.safeParse({
      fundingId: FUNDING,
      expectedVersion: "3",
      handoverId: KEY,
      idempotencyKey: KEY,
    });
    expect(confirm.success && confirm.data.expectedVersion).toBe(3);
    expect(
      confirmReceivedSchema.safeParse({ fundingId: FUNDING, expectedVersion: "3", handoverId: "", idempotencyKey: KEY })
        .success,
    ).toBe(false);
    expect(
      approveFundingSchema.safeParse({ fundingId: FUNDING, expectedVersion: "0", amount: "10", idempotencyKey: KEY })
        .success,
    ).toBe(false);
  });
});
