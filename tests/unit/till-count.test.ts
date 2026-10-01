import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import sw from "@/messages/sw.json";
import { roleMayAccess } from "@/lib/auth/landing";
import { navItemsFor } from "@/lib/nav";
import { PAYMENT_METHODS } from "@/lib/settlement/methods";
import { VARIANCE_REASONS, dayStateOf, outcomeOf, type TillDayRow, type TillLine } from "@/lib/till/counting";
import { fieldErrors } from "@/lib/validation/auth";
import {
  confirmTillCountSchema,
  enterLateTillCountSchema,
  enterTillCountSchema,
  sendBackTillCountSchema,
} from "@/lib/validation/till";

/**
 * Issue #83: what the browser checks before a till count, a confirmation or a send-back reaches the
 * database, which checks it all again; which state today is in; who reaches the screen; and the
 * words it uses.
 */

const ID = "7d4f5b1e-3c1a-4a55-9a53-2f4c9e1d2b10";
const KEY = "9f1b8d1c-6e0a-4d6f-9d5a-1c7b3e2a4f60";
const TODAY = "2026-10-07";

const sixFigures = (overrides: Record<string, string> = {}) =>
  Object.fromEntries(PAYMENT_METHODS.map((m) => [m, overrides[m] ?? "0"]));

const enter = (overrides: Record<string, unknown> = {}) =>
  enterTillCountSchema.safeParse({
    businessDate: TODAY,
    previousCountId: "",
    counted: sixFigures({ cash: "150,000", crdb_transfer: "1 200 000" }),
    note: "",
    idempotencyKey: KEY,
    ...overrides,
  });

const confirm = (overrides: Record<string, unknown> = {}) =>
  confirmTillCountSchema.safeParse({
    countId: ID,
    expectedVersion: "1",
    short: "1000",
    over: "0",
    explanation: "counting_error",
    note: "",
    idempotencyKey: KEY,
    ...overrides,
  });

const line = (method: string, expected: number, counted: number | null): TillLine => ({
  line: method,
  expected,
  counted,
  variance: counted === null ? null : counted - expected,
});

describe("the till count input", () => {
  it("takes one whole-shilling figure for every payment method, and no expected figure", () => {
    const parsed = enter({ expected: "150000" });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      businessDate: TODAY,
      previousCountId: null,
      counted: {
        cash: 150000,
        mixx_by_yas: 0,
        halopesa: 0,
        mwanga_hakika_transfer: 0,
        crdb_transfer: 1200000,
        cheque: 0,
      },
      note: null,
      idempotencyKey: KEY,
    });
  });

  it("accepts zero: a method nobody paid with is still counted", () => {
    expect(enter({ counted: sixFigures() }).data?.counted.cash).toBe(0);
  });

  it("refuses a blank figure beside the method it belongs to, rather than reading it as zero", () => {
    const parsed = enter({ counted: sixFigures({ halopesa: "" }) });
    expect(parsed.success).toBe(false);
    expect(fieldErrors(parsed.error!)).toMatchObject({ "counted.halopesa": "till.errors.amount_required" });
  });

  it("refuses decimals and negative figures", () => {
    expect(fieldErrors(enter({ counted: sixFigures({ cash: "1.5" }) }).error!)).toMatchObject({
      "counted.cash": "till.errors.amount_invalid",
    });
    expect(fieldErrors(enter({ counted: sixFigures({ cheque: "-5" }) }).error!)).toMatchObject({
      "counted.cheque": "till.errors.amount_invalid",
    });
  });

  it("refuses a figure too large to be a day's takings", () => {
    expect(fieldErrors(enter({ counted: sixFigures({ cash: "2000000000000" }) }).error!)).toMatchObject({
      "counted.cash": "till.errors.amount_too_large",
    });
  });

  it("needs a reason of 3 to 500 characters to count a missed day late", () => {
    const late = (lateReason: string) =>
      enterLateTillCountSchema.safeParse({
        businessDate: "2026-10-05",
        previousCountId: "",
        counted: sixFigures(),
        note: "",
        lateReason,
        idempotencyKey: KEY,
      });
    expect(fieldErrors(late("  ").error!)).toMatchObject({ lateReason: "till.errors.late_reason_required" });
    expect(late("Cashier was off sick").data?.lateReason).toBe("Cashier was off sick");
  });
});

describe("the Manager's decision", () => {
  it("takes no reason for a balanced count", () => {
    expect(fieldErrors(confirm({ short: "0" }).error!)).toMatchObject({
      explanation: "till.errors.explanation_not_needed",
    });
    expect(confirm({ short: "0", explanation: "" }).success).toBe(true);
  });

  it("needs one of the seven reasons for a shortage or an excess", () => {
    expect(fieldErrors(confirm({ explanation: "" }).error!)).toMatchObject({
      explanation: "till.errors.explanation_required",
    });
    expect(fieldErrors(confirm({ short: "0", over: "500", explanation: "" }).error!)).toMatchObject({
      explanation: "till.errors.explanation_required",
    });
    expect(fieldErrors(confirm({ explanation: "bad_luck" }).error!)).toMatchObject({
      explanation: "till.errors.explanation_invalid",
    });
  });

  it("needs a written note for Suspected loss or theft, Under investigation and Other", () => {
    for (const reason of ["suspected_loss_or_theft", "under_investigation", "other"]) {
      expect(fieldErrors(confirm({ explanation: reason }).error!)).toMatchObject({
        note: "till.errors.explanation_note_required",
      });
    }
    expect(confirm({ explanation: "other", note: "Slip filed under cash" }).success).toBe(true);
  });

  it("sends the database no figure", () => {
    expect(confirm().data).toEqual({
      countId: ID,
      expectedVersion: 1,
      explanation: "counting_error",
      note: null,
      idempotencyKey: KEY,
    });
  });

  it("needs a reason to send a count back", () => {
    const parsed = sendBackTillCountSchema.safeParse({
      countId: ID,
      expectedVersion: "2",
      reason: "",
      idempotencyKey: KEY,
    });
    expect(fieldErrors(parsed.error!)).toMatchObject({ reason: "till.errors.reason_required" });
  });
});

describe("where a count stands", () => {
  it("is a Shortage when any method is short, even if another is over by as much", () => {
    expect(outcomeOf([line("cash", 150000, 149000), line("crdb_transfer", 200000, 201000)])).toBe("shortage");
  });

  it("is an Excess when nothing is short and something is over", () => {
    expect(outcomeOf([line("cash", 0, 0), line("halopesa", 5000, 6000)])).toBe("excess");
  });

  it("is Balanced only when every line matches exactly", () => {
    expect(outcomeOf([line("cash", 150000, 150000), line("cheque", 0, 0)])).toBe("balanced");
  });

  it("is unknown, never balanced, when a line was not counted", () => {
    expect(outcomeOf([line("cash", 150000, null)])).toBeNull();
  });

  it("reads a day from the database's state, whoever entered its count", () => {
    const day = (state: TillDayRow["state"], latestStatus: TillDayRow["latestStatus"] = null): TillDayRow => ({
      businessDate: TODAY,
      state,
      notCountedSince: null,
      awaitingSince: null,
      latestId: latestStatus ? ID : null,
      latestStatus,
      latestReturnReason: null,
    });
    expect(dayStateOf(null)).toBe("due");
    expect(dayStateOf(day("due"))).toBe("due");
    expect(dayStateOf(day("awaiting_confirmation", "awaiting_confirmation"))).toBe("awaiting_confirmation");
    expect(dayStateOf(day("due", "sent_back"))).toBe("sent_back");
    expect(dayStateOf(day("not_counted", "sent_back"))).toBe("not_counted");
    expect(dayStateOf(day("shortage", "confirmed"))).toBe("shortage");
  });
});

describe("the till screen", () => {
  it("is reached by the Cashier, the Manager and Directors, and offered in their navigation", () => {
    for (const role of ["cashier", "manager", "director"] as const) {
      expect(roleMayAccess(role, "/till")).toBe(true);
      expect(navItemsFor(role).some((item) => item.href === "/till")).toBe(true);
    }
    expect(roleMayAccess("sales_rep", "/till")).toBe(false);
    expect(navItemsFor("sales_rep").some((item) => item.href === "/till")).toBe(false);
  });

  it("names the seven variance reasons in both languages", () => {
    expect(VARIANCE_REASONS).toHaveLength(7);
    for (const reason of VARIANCE_REASONS) {
      expect(en.till.reason[reason]).toBeTruthy();
      expect(sw.till.reason[reason]).toBeTruthy();
    }
  });

  it("says Not counted and Awaiting Manager confirmation in words that are not a zero", () => {
    expect(en.till.state.not_counted).toBe("Not counted");
    expect(en.till.state.awaiting_confirmation).toBe("Awaiting Manager confirmation");
    expect(sw.till.state.not_counted).toBe(sw.imprest.count.state.not_counted);
  });
});
