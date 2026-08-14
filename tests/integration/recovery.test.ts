import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { applyPhoneChangeAtAuth, resumePendingPhoneChanges } from "@/lib/admin/accounts";
import { findAuthUserByIdentifier } from "@/lib/admin/auth-admin";
import { provisionAccountWithApi } from "@/lib/admin/provisioning";
import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";
import {
  admin,
  api,
  createGatedStaff,
  ensureDirector,
  generateTemporaryPassword,
  randomPhone,
  selfChangePassword,
  signInWithPhone,
  type Fixture,
} from "@/tests/integration/helpers";

/**
 * Recovery after a failure BETWEEN Supabase Auth and this database.
 *
 * Every test here injects the failure rather than describing it: the Auth call really happens, and
 * the database step that should follow really is skipped, so the state under test is the state a
 * crashed process actually leaves behind.
 */

let director: Fixture;

beforeAll(async () => {
  director = await ensureDirector();
});

describe("forced first login, after a crash between Auth and the gate", () => {
  /** The single Auth request the server makes: password and proof land together or not at all. */
  async function changePasswordWithEvidence(userId: string, operationId: string, password: string) {
    const token = randomUUID();
    const { error } = await admin().auth.admin.updateUserById(userId, {
      password,
      app_metadata: {
        fv_first_login: { operation_id: operationId, token, changed_at: new Date().toISOString() },
      },
    });
    expect(error).toBeNull();
    return token;
  }

  async function markerOf(userId: string) {
    const { data } = await admin().auth.admin.getUserById(userId);
    return (data.user?.app_metadata as Record<string, unknown> | null)?.fv_first_login as
      | { operation_id: string; token: string }
      | undefined;
  }

  it("still cannot be retried by repeating the self-service Auth call", async () => {
    const staff = await createGatedStaff(director, "cashier");
    const session = await signInWithPhone(staff.phoneE164, staff.password);
    const chosen = generateTemporaryPassword();

    const first = await selfChangePassword(session.body.access_token, chosen);
    expect(first.status).toBe(200);

    // The constraint that forced this whole design, asserted rather than assumed.
    const repeat = await selfChangePassword(session.body.access_token, chosen);
    expect(repeat.status).toBe(422);
    expect(repeat.body.error_code).toBe("same_password");
  });

  it("converges after a crash between Auth accepting the password and any database write", async () => {
    const staff = await createGatedStaff(director, "cashier");
    const chosen = generateTemporaryPassword();

    const { data: begun } = await api().rpc("service_begin_first_login", { p_user_id: staff.userId });
    const operationId = begun.operation.id as string;

    // Auth accepts the password AND records the marker. Then the process dies: nothing reaches the
    // database, so the operation is still `pending`.
    await changePasswordWithEvidence(staff.userId, operationId, chosen);

    // Nothing was recorded, and the database says so by refusing to clear the gate. (The operation
    // row itself is readable only by the user it belongs to, so this is also the only way to ask.)
    const { data: premature } = await api().rpc("service_complete_first_login", {
      p_user_id: staff.userId,
      p_operation_id: operationId,
    });
    expect(premature.ok).toBe(false);
    expect(premature.reason).toBe("password_change_not_recorded");

    // The retry finds the evidence in Auth — where it was written atomically with the password —
    // and completes using the SAME password, with no second Auth change and no new choice.
    const marker = await markerOf(staff.userId);
    expect(marker?.operation_id).toBe(operationId);

    const { data: recorded } = await api().rpc("service_record_first_login_password_changed", {
      p_operation_id: operationId,
      p_user_id: staff.userId,
      p_auth_evidence: marker!.token,
    });
    expect(recorded.ok).toBe(true);

    const { data: completed } = await api().rpc("service_complete_first_login", {
      p_user_id: staff.userId,
      p_operation_id: operationId,
    });
    expect(completed.ok).toBe(true);

    const { data: profile } = await director.read
      .from("profiles")
      .select("must_change_password")
      .eq("id", staff.userId)
      .single();
    expect(profile?.must_change_password).toBe(false);

    // The password they chose is the one that works — they were never asked for another.
    const signIn = await signInWithPhone(staff.phoneE164, chosen);
    expect(signIn.status).toBe(200);
  });

  it("keeps the evidence usable when the Auth response itself is lost", async () => {
    const staff = await createGatedStaff(director, "cashier");
    const chosen = generateTemporaryPassword();

    const { data: begun } = await api().rpc("service_begin_first_login", { p_user_id: staff.userId });
    const operationId = begun.operation.id as string;

    // The request reached Auth and applied; only the response was lost. The marker is readable
    // afterwards, which is precisely what makes the outcome knowable at all.
    await changePasswordWithEvidence(staff.userId, operationId, chosen);

    const marker = await markerOf(staff.userId);
    expect(marker?.operation_id).toBe(operationId);
    expect(await signInWithPhone(staff.phoneE164, chosen).then((r) => r.status)).toBe(200);
  });

  it("refuses to clear a gate with no recorded Auth change, even for the secret key", async () => {
    const staff = await createGatedStaff(director, "cashier");

    const { data: begun } = await api().rpc("service_begin_first_login", { p_user_id: staff.userId });
    const operationId = begun.operation.id as string;

    const { data: refused } = await api().rpc("service_complete_first_login", {
      p_user_id: staff.userId,
      p_operation_id: operationId,
    });

    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe("password_change_not_recorded");
  });

  it("will not record evidence that names no Auth write at all", async () => {
    const staff = await createGatedStaff(director, "cashier");
    const { data: begun } = await api().rpc("service_begin_first_login", { p_user_id: staff.userId });

    const { data: refused } = await api().rpc("service_record_first_login_password_changed", {
      p_operation_id: begun.operation.id,
      p_user_id: staff.userId,
      p_auth_evidence: "",
    });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe("evidence_required");
  });

  it("will not accept one user's operation as evidence about another", async () => {
    const one = await createGatedStaff(director, "cashier");
    const two = await createGatedStaff(director, "cashier");

    const { data: begun } = await api().rpc("service_begin_first_login", { p_user_id: one.userId });

    const { data: refused } = await api().rpc("service_record_first_login_password_changed", {
      p_operation_id: begun.operation.id,
      p_user_id: two.userId,
      p_auth_evidence: randomUUID(),
    });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe("operation_user_mismatch");
  });

  it("supersedes recorded evidence when a Director resets the password", async () => {
    const staff = await createGatedStaff(director, "cashier");
    const chosen = generateTemporaryPassword();

    const { data: begun } = await api().rpc("service_begin_first_login", { p_user_id: staff.userId });
    const operationId = begun.operation.id as string;

    const token = await changePasswordWithEvidence(staff.userId, operationId, chosen);
    await api().rpc("service_record_first_login_password_changed", {
      p_operation_id: operationId,
      p_user_id: staff.userId,
      p_auth_evidence: token,
    });

    const { data: reset } = await director.api.rpc("admin_request_password_reset", {
      p_target_user_id: staff.userId,
      p_idempotency_key: randomUUID(),
    });
    expect(reset.ok).toBe(true);

    const { data: refused } = await api().rpc("service_complete_first_login", {
      p_user_id: staff.userId,
      p_operation_id: operationId,
    });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe("superseded");
  });
});

describe("phone change across two systems", () => {
  async function currentIdentifier(userId: string): Promise<string | null> {
    const { data } = await admin().auth.admin.getUserById(userId);
    return data.user?.email ?? null;
  }

  it("changes both systems together on the happy path", async () => {
    const staff = await createGatedStaff(director, "sales_rep");
    const next = randomPhone();

    const { data: issued } = await director.api.rpc("admin_request_phone_change", {
      p_target_user_id: staff.userId,
      p_phone_e164: next,
      p_idempotency_key: randomUUID(),
    });
    expect(issued.ok).toBe(true);

    const applied = await applyPhoneChangeAtAuth(issued.command);
    expect(applied.ok).toBe(true);

    expect(await currentIdentifier(staff.userId)).toBe(derivedAuthIdentifier(next));
    const signIn = await signInWithPhone(next, staff.password);
    expect(signIn.status).toBe(200);
  });

  it("leaves nothing changed when the database refuses first", async () => {
    const staff = await createGatedStaff(director, "sales_rep");
    const taken = director.phoneE164;

    const { data: refused } = await director.api.rpc("admin_request_phone_change", {
      p_target_user_id: staff.userId,
      p_phone_e164: taken,
      p_idempotency_key: randomUUID(),
    });

    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe("phone_in_use");
    expect(await currentIdentifier(staff.userId)).toBe(derivedAuthIdentifier(staff.phoneE164));
  });

  it("converges after a crash between the database change and Auth", async () => {
    const staff = await createGatedStaff(director, "sales_rep");
    const next = randomPhone();

    // The database change commits...
    const { data: issued } = await director.api.rpc("admin_request_phone_change", {
      p_target_user_id: staff.userId,
      p_phone_e164: next,
      p_idempotency_key: randomUUID(),
    });
    expect(issued.ok).toBe(true);

    // ...and the process dies here. The two systems now disagree, which is exactly the state the
    // command row exists to make visible and finishable.
    expect(await currentIdentifier(staff.userId)).toBe(derivedAuthIdentifier(staff.phoneE164));

    const { data: pending } = await api().rpc("service_pending_phone_changes");
    expect(pending).toHaveLength(1);

    const resumed = await resumePendingPhoneChanges();
    expect(resumed).toBe(1);

    // Both systems now agree on the NEW number, and it is the one that signs in.
    expect(await currentIdentifier(staff.userId)).toBe(derivedAuthIdentifier(next));
    const signIn = await signInWithPhone(next, staff.password);
    expect(signIn.status).toBe(200);

    // The resume is idempotent: nothing is left pending, and running it again does nothing.
    const { data: afterwards } = await api().rpc("service_pending_phone_changes");
    expect(afterwards).toHaveLength(0);
    expect(await resumePendingPhoneChanges()).toBe(0);
  });

  it("reverts the database when Auth refuses, so the old identifier stays authoritative", async () => {
    const staff = await createGatedStaff(director, "sales_rep");
    const other = await createGatedStaff(director, "cashier");
    const next = randomPhone();

    const { data: issued } = await director.api.rpc("admin_request_phone_change", {
      p_target_user_id: staff.userId,
      p_phone_e164: next,
      p_idempotency_key: randomUUID(),
    });
    expect(issued.ok).toBe(true);

    // Make the Auth side fail for a real reason: another Auth user already holds that identifier.
    await admin().auth.admin.updateUserById(other.userId, {
      email: derivedAuthIdentifier(next),
      email_confirm: true,
    });

    const applied = await applyPhoneChangeAtAuth(issued.command);
    expect(applied.ok).toBe(false);

    // The database was put back, so the account still signs in with the number Auth knows.
    const { data: profile } = await director.read
      .from("profiles")
      .select("phone_e164")
      .eq("id", staff.userId)
      .single();
    expect(profile?.phone_e164).toBe(staff.phoneE164);

    const signIn = await signInWithPhone(staff.phoneE164, staff.password);
    expect(signIn.status).toBe(200);

    const { data: pending } = await api().rpc("service_pending_phone_changes");
    expect(pending).toHaveLength(0);
  });

  it("gives the number to exactly one account when two requests race for it", async () => {
    const first = await createGatedStaff(director, "cashier");
    const second = await createGatedStaff(director, "cashier");
    const contested = randomPhone();

    const [a, b] = await Promise.all([
      director.api.rpc("admin_request_phone_change", {
        p_target_user_id: first.userId,
        p_phone_e164: contested,
        p_idempotency_key: randomUUID(),
      }),
      director.api.rpc("admin_request_phone_change", {
        p_target_user_id: second.userId,
        p_phone_e164: contested,
        p_idempotency_key: randomUUID(),
      }),
    ]);

    const winners = [a.data, b.data].filter((r) => r?.ok === true);
    expect(winners).toHaveLength(1);

    const { count } = await director.read
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("phone_e164", contested);
    expect(count).toBe(1);
  });
});

describe("account creation after a lost response", () => {
  it("refuses rather than reporting bland success with no credential", async () => {
    const phoneE164 = randomPhone();
    const key = randomUUID();
    const input = { fullName: "Lost Response", phoneE164, role: "cashier" as const, idempotencyKey: key };

    const first = await provisionAccountWithApi(director.api, input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The Director never saw the response and retries with the same key.
    const retry = await provisionAccountWithApi(director.api, input);

    expect(retry.ok).toBe(false);
    if (retry.ok) return;
    expect(retry.reason).toBe("already_provisioned");
    // ...and the reply names the account, so the interface can offer the recovery that works.
    expect(retry).toHaveProperty("userId", first.userId);
  });

  it("recovers a usable credential through a Director reset, re-arming the gate", async () => {
    const phoneE164 = randomPhone();
    const created = await provisionAccountWithApi(director.api, {
      fullName: "Needs A New Password",
      phoneE164,
      role: "cashier",
      idempotencyKey: randomUUID(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Recovery: issue a new temporary password for the account that already exists.
    const { data: issued } = await director.api.rpc("admin_request_password_reset", {
      p_target_user_id: created.userId,
      p_idempotency_key: randomUUID(),
    });
    expect(issued.ok).toBe(true);

    const replacement = generateTemporaryPassword();
    await admin().auth.admin.updateUserById(created.userId, { password: replacement });
    await api().rpc("service_complete_command", { p_command_id: issued.command.id });

    const signIn = await signInWithPhone(phoneE164, replacement);
    expect(signIn.status).toBe(200);

    const { data: profile } = await director.read
      .from("profiles")
      .select("must_change_password")
      .eq("id", created.userId)
      .single();
    expect(profile?.must_change_password).toBe(true);

    const { data: audits } = await director.read
      .from("audit_events")
      .select("actor_id, actor_role")
      .eq("action", "password_reset_by_director")
      .eq("entity_id", created.userId);
    expect(audits?.[0]).toMatchObject({ actor_id: director.userId, actor_role: "director" });
  });

  it("does not create a duplicate when a refreshed page submits a NEW key for the same phone", async () => {
    const phoneE164 = randomPhone();

    const first = await provisionAccountWithApi(director.api, {
      fullName: "Refresher",
      phoneE164,
      role: "cashier",
      idempotencyKey: randomUUID(),
    });
    expect(first.ok).toBe(true);

    // A refresh renders a new key, so this really is a new job — the phone is what stops it.
    const afterRefresh = await provisionAccountWithApi(director.api, {
      fullName: "Refresher",
      phoneE164,
      role: "cashier",
      idempotencyKey: randomUUID(),
    });

    expect(afterRefresh.ok).toBe(false);
    if (afterRefresh.ok) return;
    expect(afterRefresh.reason).toBe("phone_in_use");

    const { count } = await director.read
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("phone_e164", phoneE164);
    expect(count).toBe(1);

    const found = await findAuthUserByIdentifier(derivedAuthIdentifier(phoneE164));
    expect(found).not.toBeNull();
  });
});
