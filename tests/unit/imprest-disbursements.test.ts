import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import sw from "@/messages/sw.json";
import { distinctPurposes, IMPREST_CATEGORIES, openFor, PURPOSE_MAX } from "@/lib/imprest/spending";
import {
  approveDisbursementSchema,
  disbursementReasonSchema,
  proposeDisbursementSchema,
} from "@/lib/validation/imprest";

const KEY = "0b7b0a55-0000-4000-8000-000000000001";
const ID = "0b7b0a55-0000-4000-8000-000000000003";

const propose = (fields: Partial<Record<string, string>>) =>
  proposeDisbursementSchema.safeParse({
    amount: "30,000",
    category: "fuel_and_lubricants",
    purpose: "Generator diesel",
    idempotencyKey: KEY,
    ...fields,
  });

const firstMessage = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.success ? null : result.error?.issues[0]?.message;

describe("disbursement inputs", () => {
  it("take whole shillings, one of the nine categories and a short purpose", () => {
    const ok = propose({});
    expect(ok.success && ok.data).toEqual({
      amount: 30000,
      category: "fuel_and_lubricants",
      purpose: "Generator diesel",
      idempotencyKey: KEY,
    });
  });

  it("answer a bad amount in the spending messages, not the funding ones", () => {
    expect(firstMessage(propose({ amount: "0" }))).toBe("spendingErrors.amount_invalid");
    expect(firstMessage(propose({ amount: "12.5" }))).toBe("spendingErrors.amount_invalid");
    expect(firstMessage(propose({ amount: "999999999999" }))).toBe("spendingErrors.amount_too_large");
  });

  it("refuse a category that is not one of the nine", () => {
    expect(firstMessage(propose({ category: "" }))).toBe("spendingErrors.category_invalid");
    expect(firstMessage(propose({ category: "entertainment" }))).toBe("spendingErrors.category_invalid");
    expect(IMPREST_CATEGORIES).toHaveLength(9);
  });

  it("hold a purpose to 3 to 120 characters after tidying its spaces", () => {
    expect(firstMessage(propose({ purpose: "  " }))).toBe("spendingErrors.purpose_required");
    expect(firstMessage(propose({ purpose: "ab" }))).toBe("spendingErrors.purpose_required");
    expect(propose({ purpose: "x".repeat(PURPOSE_MAX) }).success).toBe(true);
    expect(firstMessage(propose({ purpose: "x".repeat(PURPOSE_MAX + 1) }))).toBe(
      "spendingErrors.purpose_required",
    );
    const tidy = propose({ purpose: "  Generator   diesel " });
    expect(tidy.success && tidy.data.purpose).toBe("Generator diesel");
  });

  it("approve with no amount at all: the proposed figure stands", () => {
    const parsed = approveDisbursementSchema.safeParse({
      disbursementId: ID,
      expectedVersion: "1",
      idempotencyKey: KEY,
      amount: "5000",
    });
    expect(parsed.success && parsed.data).toEqual({ disbursementId: ID, expectedVersion: 1, idempotencyKey: KEY });
  });

  it("require a reason of 3 to 500 characters to reject, withdraw or cancel", () => {
    const reason = (value: string) =>
      disbursementReasonSchema.safeParse({ disbursementId: ID, expectedVersion: "2", reason: value, idempotencyKey: KEY });
    expect(firstMessage(reason("no"))).toBe("spendingErrors.reason_required");
    expect(reason("x".repeat(500)).success).toBe(true);
    expect(reason("x".repeat(501)).success).toBe(false);
    expect(reason("Wrong amount").success).toBe(true);
  });

  it("refuse a target that is not a disbursement id or a version", () => {
    expect(
      firstMessage(approveDisbursementSchema.safeParse({ disbursementId: "x", expectedVersion: "1", idempotencyKey: KEY })),
    ).toBe("spendingErrors.no_disbursement");
    expect(
      firstMessage(approveDisbursementSchema.safeParse({ disbursementId: ID, expectedVersion: "0", idempotencyKey: KEY })),
    ).toBe("spendingErrors.stale");
  });
});

describe("recent purposes", () => {
  it("keep the newest spelling of each purpose once, up to the limit", () => {
    expect(
      distinctPurposes(["Generator diesel", "generator  DIESEL", "Casual loaders", " ", "Tea", "Water"], 3),
    ).toEqual(["Generator diesel", "Casual loaders", "Tea"]);
  });
});

describe("how long an approval has been open", () => {
  const now = new Date("2026-09-25T12:00:00Z");
  it("counts in the largest whole unit", () => {
    expect(openFor("2026-09-25T11:59:30Z", now)).toEqual({ unit: "minutes", count: 0 });
    expect(openFor("2026-09-25T11:15:00Z", now)).toEqual({ unit: "minutes", count: 45 });
    expect(openFor("2026-09-25T09:00:00Z", now)).toEqual({ unit: "hours", count: 3 });
    expect(openFor("2026-09-22T11:00:00Z", now)).toEqual({ unit: "days", count: 3 });
  });

  it("never goes negative when the server clock is behind the database", () => {
    expect(openFor("2026-09-25T12:00:05Z", now)).toEqual({ unit: "minutes", count: 0 });
  });
});

describe("refusal messages", () => {
  const migration = readFileSync(
    join(process.cwd(), "supabase/migrations/20260925000100_imprest_disbursements.sql"),
    "utf8",
  );
  // Every refusal the commands return is `'ok', false, 'reason', <reason>`; one picks its reason
  // with a CASE on the status the command needed.
  const refusals = [...migration.matchAll(/'ok', false,\s*'reason',\s*'([a-z_]+)'/g)].map((m) => m[1]);
  const inCase = [...migration.matchAll(/'reason', case when [^']*'[a-z]+' then '([a-z_]+)' else '([a-z_]+)' end/g)].flatMap(
    (m) => [m[1], m[2]],
  );
  const reasons = new Set([...refusals, ...inCase]);
  const actions = readFileSync(join(process.cwd(), "app/(app)/imprest/actions.ts"), "utf8");
  const known = actions.slice(actions.indexOf("const SPENDING_ERRORS"), actions.indexOf("]);", actions.indexOf("const SPENDING_ERRORS")));

  it("found the refusals the commands can return", () => {
    for (const reason of ["insufficient_imprest", "no_fund", "not_approved", "not_awaiting_decision", "stale"]) {
      expect(reasons).toContain(reason);
    }
  });

  it.each([...reasons])("%s is mapped to a message in English and Swahili", (reason) => {
    expect(known).toContain(`"${reason}"`);
    expect(en.spendingErrors).toHaveProperty(reason);
    expect(sw.spendingErrors).toHaveProperty(reason);
  });

  it("carry the free amount into the over-limit message in both languages", () => {
    for (const messages of [en, sw]) {
      expect(messages.spendingErrors.insufficient_imprest).toContain("{free_to_approve_tzs}");
      expect(messages.spendingErrors.insufficient_imprest).toContain("{amount_tzs}");
    }
  });

  it("have the same keys in English and Swahili", () => {
    const keys = (value: unknown, prefix = ""): string[] =>
      value && typeof value === "object"
        ? Object.entries(value).flatMap(([k, v]) => keys(v, `${prefix}${k}.`))
        : [prefix];
    expect(keys(sw.imprest.spending)).toEqual(keys(en.imprest.spending));
    expect(keys(sw.spendingErrors)).toEqual(keys(en.spendingErrors));
  });

  it("never say encumber, in either language", () => {
    const text = JSON.stringify([en.imprest, en.spendingErrors, sw.imprest, sw.spendingErrors]);
    expect(text).not.toMatch(/encumb/i);
  });

  it("show the exact help texts the ticket gives for the new figures", () => {
    expect(en.imprest.total.label).toBe("Posted imprest funding");
    expect(en.imprest.spending.figures.setAside).toBe("Set aside for approved payments");
    expect(en.imprest.spending.figures.setAsideHelp).toBe(
      "Approved but not yet paid. This money can't be approved again.",
    );
    expect(en.imprest.spending.figures.free).toBe("Free to approve");
    expect(en.imprest.spending.figures.freeHelp).toBe(
      "Posted imprest funding minus what is set aside. An approval above this is refused.",
    );
  });
});
