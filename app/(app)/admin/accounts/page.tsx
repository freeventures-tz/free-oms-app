import { randomUUID } from "node:crypto";
import { Suspense } from "react";

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
      <Suspense fallback={null}>
        <ResumePendingPhoneChanges />
      </Suspense>
    </>
  );
}

/**
 * Finishes any phone change that reached this database but never reached Supabase Auth — the state
 * a crash between the two systems leaves behind. Idempotent, and it still runs on every visit a
 * Director makes to this screen, so the two systems converge without anyone having to notice.
 *
 * It sits behind its own boundary because it was measured on the critical path: a whole serial
 * round trip that every render waited for, in front of a screen that does not display anything it
 * produces. The sweep converges Supabase AUTH; the list below is read from `profiles`, which the
 * database has already updated — so nothing rendered here was ever waiting on this answer.
 *
 * Failure is swallowed on purpose. Convergence is a background duty, it is retried on the next
 * visit, and now that it resolves AFTER the page is on screen an exception would replace a screen
 * the Director is already reading with an error page.
 */
async function ResumePendingPhoneChanges() {
  try {
    await resumePendingPhoneChanges();
  } catch {
    // Retried the next time a Director opens this screen.
  }
  return null;
}
