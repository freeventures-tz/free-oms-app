import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import { changePasswordSchema, createAccountSchema, signInSchema } from "@/lib/validation/auth";

function messageExists(key: string): boolean {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      en,
    ) !== undefined;
}

describe("sign-in validation", () => {
  it("normalises the phone as part of parsing, so the action never sees a raw format", () => {
    const parsed = signInSchema.safeParse({ phone: "0712 345 678", password: "whatever" });
    expect(parsed.success && parsed.data.phone).toBe("+255712345678");
  });

  it("does not apply the password policy at sign-in", () => {
    // Applying it here would tell an attacker what a valid password looks like, and would lock out
    // any existing password that predates a policy change.
    expect(signInSchema.safeParse({ phone: "0712345678", password: "x" }).success).toBe(true);
  });

  it("requires a password to be present", () => {
    expect(signInSchema.safeParse({ phone: "0712345678", password: "" }).success).toBe(false);
  });
});

describe("password change validation", () => {
  it("enforces the stated policy", () => {
    expect(
      changePasswordSchema.safeParse({ password: "Short1", confirmPassword: "Short1" }).success,
    ).toBe(false);
    expect(
      changePasswordSchema.safeParse({
        password: "GoodEnough1234",
        confirmPassword: "GoodEnough1234",
      }).success,
    ).toBe(true);
  });

  it("catches a mistyped confirmation", () => {
    const result = changePasswordSchema.safeParse({
      password: "GoodEnough1234",
      confirmPassword: "GoodEnough1235",
    });
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0].path).toEqual(["confirmPassword"]);
  });
});

describe("account creation validation", () => {
  it("requires a real role", () => {
    const result = createAccountSchema.safeParse({
      fullName: "Asha Mushi",
      phone: "0712345678",
      role: "superuser",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(result.success).toBe(false);
  });
});

/**
 * Validation messages are display strings, so they obey the same rule as every other one: they are
 * KEYS. This test fails if a schema ever hardcodes English.
 */
describe("validation messages", () => {
  it("emits translation keys that exist in the dictionary", () => {
    const failures = [
      signInSchema.safeParse({ phone: "abc", password: "" }),
      changePasswordSchema.safeParse({ password: "x", confirmPassword: "y" }),
      createAccountSchema.safeParse({ fullName: "", phone: "", role: "", idempotencyKey: "nope" }),
    ];

    for (const failure of failures) {
      expect(failure.success).toBe(false);
      if (failure.success) continue;
      for (const issue of failure.error.issues) {
        expect(issue.message, issue.message).toMatch(/^[a-z][\w.]+$/);
        expect(messageExists(issue.message), issue.message).toBe(true);
      }
    }
  });
});
