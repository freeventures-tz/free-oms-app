import { describe, expect, it } from "vitest";

import {
  DERIVED_IDENTIFIER_DOMAIN,
  derivedAuthIdentifier,
  formatPhoneForDisplay,
  normaliseTanzanianPhone,
} from "@/lib/auth/phone-identity";

describe("Tanzanian phone normalisation", () => {
  it("accepts every format staff actually type and produces one stored form", () => {
    const inputs = [
      "0712345678",
      "0712 345 678",
      "+255712345678",
      "+255 712 345 678",
      "255712345678",
      "712345678",
      "(0712) 345-678",
    ];

    for (const input of inputs) {
      expect(normaliseTanzanianPhone(input), input).toEqual({ ok: true, e164: "+255712345678" });
    }
  });

  it("refuses numbers that are not Tanzanian", () => {
    expect(normaliseTanzanianPhone("+254712345678")).toEqual({ ok: false, reason: "not_tanzanian" });
  });

  it("refuses the wrong number of digits rather than guessing", () => {
    expect(normaliseTanzanianPhone("07123456")).toEqual({ ok: false, reason: "wrong_length" });
    expect(normaliseTanzanianPhone("07123456789")).toEqual({ ok: false, reason: "wrong_length" });
  });

  it("refuses letters instead of silently dropping them", () => {
    expect(normaliseTanzanianPhone("07123abc78")).toEqual({
      ok: false,
      reason: "invalid_characters",
    });
  });

  it("refuses an empty field", () => {
    expect(normaliseTanzanianPhone("   ")).toEqual({ ok: false, reason: "empty" });
  });
});

describe("derived Auth identifier", () => {
  it("is deterministic, which is what makes orphan adoption possible", () => {
    const first = derivedAuthIdentifier("+255712345678");
    const second = derivedAuthIdentifier("+255712345678");
    expect(first).toBe(second);
    expect(first).toBe(`255712345678@${DERIVED_IDENTIFIER_DOMAIN}`);
  });

  it("uses a domain that can never be routable", () => {
    expect(DERIVED_IDENTIFIER_DOMAIN.endsWith(".invalid")).toBe(true);
  });

  it("maps different numbers to different identifiers", () => {
    expect(derivedAuthIdentifier("+255712345678")).not.toBe(derivedAuthIdentifier("+255712345679"));
  });

  it("refuses anything that has not been normalised first", () => {
    expect(() => derivedAuthIdentifier("0712345678")).toThrow();
  });
});

describe("display formatting", () => {
  it("groups the number the way it is read aloud", () => {
    expect(formatPhoneForDisplay("+255712345678")).toBe("+255 712 345 678");
  });
});
