import { config } from "dotenv";

/**
 * Integration tests run against the LOCAL Supabase stack and nothing else.
 *
 * The guard below is deliberate: these tests create users, reset passwords, deactivate accounts and
 * write audit rows. Pointing them at a hosted project — by a stale `.env.local`, a shell variable,
 * or a copied CI secret — would do all of that to real data. Refusing to start is the only
 * acceptable behaviour, so the check is on the URL itself rather than on an opt-in flag.
 */
config({ path: ".env.test.local", quiet: true });
config({ path: ".env.local", quiet: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

const isLocal =
  url.startsWith("http://127.0.0.1:") ||
  url.startsWith("http://localhost:") ||
  url.startsWith("http://[::1]:");

if (!isLocal) {
  throw new Error(
    `Integration tests refuse to run against ${url || "(unset)"}. ` +
      "They must target the local Supabase stack — run `npm run db:start` and point " +
      "NEXT_PUBLIC_SUPABASE_URL at http://127.0.0.1:54321.",
  );
}

if (!process.env.SUPABASE_SECRET_KEY) {
  throw new Error("SUPABASE_SECRET_KEY is required for integration tests.");
}

export const SUPABASE_URL = url;
export const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
export const SECRET_KEY = process.env.SUPABASE_SECRET_KEY!;
