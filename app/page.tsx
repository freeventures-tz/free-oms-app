import { redirect } from "next/navigation";

import { landingPathFor } from "@/lib/auth/landing";
import { getViewer } from "@/lib/auth/viewer";

/**
 * The root is a router, not a page. Landing is by role, immediately after authentication, with no
 * intermediate menu (design.md §4.1) — and the role comes from live database state.
 */
export default async function Home() {
  const viewer = await getViewer();

  switch (viewer.state) {
    case "anonymous":
      redirect("/sign-in");
    case "gated":
      redirect("/first-login");
    case "blocked":
      redirect("/no-access");
    case "active":
      redirect(landingPathFor(viewer.role));
  }
}
