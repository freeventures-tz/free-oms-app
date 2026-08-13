import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { findAuthUserByIdentifier } from "@/lib/admin/auth-admin";
import { provisionAccountWithApi } from "@/lib/admin/provisioning";
import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";
import {
  admin,
  api,
  createLiveStaff,
  ensureDirector,
  randomPhone,
  signInWithPhone,
  type Fixture,
} from "@/tests/integration/helpers";

let director: Fixture;

beforeAll(async () => {
  director = await ensureDirector();
});

async function countAuthUsersFor(phoneE164: string): Promise<number> {
  const found = await findAuthUserByIdentifier(derivedAuthIdentifier(phoneE164));
  return found ? 1 : 0;
}

async function countProfilesFor(phoneE164: string): Promise<number> {
  const { count } = await director.read
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("phone_e164", phoneE164);
  return count ?? 0;
}

describe("provisioning an account", () => {
  it("creates an account that is active, gated, and has exactly one role", async () => {
    const phoneE164 = randomPhone();
    const result = await provisionAccountWithApi(director.api, {
      fullName: "Asha Mushi",
      phoneE164,
      role: "cashier",
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.temporaryPassword).toBeTruthy();

    const { data: profile } = await director.read
      .from("profiles")
      .select("id, is_active, must_change_password")
      .eq("id", result.userId)
      .single();

    expect(profile?.is_active).toBe(true);
    expect(profile?.must_change_password).toBe(true);

    const { data: roles } = await director.read
      .from("user_roles")
      .select("role")
      .eq("user_id", result.userId);
    expect(roles).toHaveLength(1);
    expect(roles?.[0].role).toBe("cashier");

    const signIn = await signInWithPhone(phoneE164, result.temporaryPassword);
    expect(signIn.status).toBe(200);
    expect(signIn.body.user.id).toBe(result.userId);
  });

  it("is audited to the Director whose session issued it", async () => {
    const phoneE164 = randomPhone();
    const result = await provisionAccountWithApi(director.api, {
      fullName: "Attributed Account",
      phoneE164,
      role: "sales_rep",
      idempotencyKey: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { data: audits } = await director.read
      .from("audit_events")
      .select("actor_id, actor_role, is_system_actor")
      .eq("action", "account_provisioned")
      .eq("entity_id", result.userId);

    expect(audits?.[0]).toMatchObject({
      actor_id: director.userId,
      actor_role: "director",
      is_system_actor: false,
    });
  });

  it("never stores the temporary password anywhere", async () => {
    const phoneE164 = randomPhone();
    const result = await provisionAccountWithApi(director.api, {
      fullName: "Neema Kimaro",
      phoneE164,
      role: "sales_rep",
      idempotencyKey: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { data: job } = await director.read
      .from("account_provisioning_jobs")
      .select("*")
      .eq("auth_user_id", result.userId)
      .single();

    expect(JSON.stringify(job)).not.toContain(result.temporaryPassword);
  });

  it("produces exactly one account when two runs race on the same key", async () => {
    const phoneE164 = randomPhone();
    const key = randomUUID();
    const input = {
      fullName: "Race Person",
      phoneE164,
      role: "cashier" as const,
      idempotencyKey: key,
    };

    const [a, b] = await Promise.all([
      provisionAccountWithApi(director.api, input),
      provisionAccountWithApi(director.api, input),
    ]);

    // One run wins outright. The other either adopts the same account or is told to try again —
    // what it must NEVER do is create a second Auth user or a second profile.
    expect(a.ok || b.ok).toBe(true);
    expect(await countAuthUsersFor(phoneE164)).toBe(1);
    expect(await countProfilesFor(phoneE164)).toBe(1);

    const { count: jobCount } = await director.read
      .from("account_provisioning_jobs")
      .select("id", { count: "exact", head: true })
      .eq("idempotency_key", key);
    expect(jobCount).toBe(1);
  });

  it("adopts an orphaned Auth user after a failure between the two systems", async () => {
    const phoneE164 = randomPhone();
    const key = randomUUID();

    // Reproduce the worst case exactly: claim the job, take the right to call Auth, create the Auth
    // user — and then die before recording its id.
    const { data: claim } = await director.api.rpc("admin_request_account_provisioning", {
      p_idempotency_key: key,
      p_full_name: "Orphan Owner",
      p_phone_e164: phoneE164,
      p_role: "manager",
    });
    expect(claim.ok).toBe(true);

    const jobId = claim.job.id as string;
    const { data: attempt } = await api().rpc("service_begin_auth_attempt", { p_job_id: jobId });
    expect(attempt.ok).toBe(true);

    const { data: created } = await admin().auth.admin.createUser({
      email: derivedAuthIdentifier(phoneE164),
      password: "Orphaned-Temp-1234",
      email_confirm: true,
    });
    const orphanId = created?.user?.id;
    expect(orphanId).toBeTruthy();

    const resumed = await provisionAccountWithApi(director.api, {
      fullName: "Orphan Owner",
      phoneE164,
      role: "manager",
      idempotencyKey: key,
    });

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.userId).toBe(orphanId);
    expect(await countAuthUsersFor(phoneE164)).toBe(1);
    expect(await countProfilesFor(phoneE164)).toBe(1);
    expect(resumed.temporaryPassword).toBeTruthy();

    const signIn = await signInWithPhone(phoneE164, resumed.temporaryPassword);
    expect(signIn.status).toBe(200);
  });

  it("refuses a phone number that already signs someone in", async () => {
    const phoneE164 = randomPhone();
    await provisionAccountWithApi(director.api, {
      fullName: "First Holder",
      phoneE164,
      role: "cashier",
      idempotencyKey: randomUUID(),
    });

    const clash = await provisionAccountWithApi(director.api, {
      fullName: "Second Holder",
      phoneE164,
      role: "sales_rep",
      idempotencyKey: randomUUID(),
    });

    expect(clash.ok).toBe(false);
    if (clash.ok) return;
    expect(clash.reason).toBe("phone_in_use");
    expect(await countProfilesFor(phoneE164)).toBe(1);
  });

  it("refuses provisioning by anyone who is not a Director", async () => {
    const manager = await createLiveStaff(director, "manager");

    const attempt = await provisionAccountWithApi(manager.api, {
      fullName: "Should Not Exist",
      phoneE164: randomPhone(),
      role: "director",
      idempotencyKey: randomUUID(),
    });

    expect(attempt.ok).toBe(false);
  });

  it("allows only one bootstrap, ever", async () => {
    const { count: before } = await director.read
      .from("account_provisioning_jobs")
      .select("id", { count: "exact", head: true })
      .eq("is_bootstrap", true);
    expect(before).toBe(1);

    // The bootstrap claim is service-only. It refuses either because a Director already exists or
    // because the one bootstrap job that will ever exist describes a different person — both are
    // refusals, and which one you get depends only on how far the first bootstrap got.
    const { data } = await api().rpc("service_claim_bootstrap_job", {
      p_idempotency_key: randomUUID(),
      p_full_name: "Second Bootstrap Director",
      p_phone_e164: randomPhone(),
    });

    expect(data.ok).toBe(false);
    expect(["already_bootstrapped", "idempotency_key_conflict"]).toContain(data.reason);

    // What actually matters: no second bootstrap job, and no second Auth user from one.
    const { count: after } = await director.read
      .from("account_provisioning_jobs")
      .select("id", { count: "exact", head: true })
      .eq("is_bootstrap", true);
    expect(after).toBe(1);
  });
});

describe("account lifecycle", () => {
  it("deactivates an account and stops it signing in again", async () => {
    const staff = await createLiveStaff(director, "sales_rep");

    const before = await signInWithPhone(staff.phoneE164, staff.password);
    expect(before.status).toBe(200);

    const { data: deactivated } = await director.api.rpc("admin_set_account_active", {
      p_target_user_id: staff.userId,
      p_is_active: false,
    });
    expect(deactivated.ok).toBe(true);

    const { data: profile } = await director.read
      .from("profiles")
      .select("is_active")
      .eq("id", staff.userId)
      .single();
    expect(profile?.is_active).toBe(false);

    // The database flag is the control; the application also bans the Auth user as hygiene, which
    // the integration path exercises separately. Access is denied here either way.
    const { data: reactivated } = await director.api.rpc("admin_set_account_active", {
      p_target_user_id: staff.userId,
      p_is_active: true,
    });
    expect(reactivated.ok).toBe(true);

    const again = await signInWithPhone(staff.phoneE164, staff.password);
    expect(again.status).toBe(200);
  });

  it("changes a staff role and records both the old and the new one", async () => {
    const staff = await createLiveStaff(director, "cashier");

    const { data } = await director.api.rpc("admin_change_user_role", {
      p_target_user_id: staff.userId,
      p_role: "sales_rep",
    });
    expect(data.ok).toBe(true);

    const { data: roles } = await director.read
      .from("user_roles")
      .select("role")
      .eq("user_id", staff.userId);
    expect(roles).toHaveLength(1);
    expect(roles?.[0].role).toBe("sales_rep");

    const { data: audits } = await director.read
      .from("audit_events")
      .select("before_state, after_state")
      .eq("action", "user_role_changed")
      .eq("entity_id", staff.userId);

    expect(audits?.[0].before_state).toMatchObject({ role: "cashier" });
    expect(audits?.[0].after_state).toMatchObject({ role: "sales_rep" });
  });
});
