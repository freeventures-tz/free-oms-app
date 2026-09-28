import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import sw from "@/messages/sw.json";
import {
  COUNT_EXPLANATIONS,
  EXPLANATIONS_NEEDING_NOTE,
  dayState,
  type DailyCount,
} from "@/lib/imprest/counting";
import { fieldErrors } from "@/lib/validation/auth";
import { confirmCountSchema, enterCountSchema, sendBackCountSchema } from "@/lib/validation/imprest";

/**
 * Issue #68: what the browser checks before a count, a confirmation or a send-back reaches the
 * database, which checks it all again; which state today is in; and the words the screens use.
 */

const ID = "7d4f5b1e-3c1a-4a55-9a53-2f4c9e1d2b10";
const KEY = "9f1b8d1c-6e0a-4d6f-9d5a-1c7b3e2a4f60";
const TODAY = "2026-09-28";

const enter = (overrides: Record<string, unknown> = {}) =>
  enterCountSchema.safeParse({
    businessDate: TODAY,
    previousCountId: "",
    counted: "149,500",
    note: "",
    idempotencyKey: KEY,
    ...overrides,
  });

const confirm = (overrides: Record<string, unknown> = {}) =>
  confirmCountSchema.safeParse({
    countId: ID,
    expectedVersion: "1",
    variance: "-1000",
    explanation: "counting_error",
    note: "",
    idempotencyKey: KEY,
    ...overrides,
  });

describe("the count input", () => {
  it("takes the cash counted as whole shillings, with no expected figure", () => {
    const parsed = enter({ expected: "150000", variance: "5" });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      businessDate: TODAY,
      previousCountId: null,
      counted: 149500,
      note: null,
      idempotencyKey: KEY,
    });
  });

  it("accepts a count of zero: an empty tin is a count, not a missing one", () => {
    expect(enter({ counted: "0" }).data?.counted).toBe(0);
  });

  it("names the count a recount replaces, and tidies the note", () => {
    const parsed = enter({ previousCountId: ID, note: "  Coins   counted twice " });
    expect(parsed.data).toMatchObject({ previousCountId: ID, note: "Coins counted twice" });
  });

  it.each([
    ["missing", "", "countErrors.amount_invalid"],
    ["negative", "-5", "countErrors.amount_invalid"],
    ["with a decimal", "12.50", "countErrors.amount_invalid"],
    ["above TZS 100,000,000", "100000001", "countErrors.amount_too_large"],
  ])("refuses a count that is %s", (_what, counted, message) => {
    const parsed = enter({ counted });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(fieldErrors(parsed.error).counted).toBe(message);
  });

  it("refuses a note under 3 characters", () => {
    const parsed = enter({ note: "ok" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(fieldErrors(parsed.error).note).toBe("countErrors.note_invalid");
  });
});

describe("the confirmation input", () => {
  it("carries the count and version the Manager was shown, and a preset explanation", () => {
    const parsed = confirm();
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      countId: ID,
      expectedVersion: 1,
      explanation: "counting_error",
      note: null,
      idempotencyKey: KEY,
    });
  });

  it("needs an explanation for a shortage or an excess", () => {
    for (const variance of ["-1000", "500"]) {
      const parsed = confirm({ variance, explanation: "" });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(fieldErrors(parsed.error).explanation).toBe("countErrors.explanation_required");
      }
    }
  });

  it("takes no explanation for a balanced day", () => {
    const parsed = confirm({ variance: "0", explanation: "" });
    expect(parsed.data).toMatchObject({ explanation: null, note: null });
    const extra = confirm({ variance: "0", explanation: "counting_error" });
    expect(extra.success).toBe(false);
    if (!extra.success) expect(fieldErrors(extra.error).explanation).toBe("countErrors.explanation_not_needed");
  });

  it.each(EXPLANATIONS_NEEDING_NOTE)("needs a written note with %s", (explanation) => {
    const parsed = confirm({ explanation, note: "" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(fieldErrors(parsed.error).note).toBe("countErrors.explanation_note_required");
    expect(confirm({ explanation, note: "Cashier was alone at the tin" }).success).toBe(true);
  });

  it("refuses an explanation outside the preset list", () => {
    const parsed = confirm({ explanation: "bad_luck" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(fieldErrors(parsed.error).explanation).toBe("countErrors.explanation_invalid");
  });
});

describe("the count send-back input", () => {
  it.each([
    ["missing", ""],
    ["under 3 characters", "no"],
    ["over 500 characters", "x".repeat(501)],
  ])("refuses a reason that is %s", (_what, reason) => {
    const parsed = sendBackCountSchema.safeParse({ countId: ID, expectedVersion: "1", reason, idempotencyKey: KEY });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(fieldErrors(parsed.error).reason).toBe("countErrors.reason_required");
  });

  it("has no figure: the Manager never changes the Cashier's count", () => {
    const parsed = sendBackCountSchema.safeParse({
      countId: ID,
      expectedVersion: "2",
      reason: "  Count the coins   again ",
      counted: "5",
      idempotencyKey: KEY,
    });
    expect(parsed.data).toEqual({ countId: ID, expectedVersion: 2, reason: "Count the coins again", idempotencyKey: KEY });
  });
});

const row = (overrides: Partial<DailyCount>): DailyCount => ({
  id: ID,
  businessDate: TODAY,
  attempt: 1,
  counted: 149000,
  note: null,
  postedBalance: null,
  awaitingVerification: null,
  expected: 150000,
  variance: -1000,
  status: "awaiting_confirmation",
  version: 1,
  countedBy: "Cashier",
  countedAt: "2026-09-28T15:00:00Z",
  outcome: null,
  explanation: null,
  explanationNote: null,
  confirmedBy: null,
  confirmedAt: null,
  returnReason: null,
  returnedBy: null,
  returnedAt: null,
  needsDirectorDecision: null,
  lateReason: null,
  ...overrides,
});

describe("today's state", () => {
  // Issue #69: today is due until it closes; only a closed day with no count is Not counted.
  it("is due when today has no count, never a zero variance", () => {
    expect(dayState([], TODAY)).toEqual({ state: "due", latest: null });
    expect(dayState([row({ businessDate: "2026-09-27", status: "confirmed", outcome: "balanced" })], TODAY).state).toBe(
      "due",
    );
  });

  it("is Awaiting Manager confirmation while today's latest count waits", () => {
    expect(dayState([row({})], TODAY).state).toBe("awaiting_confirmation");
  });

  it("is Sent back while today's latest count waits for a recount", () => {
    const back = row({ status: "sent_back", returnReason: "Count again" });
    expect(dayState([back], TODAY)).toEqual({ state: "sent_back", latest: back });
  });

  it("is the confirmed outcome once the Manager confirms, from the latest attempt", () => {
    const rows = [
      row({ attempt: 2, status: "confirmed", outcome: "excess", variance: 500 }),
      row({ attempt: 1, status: "sent_back" }),
    ];
    expect(dayState(rows, TODAY).state).toBe("excess");
    expect(dayState([row({ status: "confirmed", outcome: "balanced", variance: 0 })], TODAY).state).toBe("balanced");
    expect(dayState([row({ status: "confirmed", outcome: "shortage" })], TODAY).state).toBe("shortage");
  });
});

describe("the words", () => {
  const dictionaries = { en, sw } as const;

  it.each(["en", "sw"] as const)("labels every variance explanation in %s", (locale) => {
    const labels = dictionaries[locale].imprest.count.explanation as Record<string, string>;
    for (const explanation of COUNT_EXPLANATIONS) expect(labels[explanation]).toBeTruthy();
  });

  it.each(["en", "sw"] as const)("names each of the day's states in %s, all different", (locale) => {
    const states = dictionaries[locale].imprest.count.state as Record<string, string>;
    const names = ["due", "not_counted", "awaiting_confirmation", "sent_back", "balanced", "shortage", "excess"].map(
      (s) => states[s],
    );
    expect(names.every(Boolean)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it("has a message for every refusal the count commands return", () => {
    const errors = en.countErrors as Record<string, string>;
    for (const reason of [
      "no_fund",
      "day_changed",
      "already_confirmed",
      "count_awaiting_confirmation",
      "stale",
      "amount_invalid",
      "note_invalid",
      "no_count",
      "not_awaiting_confirmation",
      "reason_required",
      "explanation_required",
      "explanation_invalid",
      "explanation_note_required",
      "explanation_not_needed",
      "earlier_count_waiting",
      "figures_moved",
      "idempotency_key_conflict",
      "unconfirmed",
      "not_permitted",
      "generic",
    ]) {
      expect(errors[reason], reason).toBeTruthy();
    }
  });
});
