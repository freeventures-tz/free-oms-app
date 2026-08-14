import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  applyPhoneChangeAtAuth,
  resetUserPassword,
  resumePendingPhoneChanges,
} from "@/lib/admin/accounts";
import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";
import {
  SECRET_KEY,
  admin,
  api,
  callApiRpc,
  createGatedStaff,
  createLiveStaff,
  ensureDirector,
  randomPhone,
  signInWithPhone,
  type Fixture,
} from "@/tests/integration/helpers";

/**
 * Reproductions of the defects found in review. Each one asserts the CORRECT behaviour, so each
 * failed before the fix and guards it afterwards. They are written against the production functions,
 * not against imitations of them.
 */

let director: Fixture;

beforeAll(async () => {
  director = await ensureDirector();
});

describe("a password reset is idempotent per key", () => {
  it("does not invalidate the credential the Director already wrote down", async () => {
    const staff = await createLiveStaff(director, "cashier");
    const key = randomUUID();

    const first = await resetUserPassword(staff.userId, key, director.api);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const worksBefore = await signInWithPhone(staff.phoneE164, first.temporaryPassword);
    expect(worksBefore.status).toBe(200);

    // The Director's response was lost, so the same interaction is replayed with the same key.
    const replay = await resetUserPassword(staff.userId, key, director.api);

    // It must NOT quietly issue a second password: the first one is on a piece of paper, and
    // replacing it silently is how a Director hands over a credential that no longer works.
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.reason).toBe("already_completed");

    const stillWorks = await signInWithPhone(staff.phoneE164, first.temporaryPassword);
    expect(stillWorks.status).toBe(200);
  });

  it("lets exactly one of two concurrent replays perform the Auth change", async () => {
    const staff = await createLiveStaff(director, "cashier");
    const key = randomUUID();

    const [a, b] = await Promise.all([
      resetUserPassword(staff.userId, key, director.api),
      resetUserPassword(staff.userId, key, director.api),
    ]);

    const issued = [a, b].filter((r) => r.ok);
    expect(issued).toHaveLength(1);

    const winner = issued[0];
    if (!winner.ok) return;
    const signIn = await signInWithPhone(staff.phoneE164, winner.temporaryPassword);
    expect(signIn.status).toBe(200);
  });
});

describe("a phone change converges across both systems", () => {
  async function authIdentifier(userId: string): Promise<string | null> {
    const { data } = await admin().auth.admin.getUserById(userId);
    return data.user?.email ?? null;
  }

  async function profilePhone(userId: string): Promise<string | null> {
    const { data } = await director.read
      .from("profiles")
      .select("phone_e164")
      .eq("id", userId)
      .single();
    return (data?.phone_e164 as string) ?? null;
  }

  it("never reapplies a command that was already reverted", async () => {
    const staff = await createGatedStaff(director, "sales_rep");
    const blocker = await createGatedStaff(director, "cashier");
    const wanted = randomPhone();

    const { data: issued } = await director.api.rpc("admin_request_phone_change", {
      p_target_user_id: staff.userId,
      p_phone_e164: wanted,
      p_idempotency_key: randomUUID(),
    });
    expect(issued.ok).toBe(true);

    // Force the Auth side to fail, which reverts the database.
    await admin().auth.admin.updateUserById(blocker.userId, {
      email: derivedAuthIdentifier(wanted),
      email_confirm: true,
    });
    const failed = await applyPhoneChangeAtAuth(issued.command);
    expect(failed.ok).toBe(false);
    expect(await profilePhone(staff.userId)).toBe(staff.phoneE164);

    // Free the identifier, then replay the SAME reverted command. It must not now push the new
    // number into Auth while the database sits on the old one.
    await admin().auth.admin.updateUserById(blocker.userId, {
      email: derivedAuthIdentifier(blocker.phoneE164),
      email_confirm: true,
    });

    const replay = await applyPhoneChangeAtAuth(issued.command);
    expect(replay.ok).toBe(false);

    expect(await profilePhone(staff.userId)).toBe(staff.phoneE164);
    expect(await authIdentifier(staff.userId)).toBe(derivedAuthIdentifier(staff.phoneE164));
  });

  it("refuses a second live phone change for the same account", async () => {
    const staff = await createGatedStaff(director, "sales_rep");
    const first = randomPhone();
    const second = randomPhone();

    const { data: one } = await director.api.rpc("admin_request_phone_change", {
      p_target_user_id: staff.userId,
      p_phone_e164: first,
      p_idempotency_key: randomUUID(),
    });
    expect(one.ok).toBe(true);

    // A second, independently executable command for one account is what let two changes be
    // applied out of order and leave the two systems disagreeing.
    const { data: two } = await director.api.rpc("admin_request_phone_change", {
      p_target_user_id: staff.userId,
      p_phone_e164: second,
      p_idempotency_key: randomUUID(),
    });
    expect(two.ok).toBe(false);
    expect(two.reason).toBe("change_already_in_flight");
  });

  it("binds an idempotency key to the exact change it was issued for", async () => {
    const staff = await createGatedStaff(director, "cashier");
    const key = randomUUID();

    const { data: issued } = await director.api.rpc("admin_request_phone_change", {
      p_target_user_id: staff.userId,
      p_phone_e164: randomPhone(),
      p_idempotency_key: key,
    });
    expect(issued.ok).toBe(true);

    const { data: mismatched } = await director.api.rpc("admin_request_phone_change", {
      p_target_user_id: staff.userId,
      p_phone_e164: randomPhone(),
      p_idempotency_key: key,
    });
    expect(mismatched.ok).toBe(false);
    expect(mismatched.reason).toBe("idempotency_key_conflict");
  });

  it("lets only one recovery worker execute a pending command", async () => {
    const staff = await createGatedStaff(director, "manager");
    const wanted = randomPhone();

    // Drain anything earlier tests left pending, so the count below is about THIS command.
    await resumePendingPhoneChanges();

    const { data: issued } = await director.api.rpc("admin_request_phone_change", {
      p_target_user_id: staff.userId,
      p_phone_e164: wanted,
      p_idempotency_key: randomUUID(),
    });
    expect(issued.ok).toBe(true);

    // Two recovery workers wake at once, as two server instances would.
    const [a, b] = await Promise.all([resumePendingPhoneChanges(), resumePendingPhoneChanges()]);
    expect(a + b).toBe(1);

    expect(await profilePhone(staff.userId)).toBe(wanted);
    expect(await authIdentifier(staff.userId)).toBe(derivedAuthIdentifier(wanted));
  });

  it("refuses to act on a command another worker is already holding", async () => {
    const staff = await createGatedStaff(director, "cashier");
    const wanted = randomPhone();

    const { data: issued } = await director.api.rpc("admin_request_phone_change", {
      p_target_user_id: staff.userId,
      p_phone_e164: wanted,
      p_idempotency_key: randomUUID(),
    });
    expect(issued.ok).toBe(true);

    // Another worker takes the claim first.
    const otherWorker = randomUUID();
    const { data: claimed } = await api().rpc("service_claim_command", {
      p_command_id: issued.command.id,
      p_worker_token: otherWorker,
    });
    expect(claimed.ok).toBe(true);

    // This one must not perform the Auth change anyway — that is how one command got applied twice.
    const result = await applyPhoneChangeAtAuth(issued.command);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("claimed_by_other");
  });

  it("will not let a worker complete a command it does not hold", async () => {
    const staff = await createGatedStaff(director, "cashier");

    const { data: issued } = await director.api.rpc("admin_request_phone_change", {
      p_target_user_id: staff.userId,
      p_phone_e164: randomPhone(),
      p_idempotency_key: randomUUID(),
    });

    await api().rpc("service_claim_command", {
      p_command_id: issued.command.id,
      p_worker_token: randomUUID(),
    });

    const { data: refused } = await api().rpc("service_complete_command", {
      p_command_id: issued.command.id,
      p_worker_token: randomUUID(),
    });

    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe("claim_lost");
  });
});

describe("audit attribution cannot be manufactured", () => {
  it("gives the secret key no way to attribute an event to a chosen user", async () => {
    const before = await director.read
      .from("audit_events")
      .select("id", { count: "exact", head: true })
      .eq("actor_id", director.userId)
      .eq("action", "route_access_denied");

    // The withdrawn function took a user id from its caller. Nothing in `api` may do that.
    const { status } = await callApiRpc(
      "service_record_access_denial",
      { p_user_id: director.userId, p_path: "/admin/accounts" },
      SECRET_KEY,
    );
    expect(status).toBe(404);

    const after = await director.read
      .from("audit_events")
      .select("id", { count: "exact", head: true })
      .eq("actor_id", director.userId)
      .eq("action", "route_access_denied");

    expect(after.count).toBe(before.count);
  });

  it("records a refusal against the session that made it, derived not supplied", async () => {
    const cashier = await createLiveStaff(director, "cashier");

    const { data } = await cashier.api.rpc("self_record_access_denial", {
      p_path: "/admin/accounts",
    });
    expect(data.ok).toBe(true);

    const { data: events } = await director.read
      .from("audit_events")
      .select("actor_id, actor_role")
      .eq("action", "route_access_denied")
      .eq("entity_id", cashier.userId);

    expect(events?.[0]).toMatchObject({ actor_id: cashier.userId, actor_role: "cashier" });
  });

  it("cannot be aimed at another user even by an authenticated caller", async () => {
    const cashier = await createLiveStaff(director, "cashier");

    // There is no target parameter to aim. The signature itself is the control.
    const { error } = await cashier.api.rpc("self_record_access_denial", {
      p_path: "/admin/accounts",
      p_user_id: director.userId,
    });
    expect(error).not.toBeNull();
  });
});

describe("audit history records the authority the actor held", () => {
  it("records a self-demotion under the Director role it was performed with", async () => {
    const second = await createLiveStaff(director, "director");

    // Two Directors exist, so this is permitted — and it is performed AS a Director.
    const { data } = await second.api.rpc("admin_change_user_role", {
      p_target_user_id: second.userId,
      p_role: "manager",
    });
    expect(data.ok).toBe(true);

    const { data: events } = await director.read
      .from("audit_events")
      .select("actor_role, before_state, after_state")
      .eq("action", "user_role_changed")
      .eq("entity_id", second.userId);

    // Reading the role after the mutation recorded "manager" — the authority they ended with, not
    // the one they used.
    expect(events?.[0].actor_role).toBe("director");
    expect(events?.[0].before_state).toMatchObject({ role: "director" });
    expect(events?.[0].after_state).toMatchObject({ role: "manager" });
  });
});
