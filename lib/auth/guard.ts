import { redirect } from "next/navigation";

import { recordAccessDenial } from "@/lib/admin/accounts";
import { roleMayAccess } from "@/lib/auth/landing";
import { getViewer, type AppRole, type Viewer } from "@/lib/auth/viewer";

type ActiveViewer = Extract<Viewer, { state: "active" }>;

/**
 * The route guard (layer 2 of architecture.md §5.4).
 *
 * It produces the right SCREEN — sign-in, forced password change, no-access — and it audits a
 * refused attempt (design.md §4.5). It is not the boundary: the same request would be refused by
 * GRANTs, RLS and the `api` functions if this code did not exist, and it is written on the
 * assumption that one day someone will reach a page without passing through here.
 */
export async function requireAccess(pathname: string): Promise<ActiveViewer> {
  const viewer = await getViewer();

  if (viewer.state === "anonymous") redirect("/sign-in");
  if (viewer.state === "gated") redirect("/first-login");
  if (viewer.state === "blocked") redirect("/no-access");

  if (!roleMayAccess(viewer.role, pathname)) {
    // Recorded through the user's OWN session: there is no user parameter to supply, so this can
    // never attribute an attempt to somebody who did not make it.
    await recordAccessDenial(pathname);
    redirect("/no-access?denied=1");
  }

  return viewer;
}

/** For Server Actions, which must re-derive identity rather than trust anything from the client. */
export async function requireRole(roles: readonly AppRole[]): Promise<ActiveViewer> {
  const viewer = await getViewer();
  if (viewer.state !== "active" || !roles.includes(viewer.role)) {
    throw new Error("not_permitted");
  }
  return viewer;
}
