import { getTranslations } from "next-intl/server";

import { SignInForm } from "@/app/sign-in/sign-in-form";
import { AuthHeading, AuthShell } from "@/components/auth/auth-shell";

/**
 * Sign-in (design.md §7.1, §7C.1).
 *
 * One White card on a Deep Twilight canvas at every device tier, carrying the lockup, the language
 * switcher above it, and two steps: the phone number, then the password.
 *
 * There is no signup control and no signup route, because there is no public signup — it is
 * disabled at the Auth provider itself, not hidden here.
 */
export default async function SignInPage({
  searchParams,
}: PageProps<"/sign-in">) {
  const t = await getTranslations();
  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : undefined;

  return (
    <AuthShell>
      <AuthHeading title={t("auth.signIn.title")} />
      <SignInForm next={next} />
    </AuthShell>
  );
}
