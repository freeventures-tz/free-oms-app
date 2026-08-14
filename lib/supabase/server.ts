import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { publicEnv } from "@/lib/env";

/**
 * Server client bound to the caller's session cookies. Publishable key, so **RLS is enforced** —
 * this is the default client for everything a user does. Reads through it see exactly what the
 * policies allow that user to see, which is what makes the interface and the boundary agree.
 */
export async function createServerSupabase() {
  const cookieStore = await cookies();

  return createServerClient(publicEnv.supabaseUrl, publicEnv.supabasePublishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only. The proxy refreshes the
          // session on every request, so nothing is lost.
        }
      },
    },
  });
}
