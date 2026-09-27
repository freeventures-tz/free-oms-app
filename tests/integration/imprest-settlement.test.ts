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
 * Imprest hand-out and settlement (issue #62), over real HTTP: PostgREST for the commands and the
 * real Storage API for the receipts.
 *
 * pgTAP proves the settlement equation and every refusal inside one rolled-back transaction, which
 * never reaches COMMIT. These tests commit. That matters here: the check that a settlement's totals
 * match its lines waits for commit. They also prove what only real requests can: storage policies
 * as the Storage API applies them, a leaked secret key against the bucket, authority that changed
 * after sign-in, and the same settlement arriving six times at once.
 *
 * The fund is shared with every other integration file, so every figure is read first and asserted
 * as a change.
 */

const BUCKET = "imprest-evidence";

type Disbursement = { id: string; fund_id: string; status: string; version: number; amount_tzs: number };
type Result = { ok: boolean; reason: string; disbursement?: Disbursement; [key: string]: unknown };
type Receipt = { id: string; object_path: string; key: string; file_name: string; content_type: string };
type Position = {
  posted_funding_tzs: number | null;
  set_aside_tzs: number | null;
  free_to_approve_tzs: number;
  awaiting_verification_tzs: number | null;
};

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
    p_reason: "Settlement float",
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

/** Proposed by `who`, approved by the Manager and handed out: ready to settle. */
async function handedOut(who: Fixture, amount: number): Promise<Disbursement> {
  const proposed = await rpc(who, "staff_propose_imprest_disbursement", {
    p_amount_tzs: amount,
    p_category: "transport_and_delivery",
    p_purpose: "Trip allowance",
    p_idempotency_key: randomUUID(),
  });
  const approved = await rpc(manager, "staff_decide_imprest_disbursement", {
    p_id: proposed.disbursement!.id,
    p_expected_version: 1,
    p_approve: true,
    p_reason: null,
    p_idempotency_key: randomUUID(),
  });
  expect(approved.reason).toBe("approved");
  const out = await rpc(who, "staff_hand_out_imprest_disbursement", {
    p_id: proposed.disbursement!.id,
    p_expected_version: 2,
    p_recipient: "Juma the driver",
    p_idempotency_key: randomUUID(),
  });
  expect(out.reason).toBe("handed_out");
  return out.disbursement!;
}

async function register(who: Fixture, d: Disbursement, name = "petrol.jpg", type = "image/jpeg") {
  const result = await rpc(who, "staff_register_imprest_receipt", {
    p_disbursement_id: d.id,
    p_file_name: name,
    p_content_type: type,
    p_byte_size: 4096,
    p_idempotency_key: randomUUID(),
  });
  expect(result.reason).toBe("registered");
  return result.receipt as Receipt;
}

/** Encrypts `plain` with the receipt's key and uploads it through the Storage API as `token`. */
async function upload(token: string, receipt: Receipt, plain: Uint8Array, extra: Record<string, string> = {}) {
  const stored = await encryptReceipt(plain.slice().buffer, receipt.key);
  return fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${receipt.object_path}`, {
    method: "POST",
    headers: {
      apikey: PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      ...extra,
    },
    body: stored,
  });
}

const download = (token: string, path: string, apikey = PUBLISHABLE_KEY) =>
  fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/${BUCKET}/${path}`, {
    headers: { apikey, Authorization: `Bearer ${token}` },
  });

const line = (amount: number, purpose: string, receipt: string | null, reason: string | null = null, note: string | null = null) => ({
  amount_tzs: amount,
  purpose,
  receipt_id: receipt,
  no_receipt_reason: reason,
  no_receipt_note: note,
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

const photo = () => new Uint8Array(randomBytes(4096));

beforeAll(async () => {
  director = await ensureDirector();
  secondDirector = await createLiveStaff(director, "director", "Settlement Second Director");
  manager = await createLiveStaff(director, "manager", "Settlement Manager");
  cashier = await createLiveStaff(director, "cashier", "Settlement Cashier");
  secondCashier = await createLiveStaff(director, "cashier", "Second Settlement Cashier");
  salesRep = await createLiveStaff(director, "sales_rep", "Settlement Sales Rep");
  await postFunding(500000);
});

describe("the trip allowance over HTTP", () => {
  it("hands out, settles three encrypted receipts with change, and commits", async () => {
    const before = await position(manager);
    const trip = await handedOut(cashier, 60000);

    const afterHandOut = await position(manager);
    expect(afterHandOut.set_aside_tzs).toBe(before.set_aside_tzs! + 60000);
    expect(afterHandOut.awaiting_verification_tzs).toBe(before.awaiting_verification_tzs! + 60000);

    const receipts = [];
    for (const name of ["petrol.jpg", "parking.png", "fine.pdf"]) {
      const receipt = await register(cashier, trip, name, name.endsWith("pdf") ? "application/pdf" : "image/jpeg");
      const response = await upload(cashier.accessToken, receipt, photo());
      expect(response.status, await response.clone().text()).toBe(200);
      receipts.push(receipt);
    }

    const settled = await settle(
      cashier,
      trip,
      [
        line(35000, "Petrol, Dar to Kibaha", receipts[0].id),
        line(2000, "Parking", receipts[1].id),
        line(10000, "Traffic fine", receipts[2].id),
      ],
      13000,
    );
    expect(settled.reason).toBe("settled");

    // A separate request, so the settlement and its deferred totals check really committed.
    const { data } = await manager.read
      .from("imprest_settlements")
      .select("used_tzs, returned_tzs, unaccounted_tzs, line_count, imprest_settlement_lines(line_no, amount_tzs)")
      .eq("disbursement_id", trip.id);
    expect(data).toEqual([
      expect.objectContaining({ used_tzs: 47000, returned_tzs: 13000, unaccounted_tzs: 0, line_count: 3 }),
    ]);
    expect(data![0].imprest_settlement_lines).toHaveLength(3);

    const after = await position(manager);
    expect(after.set_aside_tzs).toBe(afterHandOut.set_aside_tzs);
    expect(after.free_to_approve_tzs).toBe(afterHandOut.free_to_approve_tzs);
    expect(after.awaiting_verification_tzs).toBe(afterHandOut.awaiting_verification_tzs! - 13000);
  });

  it("records a remainder as Not accounted for, and a called-off trip as all returned", async () => {
    const before = await position(director);
    const short = await handedOut(cashier, 60000);
    const off = await handedOut(cashier, 60000);

    expect((await settle(cashier, short, [line(47000, "Fuel and fees", null, "vendor_did_not_issue")], 10000))
      .reason).toBe("explanation_required");
    expect(
      (await settle(cashier, short, [line(47000, "Fuel and fees", null, "vendor_did_not_issue")], 10000, "Driver short"))
        .reason,
    ).toBe("settled");
    expect((await settle(cashier, off, [], 60000)).reason).toBe("settled");

    const { data } = await director.read
      .from("imprest_settlements")
      .select("disbursement_id, used_tzs, returned_tzs, unaccounted_tzs, unaccounted_explanation")
      .in("disbursement_id", [short.id, off.id]);
    const byId = new Map(data!.map((row) => [row.disbursement_id, row]));
    expect(byId.get(short.id)).toMatchObject({ used_tzs: 47000, unaccounted_tzs: 3000, unaccounted_explanation: "Driver short" });
    expect(byId.get(off.id)).toMatchObject({ used_tzs: 0, returned_tzs: 60000, unaccounted_tzs: 0 });

    const after = await position(director);
    expect(after.set_aside_tzs).toBe(before.set_aside_tzs! + 120000);
    expect(after.awaiting_verification_tzs).toBe(before.awaiting_verification_tzs! + 50000);
  });

  it("refuses a settlement above the approval and changes nothing", async () => {
    const trip = await handedOut(cashier, 60000);
    const refused = await settle(cashier, trip, [line(55000, "Fuel", null, "transport_fare")], 13000);
    expect(refused).toMatchObject({ ok: false, reason: "over_approval", used_tzs: 55000, returned_tzs: 13000 });
    const { data } = await manager.read.from("imprest_disbursements").select("status, version").eq("id", trip.id);
    expect(data).toEqual([{ status: "handed_out", version: trip.version }]);
  });

  it("refuses to cancel once the cash is handed out", async () => {
    const trip = await handedOut(cashier, 5000);
    const refused = await rpc(manager, "staff_cancel_imprest_disbursement", {
      p_id: trip.id,
      p_expected_version: trip.version,
      p_reason: "Trip called off",
      p_idempotency_key: randomUUID(),
    });
    expect(refused).toMatchObject({ ok: false, reason: "not_approved", status: "handed_out" });
  });
});

describe("retries", () => {
  it("writes one settlement when the same request arrives six times at once", async () => {
    const trip = await handedOut(cashier, 9000);
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => settle(cashier, trip, [line(9000, "Fuel", null, "transport_fare")], 0, null, key)),
    );
    expect(results.filter((r) => r.reason === "settled")).toHaveLength(1);
    expect(results.filter((r) => r.reason === "replayed")).toHaveLength(5);
    const { data } = await manager.read.from("imprest_settlements").select("id").eq("disbursement_id", trip.id);
    expect(data).toHaveLength(1);
  });

  it("treats a changed retry on the same key as a conflict", async () => {
    const trip = await handedOut(cashier, 9000);
    const key = randomUUID();
    expect((await settle(cashier, trip, [line(9000, "Fuel", null, "transport_fare")], 0, null, key)).reason).toBe("settled");
    expect((await settle(cashier, trip, [line(8000, "Fuel", null, "transport_fare")], 1000, null, key)).reason).toBe(
      "idempotency_key_conflict",
    );
  });
});

describe("receipts in storage", () => {
  let trip: Disbursement;
  let receipt: Receipt;
  let plain: Uint8Array;

  beforeAll(async () => {
    trip = await handedOut(cashier, 12000);
    receipt = await register(cashier, trip);
    plain = photo();
    const response = await upload(cashier.accessToken, receipt, plain);
    expect(response.status).toBe(200);
  });

  it("stores only ciphertext, which the Manager and a Director open with the key", async () => {
    for (const reader of [manager, director, cashier]) {
      const response = await download(reader.accessToken, receipt.object_path);
      expect(response.status, reader.role).toBe(200);
      const stored = await response.arrayBuffer();
      expect(Buffer.from(stored).includes(Buffer.from(plain.subarray(0, 64)))).toBe(false);

      const opened = await rpc(reader, "staff_open_imprest_receipt", { p_receipt_id: receipt.id });
      const key = (opened.receipt as Receipt).key;
      expect(new Uint8Array(await decryptReceipt(stored, key))).toEqual(plain);
    }
  });

  it("opens through a short-lived signed link for somebody allowed, and for nobody else", async () => {
    const signed = await manager.read.storage.from(BUCKET).createSignedUrl(receipt.object_path, 60);
    expect(signed.error).toBeNull();
    expect((await fetch(signed.data!.signedUrl)).status).toBe(200);

    for (const outsider of [secondCashier, salesRep]) {
      const refused = await outsider.read.storage.from(BUCKET).createSignedUrl(receipt.object_path, 60);
      expect(refused.error, outsider.role).not.toBeNull();
    }
  });

  it("refuses another Cashier, a Sales Representative and anon", async () => {
    for (const outsider of [secondCashier, salesRep]) {
      expect((await download(outsider.accessToken, receipt.object_path)).status, outsider.role).toBeGreaterThanOrEqual(400);
      const opened = await rpc(outsider === salesRep ? secondCashier : outsider, "staff_open_imprest_receipt", {
        p_receipt_id: receipt.id,
      });
      expect(opened.reason).toBe("no_receipt");
    }
    expect((await download(PUBLISHABLE_KEY, receipt.object_path)).status).toBeGreaterThanOrEqual(400);

    const theirs = await register(cashier, trip, "second.jpg");
    const planted = await upload(secondCashier.accessToken, theirs, photo());
    expect(planted.status).toBeGreaterThanOrEqual(400);
  });

  it("refuses a plain image, an overwrite and a delete by the uploader", async () => {
    const other = await register(cashier, trip, "plain.jpg");
    const plainUpload = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${other.object_path}`, {
      method: "POST",
      headers: { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${cashier.accessToken}`, "Content-Type": "image/jpeg" },
      body: photo(),
    });
    expect(plainUpload.status).toBeGreaterThanOrEqual(400);

    const overwrite = await upload(cashier.accessToken, receipt, photo(), { "x-upsert": "true" });
    expect(overwrite.status).toBeGreaterThanOrEqual(400);

    const removed = await cashier.read.storage.from(BUCKET).remove([receipt.object_path]);
    expect(removed.data ?? []).toHaveLength(0);

    const stored = await (await download(manager.accessToken, receipt.object_path)).arrayBuffer();
    const opened = await rpc(manager, "staff_open_imprest_receipt", { p_receipt_id: receipt.id });
    expect(new Uint8Array(await decryptReceipt(stored, (opened.receipt as Receipt).key))).toEqual(plain);
  });

  it("gives a leaked secret key no way to plant, replace, delete or read a receipt", async () => {
    const service = { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` };

    const planted = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/imprest/${trip.id}/planted`, {
      method: "POST",
      headers: { ...service, "Content-Type": "application/octet-stream" },
      body: photo(),
    });
    expect(planted.status).toBeGreaterThanOrEqual(400);

    const replaced = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${receipt.object_path}`, {
      method: "PUT",
      headers: { ...service, "Content-Type": "application/octet-stream" },
      body: photo(),
    });
    expect(replaced.status).toBeGreaterThanOrEqual(400);

    const deleted = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
      method: "DELETE",
      headers: { ...service, "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: [receipt.object_path] }),
    });
    expect(deleted.status).toBeGreaterThanOrEqual(400);

    // It can fetch the stored bytes, and they are ciphertext it has no key for: the key column is
    // closed to it and so is the command that hands keys out.
    const stolen = await download(SECRET_KEY, receipt.object_path, SECRET_KEY);
    if (stolen.status === 200) {
      const bytes = Buffer.from(await stolen.arrayBuffer());
      expect(bytes.includes(Buffer.from(plain.subarray(0, 64)))).toBe(false);
    }
    const keyRead = await fetch(`${SUPABASE_URL}/rest/v1/imprest_receipts?select=encryption_key`, { headers: service });
    expect(keyRead.status).toBeGreaterThanOrEqual(400);
    const opened = await callApiRpc("staff_open_imprest_receipt", { p_receipt_id: receipt.id }, SECRET_KEY);
    expect(opened.status).toBeGreaterThanOrEqual(400);

    const stored = await (await download(manager.accessToken, receipt.object_path)).arrayBuffer();
    const managerKey = ((await rpc(manager, "staff_open_imprest_receipt", { p_receipt_id: receipt.id })).receipt as Receipt).key;
    expect(new Uint8Array(await decryptReceipt(stored, managerKey))).toEqual(plain);
  });

  it("refuses an upload once the disbursement is settled", async () => {
    const late = await register(cashier, trip, "late.jpg");
    expect((await settle(cashier, trip, [line(12000, "Fuel", receipt.id)], 0)).reason).toBe("settled");
    expect((await upload(cashier.accessToken, late, photo())).status).toBeGreaterThanOrEqual(400);
  });
});

describe("authority", () => {
  it("refuses a Cashier deactivated after signing in", async () => {
    const leaving = await createLiveStaff(director, "cashier", "Leaving Settlement Cashier");
    const trip = await handedOut(leaving, 3000);
    const { data } = await director.api.rpc("admin_set_account_active", {
      p_target_user_id: leaving.userId,
      p_is_active: false,
    });
    expect((data as Result).ok).toBe(true);
    const { error } = await leaving.api.rpc("staff_settle_imprest_disbursement", {
      p_id: trip.id,
      p_expected_version: trip.version,
      p_lines: [],
      p_returned_tzs: 3000,
      p_explanation: null,
      p_idempotency_key: randomUUID(),
    });
    expect(error?.message).toMatch(/may not perform this command/);
  });

  it("refuses a Cashier whose role changed after signing in", async () => {
    const moved = await createLiveStaff(director, "cashier", "Moved Settlement Cashier");
    const proposed = await rpc(moved, "staff_propose_imprest_disbursement", {
      p_amount_tzs: 3000,
      p_category: "other",
      p_purpose: "Moved",
      p_idempotency_key: randomUUID(),
    });
    await rpc(manager, "staff_decide_imprest_disbursement", {
      p_id: proposed.disbursement!.id,
      p_expected_version: 1,
      p_approve: true,
      p_reason: null,
      p_idempotency_key: randomUUID(),
    });
    const { data } = await director.api.rpc("admin_change_user_role", {
      p_target_user_id: moved.userId,
      p_role: "sales_rep",
    });
    expect((data as Result).ok).toBe(true);
    const { error } = await moved.api.rpc("staff_hand_out_imprest_disbursement", {
      p_id: proposed.disbursement!.id,
      p_expected_version: 2,
      p_recipient: "Anybody",
      p_idempotency_key: randomUUID(),
    });
    expect(error?.message).toMatch(/may not perform this command/);
  });

  it("keeps hand-out and settlement to the proposing Cashier", async () => {
    const trip = await handedOut(cashier, 3000);
    expect((await settle(secondCashier, trip, [], 3000)).reason).toBe("no_disbursement");
    for (const other of [manager, director, salesRep]) {
      const { error } = await other.api.rpc("staff_settle_imprest_disbursement", {
        p_id: trip.id,
        p_expected_version: trip.version,
        p_lines: [],
        p_returned_tzs: 3000,
        p_explanation: null,
        p_idempotency_key: randomUUID(),
      });
      expect(error?.message, other.role).toMatch(/may not perform this command/);
    }
  });
});

describe("reads and direct writes", () => {
  const headers = (token: string) => ({
    apikey: PUBLISHABLE_KEY,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  });

  it("shows a Cashier only their own hand-outs and settlements, and a Sales Representative none", async () => {
    const mine = await handedOut(cashier, 2000);
    const theirs = await handedOut(secondCashier, 2000);
    await settle(cashier, mine, [], 2000);
    await settle(secondCashier, theirs, [], 2000);

    const own = await cashier.read.from("imprest_settlements").select("disbursement_id").in("disbursement_id", [mine.id, theirs.id]);
    expect(own.data).toEqual([{ disbursement_id: mine.id }]);
    const handouts = await cashier.read
      .from("imprest_disbursement_handouts")
      .select("disbursement_id")
      .in("disbursement_id", [mine.id, theirs.id]);
    expect(handouts.data).toEqual([{ disbursement_id: mine.id }]);

    for (const table of ["imprest_settlements", "imprest_disbursement_handouts", "imprest_receipts", "imprest_settlement_lines"]) {
      const { data } = await salesRep.read.from(table).select("id").limit(1);
      expect(data, table).toEqual([]);
    }
    const everything = await manager.read.from("imprest_settlements").select("id").in("disbursement_id", [mine.id, theirs.id]);
    expect(everything.data).toHaveLength(2);
  });

  it("orders the Manager's two queues by when each step began, not by approval", async () => {
    // Approved first, handed out second: the queue must put the other one first.
    const first = await handedOut(cashier, 1000);
    const second = await handedOut(cashier, 1000);
    const approvedLater = await rpc(cashier, "staff_propose_imprest_disbursement", {
      p_amount_tzs: 1000,
      p_category: "other",
      p_purpose: "Approved later",
      p_idempotency_key: randomUUID(),
    });
    await rpc(manager, "staff_decide_imprest_disbursement", {
      p_id: approvedLater.disbursement!.id,
      p_expected_version: 1,
      p_approve: true,
      p_reason: null,
      p_idempotency_key: randomUUID(),
    });
    const approvedFirst = await rpc(cashier, "staff_propose_imprest_disbursement", {
      p_amount_tzs: 1000,
      p_category: "other",
      p_purpose: "Approved earlier, handed out last",
      p_idempotency_key: randomUUID(),
    });
    // Its approval is backdated by nothing; it is simply handed out after the other.
    await rpc(manager, "staff_decide_imprest_disbursement", {
      p_id: approvedFirst.disbursement!.id,
      p_expected_version: 1,
      p_approve: true,
      p_reason: null,
      p_idempotency_key: randomUUID(),
    });
    for (const d of [approvedFirst.disbursement!, approvedLater.disbursement!].reverse()) {
      await rpc(cashier, "staff_hand_out_imprest_disbursement", {
        p_id: d.id,
        p_expected_version: 2,
        p_recipient: "Queue driver",
        p_idempotency_key: randomUUID(),
      });
    }
    // PostgREST sorts by an embedded row only when it is selected, as the loader selects it.
    const out = await manager.read
      .from("imprest_disbursements")
      .select("id, imprest_disbursement_handouts(handed_out_at)")
      .in("id", [approvedFirst.disbursement!.id, approvedLater.disbursement!.id])
      .order("imprest_disbursement_handouts(handed_out_at)", { ascending: true });
    expect(out.error).toBeNull();
    expect(out.data!.map((row) => row.id)).toEqual([approvedLater.disbursement!.id, approvedFirst.disbursement!.id]);

    // Settled in the opposite order to their hand-outs.
    await settle(cashier, second, [], 1000);
    await settle(cashier, first, [], 1000);
    const waiting = await manager.read
      .from("imprest_disbursements")
      .select("id")
      .in("id", [first.id, second.id])
      .order("imprest_disbursement_settled_at", { ascending: true });
    expect(waiting.error).toBeNull();
    expect(waiting.data!.map((row) => row.id)).toEqual([second.id, first.id]);
  });

  it("never sends a receipt's key to a table read", async () => {
    const { error } = await manager.read.from("imprest_receipts").select("encryption_key").limit(1);
    expect(error).not.toBeNull();
  });

  it("refuses direct writes by every signed-in role and by the secret key", async () => {
    const trip = await handedOut(cashier, 2000);
    for (const [who, token] of [
      ["cashier", cashier.accessToken],
      ["manager", manager.accessToken],
      ["director", director.accessToken],
      ["secret key", SECRET_KEY],
    ] as const) {
      const apikey = who === "secret key" ? SECRET_KEY : PUBLISHABLE_KEY;
      const insert = await fetch(`${SUPABASE_URL}/rest/v1/imprest_settlements`, {
        method: "POST",
        headers: { ...headers(token), apikey },
        body: JSON.stringify({
          disbursement_id: trip.id,
          cycle: 1,
          approved_tzs: 2000,
          used_tzs: 0,
          returned_tzs: 2000,
          unaccounted_tzs: 0,
          line_count: 0,
          no_receipt_lines: 0,
          settled_by: cashier.userId,
        }),
      });
      expect(insert.status, who).toBeGreaterThanOrEqual(400);
      const patch = await fetch(`${SUPABASE_URL}/rest/v1/imprest_disbursement_handouts?disbursement_id=eq.${trip.id}`, {
        method: "PATCH",
        headers: { ...headers(token), apikey },
        body: JSON.stringify({ recipient: "Somebody else" }),
      });
      expect(patch.status, who).toBeGreaterThanOrEqual(400);
    }
    const { data } = await manager.read.from("imprest_disbursement_handouts").select("recipient").eq("disbursement_id", trip.id);
    expect(data).toEqual([{ recipient: "Juma the driver" }]);
    const { data: settlements } = await manager.read.from("imprest_settlements").select("id").eq("disbursement_id", trip.id);
    expect(settlements).toEqual([]);
  });

  it("gives a leaked secret key none of the new commands", async () => {
    const trip = await handedOut(cashier, 2000);
    for (const [fn, args] of [
      ["staff_hand_out_imprest_disbursement", { p_id: trip.id, p_expected_version: 2, p_recipient: "Leaked" }],
      ["staff_register_imprest_receipt", { p_disbursement_id: trip.id, p_file_name: "x.jpg", p_content_type: "image/jpeg", p_byte_size: 10 }],
      ["staff_settle_imprest_disbursement", { p_id: trip.id, p_expected_version: 3, p_lines: [], p_returned_tzs: 2000, p_explanation: null }],
    ] as const) {
      const response = await callApiRpc(fn, { ...args, p_idempotency_key: randomUUID() }, SECRET_KEY);
      expect(response.status, fn).toBeGreaterThanOrEqual(400);
    }
    const { data } = await manager.read.from("imprest_disbursements").select("status").eq("id", trip.id);
    expect(data).toEqual([{ status: "handed_out" }]);
  });
});
