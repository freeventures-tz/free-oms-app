import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createLiveStaff,
  ensureDirector,
  type Fixture,
} from "@/tests/integration/helpers";

/**
 * Raised approvals (issue #70), over real HTTP through PostgREST.
 *
 * pgTAP proves every rule inside one rolled-back transaction. These tests commit, so they prove what
 * only real requests can: the deferred settlement checks at COMMIT, the reads the screens make
 * (the calculated approved amount and the waiting list's sort column), authority as PostgREST sees
 * it, a lost answer replayed by its key, and the races that matter for money: two Managers deciding
 * one request, and a raise racing an approval for the last free shillings.
 *
 * The fund is shared with every other integration file, so every figure is read first and asserted
 * as a change.
 */

type Disbursement = { id: string; fund_id: string; status: string; version: number; amount_tzs: number };
type Result = {
  ok: boolean;
  reason: string;
  disbursement?: Disbursement;
  raise?: { id: string; status: string; amount_tzs: number };
  [key: string]: unknown;
};
type Position = {
  posted_balance_tzs: number | null;
  set_aside_tzs: number | null;
  free_to_approve_tzs: number;
  awaiting_verification_tzs: number | null;
};

let director: Fixture;
let secondDirector: Fixture;
let manager: Fixture;
let secondManager: Fixture;
let cashier: Fixture;
let secondCashier: Fixture;
let salesRep: Fixture;

async function call(who: Fixture, fn: string, args: Record<string, unknown>) {
  return who.api.rpc(fn, args);
}

async function rpc(who: Fixture, fn: string, args: Record<string, unknown>): Promise<Result> {
  const { data, error } = await call(who, fn, args);
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
    p_reason: "Raise float",
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

async function proposed(who: Fixture, amount: number): Promise<Disbursement> {
  const result = await rpc(who, "staff_propose_imprest_disbursement", {
    p_amount_tzs: amount,
    p_category: "transport_and_delivery",
    p_purpose: "Trip allowance",
    p_idempotency_key: randomUUID(),
  });
  expect(result.reason).toBe("proposed");
  return result.disbursement!;
}

const approve = (d: Disbursement) =>
  rpc(manager, "staff_decide_imprest_disbursement", {
    p_id: d.id,
    p_expected_version: d.version,
    p_approve: true,
    p_reason: null,
    p_idempotency_key: randomUUID(),
  });

async function handedOut(who: Fixture, amount: number): Promise<Disbursement> {
  const made = await proposed(who, amount);
  const approved = await approve(made);
  expect(approved.reason).toBe("approved");
  const out = await rpc(who, "staff_hand_out_imprest_disbursement", {
    p_id: made.id,
    p_expected_version: approved.disbursement!.version,
    p_recipient: "Juma the driver",
    p_idempotency_key: randomUUID(),
  });
  expect(out.reason).toBe("handed_out");
  return out.disbursement!;
}

const ask = (
  who: Fixture,
  d: Disbursement,
  amount: number,
  reason = "The road toll rose",
  key = randomUUID(),
) =>
  call(who, "staff_request_imprest_raise", {
    p_id: d.id,
    p_expected_version: d.version,
    p_amount_tzs: amount,
    p_reason: reason,
    p_idempotency_key: key,
  });

const decide = (
  who: Fixture,
  d: Disbursement,
  raiseId: string,
  raise: boolean,
  reason: string | null = null,
  key = randomUUID(),
) =>
  call(who, "staff_decide_imprest_raise", {
    p_id: d.id,
    p_expected_version: d.version,
    p_raise_id: raiseId,
    p_raise: raise,
    p_reason: reason,
    p_idempotency_key: key,
  });

const giveOut = (who: Fixture, d: Disbursement, raiseId: string, recipient = "Juma the driver", key = randomUUID()) =>
  call(who, "staff_hand_out_imprest_raise", {
    p_id: d.id,
    p_expected_version: d.version,
    p_raise_id: raiseId,
    p_recipient: recipient,
    p_idempotency_key: key,
  });

const settle = (who: Fixture, d: Disbursement, amount: number, returned: number, key = randomUUID()) =>
  rpc(who, "staff_settle_imprest_disbursement", {
    p_id: d.id,
    p_expected_version: d.version,
    p_lines: [
      { amount_tzs: amount, purpose: "Fare", receipt_id: null, no_receipt_reason: "transport_fare", no_receipt_note: null },
    ],
    p_returned_tzs: returned,
    p_explanation: null,
    p_idempotency_key: key,
  });

/** An answer that succeeded, or a failure the test can read. PostgREST returns a refusal as data. */
async function ok(answer: ReturnType<typeof ask>): Promise<Result> {
  const { data, error } = await answer;
  if (error) throw new Error(error.message);
  const result = data as Result;
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result;
}

async function refused(answer: ReturnType<typeof ask>): Promise<string> {
  const { data, error } = await answer;
  if (error) return `error:${error.code ?? error.message}`;
  const result = data as Result;
  return result.ok ? "accepted" : result.reason;
}

async function latestSettlement(id: string): Promise<{ id: string; cycle: number }> {
  const { data, error } = await manager.read
    .from("imprest_settlements")
    .select("id, cycle")
    .eq("disbursement_id", id)
    .order("cycle", { ascending: false })
    .limit(1)
    .single();
  if (error) throw new Error(`settlement: ${error.message}`);
  return { id: String(data.id), cycle: Number(data.cycle) };
}

beforeAll(async () => {
  director = await ensureDirector();
  secondDirector = await createLiveStaff(director, "director", "Raise Second Director");
  manager = await createLiveStaff(director, "manager", "Raise Manager");
  secondManager = await createLiveStaff(director, "manager", "Second Raise Manager");
  cashier = await createLiveStaff(director, "cashier", "Raise Cashier");
  secondCashier = await createLiveStaff(director, "cashier", "Second Raise Cashier");
  salesRep = await createLiveStaff(director, "sales_rep", "Raise Sales Rep");
  await postFunding(500000);
});

describe("a trip that cost more than was approved, over HTTP", () => {
  it("asks, is raised, hands out the extra, settles against the raise and is verified", async () => {
    const before = await position(manager);
    const out = await handedOut(cashier, 60000);

    // Asking sets nothing aside.
    const asked = await ok(ask(cashier, out, 20000, "The road toll rose"));
    expect(asked.reason).toBe("requested");
    const requestId = asked.raise!.id;
    const askedD = asked.disbursement!;
    expect(askedD.version).toBe(out.version + 1);
    const afterAsk = await position(manager);
    expect(afterAsk.set_aside_tzs).toBe(before.set_aside_tzs! + 60000);
    expect(afterAsk.awaiting_verification_tzs).toBe(before.awaiting_verification_tzs! + 60000);

    // The Manager's list reads the request, sorted by the column the screen uses.
    const waiting = await manager.read
      .from("imprest_disbursements")
      .select("id, approved_tzs:imprest_disbursement_approved_tzs, imprest_approval_raises(id, status, amount_tzs)")
      .not("imprest_disbursement_raise_requested_at", "is", null)
      .order("imprest_disbursement_raise_requested_at", { ascending: true });
    expect(waiting.error).toBeNull();
    const row = (waiting.data ?? []).find((r) => r.id === out.id);
    expect(Number(row?.approved_tzs)).toBe(60000);
    expect(row?.imprest_approval_raises).toEqual([{ id: requestId, status: "requested", amount_tzs: 20000 }]);

    // Raising sets the increase aside at once. The extra is not yet awaiting verification.
    const raised = await ok(decide(manager, askedD, requestId, true));
    expect(raised.reason).toBe("raised");
    const afterRaise = await position(manager);
    expect(afterRaise.set_aside_tzs).toBe(before.set_aside_tzs! + 80000);
    expect(afterRaise.free_to_approve_tzs).toBe(before.free_to_approve_tzs - 80000);
    expect(afterRaise.awaiting_verification_tzs).toBe(before.awaiting_verification_tzs! + 60000);

    // The approved amount is the calculated sum, and settlement waits for the hand-out.
    const { data: sum } = await manager.read
      .from("imprest_disbursements")
      .select("approved_tzs:imprest_disbursement_approved_tzs")
      .eq("id", out.id)
      .single();
    expect(Number(sum?.approved_tzs)).toBe(80000);
    expect((await settle(cashier, raised.disbursement!, 75000, 5000)).reason).toBe("raise_not_handed_out");

    const extra = await ok(giveOut(cashier, raised.disbursement!, requestId, "Juma the driver"));
    expect(extra.reason).toBe("handed_out");
    expect((await position(manager)).awaiting_verification_tzs).toBe(before.awaiting_verification_tzs! + 80000);

    // Settlement is held to the raised 80,000.
    expect((await settle(cashier, extra.disbursement!, 78000, 5000)).reason).toBe("over_approval");
    const settled = await settle(cashier, extra.disbursement!, 75000, 5000);
    expect(settled.reason).toBe("settled");
    const cycle = await latestSettlement(out.id);
    const { data: recorded } = await manager.read
      .from("imprest_settlements")
      .select("approved_tzs, used_tzs, returned_tzs, unaccounted_tzs")
      .eq("id", cycle.id)
      .single();
    expect(recorded).toEqual({ approved_tzs: 80000, used_tzs: 75000, returned_tzs: 5000, unaccounted_tzs: 0 });

    // Verification posts Used, and only the returned 5,000 comes back to free.
    const verified = await rpc(manager, "staff_verify_imprest_disbursement", {
      p_id: out.id,
      p_expected_version: settled.disbursement!.version,
      p_settlement_id: cycle.id,
      p_idempotency_key: randomUUID(),
    });
    expect(verified.reason).toBe("verified");
    const after = await position(manager);
    expect(after.posted_balance_tzs).toBe(before.posted_balance_tzs! - 75000);
    expect(after.set_aside_tzs).toBe(before.set_aside_tzs);
    expect(after.free_to_approve_tzs).toBe(before.free_to_approve_tzs - 75000);
    expect(after.awaiting_verification_tzs).toBe(before.awaiting_verification_tzs);
  });

  it("keeps a refused request visible and lets the Cashier ask again", async () => {
    const out = await handedOut(cashier, 30000);
    const first = await ok(ask(cashier, out, 10000, "A second delivery"));
    const refusedAnswer = await ok(decide(manager, first.disbursement!, first.raise!.id, false, "Use the money you have"));
    expect(refusedAnswer.reason).toBe("refused");

    const { data } = await director.read
      .from("imprest_approval_raises")
      .select("raise_no, status, amount_tzs, reason, refusal_reason, requested_by, decided_by")
      .eq("disbursement_id", out.id);
    expect(data).toEqual([
      {
        raise_no: 1,
        status: "refused",
        amount_tzs: 10000,
        reason: "A second delivery",
        refusal_reason: "Use the money you have",
        requested_by: cashier.userId,
        decided_by: manager.userId,
      },
    ]);

    const again = await ok(ask(cashier, refusedAnswer.disbursement!, 5000, "Only half then"));
    expect(again.raise!.status).toBe("requested");
    const { data: numbers } = await manager.read
      .from("imprest_approval_raises")
      .select("raise_no")
      .eq("disbursement_id", out.id)
      .order("raise_no");
    expect(numbers).toEqual([{ raise_no: 1 }, { raise_no: 2 }]);
  });

  it("refuses a raise above Free to approve and says how much is free", async () => {
    const before = await position(manager);
    const out = await handedOut(cashier, 20000);
    const asked = await ok(ask(cashier, out, before.free_to_approve_tzs + 1, "Far more than is free"));
    const { data, error } = await decide(manager, asked.disbursement!, asked.raise!.id, true);
    expect(error).toBeNull();
    const answer = data as Result;
    expect(answer.ok).toBe(false);
    expect(answer.reason).toBe("insufficient_imprest");
    expect(answer.free_to_approve_tzs).toBe(before.free_to_approve_tzs - 20000);
    expect((await position(manager)).set_aside_tzs).toBe(before.set_aside_tzs! + 20000);
  });
});

describe("a trip sent back, raised and settled again, over HTTP", () => {
  it("gets a raise while sent back and settles the next cycle against it", async () => {
    const out = await handedOut(cashier, 50000);
    const first = await settle(cashier, out, 50000, 0);
    expect(first.reason).toBe("settled");
    const cycle1 = await latestSettlement(out.id);
    const back = await rpc(manager, "staff_send_back_imprest_settlement", {
      p_id: out.id,
      p_expected_version: first.disbursement!.version,
      p_settlement_id: cycle1.id,
      p_reason: "The fare needs a note",
      p_idempotency_key: randomUUID(),
    });
    expect(back.reason).toBe("sent_back");

    const before = await position(manager);
    const asked = await ok(ask(cashier, back.disbursement!, 8000, "A second toll on the way back"));
    const raised = await ok(decide(manager, asked.disbursement!, asked.raise!.id, true));
    expect((await position(manager)).set_aside_tzs).toBe(before.set_aside_tzs! + 8000);
    expect((await settle(cashier, raised.disbursement!, 58000, 0)).reason).toBe("raise_not_handed_out");
    const extra = await ok(giveOut(cashier, raised.disbursement!, asked.raise!.id));
    // The extra counts beside the returned cycle until the next cycle explains it.
    expect((await position(manager)).awaiting_verification_tzs).toBe(before.awaiting_verification_tzs! + 8000);

    const second = await settle(cashier, extra.disbursement!, 58000, 0);
    expect(second.reason).toBe("settled");
    const cycle2 = await latestSettlement(out.id);
    expect(cycle2.cycle).toBe(2);
    const { data } = await manager.read
      .from("imprest_settlements")
      .select("cycle, approved_tzs")
      .eq("disbursement_id", out.id)
      .order("cycle");
    expect(data).toEqual([
      { cycle: 1, approved_tzs: 50000 },
      { cycle: 2, approved_tzs: 58000 },
    ]);
  });
});

describe("who may raise, over HTTP", () => {
  it("lets only the proposing Cashier ask and only a Manager decide", async () => {
    const out = await handedOut(cashier, 25000);
    expect(await refused(ask(secondCashier, out, 5000))).toBe("no_disbursement");
    for (const who of [manager, director, salesRep]) {
      expect(await refused(ask(who, out, 5000))).toMatch(/^error:/);
    }
    const asked = await ok(ask(cashier, out, 5000));
    for (const who of [cashier, director, secondDirector, salesRep]) {
      expect(await refused(decide(who, asked.disbursement!, asked.raise!.id, true))).toMatch(/^error:/);
    }
    const raised = await ok(decide(secondManager, asked.disbursement!, asked.raise!.id, true));
    expect(raised.reason).toBe("raised");
    for (const who of [secondCashier, manager, director]) {
      expect(await refused(giveOut(who, raised.disbursement!, asked.raise!.id))).toMatch(
        /^error:|no_disbursement/,
      );
    }
    expect((await ok(giveOut(cashier, raised.disbursement!, asked.raise!.id))).reason).toBe("handed_out");
  });

  it("shows raises to Directors and the Manager, to the proposing Cashier only, and to nobody else", async () => {
    const out = await handedOut(cashier, 12000);
    await ok(ask(cashier, out, 3000, "A little more"));
    const readable = async (who: Fixture) => {
      const { data, error } = await who.read.from("imprest_approval_raises").select("id").eq("disbursement_id", out.id);
      expect(error).toBeNull();
      return (data ?? []).length;
    };
    expect(await readable(director)).toBe(1);
    expect(await readable(manager)).toBe(1);
    expect(await readable(cashier)).toBe(1);
    expect(await readable(secondCashier)).toBe(0);
    expect(await readable(salesRep)).toBe(0);
  });

  it("gives no client a way to write a raise", async () => {
    const out = await handedOut(cashier, 12000);
    const asked = await ok(ask(cashier, out, 3000, "A little more"));
    for (const who of [manager, cashier, director]) {
      const inserted = await who.read.from("imprest_approval_raises").insert({
        disbursement_id: out.id,
        raise_no: 9,
        amount_tzs: 1,
        reason: "typed straight in",
        requested_by: who.userId,
      });
      expect(inserted.error).not.toBeNull();
      const updated = await who.read
        .from("imprest_approval_raises")
        .update({ status: "raised" })
        .eq("id", asked.raise!.id)
        .select();
      expect(updated.data ?? []).toEqual([]);
      const removed = await who.read.from("imprest_approval_raises").delete().eq("id", asked.raise!.id).select();
      expect(removed.data ?? []).toEqual([]);
    }
  });
});

describe("a lost answer and a stale screen, over HTTP", () => {
  it("replays a request, a raise and a hand-out by their keys and records each once", async () => {
    const out = await handedOut(cashier, 40000);
    const askKey = randomUUID();
    const first = await ok(ask(cashier, out, 7000, "Extra hire of a trolley", askKey));
    const replay = await ok(ask(cashier, out, 7000, "Extra hire of a trolley", askKey));
    expect(replay.reason).toBe("replayed");
    expect(await refused(ask(cashier, out, 9000, "Extra hire of a trolley", askKey))).toBe("idempotency_key_conflict");

    const raiseKey = randomUUID();
    const raised = await ok(decide(manager, first.disbursement!, first.raise!.id, true, null, raiseKey));
    expect((await ok(decide(manager, first.disbursement!, first.raise!.id, true, null, raiseKey))).reason).toBe("replayed");

    const before = await position(manager);
    const outKey = randomUUID();
    await ok(giveOut(cashier, raised.disbursement!, first.raise!.id, "Juma the driver", outKey));
    expect((await ok(giveOut(cashier, raised.disbursement!, first.raise!.id, "Juma the driver", outKey))).reason).toBe(
      "replayed",
    );
    expect((await position(manager)).awaiting_verification_tzs).toBe(before.awaiting_verification_tzs! + 7000);

    const { data } = await manager.read.from("imprest_approval_raises").select("id").eq("disbursement_id", out.id);
    expect(data).toHaveLength(1);
  });

  it("refuses a screen that showed an older approved amount", async () => {
    const out = await handedOut(cashier, 15000);
    const asked = await ok(ask(cashier, out, 2000, "One more thing"));
    // The screen showed version `out.version`; asking moved it on, so the old screen is refused.
    expect((await settle(cashier, out, 15000, 0)).reason).toBe("stale");
    expect(await refused(ask(cashier, out, 1000, "Stale screen"))).toBe("stale");
    expect(asked.disbursement!.version).toBe(out.version + 1);
  });
});

describe("races that matter for money, over HTTP", () => {
  it("lets one of two Managers raise the same request and records the raise once", async () => {
    const before = await position(manager);
    const out = await handedOut(cashier, 10000);
    const asked = await ok(ask(cashier, out, 4000, "A racing request"));
    const answers = await Promise.all([
      decide(manager, asked.disbursement!, asked.raise!.id, true),
      decide(secondManager, asked.disbursement!, asked.raise!.id, true),
    ]);
    const reasons = answers.map((a) => (a.error ? "error" : (a.data as Result).reason)).sort();
    expect(reasons.filter((r) => r === "raised")).toHaveLength(1);
    expect(reasons.filter((r) => r !== "raised")).toEqual([expect.stringMatching(/stale|no_raise_request/)]);
    expect((await position(manager)).set_aside_tzs).toBe(before.set_aside_tzs! + 14000);
  });

  it("lets a raise and an approval share the last free shillings only once", async () => {
    const out = await handedOut(cashier, 10000);
    const { free_to_approve_tzs: free } = await position(manager);
    // Each fits alone; together they are more than is free.
    const each = Math.floor(free / 2) + 1000;
    const asked = await ok(ask(cashier, out, each, "A large increase"));
    const other = await proposed(secondCashier, each);
    const [raise, approval] = await Promise.all([
      decide(manager, asked.disbursement!, asked.raise!.id, true),
      call(secondManager, "staff_decide_imprest_disbursement", {
        p_id: other.id,
        p_expected_version: other.version,
        p_approve: true,
        p_reason: null,
        p_idempotency_key: randomUUID(),
      }),
    ]);
    const raiseReason = (raise.data as Result).reason;
    const approvalReason = (approval.data as Result).reason;
    const winners = [raiseReason === "raised", approvalReason === "approved"].filter(Boolean);
    expect(winners).toHaveLength(1);
    const loser = raiseReason === "raised" ? approvalReason : raiseReason;
    expect(loser).toBe("insufficient_imprest");
    expect((await position(manager)).free_to_approve_tzs).toBe(free - each);
  });

  it("lets a settlement or a raise win when they race, never a settlement beside an open raise", async () => {
    const out = await handedOut(cashier, 20000);
    const asked = await ok(ask(cashier, out, 3000, "A racing extra"));
    const raised = await ok(decide(manager, asked.disbursement!, asked.raise!.id, true));
    const extra = raised.disbursement!;
    // The extra is not handed out, so a settlement must be refused whatever else runs beside it.
    const [settlement, handout] = await Promise.all([
      settle(cashier, extra, 20000, 0),
      giveOut(cashier, extra, asked.raise!.id),
    ]);
    const handedOutFirst = (handout.data as Result).ok === true;
    if (handedOutFirst) {
      // The hand-out moved the version, so the settlement on the old screen is refused.
      expect(settlement.ok).toBe(false);
    } else {
      expect(settlement.reason).toBe("raise_not_handed_out");
    }
    const { data } = await manager.read
      .from("imprest_settlements")
      .select("approved_tzs")
      .eq("disbursement_id", out.id);
    expect(data ?? []).toEqual([]);
  });
});
