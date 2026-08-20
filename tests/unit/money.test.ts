import { describe, expect, it } from "vitest";

import { MAX_PRICE_TZS, formatTzs, isWholeShillings, parseTzs } from "@/lib/money";

/**
 * Money in whole Tanzanian shillings (architecture.md §5.12, design.md §8.5).
 *
 * There are no cents. Every rule here exists because the alternative puts a wrong figure in front
 * of a customer: a rounded tail, a floating-point artefact, or a price a keypress made ten times
 * too large.
 */

describe("reading a price someone typed", () => {
  it("accepts the separators a person actually types", () => {
    expect(parseTzs("12500")).toBe(12500);
    expect(parseTzs("12,500")).toBe(12500);
    expect(parseTzs("12 500")).toBe(12500);
    // A non-breaking space, which is what a phone keyboard and a paste from a spreadsheet produce.
    expect(parseTzs("1 250 000")).toBe(1250000);
  });

  it("refuses a decimal rather than rounding it away", () => {
    // `12,500.60` is either a mistake or a misunderstanding about what this field holds. Silently
    // discarding the tail would hide both, and the figure would go to a customer.
    expect(parseTzs("12500.60")).toBeNull();
    expect(parseTzs("12500.00")).toBeNull();
    expect(parseTzs("12,500.5")).toBeNull();
  });

  it("refuses anything that is not a positive whole number", () => {
    expect(parseTzs("")).toBeNull();
    expect(parseTzs("   ")).toBeNull();
    expect(parseTzs("abc")).toBeNull();
    expect(parseTzs("-500")).toBeNull();
    expect(parseTzs("0")).toBeNull();
    expect(parseTzs("1e6")).toBeNull();
    expect(parseTzs("500 shillings")).toBeNull();
  });

  it("refuses a figure above the typo guard the database also enforces", () => {
    expect(parseTzs(String(MAX_PRICE_TZS))).toBe(MAX_PRICE_TZS);
    expect(parseTzs(String(MAX_PRICE_TZS + 1))).toBeNull();
  });

  it("never returns a value the database would reject", () => {
    for (const input of ["1", "999", "45000", "100,000,000"]) {
      const parsed = parseTzs(input);
      expect(isWholeShillings(parsed)).toBe(true);
      expect(parsed!).toBeLessThanOrEqual(MAX_PRICE_TZS);
    }
  });
});

describe("showing a price", () => {
  it("groups thousands and never abbreviates", () => {
    // §8.5: abbreviation is allowed on dashboard tiles only. A price a customer is quoted is
    // always shown in full.
    expect(formatTzs(1250000)).toBe("TZS 1,250,000");
    expect(formatTzs(4500)).toBe("TZS 4,500");
    expect(formatTzs(1)).toBe("TZS 1");
  });

  it("shows no decimals, because there are none", () => {
    expect(formatTzs(12500)).not.toContain(".");
  });

  it("round-trips whatever was typed", () => {
    const typed = "1,250,000";
    expect(formatTzs(parseTzs(typed)!)).toBe(`TZS ${typed}`);
  });
});

describe("what counts as whole shillings", () => {
  it("refuses fractions, zero, negatives and anything unsafe", () => {
    expect(isWholeShillings(4500)).toBe(true);
    expect(isWholeShillings(4500.5)).toBe(false);
    expect(isWholeShillings(0)).toBe(false);
    expect(isWholeShillings(-1)).toBe(false);
    expect(isWholeShillings(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
    expect(isWholeShillings("4500")).toBe(false);
    expect(isWholeShillings(null)).toBe(false);
  });
});
