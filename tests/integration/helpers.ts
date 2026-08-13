import { randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { DIRECTOR_FIXTURE_PATH } from "@/tests/setup/integration-global";
import { PUBLISHABLE_KEY, SECRET_KEY, SUPABASE_URL } from "@/tests/setup/integration";
import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";
import { generateTemporaryPassword } from "@/lib/auth/temporary-password";
import { provisionAccountWithApi } from "@/lib/admin/provisioning";
import { adminApi, createAdminClient } from "@/lib/supabase/admin";
import type { AppRole } from "@/lib/auth/roles";

export function admin() {
  return createAdminClient();
}

export function api() {
  return adminApi(createAdminClient());
}

/**
 * A client bound to a real user session.
 *
 * Administrative operations now derive their actor from the session's verified JWT, so a test that
 * used the secret key would be testing a path the product does not have. Everything a Director does
 * here goes through their own session, exactly as the application does it.
 */
export function clientForToken(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/** Distinct per run, so a repeated run never collides with an earlier one. */
export function randomPhone(): string {
  let digits = "7";
  for (let i = 0; i < 8; i++) digits += String(randomInt(0, 10));
  return `+255${digits}`;
}

export async function signInWithPhone(phoneE164: string, password: string) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: derivedAuthIdentifier(phoneE164), password }),
  });
  return { status: response.status, body: await response.json() };
}

/** Changes a password the way the user's own browser does — the path that enforces same-password. */
export async function selfChangePassword(accessToken: string, password: string) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: "PUT",
    headers: {
      apikey: PUBLISHABLE_KEY,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password }),
  });
  return { status: response.status, body: await response.json() };
}

export async function callApiRpc(
  fn: string,
  args: Record<string, unknown>,
  key: string,
  bearer = key,
) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      "Content-Profile": "api",
      "Accept-Profile": "api",
    },
    body: JSON.stringify(args),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

export function decodeJwt(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

/**
 * Takes a gated account past its first login, along the SAME three steps the server uses: change
 * the password at Auth, record that it happened, then clear the gate. The database refuses to clear
 * a gate without that recorded evidence, so there is no shortcut available to a fixture either.
 */
export async function completeGateAsServer(userId: string, password: string): Promise<void> {
  const client = admin();
  const service = adminApi(client);

  const { data: begun } = await service.rpc("service_begin_first_login", { p_user_id: userId });
  if (!begun?.ok) throw new Error(`begin_first_login failed: ${JSON.stringify(begun)}`);
  if (begun.reason === "not_gated") return;

  const operationId = begun.operation.id as string;
  const token = randomUUID();

  // The same single Auth request the server makes: the password and the proof it changed land
  // together, so a fixture cannot reach a state the product could not.
  const { error } = await client.auth.admin.updateUserById(userId, {
    password,
    app_metadata: { fv_first_login: { operation_id: operationId, token, changed_at: new Date().toISOString() } },
  });
  if (error) throw new Error(`could not set password: ${error.message}`);

  const { data: recorded } = await service.rpc("service_record_first_login_password_changed", {
    p_operation_id: operationId,
    p_user_id: userId,
    p_auth_evidence: token,
  });
  if (!recorded?.ok) throw new Error(`record failed: ${JSON.stringify(recorded)}`);

  const { data: completed } = await service.rpc("service_complete_first_login", {
    p_user_id: userId,
    p_operation_id: operationId,
  });
  if (!completed?.ok) throw new Error(`gate completion failed: ${JSON.stringify(completed)}`);
}

export type Fixture = {
  userId: string;
  phoneE164: string;
  password: string;
  role: AppRole;
  accessToken: string;
  /** This user's own session, for reads that must obey RLS. */
  read: SupabaseClient;
  /** This user's own session, scoped to the `api` schema — the real administrative path. */
  api: ReturnType<SupabaseClient["schema"]>;
};

async function fixtureFor(
  userId: string,
  phoneE164: string,
  password: string,
  role: AppRole,
): Promise<Fixture> {
  const session = await signInWithPhone(phoneE164, password);
  if (session.status !== 200) {
    throw new Error(`${role} could not sign in: ${JSON.stringify(session.body)}`);
  }
  const client = clientForToken(session.body.access_token);
  return {
    userId,
    phoneE164,
    password,
    role,
    accessToken: session.body.access_token,
    read: client,
    api: client.schema("api"),
  };
}

/**
 * The Director bootstrapped once for the whole run by `tests/setup/integration-global.ts`. The
 * system permits exactly one bootstrap per database — which is itself under test — so it cannot be
 * done per file.
 */
export async function ensureDirector(): Promise<Fixture> {
  const raw = readFileSync(DIRECTOR_FIXTURE_PATH, "utf8");
  const fixture = JSON.parse(raw) as { userId: string; phoneE164: string; password: string };
  return fixtureFor(fixture.userId, fixture.phoneE164, fixture.password, "director");
}

/** A live account of the given role, provisioned by a Director through their own session. */
export async function createLiveStaff(director: Fixture, role: AppRole): Promise<Fixture> {
  const created = await createGatedStaff(director, role);
  await completeGateAsServer(created.userId, created.password);
  return fixtureFor(created.userId, created.phoneE164, created.password, role);
}

/** A provisioned account that has never completed its first login. */
export async function createGatedStaff(
  director: Fixture,
  role: AppRole,
  fullName = `Test ${role}`,
): Promise<{ userId: string; phoneE164: string; password: string }> {
  const phoneE164 = randomPhone();
  const result = await provisionAccountWithApi(director.api, {
    fullName,
    phoneE164,
    role,
    idempotencyKey: randomUUID(),
  });

  if (!result.ok) throw new Error(`provisioning failed: ${result.reason}`);
  return { userId: result.userId, phoneE164, password: result.temporaryPassword };
}

export { PUBLISHABLE_KEY, SECRET_KEY, SUPABASE_URL, generateTemporaryPassword };
