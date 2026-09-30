import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { createLiveStaff, ensureDirector, type Fixture } from "@/tests/integration/helpers";

/**
 * A supplier delivery paid from imprest (issue #73), over real HTTP through PostgREST.
 *
 * pgTAP proves every rule inside one rolled-back transaction. These tests commit, so they prove what
 * only real requests can: each role boundary as PostgREST sees it, the tables' own policies and
 * grants, the reads the screens make from both sides, that a receipt entered in one request cannot
 * gain or change its link in another, that a lost answer is replayed by its key, that two
 * submissions racing under one key make one receipt and one link, and that the six-argument form the
 * released application calls still enters a receipt.
 *
 * The fund is shared with every other integration file, so every figure is read first and asserted
 * as a change.
 */

type Row = { id: string; version: number };
type Result = {
  ok: boolean;
  reason: string;
  disbursement?: Row;
  receipt?: { id: string };
  imprest_link?: { receipt_id: string; disbursement_id: string; linked_by: string; linked_role: string } | null;
  [key: string]: unknown;
};
type Position = { posted_balance_tzs: number; set_aside_tzs: number; free_to_approve_tzs: number; awaiting_verification_tzs: number };
type Option = { id: string; disbursement_no: string; status: string; category: string; recipient: string; approved_tzs: number };

let director: Fixture;
let secondDirector: Fixture;
let manager: Fixture;
let cashier: Fixture;
let secondCashier: Fixture;
let salesRep: Fixture;

let supplierId: string;
let productId: string;

async function rpc(who: Fixture, fn: string, args: Record<string, unknown>): Promise<Result> {
  const { data, error } = await who.api.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as Result;
}

async function position(): Promise<Position> {
  const { data, error } = await manager.api.rpc("staff_imprest_spending_position");
  if (error) throw new Error(`position: ${error.message}`);
  return (data as Position[])[0];
}

async function stockOf(product: string): Promise<number> {
  const { data, error } = await manager.read
    .from("current_stock")
    .select("quantity")
    .eq("product_id", product)
    .eq("location_code", "store")
    .eq("stock_state", "available");
  if (error) throw new Error(`stock: ${error.message}`);
  return (data ?? []).reduce((sum, row) => sum + Number(row.quantity), 0);
}

async function postFunding(amount: number): Promise<void> {
  const call = async (who: Fixture, fn: string, args: Record<string, unknown>) =>
    (await rpc(who, fn, { ...args, p_idempotency_key: randomUUID() })) as unknown as {
      reason: string;
      funding: { id: string; version: number; handover_id: string };
    };
  const requested = await call(manager, "staff_request_imprest_funding", { p_amount_tzs: amount, p_reason: "Delivery float" });
  const approved = await call(director, "admin_decide_imprest_funding", {
    p_funding_id: requested.funding.id,
    p_expected_version: requested.funding.version,
    p_approve: true,
    p_amount_tzs: amount,
    p_reason: null,
  });
  const provided = await call(secondDirector, "admin_record_imprest_provided", {
    p_funding_id: approved.funding.id,
    p_expected_version: approved.funding.version,
    p_amount_tzs: amount,
  });
  const received = await call(manager, "staff_confirm_imprest_received", {
    p_funding_id: provided.funding.id,
    p_expected_version: provided.funding.version,
    p_handover_id: provided.funding.handover_id,
  });
  if (received.reason !== "received") throw new Error(`funding not received: ${received.reason}`);
}

/** Proposed by `who`, approved by the Manager, and handed out unless told to stop at approval. */
async function payment(who: Fixture, amount: number, recipient: string, handOut = true): Promise<Row> {
  const made = await rpc(who, "staff_propose_imprest_disbursement", {
    p_amount_tzs: amount,
    p_category: "materials_and_supplies",
    p_purpose: "Building materials",
    p_idempotency_key: randomUUID(),
  });
  const approved = await rpc(manager, "staff_decide_imprest_disbursement", {
    p_id: made.disbursement!.id,
    p_expected_version: made.disbursement!.version,
    p_approve: true,
    p_reason: null,
    p_idempotency_key: randomUUID(),
  });
  if (!handOut) return approved.disbursement!;
  const out = await rpc(who, "staff_hand_out_imprest_disbursement", {
    p_id: approved.disbursement!.id,
    p_expected_version: approved.disbursement!.version,
    p_recipient: recipient,
    p_idempotency_key: randomUUID(),
  });
  expect(out.reason).toBe("handed_out");
  return out.disbursement!;
}

function receiptArgs(note: string, disbursementId: string | null, key = randomUUID()) {
  return {
    p_supplier_id: supplierId,
    p_location_code: "store",
    p_delivery_date: new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Dar_es_Salaam" }),
    p_delivery_note_ref: note,
    p_lines: [{ product_id: productId, expected_quantity: 12, received_quantity: 12, damaged_quantity: 0 }],
    p_disbursement_id: disbursementId,
    p_idempotency_key: key,
  };
}

const note = (label: string) => `DN-${label}-${randomUUID().slice(0, 6)}`;

beforeAll(async () => {
  director = await ensureDirector();
  secondDirector = await createLiveStaff(director, "director", "Second Director");
  manager = await createLiveStaff(director, "manager", "Link Manager");
  cashier = await createLiveStaff(director, "cashier", "Link Cashier");
  secondCashier = await createLiveStaff(director, "cashier", "Other Cashier");
  salesRep = await createLiveStaff(director, "sales_rep", "Link Rep");

  const supplier = await rpc(director, "admin_add_supplier", {
    p_name: `Link Supplier ${randomUUID().slice(0, 8)}`,
    p_idempotency_key: randomUUID(),
  });
  supplierId = (supplier.supplier as { id: string }).id;
  const product = await rpc(director, "admin_add_product", {
    p_name: `Link Stock ${randomUUID().slice(0, 8)}`,
    p_specification: null,
    p_unit_code: "piece",
    p_unit_content: null,
    p_idempotency_key: randomUUID(),
  });
  productId = (product.product as { id: string }).id;

  await postFunding(200_000);
});

describe("the picker", () => {
  it("offers the Manager every paid-out payment of the active fund, newest first, and a Cashier only theirs", async () => {
    const older = await payment(cashier, 11_000, "Simba Sand Ltd");
    const approvedOnly = await payment(cashier, 3_000, "Nobody yet", false);
    const newer = await payment(secondCashier, 7_000, "Mbezi Nails");

    const { data: all } = await manager.api.rpc("staff_imprest_receipt_payment_options");
    const ids = (all as Option[]).map((option) => option.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
    expect(ids).not.toContain(approvedOnly.id);
    expect((all as Option[]).find((option) => option.id === older.id)).toMatchObject({
      status: "handed_out",
      category: "materials_and_supplies",
      recipient: "Simba Sand Ltd",
      approved_tzs: 11_000,
    });

    const { data: own } = await cashier.api.rpc("staff_imprest_receipt_payment_options");
    expect((own as Option[]).map((option) => option.id)).toContain(older.id);
    expect((own as Option[]).map((option) => option.id)).not.toContain(newer.id);

    for (const who of [salesRep, director]) {
      const { error } = await who.api.rpc("staff_imprest_receipt_payment_options");
      expect(error?.message, `${who.role} was offered payments`).toMatch(/may not perform this command/);
    }
  });
});

describe("entering a receipt paid from imprest", () => {
  it("links it for the Manager and the Cashier who paid, and refuses everyone else, committing each refusal", async () => {
    const paid = await payment(cashier, 20_000, "Twiga Depot");

    const rep = await rpc(salesRep, "staff_enter_stock_receipt", receiptArgs(note("REP"), paid.id));
    expect(rep).toMatchObject({ ok: false, reason: "imprest_link_not_permitted" });
    const other = await rpc(secondCashier, "staff_enter_stock_receipt", receiptArgs(note("OTHER"), paid.id));
    expect(other).toMatchObject({ ok: false, reason: "no_disbursement" });
    const { error: directorError } = await director.api.rpc("staff_enter_stock_receipt", receiptArgs(note("DIR"), paid.id));
    expect(directorError?.message).toMatch(/may not perform this command/);

    const own = await rpc(cashier, "staff_enter_stock_receipt", receiptArgs(note("OWN"), paid.id));
    expect(own.reason).toBe("entered");
    expect(own.imprest_link).toMatchObject({ disbursement_id: paid.id, linked_by: cashier.userId, linked_role: "cashier" });

    const byManager = await rpc(manager, "staff_enter_stock_receipt", receiptArgs(note("MGR"), paid.id));
    expect(byManager.imprest_link).toMatchObject({ disbursement_id: paid.id, linked_role: "manager" });

    const { data: receipts } = await manager.api.rpc("staff_imprest_disbursement_stock_receipts", {
      p_disbursement_id: paid.id,
    });
    expect((receipts as { receipt_id: string }[]).map((r) => r.receipt_id).sort()).toEqual(
      [own.receipt!.id, byManager.receipt!.id].sort(),
    );
  });

  it("refuses a payment that paid for nothing yet", async () => {
    const approvedOnly = await payment(cashier, 2_500, "Nobody yet", false);
    const result = await rpc(cashier, "staff_enter_stock_receipt", receiptArgs(note("EARLY"), approvedOnly.id));
    expect(result).toMatchObject({ ok: false, reason: "disbursement_not_paid", status: "approved" });
  });

  it("moves no imprest figure and no stock, and stock rises only on the Manager's approval", async () => {
    const paid = await payment(cashier, 9_000, "Kariakoo Bolts");
    const figures = await position();
    const stock = await stockOf(productId);

    const entered = await rpc(cashier, "staff_enter_stock_receipt", receiptArgs(note("NOMOVE"), paid.id));
    expect(entered.reason).toBe("entered");
    expect(await position()).toEqual(figures);
    expect(await stockOf(productId)).toBe(stock);

    const approved = await rpc(manager, "staff_approve_stock_receipt", {
      p_receipt_id: entered.receipt!.id,
      p_idempotency_key: randomUUID(),
    });
    expect(approved.reason).toBe("approved");
    expect(await stockOf(productId)).toBe(stock + 12);
    expect(await position()).toEqual(figures);
  });

  it("replays a lost answer by its key, and two racing submissions make one receipt and one link", async () => {
    const paid = await payment(cashier, 6_000, "Rangi Shop");
    const key = randomUUID();
    const args = receiptArgs(note("RACE"), paid.id, key);

    const [first, second] = await Promise.all([
      rpc(cashier, "staff_enter_stock_receipt", args),
      rpc(cashier, "staff_enter_stock_receipt", args),
    ]);
    expect([first.reason, second.reason].sort()).toEqual(["entered", "replayed"]);
    expect(first.receipt!.id).toBe(second.receipt!.id);
    expect(second.imprest_link?.disbursement_id).toBe(paid.id);

    const retry = await rpc(cashier, "staff_enter_stock_receipt", args);
    expect(retry).toMatchObject({ reason: "replayed", receipt: { id: first.receipt!.id } });

    const { data: links } = await manager.read
      .from("stock_receipt_imprest_links")
      .select("receipt_id")
      .eq("disbursement_id", paid.id);
    expect(links).toHaveLength(1);
  });

  it("still enters a receipt through the six-argument form the released application calls", async () => {
    const args: Record<string, unknown> = receiptArgs(note("SIX"), null);
    delete args.p_disbursement_id;
    const result = await rpc(cashier, "staff_enter_stock_receipt", args);
    expect(result).toMatchObject({ ok: true, reason: "entered", imprest_link: null });
  });
});

describe("the link, once made", () => {
  it("cannot be written, changed or removed by any session, and a later request cannot add one", async () => {
    const paid = await payment(cashier, 4_000, "Mzee Timber");
    const linked = await rpc(cashier, "staff_enter_stock_receipt", receiptArgs(note("FIXED"), paid.id));
    const plain = await rpc(manager, "staff_enter_stock_receipt", receiptArgs(note("PLAIN"), null));

    for (const who of [manager, cashier, director]) {
      const inserted = await who.read.from("stock_receipt_imprest_links").insert({
        receipt_id: plain.receipt!.id,
        disbursement_id: paid.id,
        linked_by: who.userId,
        linked_role: "manager",
        correlation_id: randomUUID(),
      });
      expect(inserted.error, `${who.role} inserted a link`).not.toBeNull();

      const updated = await who.read
        .from("stock_receipt_imprest_links")
        .update({ disbursement_id: paid.id })
        .eq("receipt_id", linked.receipt!.id)
        .select();
      expect(updated.error !== null || (updated.data ?? []).length === 0, `${who.role} changed a link`).toBe(true);

      const removed = await who.read
        .from("stock_receipt_imprest_links")
        .delete()
        .eq("receipt_id", linked.receipt!.id)
        .select();
      expect(removed.error !== null || (removed.data ?? []).length === 0, `${who.role} removed a link`).toBe(true);
    }

    const { data } = await manager.read
      .from("stock_receipt_imprest_links")
      .select("disbursement_id, linked_by")
      .in("receipt_id", [linked.receipt!.id, plain.receipt!.id]);
    expect(data).toEqual([{ disbursement_id: paid.id, linked_by: cashier.userId }]);
  });
});

describe("reading from both sides", () => {
  it("shows the receipt's payment and the payment's receipts to everyone who can read either, and nothing to anyone else", async () => {
    const paid = await payment(cashier, 5_000, "Simba Sand Ltd");
    const byManager = await rpc(manager, "staff_enter_stock_receipt", receiptArgs(note("BOTH"), paid.id));
    const receiptIds = [byManager.receipt!.id];

    // The receipt side: the Manager and Directors read every receipt, so every link.
    for (const who of [manager, director]) {
      const { data } = await who.api.rpc("staff_stock_receipt_imprest_links", { p_receipt_ids: receiptIds });
      expect((data as { disbursement: { id: string; recipient: string } }[])[0].disbursement).toMatchObject({
        id: paid.id,
        recipient: "Simba Sand Ltd",
      });
    }
    // The Cashier did not enter it, so the receipt is not theirs to read from that side.
    const { data: cashierReceiptSide } = await cashier.api.rpc("staff_stock_receipt_imprest_links", {
      p_receipt_ids: receiptIds,
    });
    expect(cashierReceiptSide).toEqual([]);

    // The payment side: the Cashier who paid reads the Manager's receipt against it.
    const { data: cashierPaymentSide } = await cashier.api.rpc("staff_imprest_disbursement_stock_receipts", {
      p_disbursement_id: paid.id,
    });
    expect(cashierPaymentSide).toEqual([
      expect.objectContaining({ receipt_id: byManager.receipt!.id, entered_by: "Link Manager", approval_status: "pending" }),
    ]);
    const { data: director_ } = await director.api.rpc("staff_imprest_disbursement_stock_receipts", {
      p_disbursement_id: paid.id,
    });
    expect(director_).toHaveLength(1);

    // Anyone else reads nothing, and the table's own policy agrees.
    const { data: otherCashier } = await secondCashier.api.rpc("staff_imprest_disbursement_stock_receipts", {
      p_disbursement_id: paid.id,
    });
    expect(otherCashier).toBeNull();
    const { error: repError } = await salesRep.api.rpc("staff_imprest_disbursement_stock_receipts", {
      p_disbursement_id: paid.id,
    });
    expect(repError?.message).toMatch(/may not perform this command/);

    const table = async (who: Fixture) =>
      (await who.read.from("stock_receipt_imprest_links").select("receipt_id").eq("receipt_id", byManager.receipt!.id))
        .data ?? [];
    expect(await table(cashier)).toHaveLength(1);
    expect(await table(director)).toHaveLength(1);
    expect(await table(secondCashier)).toHaveLength(0);
    expect(await table(salesRep)).toHaveLength(0);
  });
});
