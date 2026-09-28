import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { businessDate } from "@/lib/time/business-date";
import {
  SECRET_KEY,
  SUPABASE_URL,
  callApiRpc,
  createLiveStaff,
  ensureDirector,
  type Fixture,
} from "@/tests/integration/helpers";

/**
 * The daily count (issue #68), over real HTTP through PostgREST.
 *
 * pgTAP proves every rule inside one rolled-back transaction, and moves its business clock to prove
 * Balanced, Shortage and Excess on three days. These tests commit, so the deferred checks run at
 * COMMIT, and they prove what only real requests can: authority that changed after sign-in, a leaked
 * secret key, two Cashiers or two Managers racing, and a confirmation racing a send-back.
 *
 * A business day takes one confirmed count, and the integration files share one database and one
 * day. So this file is one day, in order: counts, recounts and races first, then the one
 * confirmation and everything that follows from it. No other file enters a count.
 */

type Count = {
  id: string;
  business_date: string;
  attempt: number;
  counted_tzs: number;
  expected_tzs: number;
  variance_tzs: number;
  status: string;
  version: number;
};
type Result = { ok: boolean; reason: string; count?: Count; [key: string]: unknown };
type Position = {
  posted_balance_tzs: number | null;
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

const today = businessDate();

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

/** Expected cash as the Manager's figures stand now: posted balance minus awaiting verification. */
async function expectedCash(): Promise<number> {
  const p = await position(manager);
  return Number(p.posted_balance_tzs) - Number(p.awaiting_verification_tzs);
}

const enter = (who: Fixture, previous: string | null, counted: number, key = randomUUID(), note: string | null = null) =>
  rpc(who, "staff_enter_imprest_count", {
    p_business_date: today,
    p_previous_count_id: previous,
    p_counted_tzs: counted,
    p_note: note,
    p_idempotency_key: key,
  });

const sendBack = (who: Fixture, c: Count, reason = "Count the coins again", key = randomUUID()) =>
  rpc(who, "staff_send_back_imprest_count", {
    p_id: c.id,
    p_expected_version: c.version,
    p_reason: reason,
    p_idempotency_key: key,
  });

const confirm = (who: Fixture, c: Count, explanation: string | null, note: string | null = null, key = randomUUID()) =>
  rpc(who, "staff_confirm_imprest_count", {
    p_id: c.id,
    p_expected_version: c.version,
    p_explanation: explanation,
    p_note: note,
    p_idempotency_key: key,
  });

async function funding(who: Fixture, fn: string, args: Record<string, unknown>) {
  const result = await rpc(who, fn, { ...args, p_idempotency_key: randomUUID() });
  return result as unknown as { reason: string; funding: { id: string; version: number; handover_id: string } };
}

async function postFunding(amount: number): Promise<void> {
  const requested = await funding(manager, "staff_request_imprest_funding", {
    p_amount_tzs: amount,
    p_reason: "Daily count float",
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

async function auditRows(entityId: string | null, action: string) {
  let query = director.read
    .from("audit_events")
    .select("actor_id, actor_role, action, source_operation, after_state, correlation_id")
    .eq("entity_type", "imprest_count")
    .eq("action", action);
  query = entityId === null ? query.is("entity_id", null) : query.eq("entity_id", entityId);
  const { data, error } = await query;
  if (error) throw new Error(`audit: ${error.message}`);
  return data ?? [];
}

beforeAll(async () => {
  director = await ensureDirector();
  secondDirector = await createLiveStaff(director, "director", "Second Count Director");
  manager = await createLiveStaff(director, "manager", "Count Manager");
  secondManager = await createLiveStaff(director, "manager", "Second Count Manager");
  cashier = await createLiveStaff(director, "cashier", "Count Cashier");
  secondCashier = await createLiveStaff(director, "cashier", "Second Count Cashier");
  salesRep = await createLiveStaff(director, "sales_rep", "Count Rep");
  await postFunding(250_000);
});

describe("one business day of counting, over HTTP", () => {
  let first: Count;
  let second: Count;
  let standing: Count;
  let expected: number;
  let before: Position;

  it("refuses a count from anybody but a live Cashier", async () => {
    for (const who of [director, manager, salesRep]) {
      const { error } = await who.api.rpc("staff_enter_imprest_count", {
        p_business_date: today,
        p_previous_count_id: null,
        p_counted_tzs: 1000,
        p_note: null,
        p_idempotency_key: randomUUID(),
      });
      expect(error?.message, who.role).toMatch(/may not perform this command/);
    }

    const leaving = await createLiveStaff(director, "cashier", "Leaving Count Cashier");
    const { data } = await director.api.rpc("admin_set_account_active", {
      p_target_user_id: leaving.userId,
      p_is_active: false,
    });
    expect((data as Result).ok).toBe(true);
    const { error } = await leaving.api.rpc("staff_enter_imprest_count", {
      p_business_date: today,
      p_previous_count_id: null,
      p_counted_tzs: 1000,
      p_note: null,
      p_idempotency_key: randomUUID(),
    });
    expect(error?.message).toMatch(/may not perform this command/);

    const response = await callApiRpc(
      "staff_enter_imprest_count",
      {
        p_business_date: today,
        p_previous_count_id: null,
        p_counted_tzs: 1000,
        p_note: null,
        p_idempotency_key: randomUUID(),
      },
      SECRET_KEY,
    );
    expect(response.status).toBeGreaterThanOrEqual(400);

    const { data: counts } = await manager.read.from("imprest_counts").select("id");
    expect(counts).toEqual([]);
  });

  it("refuses yesterday's date and a bad amount, and records each refusal", async () => {
    const yesterday = businessDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const late = await rpc(cashier, "staff_enter_imprest_count", {
      p_business_date: yesterday,
      p_previous_count_id: null,
      p_counted_tzs: 1000,
      p_note: null,
      p_idempotency_key: randomUUID(),
    });
    expect(late).toMatchObject({ ok: false, reason: "day_changed", business_date: today });
    expect((await enter(cashier, null, -5)).reason).toBe("amount_invalid");

    const refusals = await auditRows(null, "command_refused");
    const reasons = refusals
      .filter((row) => row.actor_id === cashier.userId)
      .map((row) => (row.after_state as { reason: string }).reason);
    expect(reasons).toEqual(expect.arrayContaining(["day_changed", "amount_invalid"]));
    expect(refusals.every((row) => row.actor_role === "cashier" && row.correlation_id)).toBe(true);
  });

  it("lets exactly one of two Cashiers counting at once enter the day's count", async () => {
    expected = await expectedCash();
    before = await position(manager);
    const results = await Promise.all([
      enter(cashier, null, expected - 1500, randomUUID(), "Notes and coins"),
      enter(secondCashier, null, expected - 1500),
    ]);
    const reasons = results.map((r) => r.reason).sort();
    expect(reasons).toEqual(["count_awaiting_confirmation", "counted"]);
    first = results.find((r) => r.reason === "counted")!.count!;
    expect(first).toMatchObject({
      business_date: today,
      attempt: 1,
      expected_tzs: expected,
      variance_tzs: -1500,
      status: "awaiting_confirmation",
      version: 1,
    });
    // The command does not send the posted balance behind expected cash back to the Cashier.
    expect(first).not.toHaveProperty("posted_balance_tzs");
    expect(first).not.toHaveProperty("awaiting_verification_tzs");
  });

  it("refuses a confirmation from a Director or the Cashier, and a stale version", async () => {
    for (const who of [director, cashier]) {
      const { error } = await who.api.rpc("staff_confirm_imprest_count", {
        p_id: first.id,
        p_expected_version: first.version,
        p_explanation: "counting_error",
        p_note: null,
        p_idempotency_key: randomUUID(),
      });
      expect(error?.message, who.role).toMatch(/may not perform this command/);
    }
    expect((await confirm(manager, { ...first, version: 2 }, "counting_error")).reason).toBe("stale");
    expect((await confirm(manager, first, null)).reason).toBe("explanation_required");
    expect((await sendBack(manager, first, "no")).reason).toBe("reason_required");
  });

  it("lets exactly one of two Managers send the same count back", async () => {
    const key = randomUUID();
    const results = await Promise.all([
      sendBack(manager, first, "Coins not counted", key),
      sendBack(secondManager, first, "Coins not counted"),
    ]);
    const winners = results.filter((r) => r.reason === "sent_back");
    expect(winners).toHaveLength(1);
    expect(results.map((r) => r.reason)).toEqual(
      expect.arrayContaining(["sent_back", expect.stringMatching(/^(stale|not_awaiting_confirmation)$/)]),
    );
    // A retry of the Manager's own request with its key replays when it won.
    if (results[0].reason === "sent_back") {
      expect((await sendBack(manager, first, "Coins not counted", key)).reason).toBe("replayed");
    }
    const { data } = await manager.read.from("imprest_count_returns").select("count_id").eq("count_id", first.id);
    expect(data).toHaveLength(1);
  });

  it("makes the Cashier count again, naming the count it replaces", async () => {
    expect((await enter(cashier, null, expected)).reason).toBe("stale");
    const key = randomUUID();
    const again = await enter(cashier, first.id, expected - 2500, key);
    expect(again.reason).toBe("counted");
    second = again.count!;
    expect(second).toMatchObject({ attempt: 2, variance_tzs: -2500, status: "awaiting_confirmation" });
    expect((await enter(cashier, first.id, expected - 2500, key)).reason).toBe("replayed");
    expect((await enter(cashier, first.id, expected - 2400, key)).reason).toBe("idempotency_key_conflict");
  });

  it("lets a confirmation or a send-back win when they race, never both", async () => {
    const results = await Promise.all([
      confirm(manager, second, "counting_error"),
      sendBack(secondManager, second, "Racing the confirmation"),
    ]);
    const won = results.filter((r) => r.reason === "confirmed" || r.reason === "sent_back");
    expect(won).toHaveLength(1);

    if (won[0].reason === "confirmed") {
      standing = won[0].count!;
    } else {
      // The send-back won: the Cashier counts a third time and the Manager confirms that.
      const third = await enter(cashier, second.id, expected - 2500);
      expect(third.reason).toBe("counted");
      const confirmed = await confirm(manager, third.count!, "counting_error");
      expect(confirmed.reason).toBe("confirmed");
      standing = confirmed.count!;
    }
    expect(standing).toMatchObject({ status: "confirmed", variance_tzs: -2500 });
  });

  it("posts the shortage, lowering the posted balance and Free to approve, and waits for a Director", async () => {
    const after = await position(manager);
    expect(Number(after.posted_balance_tzs)).toBe(Number(before.posted_balance_tzs) - 2500);
    expect(Number(after.free_to_approve_tzs)).toBe(Number(before.free_to_approve_tzs) - 2500);
    expect(await expectedCash()).toBe(expected - 2500);

    const { data } = await manager.read
      .from("imprest_count_postings")
      .select("kind, amount_tzs, needs_director_decision")
      .eq("count_id", standing.id);
    expect(data).toEqual([{ kind: "count_shortage", amount_tzs: 2500, needs_director_decision: true }]);
    const { data: confirmation } = await manager.read
      .from("imprest_count_confirmations")
      .select("outcome, variance_tzs, explanation")
      .eq("count_id", standing.id);
    expect(confirmation).toEqual([{ outcome: "shortage", variance_tzs: -2500, explanation: "counting_error" }]);
  });

  it("raises a flag both Directors read, and nobody else", async () => {
    for (const who of [director, secondDirector]) {
      const { data, error } = await who.read
        .from("imprest_count_flags")
        .select("kind, amount_tzs, business_date")
        .eq("count_id", standing.id);
      expect(error).toBeNull();
      expect(data, who.role).toEqual([{ kind: "count_shortage", amount_tzs: 2500, business_date: today }]);
    }
    for (const who of [manager, cashier, salesRep]) {
      const { data } = await who.read.from("imprest_count_flags").select("id");
      expect(data, who.role).toEqual([]);
    }
  });

  it("closes the day", async () => {
    expect((await enter(cashier, standing.id, expected)).reason).toBe("already_confirmed");
    expect((await sendBack(manager, standing)).reason).toBe("not_awaiting_confirmation");
  });

  it("shows every count of the day, withholding the posted balance from the Cashier", async () => {
    const { data: forCashier, error } = await cashier.api.rpc("staff_imprest_counts", {
      p_limit: 30,
      p_offset: 0,
    });
    expect(error).toBeNull();
    const rows = forCashier as { id: string; posted_balance_tzs: number | null; status: string }[];
    expect(rows[0]).toMatchObject({ id: standing.id, status: "confirmed", posted_balance_tzs: null });
    expect(rows.map((r) => r.status)).toContain("sent_back");

    const { data: forDirector } = await director.api.rpc("staff_imprest_counts", { p_limit: 30, p_offset: 0 });
    const top = (forDirector as { posted_balance_tzs: number; outcome: string; total: number }[])[0];
    expect(top.outcome).toBe("shortage");
    expect(Number(top.posted_balance_tzs)).toBe(Number(before.posted_balance_tzs));
    expect(Number(top.total)).toBe(rows.length);

    const { error: repError } = await salesRep.api.rpc("staff_imprest_counts", { p_limit: 30, p_offset: 0 });
    expect(repError?.message).toMatch(/may not perform this command/);
  });

  it("records every success with its actor, live role and correlation id", async () => {
    const entered = await auditRows(standing.id, "imprest_count_entered");
    expect(entered).toEqual([
      expect.objectContaining({ actor_id: cashier.userId, actor_role: "cashier", correlation_id: expect.any(String) }),
    ]);
    const confirmed = await auditRows(standing.id, "imprest_count_confirmed");
    expect(confirmed).toEqual([
      expect.objectContaining({
        actor_role: "manager",
        source_operation: "api.staff_confirm_imprest_count",
        after_state: expect.objectContaining({ outcome: "shortage", variance_tzs: -2500, flagged_to_directors: true }),
      }),
    ]);
    const sentBack = await auditRows(first.id, "imprest_count_sent_back");
    expect(sentBack).toHaveLength(1);
  });

  it("refuses direct writes to every count table by every signed-in role", async () => {
    for (const who of [director, manager, cashier]) {
      const change = await who.read
        .from("imprest_counts")
        .update({ counted_tzs: expected })
        .eq("id", standing.id)
        .select();
      expect(change.error?.message, who.role).toMatch(/permission denied/);
      for (const table of ["imprest_count_confirmations", "imprest_count_postings", "imprest_count_flags"]) {
        const remove = await who.read.from(table).delete().eq("count_id", standing.id).select();
        expect(remove.error?.message, `${who.role} ${table}`).toMatch(/permission denied/);
      }
    }
    const service = await fetch(`${SUPABASE_URL}/rest/v1/imprest_counts?select=id`, {
      headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` },
    });
    expect(service.status).toBeGreaterThanOrEqual(400);
  });
});
