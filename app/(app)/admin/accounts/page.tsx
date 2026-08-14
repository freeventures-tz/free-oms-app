import { randomUUID } from "node:crypto";

import { getTranslations } from "next-intl/server";

import { AccountsList, type AccountSummary } from "@/app/(app)/admin/accounts/accounts-list";
import { CreateAccountForm } from "@/app/(app)/admin/accounts/create-account-form";
import { PageHeader } from "@/components/ui/surface";
import { resumePendingPhoneChanges } from "@/lib/admin/accounts";
import { requireAccess } from "@/lib/auth/guard";
import type { AppRole } from "@/lib/auth/roles";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Director account administration (design.md §7C.3).
 *
 * The LIST is read through the Director's own session, under RLS — not with the secret key. If the
 * policies were ever wrong, this page would show less, not more, and the interface would fail in
 * the safe direction. The secret key appears only in the write paths, where it is unavoidable
 * because they span Supabase Auth.
 */
export default async function AccountsPage() {
  const viewer = await requireAccess("/admin/accounts");
  const t = await getTranslations("admin.accounts");

  // Finish any phone change that reached this database but never reached Supabase Auth — the state
  // a crash between the two systems leaves behind. Idempotent, and it runs where a Director will
  // see the result, so the two systems converge without anyone having to notice the gap.
  await resumePendingPhoneChanges();

  const supabase = await createServerSupabase();

  const [{ data: profiles }, { data: roles }] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, full_name, phone_e164, is_active, must_change_password")
      .order("full_name"),
    supabase.from("user_roles").select("user_id, role"),
  ]);

  const roleByUser = new Map<string, AppRole>(
    (roles ?? []).map((row) => [row.user_id as string, row.role as AppRole]),
  );

  const accounts: AccountSummary[] = (profiles ?? []).map((row) => ({
    id: row.id as string,
    fullName: row.full_name as string,
    phoneE164: row.phone_e164 as string,
    role: roleByUser.get(row.id as string) ?? null,
    isActive: row.is_active as boolean,
    mustChangePassword: row.must_change_password as boolean,
  }));

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <CreateAccountForm idempotencyKey={randomUUID()} />
      <AccountsList accounts={accounts} currentUserId={viewer.userId} />
    </>
  );
}
