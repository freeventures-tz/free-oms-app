import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { AppShell } from "@/components/app-shell";
import { getViewer } from "@/lib/auth/viewer";
import { navItemsFor } from "@/lib/nav";

/**
 * Everything behind this layout requires a live, active, ungated user with a role. The check runs
 * on every request against the database, so a role removed a minute ago takes effect now.
 *
 * Per-route role checks live in the pages themselves, because a layout does not know which child
 * rendered it and an approximate guard is worse than an explicit one.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();

  if (viewer.state === "anonymous") redirect("/sign-in");
  if (viewer.state === "gated") redirect("/first-login");
  if (viewer.state === "blocked") redirect("/no-access");

  const t = await getTranslations("admin.roles");

  return (
    <AppShell
      items={navItemsFor(viewer.role)}
      userName={viewer.fullName}
      roleLabel={t(viewer.role)}
    >
      {children}
    </AppShell>
  );
}
