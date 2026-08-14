import { adminApi, createAdminClient } from "@/lib/supabase/admin";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Two doors into the `api` schema, and which one a call uses IS the authorization decision.
 *
 *   userApi()     the caller's own session. `api.admin_*` functions derive the acting Director from
 *                 that session's verified JWT, so there is no actor to supply and nothing to forge.
 *                 Every administrative change a person makes goes through here.
 *
 *   serviceApi()  the secret key. Reaches only `api.service_*`, which take ids — a job, a command,
 *                 an operation — and never an actor. These CONTINUE work an authenticated Director
 *                 already began; they cannot begin any.
 */
export async function userApi() {
  const supabase = await createServerSupabase();
  return supabase.schema("api");
}

export function serviceApi() {
  return adminApi(createAdminClient());
}
