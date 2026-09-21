import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  SECRET_KEY,
  SUPABASE_URL,
  PUBLISHABLE_KEY,
  callApiRpc,
  createLiveStaff,
  ensureDirector,
  type Fixture,
} from "@/tests/integration/helpers";

/**
 * Imprest funding (issue #48), over real HTTP through PostgREST.
 *
 * pgTAP proves the lifecycle, the approval limit, the mismatch cycles and immutable history inside
 * the database. These tests prove what only a real session can: grants and RLS as `authenticated`
 * rather than as the table owner, a leaked secret key, authority that changed after sign-in, and
 * commands that genuinely arrive together in separate transactions.
 *
 * Every posted figure is asserted as a DELTA, so the order in which this file's tests run cannot
 * make one of them pass for the wrong reason.
 */

type Funding = {
  id: string;
  fund_id: string;
  status: string;
  version: number;
  handover_id: string | null;
  received_amount_tzs: number | null;
};
type Result = { ok: boolean; reason: string; funding?: Funding };

let director: Fixture;
let secondDirector: Fixture;
let manager: Fixture;
let secondManager: Fixture;
let cashier: Fixture;
let salesRep: Fixture;

async function rpc(who: Fixture, fn: string, args: Record<string, unknown>): Promise<Result> {
  const { data, error } = await who.api.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as Result;
}

const request = (who: Fixture, amount: number, key = randomUUID()) =>
  rpc(who, "staff_request_imprest_funding", {
    p_amount_tzs: amount,
    p_reason: "Integration float",
    p_idempotency_key: key,
  });

const approve = (who: Fixture, f: Funding, amount: number) =>
  rpc(who, "admin_decide_imprest_funding", {
    p_funding_id: f.id,
    p_expected_version: f.version,
    p_approve: true,
    p_amount_tzs: amount,
    p_reason: null,
    p_idempotency_key: randomUUID(),
  });

const provide = (who: Fixture, f: Funding, amount: number) =>
  rpc(who, "admin_record_imprest_provided", {
    p_funding_id: f.id,
    p_expected_version: f.version,
    p_amount_tzs: amount,
    p_idempotency_key: randomUUID(),
  });

const confirm = (who: Fixture, f: Funding, key = randomUUID()) =>
  rpc(who, "staff_confirm_imprest_received", {
    p_funding_id: f.id,
    p_expected_version: f.version,
    p_handover_id: f.handover_id,
    p_idempotency_key: key,
  });

const mismatch = (who: Fixture, f: Funding, counted: number) =>
  rpc(who, "staff_report_imprest_mismatch", {
    p_funding_id: f.id,
    p_expected_version: f.version,
    p_handover_id: f.handover_id,
    p_counted_tzs: counted,
    p_note: null,
    p_idempotency_key: randomUUID(),
  });

const correct = (who: Fixture, f: Funding, amount: number) =>
  rpc(who, "admin_resolve_imprest_mismatch", {
    p_funding_id: f.id,
    p_expected_version: f.version,
    p_amount_tzs: amount,
    p_explanation: "Recounted at the gate",
    p_idempotency_key: randomUUID(),
  });

async function posted(): Promise<number> {
  const { data, error } = await director.read
    .from("imprest_funding_position")
    .select("posted_funding_tzs");
  if (error) throw new Error(error.message);
  return data.length === 0 ? 0 : Number(data[0].posted_funding_tzs);
}

/** A funding driven to `provided` at the given amounts, ready for the Manager's answer. */
async function providedFunding(approved: number, handed: number): Promise<Funding> {
  const requested = await request(manager, approved);
  const approvedResult = await approve(director, requested.funding!, approved);
  const providedResult = await provide(secondDirector, approvedResult.funding!, handed);
  expect(providedResult.reason).toBe("provided");
  return providedResult.funding!;
}

beforeAll(async () => {
  director = await ensureDirector();
  secondDirector = await createLiveStaff(director, "director", "Second Director");
  manager = await createLiveStaff(director, "manager", "Imprest Manager");
  secondManager = await createLiveStaff(director, "manager", "Second Imprest Manager");
  cashier = await createLiveStaff(director, "cashier");
  salesRep = await createLiveStaff(director, "sales_rep");
});

describe("concurrent first requests", () => {
  it("open exactly one fund, and every request joins it", async () => {
    // First in this file on purpose: no other integration file touches imprest, so no fund
    // exists yet and these requests genuinely race to open it.
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => request(i % 2 === 0 ? manager : secondManager, 10000 + i)),
    );

    expect(results.map((r) => r.reason)).toEqual(Array(6).fill("requested"));
    expect(new Set(results.map((r) => r.funding!.fund_id)).size).toBe(1);

    const { data: funds, error } = await director.read.from("imprest_funds").select("id").eq("is_active", true);
    expect(error).toBeNull();
    expect(funds).toHaveLength(1);
  });

  it("replay one request when the same key arrives six times at once", async () => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 6 }, () => request(manager, 45000, key)));

    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.reason === "requested")).toHaveLength(1);
    expect(new Set(results.map((r) => r.funding!.id)).size).toBe(1);
  });
});

describe("the funding lifecycle over HTTP", () => {
  it("posts only the confirmed handover, exactly once", async () => {
    const before = await posted();
    const requested = await request(manager, 100000);
    const approved = await approve(director, requested.funding!, 80000);
    expect(await posted()).toBe(before);

    const provided = await provide(secondDirector, approved.funding!, 70000);
    expect(await posted()).toBe(before);

    const key = randomUUID();
    const received = await confirm(manager, provided.funding!, key);
    expect(received.reason).toBe("received");
    expect(await confirm(manager, provided.funding!, key)).toMatchObject({ ok: true, reason: "replayed" });
    expect(await posted()).toBe(before + 70000);
  });

  it("keeps a shortage, its correction and the final confirmation apart", async () => {
    const before = await posted();
    const provided = await providedFunding(80000, 80000);

    const disputed = await mismatch(manager, provided, 75000);
    expect(disputed.reason).toBe("mismatch_reported");
    expect(await posted()).toBe(before);

    // The screen the Manager had open before the mismatch can no longer confirm.
    expect((await confirm(manager, provided)).reason).toBe("stale");

    const corrected = await correct(director, disputed.funding!, 75000);
    expect(corrected.reason).toBe("handover_corrected");
    expect(await posted()).toBe(before);

    expect((await confirm(manager, corrected.funding!)).reason).toBe("received");
    expect(await posted()).toBe(before + 75000);

    const { data: handovers } = await cashier.read
      .from("imprest_funding_handovers")
      .select("cycle, amount_tzs")
      .eq("funding_id", provided.id)
      .order("cycle");
    expect(handovers).toEqual([
      { cycle: 1, amount_tzs: 80000 },
      { cycle: 2, amount_tzs: 75000 },
    ]);
  });
});

describe("commands arriving together", () => {
  it("let exactly one of two Directors decide a request", async () => {
    const requested = (await request(manager, 30000)).funding!;
    const [a, b] = await Promise.all([
      approve(director, requested, 30000),
      rpc(secondDirector, "admin_decide_imprest_funding", {
        p_funding_id: requested.id,
        p_expected_version: requested.version,
        p_approve: false,
        p_amount_tzs: null,
        p_reason: "Not this week",
        p_idempotency_key: randomUUID(),
      }),
    ]);

    const reasons = [a.reason, b.reason].sort();
    expect(reasons.filter((r) => r === "approved" || r === "rejected")).toHaveLength(1);
    expect(reasons).toContain("stale");
  });

  it("serialise a confirmation racing a mismatch, and post at most once", async () => {
    const before = await posted();
    const provided = await providedFunding(60000, 60000);

    const [confirmed, disputed] = await Promise.all([
      confirm(manager, provided),
      mismatch(secondManager, provided, 50000),
    ]);

    const winners = [confirmed, disputed].filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    expect([confirmed, disputed].find((r) => !r.ok)!.reason).toBe("stale");
    expect(await posted()).toBe(before + (confirmed.ok ? 60000 : 0));
  });

  it("refuse a stale confirmation sent while the dispute is being corrected", async () => {
    const before = await posted();
    const provided = await providedFunding(60000, 60000);
    const disputed = (await mismatch(manager, provided, 55000)).funding!;

    const [stale, corrected] = await Promise.all([
      confirm(manager, provided),
      correct(director, disputed, 55000),
    ]);
    expect(stale.reason).toBe("stale");
    expect(corrected.reason).toBe("handover_corrected");
    expect(await posted()).toBe(before);
  });
});

describe("authority and reads", () => {
  it("refuses a Manager deactivated after signing in", async () => {
    const doomed = await createLiveStaff(director, "manager", "Deactivated Imprest Manager");
    const { data } = await director.api.rpc("admin_set_account_active", {
      p_target_user_id: doomed.userId,
      p_is_active: false,
    });
    expect(data.ok).toBe(true);
    await expect(request(doomed, 10000)).rejects.toThrow();
  });

  it("refuses a Manager whose role changed after signing in", async () => {
    const provided = await providedFunding(20000, 20000);
    const demoted = await createLiveStaff(director, "manager", "Demoted Imprest Manager");
    const { data } = await director.api.rpc("admin_change_user_role", {
      p_target_user_id: demoted.userId,
      p_role: "cashier",
    });
    expect(data.ok).toBe(true);
    await expect(confirm(demoted, provided)).rejects.toThrow();
  });

  it("refuses a Director confirming receipt, and a Manager approving", async () => {
    const provided = await providedFunding(20000, 20000);
    await expect(confirm(director, provided)).rejects.toThrow();
    const requested = (await request(manager, 20000)).funding!;
    await expect(approve(manager, requested, 20000)).rejects.toThrow();
  });

  it("shows a Sales Representative no funding and no total", async () => {
    for (const view of ["imprest_fundings", "imprest_funding_summaries", "imprest_funding_position"]) {
      const { data, error } = await salesRep.read.from(view).select("*");
      expect(error).toBeNull();
      expect(data, view).toEqual([]);
    }
  });

  it("lets a Cashier read the history under the imprest read policy", async () => {
    const { data, error } = await cashier.read.from("imprest_funding_summaries").select("id");
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
  });

  it("refuses direct table writes by a signed-in Manager and Director", async () => {
    const provided = await providedFunding(20000, 20000);
    const insert = await fetch(`${SUPABASE_URL}/rest/v1/imprest_funding_handovers`, {
      method: "POST",
      headers: {
        apikey: PUBLISHABLE_KEY,
        Authorization: `Bearer ${manager.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ funding_id: provided.id, cycle: 9, amount_tzs: 1, provided_by: manager.userId }),
    });
    expect(insert.status).toBeGreaterThanOrEqual(400);

    const patch = await fetch(`${SUPABASE_URL}/rest/v1/imprest_fundings?id=eq.${provided.id}`, {
      method: "PATCH",
      headers: {
        apikey: PUBLISHABLE_KEY,
        Authorization: `Bearer ${director.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "received", received_amount_tzs: 999999 }),
    });
    expect(patch.status).toBeGreaterThanOrEqual(400);

    const { data } = await director.read.from("imprest_fundings").select("status").eq("id", provided.id);
    expect(data).toEqual([{ status: "provided" }]);
  });

  it("gives a leaked secret key neither the commands nor the tables", async () => {
    const provided = await providedFunding(20000, 20000);
    const { status, body } = await callApiRpc(
      "staff_confirm_imprest_received",
      {
        p_funding_id: provided.id,
        p_expected_version: provided.version,
        p_handover_id: provided.handover_id,
        p_idempotency_key: randomUUID(),
      },
      SECRET_KEY,
    );
    expect(status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(body)).not.toMatch(/"ok"\s*:\s*true/);

    const read = await fetch(`${SUPABASE_URL}/rest/v1/imprest_fundings?select=id&limit=1`, {
      headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` },
    });
    expect(read.status).toBeGreaterThanOrEqual(400);
  });
});
