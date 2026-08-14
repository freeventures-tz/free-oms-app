import { createBrowserClient } from "@supabase/ssr";

import { publicEnv } from "@/lib/env";

/**
 * Browser client. Publishable key only, RLS enforced. It is used for interactive session concerns
 * (sign-out, token refresh) — never for authorization decisions, which happen on the server against
 * live database state.
 */
export function createClient() {
  return createBrowserClient(publicEnv.supabaseUrl, publicEnv.supabasePublishableKey);
}
