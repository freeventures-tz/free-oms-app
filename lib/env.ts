/**
 * Environment access, split by trust.
 *
 * Anything reachable from the browser must be NEXT_PUBLIC_ and must be safe to publish. The secret
 * key is read through `serverSecret()`, which refuses to run outside the server — a guard, not a
 * comment, because the cost of that mistake is total.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/** Safe to expose. The browser client uses these and relies on RLS. */
export const publicEnv = {
  get supabaseUrl(): string {
    return required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);
  },
  get supabasePublishableKey(): string {
    return required(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    );
  },
};

/**
 * The Supabase secret key (`sb_secret_…`). It carries BYPASSRLS and is the only credential that can
 * reach the service-only `api` bridge, so it never appears in a NEXT_PUBLIC_ variable, a bundle, a
 * log line, a response body, or a tracked file (architecture.md §5.3).
 */
export function supabaseSecretKey(): string {
  if (typeof window !== "undefined") {
    throw new Error("The Supabase secret key must never be read in the browser.");
  }
  const key = required("SUPABASE_SECRET_KEY", process.env.SUPABASE_SECRET_KEY);
  if (key.startsWith("eyJ")) {
    throw new Error(
      "SUPABASE_SECRET_KEY looks like a legacy service-role JWT. Use the sb_secret_… key.",
    );
  }
  return key;
}
