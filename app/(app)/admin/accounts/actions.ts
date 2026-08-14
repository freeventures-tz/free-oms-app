"use server";

import { revalidatePath } from "next/cache";

import {
  changeUserPhone,
  changeUserRole,
  resetUserPassword,
  setAccountActive,
} from "@/lib/admin/accounts";
import { provisionAccountAsDirector } from "@/lib/admin/provisioning";
import { requireRole } from "@/lib/auth/guard";
import type { AppRole } from "@/lib/auth/roles";
import {
  changePhoneSchema,
  changeRoleSchema,
  createAccountSchema,
  fieldErrors,
  resetPasswordSchema,
  setActiveSchema,
} from "@/lib/validation/auth";

/**
 * Director account administration.
 *
 * `requireRole` here produces the right SCREEN and refuses early. It is NOT what authorises the
 * change: the database derives the acting Director from the same session independently, through
 * `api.admin_*`, which takes no actor. Neither layer is permitted to be the only one, and neither
 * accepts a caller's claim about who it is.
 */

const KNOWN_ERROR_KEYS = new Set([
  "not_permitted",
  "phone_in_use",
  "last_active_director",
  "cannot_deactivate_self",
  "attempt_in_progress",
  "auth_create_failed",
  "already_bootstrapped",
  "already_provisioned",
  "idempotency_key_conflict",
  "auth_identifier_update_failed",
  "auth_identifier_update_failed_unreverted",
  "already_completed",
  "already_settled",
  "claimed_by_other",
  "change_already_in_flight",
  "reset_unconfirmed",
  "phone_change_unconfirmed",
]);

function errorKey(reason: string): string {
  return KNOWN_ERROR_KEYS.has(reason) ? `admin.errors.${reason}` : "admin.errors.generic";
}

export type AdminActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  successKey?: string;
  successName?: string;
  /** Present for exactly one render, and never persisted anywhere (architecture.md §7.7). */
  temporaryPassword?: string;
  temporaryPasswordFor?: string;
  /**
   * Set when an account already exists and this call issued no credential. The interface uses it to
   * offer the recovery that actually helps: issue a new temporary password for that account.
   */
  recoverableUserId?: string;
};

export async function createAccountAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  await requireRole(["director"]);

  const parsed = createAccountSchema.safeParse({
    fullName: formData.get("fullName"),
    phone: formData.get("phone"),
    role: formData.get("role"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await provisionAccountAsDirector({
    fullName: parsed.data.fullName,
    phoneE164: parsed.data.phone,
    role: parsed.data.role as AppRole,
    idempotencyKey: parsed.data.idempotencyKey,
  });

  if (!result.ok) {
    revalidatePath("/admin/accounts");
    // The account exists but this call issued no credential, so name it: the Director's next move
    // is to set a new temporary password on it, not to create it again.
    // Narrowed by the property rather than by the reason string: the other union member types
    // `reason` as plain `string`, so a literal comparison discriminates nothing.
    const recoverableUserId = "userId" in result ? result.userId : undefined;
    return { error: errorKey(result.reason), recoverableUserId };
  }

  revalidatePath("/admin/accounts");

  return {
    successKey: "admin.accounts.created",
    successName: parsed.data.fullName,
    temporaryPassword: result.temporaryPassword,
    temporaryPasswordFor: parsed.data.fullName,
  };
}

export async function resetPasswordAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  await requireRole(["director"]);

  const parsed = resetPasswordSchema.safeParse({
    userId: formData.get("userId"),
    idempotencyKey: formData.get("idempotencyKey"),
  });
  if (!parsed.success) return { error: "admin.errors.generic" };

  const result = await resetUserPassword(parsed.data.userId, parsed.data.idempotencyKey);
  if (!result.ok) return { error: errorKey(result.reason) };

  revalidatePath("/admin/accounts");

  return {
    successKey: "admin.accounts.updated",
    temporaryPassword: result.temporaryPassword,
    temporaryPasswordFor: String(formData.get("fullName") ?? ""),
  };
}

export async function setActiveAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  await requireRole(["director"]);

  const parsed = setActiveSchema.safeParse({
    userId: formData.get("userId"),
    isActive: formData.get("isActive") === "true",
  });
  if (!parsed.success) return { error: "admin.errors.generic" };

  const result = await setAccountActive(parsed.data.userId, parsed.data.isActive);
  if (!result.ok) return { error: errorKey(result.reason) };

  revalidatePath("/admin/accounts");
  return { successKey: "admin.accounts.updated" };
}

export async function changeRoleAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  await requireRole(["director"]);

  const parsed = changeRoleSchema.safeParse({
    userId: formData.get("userId"),
    role: formData.get("role"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await changeUserRole(parsed.data.userId, parsed.data.role as AppRole);
  if (!result.ok) return { error: errorKey(result.reason) };

  revalidatePath("/admin/accounts");
  return { successKey: "admin.accounts.updated" };
}

export async function changePhoneAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  await requireRole(["director"]);

  const parsed = changePhoneSchema.safeParse({
    userId: formData.get("userId"),
    phone: formData.get("phone"),
    idempotencyKey: formData.get("idempotencyKey"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await changeUserPhone(
    parsed.data.userId,
    parsed.data.phone,
    parsed.data.idempotencyKey,
  );
  if (!result.ok) return { error: errorKey(result.reason) };

  revalidatePath("/admin/accounts");
  return { successKey: "admin.accounts.updated" };
}
