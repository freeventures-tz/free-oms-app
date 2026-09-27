import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { createLiveStaff, ensureDirector, type Fixture } from "@/tests/integration/helpers";

/**
 * The Manager verifies a settled payment (issue #64), over real HTTP through PostgREST.
 *
 * pgTAP proves the postings, the figures and every refusal inside one rolled-back transaction.
 * These tests commit, so the check that a verification carries its postings really runs at COMMIT,
 * and they prove what only real sessions can: grants and row-level security as `authenticated`,
 * authority that changed after sign-in, and two verifications, or a verification and an approval,
 * genuinely arriving together in separate transactions.
 *
 * The fund is shared with every other integration file, so every figure is read first and asserted
 * as a change.
 */

type Disbursement = { id: string; fund_id: string; status: string; version: number; amount_tzs: number };
type Result = { ok: boolean; reason: string; disbursement?: Disbursement; [key: string]: unknown };
type Position = {
  posted_funding_tzs: number | null;
  posted_balance_tzs: number | null;
  set_aside_tzs: number | null;
  free_to_approve_tzs: number;
  awaiting_verification_tzs: number | null;
};
type Settled = { disbursement: Disbursement; settlementId: string };

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

async function position(who: Fixture): Promise<Position> {
  const { data, error } = await who.api.rpc("staff_imprest_spending_position");
  if (error) throw new Error(`position: ${error.message}`);
  return (data as Position[])[0];
}

async function funding(who: Fixture, fn: string, args: Record<string, unknown>) {
  const result = await rpc(who, fn, { ...args, p_idempotency_key: randomUUID() });
  return result as unknown as { reason: string; funding: { id: string; version: number; handover_id: string } };
}

async function postFunding(amount: number): Promise<void> {
  const requested = await funding(manager, "staff_request_imprest_funding", {
    p_amount_tzs: amount,
    p_reason: "Verification float",
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

const propose = (who: Fixture, amount: number) =>
  rpc(who, "staff_propose_imprest_disbursement", {
    p_amount_tzs: amount,
    p_category: "transport_and_delivery",
    p_purpose: "Trip allowance",
    p_idempotency_key: randomUUID(),
  });

const approve = (who: Fixture, d: Disbursement) =>
  rpc(who, "staff_decide_imprest_disbursement", {
    p_id: d.id,
    p_expected_version: d.version,
    p_approve: true,
    p_reason: null,
    p_idempotency_key: randomUUID(),
  });

const noReceipt = (amount: number, purpose: string) => ({
  amount_tzs: amount,
  purpose,
  receipt_id: null,
  no_receipt_reason: "vendor_did_not_issue",
  no_receipt_note: null,
});

/** Proposed by `who`, approved, handed out and settled with no-receipt lines. */
async function settled(
  who: Fixture,
  amount: number,
  used: number[],
  returned: number,
  explanation: string | null = null,
): Promise<Settled> {
  const proposed = (await propose(who, amount)).disbursement!;
  expect((await approve(manager, proposed)).reason).toBe("approved");
  const out = await rpc(who, "staff_hand_out_imprest_disbursement", {
    p_id: proposed.id,
    p_expected_version: 2,
    p_recipient: "Juma the driver",
    p_idempotency_key: randomUUID(),
  });
  expect(out.reason).toBe("handed_out");
  const done = await rpc(who, "staff_settle_imprest_disbursement", {
    p_id: proposed.id,
    p_expected_version: 3,
    p_lines: used.map((value, i) => noReceipt(value, `Line ${i + 1}`)),
    p_returned_tzs: returned,
    p_explanation: explanation,
    p_idempotency_key: randomUUID(),
  });
  expect(done.reason).toBe("settled");
  const { data, error } = await manager.read
    .from("imprest_settlements")
    .select("id")
    .eq("disbursement_id", proposed.id)
    .single();
  if (error) throw new Error(`settlement: ${error.message}`);
  return { disbursement: done.disbursement!, settlementId: String(data.id) };
}

const verify = (who: Fixture, s: Settled, key = randomUUID(), version = s.disbursement.version) =>
  rpc(who, "staff_verify_imprest_disbursement", {
    p_id: s.disbursement.id,
    p_expected_version: version,
    p_settlement_id: s.settlementId,
    p_idempotency_key: key,
  });

async function postings(who: Fixture, id: string) {
  const { data, error } = await who.read
    .from("imprest_postings")
    .select("kind, amount_tzs, needs_director_decision")
    .eq("disbursement_id", id)
    .order("kind");
  if (error) throw new Error(`postings: ${error.message}`);
  return data;
}

/** Leaves exactly `target` free to approve, posting funding or setting the surplus aside. */
async function leaveFree(target: number): Promise<void> {
  let free = (await position(manager)).free_to_approve_tzs;
  if (free < target) {
    await postFunding(target - free);
    free = target;
  }
  if (free > target) {
    const filler = (await propose(cashier, free - target)).disbursement!;
    expect((await approve(manager, filler)).reason).toBe("approved");
  }
  expect((await position(manager)).free_to_approve_tzs).toBe(target);
}

beforeAll(async () => {
  director = await ensureDirector();
  secondDirector = await createLiveStaff(director, "director", "Verification Second Director");
  manager = await createLiveStaff(director, "manager", "Verification Manager");
  secondManager = await createLiveStaff(director, "manager", "Second Verification Manager");
  cashier = await createLiveStaff(director, "cashier", "Verification Cashier");
  secondCashier = await createLiveStaff(director, "cashier", "Second Verification Cashier");
  salesRep = await createLiveStaff(director, "sales_rep", "Verification Sales Rep");
  await postFunding(400000);
});

describe("the worked example over HTTP", () => {
  it("posts Used and the loss, and frees only what came back", async () => {
    const before = await position(manager);
    const trip = await settled(cashier, 60000, [40000, 7000], 10000, "Driver cannot say where it went");

    const settledAt = await position(manager);
    expect(settledAt.set_aside_tzs).toBe(before.set_aside_tzs! + 60000);
    expect(settledAt.free_to_approve_tzs).toBe(before.free_to_approve_tzs - 60000);
    expect(settledAt.awaiting_verification_tzs).toBe(before.awaiting_verification_tzs! + 50000);
    expect(settledAt.posted_balance_tzs).toBe(before.posted_balance_tzs);

    const verified = await verify(manager, trip);
    expect(verified.reason).toBe("verified");
    expect(verified.disbursement!.status).toBe("verified");

    const after = await position(manager);
    expect(after.posted_funding_tzs).toBe(before.posted_funding_tzs);
    expect(after.posted_balance_tzs).toBe(before.posted_balance_tzs! - 50000);
    expect(after.set_aside_tzs).toBe(before.set_aside_tzs);
    expect(after.free_to_approve_tzs).toBe(before.free_to_approve_tzs - 50000);
    expect(after.awaiting_verification_tzs).toBe(before.awaiting_verification_tzs);
    // Expected cash moves by exactly the cash that left the tin and did not come back.
    expect(after.posted_balance_tzs! - after.awaiting_verification_tzs!).toBe(
      before.posted_balance_tzs! - before.awaiting_verification_tzs! - 50000,
    );

    expect(await postings(manager, trip.disbursement.id)).toEqual([
      { kind: "expense", amount_tzs: 47000, needs_director_decision: false },
      { kind: "unexplained_loss", amount_tzs: 3000, needs_director_decision: true },
    ]);
  });

  it("reads back through the embeds the screens use", async () => {
    const trip = await settled(cashier, 20000, [20000], 0);
    expect((await verify(manager, trip)).reason).toBe("verified");

    const { data, error } = await manager.read
      .from("imprest_disbursements")
      .select(
        "id, status, imprest_disbursement_handouts(recipient), imprest_settlements(id, cycle, used_tzs), " +
          "imprest_verifications(settlement_id, verified_by, verified_at), imprest_postings(kind, amount_tzs)",
      )
      .eq("id", trip.disbursement.id)
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({
      status: "verified",
      imprest_disbursement_handouts: { recipient: "Juma the driver" },
      imprest_settlements: [{ id: trip.settlementId, cycle: 1, used_tzs: 20000 }],
      imprest_verifications: { settlement_id: trip.settlementId, verified_by: manager.userId },
      imprest_postings: [{ kind: "expense", amount_tzs: 20000 }],
    });
  });
});

describe("who may verify", () => {
  it("refuses a Director, the Cashier and a Sales Representative", async () => {
    const trip = await settled(cashier, 5000, [5000], 0);
    for (const who of [director, cashier, salesRep]) {
      const { error } = await who.api.rpc("staff_verify_imprest_disbursement", {
        p_id: trip.disbursement.id,
        p_expected_version: trip.disbursement.version,
        p_settlement_id: trip.settlementId,
        p_idempotency_key: randomUUID(),
      });
      expect(error?.message, who.role).toMatch(/may not perform this command|not a live/);
    }
    const { data } = await manager.read.from("imprest_disbursements").select("status").eq("id", trip.disbursement.id);
    expect(data).toEqual([{ status: "settled" }]);
  });

  it("refuses a Manager deactivated after signing in", async () => {
    const leaving = await createLiveStaff(director, "manager", "Leaving Verification Manager");
    const trip = await settled(cashier, 4000, [4000], 0);
    const { data } = await director.api.rpc("admin_set_account_active", {
      p_target_user_id: leaving.userId,
      p_is_active: false,
    });
    expect((data as Result).ok).toBe(true);
    const { error } = await leaving.api.rpc("staff_verify_imprest_disbursement", {
      p_id: trip.disbursement.id,
      p_expected_version: trip.disbursement.version,
      p_settlement_id: trip.settlementId,
      p_idempotency_key: randomUUID(),
    });
    expect(error?.message).toMatch(/may not perform this command/);
  });

  it("lets the Cashier read their own verified payment and its postings, and nobody else's", async () => {
    const trip = await settled(cashier, 6000, [5000], 0, "Lost a coin purse");
    expect((await verify(manager, trip)).reason).toBe("verified");

    const own = await cashier.read.from("imprest_disbursements").select("status").eq("id", trip.disbursement.id);
    expect(own.data).toEqual([{ status: "verified" }]);
    expect(await postings(cashier, trip.disbursement.id)).toHaveLength(2);
    expect(await postings(secondCashier, trip.disbursement.id)).toEqual([]);
    expect(await postings(salesRep, trip.disbursement.id)).toEqual([]);
    expect(await postings(director, trip.disbursement.id)).toHaveLength(2);

    const seen = await position(cashier);
    expect(seen.posted_balance_tzs).toBeNull();
    expect(seen.posted_funding_tzs).toBeNull();
    expect(seen.set_aside_tzs).toBeNull();
    expect(seen.awaiting_verification_tzs).toBeNull();
  });

  it("gives no client a way to write or change a posting", async () => {
    const trip = await settled(cashier, 3000, [3000], 0);
    expect((await verify(manager, trip)).reason).toBe("verified");
    const change = await manager.read
      .from("imprest_postings")
      .update({ amount_tzs: 1 })
      .eq("disbursement_id", trip.disbursement.id)
      .select();
    expect(change.error?.message).toMatch(/permission denied/);
    const add = await manager.read.from("imprest_postings").insert({
      verification_id: randomUUID(),
      disbursement_id: trip.disbursement.id,
      settlement_id: trip.settlementId,
      fund_id: trip.disbursement.fund_id,
      kind: "expense",
      amount_tzs: 1,
      needs_director_decision: false,
    });
    expect(add.error).not.toBeNull();
    expect(await postings(manager, trip.disbursement.id)).toEqual([
      { kind: "expense", amount_tzs: 3000, needs_director_decision: false },
    ]);
  });
});

describe("stale and repeated requests", () => {
  it("refuses a stale version, replays the same request and refuses a changed retry", async () => {
    const trip = await settled(cashier, 8000, [8000], 0);
    expect((await verify(manager, trip, randomUUID(), trip.disbursement.version - 1)).reason).toBe("stale");

    const key = randomUUID();
    expect((await verify(manager, trip, key)).reason).toBe("verified");
    expect((await verify(manager, trip, key)).reason).toBe("replayed");
    expect((await verify(manager, trip, key, trip.disbursement.version + 1)).reason).toBe("idempotency_key_conflict");
    expect((await verify(manager, trip)).reason).toBe("stale");
    expect(await postings(manager, trip.disbursement.id)).toHaveLength(1);
  });
});

describe("verifications arriving together", () => {
  it("lets exactly one of two Managers verify the same settlement, and posts once", async () => {
    const trip = await settled(cashier, 30000, [25000], 3000, "Two thousand short");
    const before = await position(director);

    const results = await Promise.all([verify(manager, trip), verify(secondManager, trip)]);
    expect(results.map((r) => r.reason).sort()).toEqual(["stale", "verified"]);

    expect(await postings(director, trip.disbursement.id)).toEqual([
      { kind: "expense", amount_tzs: 25000, needs_director_decision: false },
      { kind: "unexplained_loss", amount_tzs: 2000, needs_director_decision: true },
    ]);
    const after = await position(director);
    expect(after.posted_balance_tzs).toBe(before.posted_balance_tzs! - 27000);
    expect(after.free_to_approve_tzs).toBe(before.free_to_approve_tzs + 3000);
  });

  it("replays one verification when the same key arrives six times at once", async () => {
    const trip = await settled(cashier, 7000, [7000], 0);
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 6 }, () => verify(manager, trip, key)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.reason === "verified")).toHaveLength(1);
    expect(await postings(manager, trip.disbursement.id)).toHaveLength(1);
  });

  it("never lets an approval racing a verification pass Free to approve", async () => {
    // 10,000 comes back when the trip is verified. An approval of free + 10,000 can pass only if the
    // verification commits first; one shilling more can never pass.
    for (let round = 0; round < 3; round++) {
      await leaveFree(30000);
      const trip = await settled(cashier, 25000, [15000], 10000);
      await leaveFree(5000);
      const fits = (await propose(secondCashier, 15000)).disbursement!;
      const tooBig = (await propose(secondCashier, 15001)).disbursement!;

      const [verified, approval, refused] = await Promise.all([
        verify(secondManager, trip),
        approve(manager, fits),
        approve(manager, tooBig),
      ]);

      expect(verified.reason).toBe("verified");
      expect(refused.reason).toBe("insufficient_imprest");
      const after = await position(manager);
      expect(after.free_to_approve_tzs).toBeGreaterThanOrEqual(0);
      if (approval.reason === "approved") {
        expect(after.free_to_approve_tzs).toBe(0);
      } else {
        expect(approval.reason).toBe("insufficient_imprest");
        expect(after.free_to_approve_tzs).toBe(15000);
      }
      expect(await postings(manager, trip.disbursement.id)).toEqual([
        { kind: "expense", amount_tzs: 15000, needs_director_decision: false },
      ]);
    }
  });
});
