import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import sw from "@/messages/sw.json";
import { waitedFor } from "@/lib/imprest/counting";
import { businessDate } from "@/lib/time/business-date";
import { fieldErrors } from "@/lib/validation/auth";
import { enterLateCountSchema } from "@/lib/validation/imprest";

/**
 * Issue #69: what the browser checks before a late count reaches the database, which checks it all
 * again; how long an open day has waited; the business day around midnight; and the words.
 */

const KEY = "9f1b8d1c-6e0a-4d6f-9d5a-1c7b3e2a4f60";
const PREVIOUS = "7d4f5b1e-3c1a-4a55-9a53-2f4c9e1d2b10";

const late = (overrides: Record<string, unknown> = {}) =>
  enterLateCountSchema.safeParse({
    businessDate: "2026-09-26",
    previousCountId: "",
    counted: "149,500",
    note: "",
    lateReason: "Cashier was off sick",
    idempotencyKey: KEY,
    ...overrides,
  });

describe("the late count input", () => {
  it("takes the day, the cash counted and a reason for counting late", () => {
    expect(late().data).toEqual({
      businessDate: "2026-09-26",
      previousCountId: null,
      counted: 149500,
      note: null,
      lateReason: "Cashier was off sick",
      idempotencyKey: KEY,
    });
  });

  it("names the sent-back count a late recount replaces", () => {
    expect(late({ previousCountId: PREVIOUS }).data?.previousCountId).toBe(PREVIOUS);
  });

  it.each([
    ["missing", ""],
    ["only spaces", "    "],
    ["under 3 characters", "no"],
    ["over 500 characters", "x".repeat(501)],
  ])("refuses a late reason that is %s", (_what, lateReason) => {
    const parsed = late({ lateReason });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(fieldErrors(parsed.error).lateReason).toBe("countErrors.late_reason_required");
  });

  it("tidies the reason's spaces, as every other reason", () => {
    expect(late({ lateReason: "  Off   sick  " }).data?.lateReason).toBe("Off sick");
  });

  it("still counts zero, and refuses a negative count", () => {
    expect(late({ counted: "0" }).data?.counted).toBe(0);
    expect(late({ counted: "-5" }).success).toBe(false);
  });
});

describe("how long an open day has waited", () => {
  const since = "2026-09-26T21:00:00Z"; // midnight in Dar es Salaam, the 26th's close

  it("is under an hour for the first hour", () => {
    expect(waitedFor(since, new Date("2026-09-26T21:59:59Z"))).toEqual({ unit: "lessThanHour", count: 0 });
  });

  it("counts whole hours for the first two days", () => {
    expect(waitedFor(since, new Date("2026-09-26T22:00:00Z"))).toEqual({ unit: "hours", count: 1 });
    expect(waitedFor(since, new Date("2026-09-28T20:59:00Z"))).toEqual({ unit: "hours", count: 47 });
  });

  it("counts whole days after that", () => {
    expect(waitedFor(since, new Date("2026-09-28T21:00:00Z"))).toEqual({ unit: "days", count: 2 });
    expect(waitedFor(since, new Date("2026-10-06T21:00:00Z"))).toEqual({ unit: "days", count: 10 });
  });

  it("never reads a clock running behind as time waited", () => {
    expect(waitedFor(since, new Date("2026-09-26T20:00:00Z"))).toEqual({ unit: "lessThanHour", count: 0 });
  });

  it("reads the instant's own zone, never the server's", () => {
    expect(waitedFor("2026-09-27T00:00:00+03:00", new Date("2026-09-27T01:00:00Z"))).toEqual({
      unit: "hours",
      count: 4,
    });
  });
});

describe("the business day around midnight in Dar es Salaam (UTC+3)", () => {
  it("is still the 28th one second before midnight, whatever the server's date", () => {
    expect(businessDate(new Date("2026-09-28T20:59:59Z"))).toBe("2026-09-28");
  });

  it("is the 29th at midnight, while the server's UTC date is still the 28th", () => {
    expect(businessDate(new Date("2026-09-28T21:00:00Z"))).toBe("2026-09-29");
  });
});

describe("the words", () => {
  const dictionaries = { en, sw } as const;

  it("has a message for every refusal a late count can return", () => {
    for (const locale of ["en", "sw"] as const) {
      const errors = dictionaries[locale].countErrors as Record<string, string>;
      for (const reason of [
        "later_count_waiting",
        "late_reason_required",
        "late_reason_invalid",
        "late_reason_not_needed",
        "day_not_countable",
      ]) {
        expect(errors[reason], `${locale} ${reason}`).toBeTruthy();
      }
    }
  });

  it("names the refusals that meet another day without saying 'today'", () => {
    const errors = en.countErrors as Record<string, string>;
    for (const reason of ["already_confirmed", "count_awaiting_confirmation", "stale", "earlier_count_waiting"]) {
      expect(errors[reason], reason).not.toMatch(/today/i);
    }
  });

  it.each(["en", "sw"] as const)("has the same count words in English and Swahili (%s)", (locale) => {
    const keys = (value: unknown, prefix = ""): string[] =>
      value && typeof value === "object"
        ? Object.entries(value).flatMap(([k, v]) => keys(v, `${prefix}${k}.`))
        : [prefix];
    const other = locale === "en" ? sw : en;
    expect(keys(dictionaries[locale].imprest.count).sort()).toEqual(keys(other.imprest.count).sort());
  });

  it.each(["en", "sw"] as const)("tells Due today apart from Not counted in %s", (locale) => {
    const states = dictionaries[locale].imprest.count.state as Record<string, string>;
    expect(states.due).toBeTruthy();
    expect(states.due).not.toBe(states.not_counted);
  });
});
