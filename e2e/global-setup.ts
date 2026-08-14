import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "dotenv";

config({ path: ".env.test.local", quiet: true });
config({ path: ".env.local", quiet: true });

import { provisionAccountWithApi, provisionBootstrapDirector } from "@/lib/admin/provisioning";
import { createClient } from "@supabase/supabase-js";
import { adminApi, createAdminClient } from "@/lib/supabase/admin";
import { generateTemporaryPassword } from "@/lib/auth/temporary-password";
import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";
import type { AppRole } from "@/lib/auth/roles";

export type Credentials = { phone: string; password: string };
export type GatedCredentials = Credentials & { userId: string };

export type E2EFixtures = {
  director: Credentials;
  /** Reads Products & prices and must find no way to change one (design.md §4.3). */
  manager: Credentials;
  salesRep: Credentials;
  cashier: Credentials;
  /**
   * Accounts still holding a temporary password, one per device project.
   *
   * Completing a first login is a ONE-WAY transition — that is the whole point of the gate — so a
   * single shared fixture would be consumed by whichever project ran first and every later project
   * would be testing an account that is no longer gated.
   */
  gated: Record<"mobile" | "tablet" | "desktop", GatedCredentials>;
  /**
   * A SECOND gated account per tier, for the crash-recovery journey. Completing a first login is a
   * one-way transition, so a test that completes one cannot hand it to the next test.
   */
  gatedCrash: Record<"mobile" | "tablet" | "desktop", GatedCredentials>;
};

export const FIXTURES_PATH = join(process.cwd(), "e2e", ".fixtures.json");

function randomPhone(): string {
  let digits = "7";
  for (let i = 0; i < 8; i++) digits += String(Math.floor(Math.random() * 10));
  return `+255${digits}`;
}

/**
 * Fixtures are created through the SAME server code the application uses. Nothing here reaches into
 * the database to fake a state the product could not reach on its own — a fixture that cheats
 * proves nothing about the system. (It could not cheat even if it wanted to: the secret key holds
 * no privilege on any public table.)
 *
 * The one shortcut is clearing the first-login gate for the accounts that must start past it, using
 * the identical service-only bridge the server uses after an Auth password change. The real
 * user-session path is what the `first login` spec exercises.
 *
 * `npm run test:e2e` resets the database first, so the bootstrap guard is satisfied every run.
 */
type DirectorApi = ReturnType<ReturnType<typeof createClient>["schema"]>;

async function provisionAs(
  directorApi: DirectorApi,
  role: AppRole,
  name: string,
): Promise<{ phone: string; password: string; userId: string }> {
  const phone = randomPhone();
  const created = await provisionAccountWithApi(directorApi, {
    fullName: name,
    phoneE164: phone,
    role,
    idempotencyKey: randomUUID(),
  });
  if (!created.ok) throw new Error(`fixture ${role} failed: ${created.reason}`);
  return { phone, password: created.temporaryPassword, userId: created.userId };
}

/** The three steps the server takes; the database refuses to clear a gate without the middle one. */
async function completeGate(userId: string, password: string): Promise<void> {
  const admin = createAdminClient();
  const service = adminApi(admin);

  const { data: begun } = await service.rpc("service_begin_first_login", { p_user_id: userId });
  const operationId = begun?.operation?.id as string;
  const token = randomUUID();

  await admin.auth.admin.updateUserById(userId, {
    password,
    app_metadata: {
      fv_first_login: { operation_id: operationId, token, changed_at: new Date().toISOString() },
    },
  });
  await service.rpc("service_record_first_login_password_changed", {
    p_operation_id: operationId,
    p_user_id: userId,
    p_auth_evidence: token,
  });
  await service.rpc("service_complete_first_login", {
    p_user_id: userId,
    p_operation_id: operationId,
  });
}

async function makeLiveAccount(
  directorApi: DirectorApi,
  role: AppRole,
  name: string,
): Promise<{ phone: string; password: string }> {
  const account = await provisionAs(directorApi, role, name);
  await completeGate(account.userId, account.password);
  return { phone: account.phone, password: account.password };
}

async function directorSession(phone: string, password: string): Promise<DirectorApi> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: derivedAuthIdentifier(phone), password }),
  });
  const body = await response.json();
  if (response.status !== 200) throw new Error(`director sign-in failed: ${JSON.stringify(body)}`);

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${body.access_token}` } },
  }).schema("api");
}

export default async function globalSetup(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!url.includes("127.0.0.1") && !url.includes("localhost")) {
    throw new Error(`E2E refuses to run against ${url || "(unset)"} — use the local stack.`);
  }

  const directorPhone = randomPhone();
  const bootstrapped = await provisionBootstrapDirector({
    fullName: "E2E Director",
    phoneE164: directorPhone,
    idempotencyKey: randomUUID(),
  });

  if (!bootstrapped.ok) {
    throw new Error(
      `bootstrap failed: ${bootstrapped.reason}. E2E needs a clean database — ` +
        "`npm run test:e2e` resets it, so run the suite through that script.",
    );
  }

  const directorPassword = generateTemporaryPassword();
  await completeGate(bootstrapped.userId, directorPassword);

  // Fixtures are provisioned through the Director's OWN session, because that is the only path the
  // product has: `api.admin_*` derives its actor from the session and takes no actor parameter.
  const directorApi = await directorSession(directorPhone, directorPassword);

  const salesRep = await makeLiveAccount(directorApi, "sales_rep", "E2E Sales Rep");
  const cashier = await makeLiveAccount(directorApi, "cashier", "E2E Cashier");
  const manager = await makeLiveAccount(directorApi, "manager", "E2E Manager");

  // Genuinely gated accounts: provisioned and never completed. One per device project, per journey.
  const gatedCrashEntries = await Promise.all(
    (["mobile", "tablet", "desktop"] as const).map(async (tier) => {
      const created = await provisionAs(directorApi, "cashier", `E2E Crash ${tier}`);
      return [
        tier,
        { phone: created.phone, password: created.password, userId: created.userId },
      ] as const;
    }),
  );

  const gatedEntries = await Promise.all(
    (["mobile", "tablet", "desktop"] as const).map(async (tier) => {
      const created = await provisionAs(directorApi, "cashier", `E2E Newcomer ${tier}`);
      return [
        tier,
        { phone: created.phone, password: created.password, userId: created.userId },
      ] as const;
    }),
  );

  const fixtures: E2EFixtures = {
    director: { phone: directorPhone, password: directorPassword },
    manager,
    salesRep,
    cashier,
    gated: Object.fromEntries(gatedEntries) as E2EFixtures["gated"],
    gatedCrash: Object.fromEntries(gatedCrashEntries) as E2EFixtures["gatedCrash"],
  };

  writeFileSync(FIXTURES_PATH, JSON.stringify(fixtures, null, 2));
}
