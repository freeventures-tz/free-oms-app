import { afterEach, describe, expect, it, vi } from "vitest";

import { requireSettlement } from "@/lib/sales/invoice-settlement";
import { DATA_UNAVAILABLE } from "@/lib/supabase/query";

/**
 * The edge of what a shilling figure can be, in a language that counts in doubles.
 *
 * The parser refused `null`, `""`, `"many"`, `NaN`, a fraction and an object, and then accepted
 * anything `Number.isInteger` liked — which is every value at or above 2^53, the point where a
 * double stops being able to count. Two real consequences followed, both of them the failure mode
 * the whole module exists to prevent: `"9007199254740993"` came back **one shilling short** and was
 * reported as the settlement, and a long enough run of digits came back `Infinity` and was reported
 * too. Neither is a refusal; both are the screen stating a figure about somebody's money that is
 * not the figure the database holds.
 *
 * `bigint` reaches far past 2^53, so the precision case is inside the column's range even if it is
 * far outside any yard's takings. The overflow case is malformed provider input rather than
 * anything PostgreSQL emits — which is exactly the input this parser is for.
 *
 * A figure JavaScript cannot hold exactly is not a figure this screen may state. It is a failed
 * read, and it goes where the other failed reads go.
 */

const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

afterEach(() => consoleError.mockClear());

const VALID = {
  invoice_id: "7a6b5c4d-3e2f-4109-8a7b-6c5d4e3f2a1b",
  total_tzs: 600_000,
  amount_paid_tzs: 200_000,
  approved_credit_tzs: 400_000,
  outstanding_tzs: 400_000,
  status: "partially_paid",
};

/** One settlement row with a single money column replaced. */
function withOutstanding(value: unknown) {
  return { data: { ...VALID, outstanding_tzs: value }, error: null };
}

describe("money a double can hold exactly", () => {
  it("takes zero, negatives and the largest exact integer", () => {
    // Zero is a real answer and must never be mistaken for a missing one. A negative outstanding
    // figure cannot arise through the product — `staff_record_payment` refuses a payment beyond
    // the balance — but it is arithmetic the view can express, so it is read rather than refused.
    for (const value of [0, -1, -400_000, 1, Number.MAX_SAFE_INTEGER]) {
      expect(requireSettlement(withOutstanding(value), "test").outstandingTzs, String(value)).toBe(
        value,
      );
    }
  });

  it("takes the same figures spelled as text, in case bigint ever arrives that way", () => {
    for (const [text, expected] of [
      ["0", 0],
      ["-400000", -400_000],
      ["600000", 600_000],
      ["9007199254740991", Number.MAX_SAFE_INTEGER],
    ] as const) {
      expect(requireSettlement(withOutstanding(text), "test").outstandingTzs, text).toBe(expected);
    }
  });
});

describe("money a double cannot hold exactly", () => {
  it("refuses a number at or beyond 2^53, where counting stops being exact", () => {
    // `Number.isInteger` is true for every one of these. That is the gap.
    for (const value of [2 ** 53, 2 ** 53 + 2, -(2 ** 53), 1e308, Number.POSITIVE_INFINITY]) {
      expect(
        () => requireSettlement(withOutstanding(value), "sales.invoice_settlement"),
        String(value),
      ).toThrow(`${DATA_UNAVAILABLE}: sales.invoice_settlement`);
    }
  });

  it("refuses integer text that would round on the way in", () => {
    // The reviewer's case: correctly spelled, inside PostgreSQL bigint, and one shilling is lost
    // converting it. Accepting it would put a wrong number on the screen with nothing to notice.
    expect(Number("9007199254740993")).toBe(9_007_199_254_740_992);

    for (const text of ["9007199254740993", "-9007199254740993", "18446744073709551615"]) {
      expect(
        () => requireSettlement(withOutstanding(text), "sales.invoice_settlement"),
        text,
      ).toThrow(`${DATA_UNAVAILABLE}: sales.invoice_settlement`);
    }
  });

  it("refuses integer text long enough to overflow into Infinity", () => {
    expect(Number("9".repeat(400))).toBe(Number.POSITIVE_INFINITY);

    expect(() =>
      requireSettlement(withOutstanding("9".repeat(400)), "sales.invoice_settlement"),
    ).toThrow(`${DATA_UNAVAILABLE}: sales.invoice_settlement`);
  });

  it("says which column and what was wrong with it, and never the digits themselves", () => {
    const overflowing = "9".repeat(400);

    expect(() => requireSettlement(withOutstanding(overflowing), "test")).toThrow(DATA_UNAVAILABLE);

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("outstanding_tzs"));
    // A rejected settlement field is still a figure about somebody's money.
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining(overflowing));
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("999999"));
  });

  it("tells a figure it cannot hold apart from a value that was never a figure", () => {
    // Both are failed reads, and a person reading the log needs to know which happened: one is a
    // provider sending the wrong kind of thing, the other is a real number too large to state.
    requireSettlementThrows(withOutstanding("not money at all"));
    const notAFigure = consoleError.mock.calls.flat().join(" ");
    consoleError.mockClear();

    requireSettlementThrows(withOutstanding(2 ** 53));
    const tooLarge = consoleError.mock.calls.flat().join(" ");

    expect(notAFigure).not.toBe(tooLarge);
    expect(tooLarge).toMatch(/exact|range|hold/i);
  });

  it("still refuses everything it refused before", () => {
    for (const value of [null, undefined, "", "   ", "many", Number.NaN, 1.5, {}, [], true]) {
      expect(
        () => requireSettlement(withOutstanding(value), "sales.invoice_settlement"),
        String(value),
      ).toThrow(`${DATA_UNAVAILABLE}: sales.invoice_settlement`);
    }
  });
});

function requireSettlementThrows(result: { data: unknown; error: null }) {
  expect(() => requireSettlement(result, "test")).toThrow(DATA_UNAVAILABLE);
}
