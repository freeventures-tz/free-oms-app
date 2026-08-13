import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { AuthHeading, AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { getViewer } from "@/lib/auth/viewer";

/**
 * No-role, deactivated, and refused-route states (design.md §4.5, §7C.4).
 *
 * It says plainly that access is missing and who to ask. It never says what the page contains or
 * which role would have it — that would leak the authority structure to whoever reached it.
 *
 * It wears the same card as sign-in on purpose: a refusal is still the front door, and a stranded
 * user should recognise where they are.
 */
export default async function NoAccessPage({ searchParams }: PageProps<"/no-access">) {
  const viewer = await getViewer();
  if (viewer.state === "anonymous") redirect("/sign-in");
  if (viewer.state === "gated") redirect("/first-login");

  const params = await searchParams;
  const deniedRoute = params.denied === "1";
  const t = await getTranslations("access");

  const content =
    viewer.state === "active" || deniedRoute
      ? { title: t("denied.title"), body: t("denied.body"), home: true }
      : viewer.reason === "inactive"
        ? { title: t("inactive.title"), body: t("inactive.body"), home: false }
        : { title: t("noRole.title"), body: t("noRole.body"), home: false };

  return (
    <AuthShell>
      <AuthHeading title={content.title}>
        <p className="text-sm text-muted-foreground">{content.body}</p>
      </AuthHeading>

      <div className="mt-8 flex flex-col gap-3">
        {content.home ? (
          <Button asChild size="block" className="h-14 rounded-lg text-base md:h-13 xl:h-12">
            {/* "/" resolves the role landing server-side, so this is correct after a role change. */}
            <Link href="/">{t("denied.goHome")}</Link>
          </Button>
        ) : null}
        <form action="/auth/sign-out" method="post">
          <Button
            type="submit"
            variant="secondary"
            size="block"
            className="h-14 rounded-lg text-base md:h-13 xl:h-12"
          >
            <SignOutLabel />
          </Button>
        </form>
      </div>
    </AuthShell>
  );
}

async function SignOutLabel() {
  const t = await getTranslations("common");
  return <>{t("signOut")}</>;
}
