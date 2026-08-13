import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { FinishSetupForm } from "@/app/first-login/finish-setup-form";
import { FirstLoginForm } from "@/app/first-login/first-login-form";
import { AuthHeading, AuthShell } from "@/components/auth/auth-shell";
import { readFirstLoginState } from "@/lib/auth/first-login";
import { getViewer } from "@/lib/auth/viewer";

/**
 * The forced password change (design.md §7C.2).
 *
 * This is the ONLY application screen a gated user can reach, and it is blocking: no navigation, no
 * shell, no data. That is not a UI convention — while `must_change_password` is true the database
 * refuses every protected read and every business function, so there is nothing else to render.
 */
export default async function FirstLoginPage() {
  const viewer = await getViewer();

  if (viewer.state === "anonymous") redirect("/sign-in");
  if (viewer.state === "blocked") redirect("/no-access");
  if (viewer.state === "active") redirect("/");

  const t = await getTranslations();
  const setup = await readFirstLoginState();
  const needsCompletion = setup.state === "needs_completion";

  return (
    <AuthShell wide>
      <AuthHeading
        title={needsCompletion ? t("auth.firstLogin.finishTitle") : t("auth.firstLogin.title")}
      >
        <p className="text-sm text-muted-foreground">{t("auth.firstLogin.description")}</p>
        <p className="rounded-md bg-[color-mix(in_srgb,var(--fv-vanilla)_50%,transparent)] px-3 py-2 text-sm font-medium">
          {t("auth.firstLogin.blocked")}
        </p>
      </AuthHeading>

      {needsCompletion ? <FinishSetupForm /> : <FirstLoginForm />}

      <form action="/auth/sign-out" method="post" className="mt-6 flex justify-center">
        <button
          type="submit"
          className="min-h-11 rounded-md px-4 text-sm font-medium text-bronze-text transition-colors hover:bg-[color-mix(in_srgb,var(--fv-vanilla)_35%,transparent)]"
        >
          {t("common.signOut")}
        </button>
      </form>
    </AuthShell>
  );
}
