import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  PUBLISHABLE_KEY,
  SECRET_KEY,
  SUPABASE_URL,
  callApiRpc,
  createLiveStaff,
  decodeJwt,
  ensureDirector,
  randomPhone,
  signInWithPhone,
  type Fixture,
} from "@/tests/integration/helpers";

/**
 * These are the tests that the pgTAP suite structurally cannot write.
 *
 * pgTAP connects over a direct PostgreSQL session as a superuser-adjacent role. It proved the
 * privileges were right — and the operation was still unreachable over HTTP, because PostgREST only
 * routes to exposed schemas. Everything here goes through the real front door: Kong, PostgREST,
 * GoTrue, and the actual keys.
 */

let director: Fixture;

beforeAll(async () => {
  director = await ensureDirector();
});

describe("public signup", () => {
  it("is refused by Supabase Auth itself, not merely hidden in the UI", async () => {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `intruder-${randomUUID()}@example.com`,
        password: "Str0ngPassword123",
      }),
    });

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error_code).toBe("signup_disabled");
  });

  it("refuses a phone signup too", async () => {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: randomPhone(), password: "Str0ngPassword123" }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = await response.json();
    expect(["signup_disabled", "phone_provider_disabled"]).toContain(body.error_code);
  });
});

describe("schema exposure", () => {
  it("routes to api with the secret key", async () => {
    const { status, body } = await callApiRpc("service_director_exists", {}, SECRET_KEY);
    expect(status).toBe(200);
    expect(typeof body).toBe("boolean");
  });

  it("does NOT expose private, so the implementations stay unreachable over HTTP", async () => {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/clear_first_login_gate`, {
      method: "POST",
      headers: {
        apikey: SECRET_KEY,
        Authorization: `Bearer ${SECRET_KEY}`,
        "Content-Type": "application/json",
        "Content-Profile": "private",
      },
      body: JSON.stringify({ p_user_id: director.userId }),
    });

    expect(response.status).toBe(406);
    const body = await response.json();
    expect(body.code).toBe("PGRST106");
  });
});

describe("who may execute the service-only bridge", () => {
  it("refuses the publishable key", async () => {
    const { status, body } = await callApiRpc("service_director_exists", {}, PUBLISHABLE_KEY);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(String(body?.message ?? "")).toMatch(/permission denied/i);
  });

  it("refuses a signed-in user's session", async () => {
    const signIn = await signInWithPhone(director.phoneE164, director.password);
    expect(signIn.status).toBe(200);

    const { status } = await callApiRpc(
      "service_complete_first_login",
      { p_user_id: director.userId },
      PUBLISHABLE_KEY,
      signIn.body.access_token,
    );

    expect(status).toBeGreaterThanOrEqual(400);
  });

  it("refuses a Director's own session on the CONTINUATION half of an operation", async () => {
    const signIn = await signInWithPhone(director.phoneE164, director.password);

    // A Director may START administrative work from their session, and may not finish a
    // cross-system operation — that half belongs to the server and is addressed by id.
    const { status } = await callApiRpc(
      "service_complete_command",
      { p_command_id: randomUUID() },
      PUBLISHABLE_KEY,
      signIn.body.access_token,
    );

    expect(status).toBeGreaterThanOrEqual(400);
  });

  it("performs a Director reset from the Director's own session, not from the secret key", async () => {
    const staff = await createLiveStaff(director, "cashier");

    // The secret key has no function that can start this any more.
    const { status: serviceStatus } = await callApiRpc(
      "service_reset_password_gate",
      { p_target_user_id: staff.userId, p_actor_id: director.userId },
      SECRET_KEY,
    );
    expect(serviceStatus).toBe(404);

    // The Director's session can, and the database derives the actor from that session.
    const { status, body } = await callApiRpc(
      "admin_request_password_reset",
      { p_target_user_id: staff.userId, p_idempotency_key: randomUUID() },
      PUBLISHABLE_KEY,
      director.accessToken,
    );

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.command.actor_id).toBe(director.userId);
  });
});

describe("sessions", () => {
  it("issues 15-minute access tokens", async () => {
    const signIn = await signInWithPhone(director.phoneE164, director.password);
    expect(signIn.status).toBe(200);

    const claims = decodeJwt(signIn.body.access_token) as { exp: number; iat: number };
    expect(claims.exp - claims.iat).toBe(900);
  });

  it("carries the role only as a hint, and only when there is a live role", async () => {
    const signIn = await signInWithPhone(director.phoneE164, director.password);
    const claims = decodeJwt(signIn.body.access_token);
    expect(claims.user_role).toBe("director");
  });

  it("gives a neutral failure for a wrong password and an unknown number alike", async () => {
    const wrongPassword = await signInWithPhone(director.phoneE164, "NotThePassword123");
    const unknownNumber = await signInWithPhone(randomPhone(), "NotThePassword123");

    expect(wrongPassword.status).toBe(400);
    expect(unknownNumber.status).toBe(400);
    // Identical responses: nothing distinguishes "no such account" from "wrong password".
    expect(wrongPassword.body.error_code).toBe(unknownNumber.body.error_code);
  });
});
