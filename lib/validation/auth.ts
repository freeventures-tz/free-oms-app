import { z } from "zod";

import { normaliseTanzanianPhone } from "@/lib/auth/phone-identity";
import { APP_ROLES } from "@/lib/auth/roles";
import { PASSWORD_POLICY } from "@/lib/auth/password-policy";

/**
 * Zod 4 schemas for every Server Action input (architecture.md §5.11).
 *
 * Failures return TRANSLATION KEYS, never English sentences: no display string is hardcoded
 * anywhere, validation messages included (design.md §8.2).
 */

/** Accepts what staff type; yields the single stored form. */
export const phoneField = z
  .string()
  .transform((value, ctx) => {
    const result = normaliseTanzanianPhone(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: `auth.errors.phone.${result.reason}` });
      return z.NEVER;
    }
    return result.e164;
  });

export const passwordField = z
  .string()
  .min(PASSWORD_POLICY.minLength, { message: "auth.errors.password.tooShort" })
  .refine((v) => /[A-Z]/.test(v), { message: "auth.errors.password.needsUpper" })
  .refine((v) => /[a-z]/.test(v), { message: "auth.errors.password.needsLower" })
  .refine((v) => /\d/.test(v), { message: "auth.errors.password.needsDigit" });

export const signInSchema = z.object({
  phone: phoneField,
  // Deliberately NOT passwordField: the sign-in form must not tell an attacker what a valid
  // password looks like, and an existing password that predates a policy change must still work.
  password: z.string().min(1, { message: "auth.errors.password.required" }),
});

export const changePasswordSchema = z
  .object({
    password: passwordField,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "auth.errors.password.mismatch",
    path: ["confirmPassword"],
  });

export const createAccountSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(2, { message: "admin.errors.fullName.tooShort" })
    .max(120, { message: "admin.errors.fullName.tooLong" }),
  phone: phoneField,
  role: z.enum(APP_ROLES as unknown as [string, ...string[]], {
    message: "admin.errors.role.required",
  }),
  idempotencyKey: z.string().uuid({ message: "admin.errors.idempotencyKey" }),
});

export const changeRoleSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(APP_ROLES as unknown as [string, ...string[]], {
    message: "admin.errors.role.required",
  }),
});

export const changePhoneSchema = z.object({
  userId: z.string().uuid(),
  phone: phoneField,
  // Present on every cross-system command, so a repeated click resumes the same operation instead
  // of starting a second one.
  idempotencyKey: z.string().uuid({ message: "admin.errors.idempotencyKey" }),
});

export const setActiveSchema = z.object({
  userId: z.string().uuid(),
  isActive: z.coerce.boolean(),
});

export const resetPasswordSchema = z.object({
  userId: z.string().uuid(),
  idempotencyKey: z.string().uuid({ message: "admin.errors.idempotencyKey" }),
});

/** Collapses a Zod failure into one message key per field, which is all the forms render. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
