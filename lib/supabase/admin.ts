import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { publicEnv, supabaseSecretKey } from "@/lib/env";

/**
 * Server-only administrative client.
 *
 * Holds the secret key, so it BYPASSES RLS and is the only identity that can execute the
 * service-only `api` bridge. Its permitted uses are exactly three (architecture.md §5.3):
 * Director-authorised account administration, first-login gate completion after a confirmed Auth
 * password change, and the encrypted backup workflow.
 *
 * It must never be constructed in a Client Component, a route reachable without a server-side
 * authority check, or anywhere the result is returned to a browser unfiltered.
 */
export function createAdminClient(): SupabaseClient {
  if (typeof window !== "undefined") {
    throw new Error("createAdminClient() must never run in the browser.");
  }

  return createClient(publicEnv.supabaseUrl, supabaseSecretKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Every service-only RPC lives in `api`; `private` is not exposed and must stay that way. */
export function adminApi(client: SupabaseClient) {
  return client.schema("api");
}
