import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Next.js 16 renamed Middleware to Proxy. Its job here is exactly two things:
 *
 *   1. Keep the Supabase session cookies fresh, so a Server Component never sees an expired token.
 *   2. Make the OPTIMISTIC routing decision — signed in or not — to avoid rendering a protected
 *      shell for someone with no session at all.
 *
 * It is NOT the authorization boundary and must never become one. Next's own guidance is that the
 * proxy is for optimistic checks, and this project's is the same (architecture.md §5.4): activation,
 * the first-login gate and the role are read from live database state in the layouts and actions,
 * and the database refuses the work independently through GRANTs, RLS and the `api` functions.
 */

const PUBLIC_PATHS = ["/sign-in", "/auth"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getClaims() verifies the token and refreshes it when needed. It establishes IDENTITY only —
  // the `user_role` claim it may carry is a routing hint and is deliberately ignored here.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);

  const { pathname, search } = request.nextUrl;

  if (!signedIn && !isPublic(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = "";
    // Return them where they were going, if their role permits it once they arrive.
    if (pathname !== "/") url.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  if (signedIn && pathname === "/sign-in") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

/**
 * `manifest.webmanifest` and `sw.js` are excluded alongside the static assets, and must stay
 * excluded (docs/pwa.md §5).
 *
 * Both are fetched by the BROWSER rather than by the page, before anyone has signed in, and
 * neither carries user data. Without the exclusion the proxy answers each of them with a redirect
 * to `/sign-in`: the manifest becomes an HTML document the browser refuses to parse, the service
 * worker script fails registration, and the app silently stops being installable — with nothing in
 * the interface to say why. `e2e/pwa.spec.ts` fails if either one is gated again.
 *
 * This does not widen the authorization boundary. As the note at the top of this file says, the
 * proxy is an optimistic check; the database enforces access on its own.
 */
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest\\.webmanifest|sw\\.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
