import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  PUBLISHABLE_KEY,
  SECRET_KEY,
  SUPABASE_URL,
  callApiRpc,
  createLiveStaff,
  ensureDirector,
  type Fixture,
} from "@/tests/integration/helpers";

/**
 * Imprest disbursements (issue #55), over real HTTP through PostgREST.
 *
 * pgTAP proves the lifecycle, the set-aside arithmetic and the refusals inside the database. These
 * tests prove what only a real session can: grants and RLS as `authenticated` rather than as the
 * table owner, a leaked secret key, authority that changed after sign-in, and two approvals that
 * genuinely arrive together in separate transactions (AC-104).
 *
 * The fund is shared with every other integration file, so every figure is read before it is
 * relied on and asserted as a DELTA. Files run one at a time, so nothing moves it underneath us.
 */

type Disbursement = {
  id: string;
  fund_id: string;
  status: string;
  version: number;
  amount_tzs: number;
  proposed_by: string;
};
type Result = {
  ok: boolean;
  reason: string;
  disbursement?: Disbursement;
  free_to_approve_tzs?: number;
};
type Position = {
  fund_id: string;
  posted_funding_tzs: number | null;
  set_aside_tzs: number | null;
  free_to_approve_tzs: number;
};

let director: Fixture;
let secondDirector: Fixture;
let manager: Fixture;
let secondManager: Fixture;
let cashier: Fixture;
let secondCashier: Fixture;
let salesRep: Fixture;

async function rpc(who: Fixture, fn: string, args: Record<string, unknown>): Promise<Result> {
  const { data, error } = await who.api.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as Result;
}

async function funding(who: Fixture, fn: string, args: Record<string, unknown>) {
  const { data, error } = await who.api.rpc(fn, { ...args, p_idempotency_key: randomUUID() });
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as {
    ok: boolean;
    reason: string;
    funding: { id: string; version: number; handover_id: string | null };
  };
}

const propose = (who: Fixture, amount: number, key = randomUUID()) =>
  rpc(who, "staff_propose_imprest_disbursement", {
    p_amount_tzs: amount,
    p_category: "fuel_and_lubricants",
    p_purpose: "Generator fuel",
    p_idempotency_key: key,
  });

const decide = (who: Fixture, d: Disbursement, approve: boolean, reason: string | null = null) =>
  rpc(who, "staff_decide_imprest_disbursement", {
    p_id: d.id,
    p_expected_version: d.version,
    p_approve: approve,
    p_reason: reason,
    p_idempotency_key: randomUUID(),
  });

const withdraw = (who: Fixture, d: Disbursement) =>
  rpc(who, "staff_withdraw_imprest_disbursement", {
    p_id: d.id,
    p_expected_version: d.version,
    p_reason: "Bought it myself",
    p_idempotency_key: randomUUID(),
  });

const cancel = (who: Fixture, d: Disbursement) =>
  rpc(who, "staff_cancel_imprest_disbursement", {
    p_id: d.id,
    p_expected_version: d.version,
    p_reason: "No longer needed",
    p_idempotency_key: randomUUID(),
  });

async function position(who: Fixture): Promise<Position> {
  const { data, error } = await who.api.rpc("staff_imprest_spending_position");
  if (error) throw new Error(`position: ${error.message}`);
  const rows = data as Position[];
  if (rows.length !== 1) throw new Error(`expected one active fund, got ${rows.length}`);
  return rows[0];
}

/** Posts a received funding through the whole funding workflow, as the product does it. */
async function postFunding(amount: number): Promise<void> {
  const requested = await funding(manager, "staff_request_imprest_funding", {
    p_amount_tzs: amount,
    p_reason: "Disbursement float",
  });
  const approved = await funding(director, "admin_decide_imprest_funding", {
    p_funding_id: requested.funding.id,
    p_expected_version: requested.funding.version,
    p_approve: true,
    p_amount_tzs: amount,
    p_reason: null,
  });
  const provided = await funding(secondDirector, "admin_record_imprest_provided", {
    p_funding_id: approved.funding.id,
    p_expected_version: approved.funding.version,
    p_amount_tzs: amount,
  });
  const received = await funding(manager, "staff_confirm_imprest_received", {
    p_funding_id: provided.funding.id,
    p_expected_version: provided.funding.version,
    p_handover_id: provided.funding.handover_id,
  });
  if (received.reason !== "received") throw new Error(`funding not received: ${received.reason}`);
}

/**
 * Leaves exactly `target` free to approve: posts funding when there is too little, then sets the
 * surplus aside with one approved filler proposal.
 */
async function leaveFree(target: number): Promise<void> {
  let free = (await position(manager)).free_to_approve_tzs;
  if (free < target) {
    await postFunding(target - free);
    free = target;
  }
  if (free > target) {
    const filler = (await propose(cashier, free - target)).disbursement!;
    expect((await decide(manager, filler, true)).reason).toBe("approved");
  }
  expect((await position(manager)).free_to_approve_tzs).toBe(target);
}

beforeAll(async () => {
  director = await ensureDirector();
  secondDirector = await createLiveStaff(director, "director", "Disbursement Second Director");
  manager = await createLiveStaff(director, "manager", "Disbursement Manager");
  secondManager = await createLiveStaff(director, "manager", "Second Disbursement Manager");
  cashier = await createLiveStaff(director, "cashier", "Disbursement Cashier");
  secondCashier = await createLiveStaff(director, "cashier", "Second Disbursement Cashier");
  salesRep = await createLiveStaff(director, "sales_rep", "Disbursement Sales Rep");

  // Opens the fund if no earlier file did, and gives every test below money to work with.
  await postFunding(200000);
});

describe("two approvals arriving together (AC-104)", () => {
  it("approve exactly one of two 60,000 proposals when 80,000 is free", async () => {
    const a = (await propose(cashier, 60000)).disbursement!;
    const b = (await propose(secondCashier, 60000)).disbursement!;
    await leaveFree(80000);
    const before = await position(director);

    const results = await Promise.all([decide(manager, a, true), decide(secondManager, b, true)]);

    expect(results.filter((r) => r.reason === "approved")).toHaveLength(1);
    const refused = results.find((r) => !r.ok)!;
    expect(refused).toMatchObject({ reason: "insufficient_imprest", free_to_approve_tzs: 20000 });

    const after = await position(director);
    expect(after.set_aside_tzs).toBe(before.set_aside_tzs! + 60000);
    expect(after.free_to_approve_tzs).toBe(20000);
    expect(after.posted_funding_tzs).toBe(before.posted_funding_tzs);

    // The refused proposal is still waiting, unchanged, for another decision.
    const { data } = await manager.read.from("imprest_disbursements").select("status, version").in("id", [a.id, b.id]);
    expect(data!.map((row) => row.status).sort()).toEqual(["approved", "proposed"]);
  });

  it("let exactly one of two Managers decide the same proposal", async () => {
    const proposed = (await propose(cashier, 1000)).disbursement!;
    const [approve, reject] = await Promise.all([
      decide(manager, proposed, true),
      decide(secondManager, proposed, false, "Not this week"),
    ]);

    const reasons = [approve.reason, reject.reason];
    expect(reasons.filter((r) => r === "approved" || r === "rejected")).toHaveLength(1);
    expect(reasons).toContain("stale");
  });

  it("replay one proposal when the same key arrives six times at once", async () => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 6 }, () => propose(cashier, 4500, key)));

    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.reason === "proposed")).toHaveLength(1);
    expect(new Set(results.map((r) => r.disbursement!.id)).size).toBe(1);
  });
});

describe("the lifecycle over HTTP", () => {
  it("sets money aside on approval only, and frees it on cancellation", async () => {
    const start = await position(manager);
    const proposed = (await propose(cashier, 15000)).disbursement!;
    expect((await position(manager)).set_aside_tzs).toBe(start.set_aside_tzs);

    const approved = await decide(manager, proposed, true);
    expect(approved.reason).toBe("approved");
    expect((await position(manager)).set_aside_tzs).toBe(start.set_aside_tzs! + 15000);

    // The screen the Manager had open before approving can no longer act on the row.
    expect((await cancel(manager, proposed)).reason).toBe("stale");

    const cancelled = await cancel(manager, approved.disbursement!);
    expect(cancelled.reason).toBe("cancelled");
    expect(await position(manager)).toEqual(start);
  });

  it("sets nothing aside for a rejection or a withdrawal", async () => {
    const start = await position(manager);
    const rejected = (await propose(cashier, 5000)).disbursement!;
    expect((await decide(manager, rejected, false)).reason).toBe("reason_required");
    expect((await decide(manager, rejected, false, "Use the petty cash")).reason).toBe("rejected");

    const withdrawn = (await propose(cashier, 6000)).disbursement!;
    expect((await withdraw(cashier, withdrawn)).reason).toBe("withdrawn");

    expect(await position(manager)).toEqual(start);
  });
});

describe("authority", () => {
  it("refuses a Cashier deactivated after signing in", async () => {
    const doomed = await createLiveStaff(director, "cashier", "Deactivated Disbursement Cashier");
    const { data } = await director.api.rpc("admin_set_account_active", {
      p_target_user_id: doomed.userId,
      p_is_active: false,
    });
    expect(data.ok).toBe(true);
    await expect(propose(doomed, 1000)).rejects.toThrow();
  });

  it("refuses a Cashier whose role changed after signing in", async () => {
    const moved = await createLiveStaff(director, "cashier", "Moved Disbursement Cashier");
    const own = (await propose(moved, 1000)).disbursement!;
    const { data } = await director.api.rpc("admin_change_user_role", {
      p_target_user_id: moved.userId,
      p_role: "sales_rep",
    });
    expect(data.ok).toBe(true);
    await expect(propose(moved, 1000)).rejects.toThrow();
    await expect(withdraw(moved, own)).rejects.toThrow();
  });

  it("refuses a Manager whose role changed after signing in", async () => {
    const proposed = (await propose(cashier, 1000)).disbursement!;
    const demoted = await createLiveStaff(director, "manager", "Demoted Disbursement Manager");
    const { data } = await director.api.rpc("admin_change_user_role", {
      p_target_user_id: demoted.userId,
      p_role: "cashier",
    });
    expect(data.ok).toBe(true);
    await expect(decide(demoted, proposed, true)).rejects.toThrow();
  });

  it("keeps each command to its own role", async () => {
    const proposed = (await propose(cashier, 1000)).disbursement!;
    await expect(propose(manager, 1000)).rejects.toThrow();
    await expect(decide(director, proposed, true)).rejects.toThrow();
    await expect(decide(cashier, proposed, true)).rejects.toThrow();

    const approved = (await decide(manager, proposed, true)).disbursement!;
    await expect(cancel(director, approved)).rejects.toThrow();
    await expect(cancel(cashier, approved)).rejects.toThrow();
    expect((await cancel(manager, approved)).reason).toBe("cancelled");
  });

  it("answers another Cashier's proposal exactly as a missing one", async () => {
    const theirs = (await propose(cashier, 1000)).disbursement!;
    expect(await withdraw(secondCashier, theirs)).toEqual({ ok: false, reason: "no_disbursement" });
    expect(await withdraw(secondCashier, { ...theirs, id: randomUUID() })).toEqual({
      ok: false,
      reason: "no_disbursement",
    });
  });
});

describe("reads", () => {
  it("shows a Director and the Manager every figure, and a Cashier only Free to approve", async () => {
    const full = await position(director);
    expect(full.posted_funding_tzs).toBeGreaterThan(0);
    expect(full.free_to_approve_tzs).toBe(full.posted_funding_tzs! - full.set_aside_tzs!);
    expect(await position(manager)).toEqual(full);

    expect(await position(cashier)).toEqual({
      fund_id: full.fund_id,
      posted_funding_tzs: null,
      set_aside_tzs: null,
      free_to_approve_tzs: full.free_to_approve_tzs,
    });
  });

  it("gives a Sales Representative neither the figures nor a single disbursement", async () => {
    await expect(position(salesRep)).rejects.toThrow();
    const { data, error } = await salesRep.read.from("imprest_disbursements").select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("shows a Cashier only their own disbursements, and the Manager and a Director all of them", async () => {
    const mine = (await propose(cashier, 1000)).disbursement!;
    const theirs = (await propose(secondCashier, 1000)).disbursement!;

    const { data: own } = await cashier.read.from("imprest_disbursements").select("proposed_by");
    expect(own!.length).toBeGreaterThan(0);
    expect(new Set(own!.map((row) => row.proposed_by))).toEqual(new Set([cashier.userId]));

    for (const reader of [manager, director]) {
      const { data } = await reader.read.from("imprest_disbursements").select("id").in("id", [mine.id, theirs.id]);
      expect(data, reader.role).toHaveLength(2);
    }
  });
});

describe("writes outside the commands", () => {
  const headers = (token: string) => ({
    apikey: PUBLISHABLE_KEY,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  });

  it("refuses direct inserts, updates and deletes by every signed-in role", async () => {
    const proposed = (await propose(cashier, 1000)).disbursement!;

    const insert = await fetch(`${SUPABASE_URL}/rest/v1/imprest_disbursements`, {
      method: "POST",
      headers: headers(cashier.accessToken),
      body: JSON.stringify({
        disbursement_no: "FV-DSB-FAKE",
        fund_id: proposed.fund_id,
        amount_tzs: 1,
        category: "other",
        purpose: "Forged",
        proposed_by: cashier.userId,
      }),
    });
    expect(insert.status).toBeGreaterThanOrEqual(400);

    const patch = await fetch(`${SUPABASE_URL}/rest/v1/imprest_disbursements?id=eq.${proposed.id}`, {
      method: "PATCH",
      headers: headers(manager.accessToken),
      body: JSON.stringify({ status: "approved", approved_by: manager.userId, version: 2 }),
    });
    expect(patch.status).toBeGreaterThanOrEqual(400);

    const remove = await fetch(`${SUPABASE_URL}/rest/v1/imprest_disbursements?id=eq.${proposed.id}`, {
      method: "DELETE",
      headers: headers(director.accessToken),
    });
    expect(remove.status).toBeGreaterThanOrEqual(400);

    const { data } = await director.read.from("imprest_disbursements").select("status, version").eq("id", proposed.id);
    expect(data).toEqual([{ status: "proposed", version: 1 }]);
  });

  it("gives a leaked secret key neither the commands nor the table", async () => {
    const proposed = (await propose(cashier, 1000)).disbursement!;

    for (const [fn, args] of [
      ["staff_propose_imprest_disbursement", { p_amount_tzs: 1000, p_category: "other", p_purpose: "Leaked" }],
      ["staff_decide_imprest_disbursement", { p_id: proposed.id, p_expected_version: 1, p_approve: true, p_reason: null }],
      ["staff_imprest_spending_position", {}],
    ] as const) {
      const body = fn === "staff_imprest_spending_position" ? args : { ...args, p_idempotency_key: randomUUID() };
      const response = await callApiRpc(fn, body, SECRET_KEY);
      expect(response.status, fn).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(response.body)).not.toMatch(/"ok"\s*:\s*true/);
    }

    const read = await fetch(`${SUPABASE_URL}/rest/v1/imprest_disbursements?select=id&limit=1`, {
      headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` },
    });
    expect(read.status).toBeGreaterThanOrEqual(400);

    const { data } = await director.read.from("imprest_disbursements").select("status").eq("id", proposed.id);
    expect(data).toEqual([{ status: "proposed" }]);
  });
});
