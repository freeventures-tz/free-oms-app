import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { createLiveStaff, ensureDirector, type Fixture } from "@/tests/integration/helpers";

/**
 * Reversals (issue #71), over real HTTP through PostgREST.
 *
 * pgTAP proves every rule inside one rolled-back transaction. These tests commit, so they prove what
 * only real requests can: the deferred completeness checks at COMMIT, the reads the screens make
 * (the detail embed and the Directors' waiting list with its sort column), authority as PostgREST
 * sees it, a lost answer replayed by its key, and the races that matter for money: two Directors
 * deciding one request, and an approval racing a payment approval for the last free shillings.
 *
 * The fund is shared with every other integration file, so every figure is read first and asserted
 * as a change.
 */

type Disbursement = { id: string; version: number };
type Result = {
  ok: boolean;
  reason: string;
  disbursement?: Disbursement;
  reversal?: { id: string; status: string; version: number; correct_tzs: number };
  [key: string]: unknown;
};
type Position = { posted_balance_tzs: number; set_aside_tzs: number; free_to_approve_tzs: number };
type PostingRow = { id: string; kind: string; entry: string; amount_tzs: number; corrects_posting_id: string | null };

let director: Fixture;
let secondDirector: Fixture;
let manager: Fixture;
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
    p_reason: "Reversal float",
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

async function approvedPayment(who: Fixture, amount: number): Promise<Disbursement> {
  const made = await rpc(who, "staff_propose_imprest_disbursement", {
    p_amount_tzs: amount,
    p_category: "transport_and_delivery",
    p_purpose: "Trip allowance",
    p_idempotency_key: randomUUID(),
  });
  const approved = await rpc(manager, "staff_decide_imprest_disbursement", {
    p_id: made.disbursement!.id,
    p_expected_version: made.disbursement!.version,
    p_approve: true,
    p_reason: null,
    p_idempotency_key: randomUUID(),
  });
  return approved.disbursement!;
}

/** A payment settled as Used `used`, Returned `returned`, the rest unexplained, and verified. */
async function verified(who: Fixture, amount: number, used: number, returned: number): Promise<string> {
  const approved = await approvedPayment(who, amount);
  const out = await rpc(who, "staff_hand_out_imprest_disbursement", {
    p_id: approved.id,
    p_expected_version: approved.version,
    p_recipient: "Juma the driver",
    p_idempotency_key: randomUUID(),
  });
  const settled = await rpc(who, "staff_settle_imprest_disbursement", {
    p_id: approved.id,
    p_expected_version: out.disbursement!.version,
    p_lines: [
      { amount_tzs: used, purpose: "Fare", receipt_id: null, no_receipt_reason: "transport_fare", no_receipt_note: null },
    ],
    p_returned_tzs: returned,
    p_explanation: amount - used - returned > 0 ? "Change lost on the road" : null,
    p_idempotency_key: randomUUID(),
  });
  const { data: s } = await manager.read
    .from("imprest_settlements")
    .select("id")
    .eq("disbursement_id", approved.id)
    .single();
  const done = await rpc(manager, "staff_verify_imprest_disbursement", {
    p_id: approved.id,
    p_expected_version: settled.disbursement!.version,
    p_settlement_id: s!.id,
    p_idempotency_key: randomUUID(),
  });
  expect(done.reason).toBe("verified");
  return approved.id;
}

async function postings(id: string): Promise<PostingRow[]> {
  const { data, error } = await manager.read
    .from("imprest_postings")
    .select("id, kind, entry, amount_tzs, corrects_posting_id")
    .eq("disbursement_id", id)
    .order("posted_at")
    .order("entry");
  if (error) throw new Error(`postings: ${error.message}`);
  return (data ?? []).map((p) => ({ ...p, amount_tzs: Number(p.amount_tzs) })) as PostingRow[];
}

const original = async (id: string, kind: string) =>
  (await postings(id)).find((p) => p.kind === kind && p.entry === "original")!;

const request = (who: Fixture, postingId: string, correct: number, key = randomUUID()) =>
  who.api.rpc("staff_request_imprest_reversal", {
    p_posting_id: postingId,
    p_correct_tzs: correct,
    p_reason: "Receipt shows a different figure",
    p_idempotency_key: key,
  });

const decide = (who: Fixture, reversalId: string, version: number, approve: boolean, key = randomUUID()) =>
  who.api.rpc("admin_decide_imprest_reversal", {
    p_reversal_id: reversalId,
    p_expected_version: version,
    p_approve: approve,
    p_reason: approve ? null : "Not enough evidence",
    p_idempotency_key: key,
  });

async function answer(call: ReturnType<typeof request>): Promise<string> {
  const { data, error } = await call;
  if (error) return `error:${error.code ?? error.message}`;
  return (data as Result).reason;
}

async function ok(call: ReturnType<typeof request>): Promise<Result> {
  const { data, error } = await call;
  if (error) throw new Error(error.message);
  const result = data as Result;
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result;
}

beforeAll(async () => {
  director = await ensureDirector();
  secondDirector = await createLiveStaff(director, "director", "Reversal Second Director");
  manager = await createLiveStaff(director, "manager", "Reversal Manager");
  cashier = await createLiveStaff(director, "cashier", "Reversal Cashier");
  secondCashier = await createLiveStaff(director, "cashier", "Second Reversal Cashier");
  salesRep = await createLiveStaff(director, "sales_rep", "Reversal Sales Rep");
  await postFunding(500000);
});

describe("an expense corrected after verification, over HTTP", () => {
  it("is asked for, approved by a Director, and posts a reversal and a replacement", async () => {
    const id = await verified(cashier, 60000, 47000, 10000);
    const expense = await original(id, "expense");
    const before = await position(manager);

    const asked = await ok(request(cashier, expense.id, 45000));
    expect(asked.reason).toBe("requested");
    const reversalId = asked.reversal!.id;
    expect(await position(manager)).toEqual(before);

    // The Directors' list reads the request, sorted by the column the screen uses.
    const waiting = await director.read
      .from("imprest_disbursements")
      .select("id, imprest_posting_reversals(id, status, correct_tzs)")
      .not("imprest_disbursement_reversal_requested_at", "is", null)
      .order("imprest_disbursement_reversal_requested_at", { ascending: true });
    expect(waiting.error).toBeNull();
    const row = (waiting.data ?? []).find((r) => r.id === id);
    expect(row?.imprest_posting_reversals).toEqual([{ id: reversalId, status: "requested", correct_tzs: 45000 }]);

    // A lost answer: the same key replays the approval and posts nothing twice.
    const key = randomUUID();
    const approved = await ok(decide(director, reversalId, 1, true, key));
    expect(approved.reason).toBe("approved");
    expect((await ok(decide(director, reversalId, 1, true, key))).reason).toBe("replayed");

    const rows = await postings(id);
    expect(rows.filter((p) => p.entry !== "original")).toEqual([
      expect.objectContaining({ entry: "reversal", kind: "expense", amount_tzs: 47000, corrects_posting_id: expense.id }),
      expect.objectContaining({ entry: "replacement", kind: "expense", amount_tzs: 45000, corrects_posting_id: expense.id }),
    ]);
    const after = await position(manager);
    expect(after.posted_balance_tzs).toBe(before.posted_balance_tzs + 2000);
    expect(after.free_to_approve_tzs).toBe(before.free_to_approve_tzs + 2000);

    // The detail read the screen makes still comes back whole, with every posting and request.
    const detail = await cashier.read
      .from("imprest_disbursements")
      .select("id, imprest_postings(id, entry), imprest_posting_reversals(id, status, decided_by)")
      .eq("id", id)
      .single();
    expect(detail.error).toBeNull();
    // The expense and the 3,000 loss verification posted, then the reversal and the replacement.
    expect(detail.data?.imprest_postings).toHaveLength(4);
    expect(detail.data?.imprest_posting_reversals).toEqual([
      { id: reversalId, status: "approved", decided_by: director.userId },
    ]);

    // The reversed original is closed; its replacement is open to correction.
    expect(await answer(request(cashier, expense.id, 44000))).toBe("already_reversed");
    const replacement = rows.find((p) => p.entry === "replacement")!;
    expect(await answer(request(cashier, replacement.id, 44000))).toBe("requested");
  });
});

describe("who may ask and decide, as PostgREST sees it", () => {
  it("lets the proposing Cashier and the Manager ask, and only a Director decide", async () => {
    const id = await verified(cashier, 20000, 15000, 3000);
    const loss = await original(id, "unexplained_loss");
    expect(loss.amount_tzs).toBe(2000);

    expect(await answer(request(secondCashier, loss.id, 0))).toBe("no_posting");
    expect(await answer(request(salesRep, loss.id, 0))).toBe("error:42501");
    expect(await answer(request(director, loss.id, 0))).toBe("error:42501");

    const asked = await ok(request(manager, loss.id, 0));
    const reversalId = asked.reversal!.id;
    expect(await answer(decide(manager, reversalId, 1, true))).toBe("error:42501");
    expect(await answer(decide(cashier, reversalId, 1, true))).toBe("error:42501");

    // Another Cashier reads nothing of it; a Sales Representative neither.
    for (const who of [secondCashier, salesRep]) {
      const { data } = await who.read.from("imprest_posting_reversals").select("id").eq("id", reversalId);
      expect(data ?? []).toEqual([]);
    }

    const rejected = await ok(decide(secondDirector, reversalId, 1, false));
    expect(rejected.reason).toBe("rejected");
    const { data: row } = await cashier.read
      .from("imprest_posting_reversals")
      .select("status, rejection_reason, decided_by")
      .eq("id", reversalId)
      .single();
    expect(row).toEqual({ status: "rejected", rejection_reason: "Not enough evidence", decided_by: secondDirector.userId });
    expect((await postings(id)).filter((p) => p.entry !== "original")).toEqual([]);
  });
});

describe("races over money", () => {
  it("lets exactly one of two Directors decide a request", async () => {
    const id = await verified(cashier, 30000, 30000, 0);
    const expense = await original(id, "expense");
    const reversalId = (await ok(request(manager, expense.id, 25000))).reversal!.id;

    const answers = await Promise.all([
      answer(decide(director, reversalId, 1, true)),
      answer(decide(secondDirector, reversalId, 1, false)),
    ]);
    expect(answers.filter((a) => a === "approved" || a === "rejected")).toHaveLength(1);
    expect(answers.filter((a) => a === "stale")).toHaveLength(1);
  });

  it("never lets a correction and a payment approval both spend the last free shillings", async () => {
    const id = await verified(cashier, 10000, 10000, 0);
    const expense = await original(id, "expense");
    const { free_to_approve_tzs: free } = await position(manager);

    // A correction that needs everything that is free, and a payment that takes one shilling of it.
    const reversalId = (await ok(request(manager, expense.id, 10000 + free))).reversal!.id;
    const payment = await rpc(cashier, "staff_propose_imprest_disbursement", {
      p_amount_tzs: 1,
      p_category: "transport_and_delivery",
      p_purpose: "One shilling",
      p_idempotency_key: randomUUID(),
    });

    const [correction, approval] = await Promise.all([
      answer(decide(director, reversalId, 1, true)),
      rpc(manager, "staff_decide_imprest_disbursement", {
        p_id: payment.disbursement!.id,
        p_expected_version: payment.disbursement!.version,
        p_approve: true,
        p_reason: null,
        p_idempotency_key: randomUUID(),
      }).then((r) => r.reason),
    ]);
    // Whichever went first, the other found too little free.
    expect([correction, approval].sort()).toEqual(
      correction === "approved" ? ["approved", "insufficient_imprest"] : ["approved", "below_set_aside"],
    );
    expect((await position(manager)).free_to_approve_tzs).toBeGreaterThanOrEqual(0);
  });
});
