import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  PUBLISHABLE_KEY,
  SECRET_KEY,
  callApiRpc,
  createGatedStaff,
  createLiveStaff,
  ensureDirector,
  signInWithPhone,
  type Fixture,
} from "@/tests/integration/helpers";

/**
 * Authority comes from the SESSION, not from a parameter.
 *
 * The previous design let a service-key caller name any Director as the actor of any change. The
 * database checked that the named id belonged to a Director — but not that this Director had asked
 * for anything. These tests hold the new boundary: `api.admin_*` derives its actor and cannot be
 * told who to be, and `api.service_*` cannot start administrative work at all.
 */

let director: Fixture;

beforeAll(async () => {
  director = await ensureDirector();
});

describe("the admin_ / service_ split", () => {
  it("gives the secret key no way to start an administrative change", async () => {
    const staff = await createLiveStaff(director, "cashier");

    for (const fn of [
      "admin_set_account_active",
      "admin_change_user_role",
      "admin_request_password_reset",
      "admin_request_phone_change",
      "admin_request_account_provisioning",
    ]) {
      const { status } = await callApiRpc(fn, { p_target_user_id: staff.userId }, SECRET_KEY);
      expect(status, fn).toBeGreaterThanOrEqual(400);
    }
  });

  it("gives a signed-in Director no way to continue a cross-system operation", async () => {
    for (const fn of [
      "service_complete_command",
      "service_fail_command",
      "service_revert_phone_change",
      "service_pending_phone_changes",
      "service_begin_first_login",
      "service_complete_first_login",
      "service_claim_bootstrap_job",
    ]) {
      const { status } = await callApiRpc(
        fn,
        { p_command_id: randomUUID(), p_user_id: director.userId },
        PUBLISHABLE_KEY,
        director.accessToken,
      );
      expect(status, fn).toBeGreaterThanOrEqual(400);
    }
  });

  it("refuses an unauthenticated caller outright", async () => {
    const { status } = await callApiRpc(
      "admin_set_account_active",
      { p_target_user_id: director.userId, p_is_active: false },
      PUBLISHABLE_KEY,
    );
    expect(status).toBeGreaterThanOrEqual(400);
  });
});

describe("who may act as a Director", () => {
  it("refuses every role that is not Director", async () => {
    const target = await createLiveStaff(director, "sales_rep");

    for (const role of ["manager", "cashier", "sales_rep"] as const) {
      const impostor = await createLiveStaff(director, role);

      const { error } = await impostor.api.rpc("admin_set_account_active", {
        p_target_user_id: target.userId,
        p_is_active: false,
      });
      expect(error, role).not.toBeNull();

      const { error: resetError } = await impostor.api.rpc("admin_request_password_reset", {
        p_target_user_id: target.userId,
        p_idempotency_key: randomUUID(),
      });
      expect(resetError, role).not.toBeNull();
    }
  });

  it("refuses a Director who is still behind the first-login gate", async () => {
    const gatedDirector = await createGatedStaff(director, "director", "Gated Director");
    const session = await signInWithPhone(gatedDirector.phoneE164, gatedDirector.password);
    expect(session.status).toBe(200);

    const { status } = await callApiRpc(
      "admin_request_password_reset",
      { p_target_user_id: director.userId, p_idempotency_key: randomUUID() },
      PUBLISHABLE_KEY,
      session.body.access_token,
    );
    expect(status).toBeGreaterThanOrEqual(400);
  });

  it("refuses a Director whose account was deactivated after they signed in", async () => {
    const second = await createLiveStaff(director, "director");
    const target = await createLiveStaff(director, "cashier");

    // Their session is still perfectly valid; their authority is not.
    const { data: deactivated } = await director.api.rpc("admin_set_account_active", {
      p_target_user_id: second.userId,
      p_is_active: false,
    });
    expect(deactivated.ok).toBe(true);

    const { error } = await second.api.rpc("admin_set_account_active", {
      p_target_user_id: target.userId,
      p_is_active: false,
    });
    expect(error).not.toBeNull();
  });

  it("refuses a former Director whose role was changed after they signed in", async () => {
    const second = await createLiveStaff(director, "director");
    const target = await createLiveStaff(director, "cashier");

    const { data: demoted } = await director.api.rpc("admin_change_user_role", {
      p_target_user_id: second.userId,
      p_role: "manager",
    });
    expect(demoted.ok).toBe(true);

    const { error } = await second.api.rpc("admin_request_password_reset", {
      p_target_user_id: target.userId,
      p_idempotency_key: randomUUID(),
    });
    expect(error).not.toBeNull();
  });
});

describe("Director password reset is never anonymous", () => {
  it("has no null-actor form to call", async () => {
    const staff = await createLiveStaff(director, "cashier");

    // The withdrawn function accepted `p_actor_id`; there is no such parameter now, and no
    // service-key path to the Director reset at all.
    const { status } = await callApiRpc(
      "service_reset_password_gate",
      { p_target_user_id: staff.userId, p_actor_id: null },
      SECRET_KEY,
    );
    expect(status).toBeGreaterThanOrEqual(400);
  });

  it("names the Director who performed it", async () => {
    const staff = await createLiveStaff(director, "cashier");

    const { data } = await director.api.rpc("admin_request_password_reset", {
      p_target_user_id: staff.userId,
      p_idempotency_key: randomUUID(),
    });
    expect(data.ok).toBe(true);

    const { data: audits } = await director.read
      .from("audit_events")
      .select("actor_id, actor_role, is_system_actor")
      .eq("action", "password_reset_by_director")
      .eq("entity_id", staff.userId);

    expect(audits?.[0]).toMatchObject({
      actor_id: director.userId,
      actor_role: "director",
      is_system_actor: false,
    });
  });

  it("records the command against the Director who issued it, not the caller of the continuation", async () => {
    const staff = await createLiveStaff(director, "cashier");
    const key = randomUUID();

    const { data } = await director.api.rpc("admin_request_password_reset", {
      p_target_user_id: staff.userId,
      p_idempotency_key: key,
    });

    const { data: command } = await director.read
      .from("admin_commands")
      .select("actor_id, actor_role, target_user_id, kind, stage")
      .eq("idempotency_key", key)
      .single();

    expect(command).toMatchObject({
      actor_id: director.userId,
      actor_role: "director",
      target_user_id: staff.userId,
      kind: "password_reset",
      stage: "db_applied",
    });
    expect(data.command.id).toBeTruthy();
  });
});
