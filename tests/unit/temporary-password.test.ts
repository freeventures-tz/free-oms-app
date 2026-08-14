import { describe, expect, it } from "vitest";

import {
  TEMPORARY_PASSWORD_LENGTH,
  generateTemporaryPassword,
  passwordMeetsPolicy,
} from "@/lib/auth/temporary-password";

describe("temporary passwords", () => {
  it("always satisfies the Auth policy, never by luck", () => {
    for (let i = 0; i < 200; i++) {
      const password = generateTemporaryPassword();
      expect(password).toHaveLength(TEMPORARY_PASSWORD_LENGTH);
      expect(passwordMeetsPolicy(password), password).toBe(true);
    }
  });

  it("omits characters that are misread when a password is dictated over a phone", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateTemporaryPassword()).not.toMatch(/[O0Il1]/);
    }
  });

  it("does not repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateTemporaryPassword());
    expect(seen.size).toBe(500);
  });

  it("does not always place the guaranteed classes in the same positions", () => {
    const firstCharacters = new Set<string>();
    for (let i = 0; i < 200; i++) firstCharacters.add(generateTemporaryPassword()[0]);
    // If the shuffle were missing, every password would start with an upper-case letter.
    expect([...firstCharacters].some((c) => /[a-z]/.test(c))).toBe(true);
    expect([...firstCharacters].some((c) => /\d/.test(c))).toBe(true);
  });
});

describe("password policy", () => {
  it("rejects what the policy says it rejects", () => {
    expect(passwordMeetsPolicy("short1A")).toBe(false);
    expect(passwordMeetsPolicy("alllowercase123")).toBe(false);
    expect(passwordMeetsPolicy("ALLUPPERCASE123")).toBe(false);
    expect(passwordMeetsPolicy("NoDigitsInHere")).toBe(false);
    expect(passwordMeetsPolicy("GoodEnough1234")).toBe(true);
  });
});
