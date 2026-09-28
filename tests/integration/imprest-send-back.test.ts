import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { decryptReceipt, encryptReceipt } from "@/lib/imprest/receipt-crypto";
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
 * Send back and settle again (issue #65), over real HTTP: PostgREST for the commands and the real
 * Storage API for receipts filed while a disbursement is sent back.
 *
 * pgTAP proves every rule inside one rolled-back transaction. These tests commit, so the check that
 * a return leaves its disbursement sent back really runs at COMMIT, and they prove what only real
 * requests can: the bucket's policy and trigger as the Storage API applies them during a sent-back
 * cycle, a leaked secret key against it, authority that changed after sign-in, and a send-back
 * racing a verification or another send-back.
 *
 * The fund is shared with every other integration file, so every figure is read first and asserted
 * as a change.
 */

const BUCKET = "imprest-evidence";

type Disbursement = { id: string; fund_id: string; status: string; version: number; amount_tzs: number };
type Result = { ok: boolean; reason: string; disbursement?: Disbursement; [key: string]: unknown };
type Receipt = { id: string; object_path: string; key: string };
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
    p_reason: "Send-back float",
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

async function handedOut(who: Fixture, amount: number): Promise<Disbursement> {
  const proposed = await rpc(who, "staff_propose_imprest_disbursement", {
    p_amount_tzs: amount,
    p_category: "transport_and_delivery",
    p_purpose: "Trip allowance",
    p_idempotency_key: randomUUID(),
  });
  expect(
    (
      await rpc(manager, "staff_decide_imprest_disbursement", {
        p_id: proposed.disbursement!.id,
        p_expected_version: 1,
        p_approve: true,
        p_reason: null,
        p_idempotency_key: randomUUID(),
      })
    ).reason,
  ).toBe("approved");
  const out = await rpc(who, "staff_hand_out_imprest_disbursement", {
    p_id: proposed.disbursement!.id,
    p_expected_version: 2,
    p_recipient: "Juma the driver",
    p_idempotency_key: randomUUID(),
  });
  expect(out.reason).toBe("handed_out");
  return out.disbursement!;
}

async function register(who: Fixture, d: Disbursement, name = "petrol.jpg") {
  const result = await rpc(who, "staff_register_imprest_receipt", {
    p_disbursement_id: d.id,
    p_file_name: name,
    p_content_type: "image/jpeg",
    p_byte_size: 4096,
    p_idempotency_key: randomUUID(),
  });
  expect(result.reason).toBe("registered");
  return result.receipt as Receipt;
}

async function upload(token: string, receipt: Receipt, plain: Uint8Array) {
  const stored = await encryptReceipt(plain.slice().buffer, receipt.key);
  return fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${receipt.object_path}`, {
    method: "POST",
    headers: {
      apikey: PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
    },
    body: stored,
  });
}

const download = (token: string, path: string) =>
  fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/${BUCKET}/${path}`, {
    headers: { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
  });

const line = (amount: number, purpose: string, receipt: string | null, reason: string | null = null) => ({
  amount_tzs: amount,
  purpose,
  receipt_id: receipt,
  no_receipt_reason: reason,
  no_receipt_note: null,
});

const settle = (
  who: Fixture,
  d: Disbursement,
  lines: ReturnType<typeof line>[],
  returned: number,
  explanation: string | null = null,
  key = randomUUID(),
) =>
  rpc(who, "staff_settle_imprest_disbursement", {
    p_id: d.id,
    p_expected_version: d.version,
    p_lines: lines,
    p_returned_tzs: returned,
    p_explanation: explanation,
    p_idempotency_key: key,
  });

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

const sendBack = (who: Fixture, d: Disbursement, settlementId: string, reason = "The receipt is unreadable", key = randomUUID()) =>
  rpc(who, "staff_send_back_imprest_settlement", {
    p_id: d.id,
    p_expected_version: d.version,
    p_settlement_id: settlementId,
    p_reason: reason,
    p_idempotency_key: key,
  });

const verify = (who: Fixture, d: Disbursement, settlementId: string) =>
  rpc(who, "staff_verify_imprest_disbursement", {
    p_id: d.id,
    p_expected_version: d.version,
    p_settlement_id: settlementId,
    p_idempotency_key: randomUUID(),
  });

/** Handed out and settled exactly with one No-receipt line: ready to send back. */
async function settledSimply(amount: number): Promise<{ d: Disbursement; settlementId: string }> {
  const out = await handedOut(cashier, amount);
  const done = await settle(cashier, out, [line(amount, "Fuel", null, "vendor_did_not_issue")], 0);
  expect(done.reason).toBe("settled");
  return { d: done.disbursement!, settlementId: (await latestSettlement(out.id)).id };
}

const photo = () => new Uint8Array(randomBytes(4096));

beforeAll(async () => {
  director = await ensureDirector();
  secondDirector = await createLiveStaff(director, "director", "Send-back Second Director");
  manager = await createLiveStaff(director, "manager", "Send-back Manager");
  secondManager = await createLiveStaff(director, "manager", "Second Send-back Manager");
  cashier = await createLiveStaff(director, "cashier", "Send-back Cashier");
  secondCashier = await createLiveStaff(director, "cashier", "Second Send-back Cashier");
  salesRep = await createLiveStaff(director, "sales_rep", "Send-back Sales Rep");
  await postFunding(400000);
});

describe("a trip sent back and settled again, over HTTP with the real Storage API", () => {
  it("returns cycle 1, files a new receipt while sent back, and verifies cycle 2", async () => {
    const before = await position(manager);
    const out = await handedOut(cashier, 60000);

    const fuel = await register(cashier, out, "fuel.jpg");
    const fuelPhoto = photo();
    expect((await upload(cashier.accessToken, fuel, fuelPhoto)).status).toBe(200);
    const first = await settle(
      cashier,
      out,
      [line(40000, "Fuel", fuel.id), line(7000, "Tolls", null, "transport_fare")],
      10000,
      "Driver cannot say where three thousand went",
    );
    expect(first.reason).toBe("settled");
    const cycle1 = await latestSettlement(out.id);
    expect(cycle1.cycle).toBe(1);
    expect((await position(manager)).awaiting_verification_tzs).toBe(before.awaiting_verification_tzs! + 50000);

    // The Manager sends it back.
    const returned = await sendBack(manager, first.disbursement!, cycle1.id, "The tolls need a receipt");
    expect(returned.reason).toBe("sent_back");
    expect(returned.disbursement!.status).toBe("sent_back");
    const whileBack = await position(manager);
    expect(whileBack.set_aside_tzs).toBe(before.set_aside_tzs! + 60000);
    expect(whileBack.awaiting_verification_tzs).toBe(before.awaiting_verification_tzs! + 50000);
    expect(whileBack.posted_balance_tzs).toBe(before.posted_balance_tzs);
    expect((await verify(manager, returned.disbursement!, cycle1.id)).reason).toBe("not_settled");

    // The Cashier reads the reason, and files a new receipt through the real Storage API.
    const reason = await cashier.read
      .from("imprest_settlement_returns")
      .select("reason, settlement_id, returned_by")
      .eq("disbursement_id", out.id);
    expect(reason.data).toEqual([
      { reason: "The tolls need a receipt", settlement_id: cycle1.id, returned_by: manager.userId },
    ]);
    const tolls = await register(cashier, returned.disbursement!, "tolls.jpg");
    const tollsPhoto = photo();
    expect((await upload(cashier.accessToken, tolls, tollsPhoto)).status).toBe(200);

    // Nobody else puts a file there, and the secret key neither plants, replaces nor deletes one.
    const spare = await register(cashier, returned.disbursement!, "spare.jpg");
    expect((await upload(secondCashier.accessToken, spare, photo())).status).toBeGreaterThanOrEqual(400);
    const service = { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` };
    const planted = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${spare.object_path}`, {
      method: "POST",
      headers: { ...service, "Content-Type": "application/octet-stream" },
      body: photo(),
    });
    expect(planted.status).toBeGreaterThanOrEqual(400);
    const replaced = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${tolls.object_path}`, {
      method: "PUT",
      headers: { ...service, "Content-Type": "application/octet-stream" },
      body: photo(),
    });
    expect(replaced.status).toBeGreaterThanOrEqual(400);
    const deleted = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
      method: "DELETE",
      headers: { ...service, "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: [fuel.object_path, tolls.object_path] }),
    });
    expect(deleted.status).toBeGreaterThanOrEqual(400);
    const removed = await cashier.read.storage.from(BUCKET).remove([tolls.object_path]);
    expect(removed.data ?? []).toEqual([]);

    // Settling again: the fuel receipt from cycle 1 cited again, and the new tolls receipt.
    const second = await settle(
      cashier,
      returned.disbursement!,
      [line(40000, "Fuel", fuel.id), line(8000, "Tolls", tolls.id)],
      11000,
      "Driver lost a thousand shillings",
    );
    expect(second.reason).toBe("settled");
    const cycle2 = await latestSettlement(out.id);
    expect(cycle2.cycle).toBe(2);
    expect((await position(manager)).awaiting_verification_tzs).toBe(before.awaiting_verification_tzs! + 49000);

    // Once settled again, the bucket takes no more files for it.
    expect((await upload(cashier.accessToken, spare, photo())).status).toBeGreaterThanOrEqual(400);

    // Both receipts open for the Manager with their own keys.
    for (const [receipt, plain] of [
      [fuel, fuelPhoto],
      [tolls, tollsPhoto],
    ] as const) {
      const stored = await (await download(manager.accessToken, receipt.object_path)).arrayBuffer();
      const opened = await rpc(manager, "staff_open_imprest_receipt", { p_receipt_id: receipt.id });
      expect(new Uint8Array(await decryptReceipt(stored, (opened.receipt as Receipt).key))).toEqual(plain);
    }

    // Only the latest cycle is verified.
    expect((await verify(manager, second.disbursement!, cycle1.id)).reason).toBe("settlement_not_latest");
    const verified = await verify(manager, second.disbursement!, cycle2.id);
    expect(verified.reason).toBe("verified");
    const { data: postings } = await manager.read
      .from("imprest_postings")
      .select("kind, amount_tzs, settlement_id")
      .eq("disbursement_id", out.id)
      .order("kind");
    expect(postings).toEqual([
      { kind: "expense", amount_tzs: 48000, settlement_id: cycle2.id },
      { kind: "unexplained_loss", amount_tzs: 1000, settlement_id: cycle2.id },
    ]);
    const after = await position(manager);
    expect(after.posted_balance_tzs).toBe(before.posted_balance_tzs! - 49000);
    expect(after.set_aside_tzs).toBe(before.set_aside_tzs);
    expect(after.awaiting_verification_tzs).toBe(before.awaiting_verification_tzs);

    // The screens' embed reads every cycle and the return.
    const { data, error } = await director.read
      .from("imprest_disbursements")
      .select("status, imprest_settlements(cycle, used_tzs), imprest_settlement_returns(settlement_id, reason)")
      .eq("id", out.id)
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({
      status: "verified",
      imprest_settlement_returns: [{ settlement_id: cycle1.id, reason: "The tolls need a receipt" }],
    });
    expect((data!.imprest_settlements as { cycle: number }[]).map((s) => s.cycle).sort()).toEqual([1, 2]);
  });
});

describe("who may send back", () => {
  it("refuses a Director, the Cashier and a Sales Representative", async () => {
    const { d, settlementId } = await settledSimply(5000);
    for (const who of [director, cashier, salesRep]) {
      const { error } = await who.api.rpc("staff_send_back_imprest_settlement", {
        p_id: d.id,
        p_expected_version: d.version,
        p_settlement_id: settlementId,
        p_reason: "Not mine to send back",
        p_idempotency_key: randomUUID(),
      });
      expect(error?.message, who.role).toMatch(/may not perform this command|not a live/);
    }
    const { data } = await manager.read.from("imprest_disbursements").select("status").eq("id", d.id);
    expect(data).toEqual([{ status: "settled" }]);
  });

  it("refuses a Manager deactivated after signing in", async () => {
    const leaving = await createLiveStaff(director, "manager", "Leaving Send-back Manager");
    const { d, settlementId } = await settledSimply(4000);
    const { data } = await director.api.rpc("admin_set_account_active", {
      p_target_user_id: leaving.userId,
      p_is_active: false,
    });
    expect((data as Result).ok).toBe(true);
    const { error } = await leaving.api.rpc("staff_send_back_imprest_settlement", {
      p_id: d.id,
      p_expected_version: d.version,
      p_settlement_id: settlementId,
      p_reason: "Gone already",
      p_idempotency_key: randomUUID(),
    });
    expect(error?.message).toMatch(/may not perform this command/);
  });

  it("keeps settling again to the proposing Cashier", async () => {
    const { d, settlementId } = await settledSimply(3000);
    const back = await sendBack(manager, d, settlementId);
    expect(back.reason).toBe("sent_back");
    expect((await settle(secondCashier, back.disbursement!, [], 3000)).reason).toBe("no_disbursement");
    const { error } = await manager.api.rpc("staff_settle_imprest_disbursement", {
      p_id: d.id,
      p_expected_version: back.disbursement!.version,
      p_lines: [],
      p_returned_tzs: 3000,
      p_explanation: null,
      p_idempotency_key: randomUUID(),
    });
    expect(error?.message).toMatch(/may not perform this command/);
    expect((await settle(cashier, back.disbursement!, [], 3000)).reason).toBe("settled");
  });

  it("gives a leaked secret key no send-back", async () => {
    const { d, settlementId } = await settledSimply(2000);
    const response = await callApiRpc(
      "staff_send_back_imprest_settlement",
      {
        p_id: d.id,
        p_expected_version: d.version,
        p_settlement_id: settlementId,
        p_reason: "Secret key",
        p_idempotency_key: randomUUID(),
      },
      SECRET_KEY,
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("stale, repeated and concurrent requests", () => {
  it("refuses a stale version and a missing reason, replays the same request and refuses a changed retry", async () => {
    const { d, settlementId } = await settledSimply(6000);
    expect((await rpc(manager, "staff_send_back_imprest_settlement", {
      p_id: d.id,
      p_expected_version: d.version - 1,
      p_settlement_id: settlementId,
      p_reason: "Too late",
      p_idempotency_key: randomUUID(),
    })).reason).toBe("stale");
    expect((await sendBack(manager, d, settlementId, "  ")).reason).toBe("reason_required");

    const key = randomUUID();
    expect((await sendBack(manager, d, settlementId, "Which fuel station?", key)).reason).toBe("sent_back");
    expect((await sendBack(manager, d, settlementId, "Which fuel station?", key)).reason).toBe("replayed");
    expect((await sendBack(manager, d, settlementId, "Another reason", key)).reason).toBe("idempotency_key_conflict");
    const { data } = await manager.read.from("imprest_settlement_returns").select("id").eq("disbursement_id", d.id);
    expect(data).toHaveLength(1);
  });

  it("lets exactly one of two Managers send back the same cycle", async () => {
    const { d, settlementId } = await settledSimply(7000);
    const results = await Promise.all([sendBack(manager, d, settlementId), sendBack(secondManager, d, settlementId)]);
    expect(results.map((r) => r.reason).sort()).toEqual(["sent_back", "stale"]);
    const { data } = await manager.read.from("imprest_settlement_returns").select("id").eq("disbursement_id", d.id);
    expect(data).toHaveLength(1);
  });

  it("lets either a send-back or a verification win when they race, never both", async () => {
    for (let round = 0; round < 3; round++) {
      const { d, settlementId } = await settledSimply(2500);
      const [back, verified] = await Promise.all([
        sendBack(manager, d, settlementId),
        verify(secondManager, d, settlementId),
      ]);
      expect([back.reason, verified.reason].sort()).toContain("stale");
      const { data } = await manager.read.from("imprest_disbursements").select("status").eq("id", d.id).single();
      const { data: returns } = await manager.read.from("imprest_settlement_returns").select("id").eq("disbursement_id", d.id);
      const { data: postings } = await manager.read.from("imprest_postings").select("id").eq("disbursement_id", d.id);
      if (back.reason === "sent_back") {
        expect(data!.status).toBe("sent_back");
        expect(postings).toHaveLength(0);
      } else {
        expect(data!.status).toBe("verified");
        expect(returns).toHaveLength(0);
      }
    }
  });
});

describe("reads and direct writes", () => {
  it("shows the return to the Manager, Directors and its own Cashier, and to nobody else", async () => {
    const { d, settlementId } = await settledSimply(1500);
    expect((await sendBack(manager, d, settlementId, "Name the shop")).reason).toBe("sent_back");
    for (const who of [manager, director, cashier]) {
      const { data } = await who.read.from("imprest_settlement_returns").select("reason").eq("disbursement_id", d.id);
      expect(data, who.role).toEqual([{ reason: "Name the shop" }]);
    }
    for (const who of [secondCashier, salesRep]) {
      const { data } = await who.read.from("imprest_settlement_returns").select("reason").eq("disbursement_id", d.id);
      expect(data, who.role).toEqual([]);
    }
  });

  it("orders the sent-back list by when each was sent back", async () => {
    const first = await settledSimply(1100);
    const second = await settledSimply(1200);
    // Sent back in the opposite order to settling, so the order proves which moment it sorts by.
    expect((await sendBack(manager, second.d, second.settlementId)).reason).toBe("sent_back");
    expect((await sendBack(manager, first.d, first.settlementId)).reason).toBe("sent_back");
    const { data, error } = await manager.read
      .from("imprest_disbursements")
      .select("id")
      .eq("status", "sent_back")
      .order("imprest_disbursement_sent_back_at", { ascending: true })
      .order("id");
    expect(error).toBeNull();
    const ids = (data ?? []).map((row) => row.id);
    expect(ids.indexOf(second.d.id)).toBeLessThan(ids.indexOf(first.d.id));
  });

  it("refuses direct writes to a return by every signed-in role", async () => {
    const { d, settlementId } = await settledSimply(1300);
    expect((await sendBack(manager, d, settlementId, "Original reason")).reason).toBe("sent_back");
    for (const who of [manager, director, cashier]) {
      const change = await who.read
        .from("imprest_settlement_returns")
        .update({ reason: "Rewritten" })
        .eq("disbursement_id", d.id)
        .select();
      expect(change.error?.message, who.role).toMatch(/permission denied/);
      const add = await who.read.from("imprest_settlement_returns").insert({
        disbursement_id: d.id,
        settlement_id: settlementId,
        reason: "Planted",
        returned_by: who.userId,
      });
      expect(add.error, who.role).not.toBeNull();
    }
    const service = await fetch(`${SUPABASE_URL}/rest/v1/imprest_settlement_returns?select=id`, {
      headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` },
    });
    expect(service.status).toBeGreaterThanOrEqual(400);
    const { data } = await manager.read.from("imprest_settlement_returns").select("reason").eq("disbursement_id", d.id);
    expect(data).toEqual([{ reason: "Original reason" }]);
  });
});
