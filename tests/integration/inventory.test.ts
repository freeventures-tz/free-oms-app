import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  SECRET_KEY,
  callApiRpc,
  createLiveStaff,
  ensureDirector,
  type Fixture,
} from "@/tests/integration/helpers";

/**
 * Suppliers, receiving, transfers and corrections, over real HTTP through PostgREST.
 *
 * pgTAP proves the rules inside the database. These tests prove the same rules survive the journey
 * a browser actually takes — a session token, a schema header, a JSON body — which is the layer
 * where a missing grant, an unexposed function or an embed that does not resolve shows up, and
 * where a direct SQL session would never notice.
 *
 * They also cover the one thing pgTAP structurally cannot: reaching AROUND the commands. A direct
 * `POST /rest/v1/inventory_ledger` as `authenticated` runs as a role a GRANT actually constrains,
 * unlike a pgTAP statement running as the table owner.
 */

let director: Fixture;
let manager: Fixture;
let cashier: Fixture;
let salesRep: Fixture;

let supplierId: string;
let productId: string;
let secondProductId: string;

beforeAll(async () => {
  director = await ensureDirector();
  manager = await createLiveStaff(director, "manager");
  cashier = await createLiveStaff(director, "cashier");
  salesRep = await createLiveStaff(director, "sales_rep");

  const { data: supplier } = await director.api.rpc("admin_add_supplier", {
    p_name: `Integration Supplier ${randomUUID().slice(0, 8)}`,
    p_idempotency_key: randomUUID(),
  });
  expect(supplier?.ok, JSON.stringify(supplier)).toBe(true);
  supplierId = (supplier.supplier as { id: string }).id;

  productId = await freshProduct(`Integration Stock ${randomUUID().slice(0, 8)}`);
  secondProductId = await freshProduct(`Integration Stock ${randomUUID().slice(0, 8)}`);
});

async function freshProduct(name: string): Promise<string> {
  const { data } = await director.api.rpc("admin_add_product", {
    p_name: name,
    p_specification: null,
    p_unit_code: "piece",
    p_unit_content: null,
    p_idempotency_key: randomUUID(),
  });
  expect(data?.ok, JSON.stringify(data)).toBe(true);
  return (data.product as { id: string }).id;
}

async function balance(product: string, location: string): Promise<number> {
  const { data, error } = await director.read
    .from("current_stock")
    .select("quantity")
    .eq("product_id", product)
    .eq("location_code", location)
    .eq("stock_state", "available")
    .maybeSingle();
  expect(error, error?.message).toBeNull();
  return data ? Number(data.quantity) : 0;
}

describe("who may register a supplier", () => {
  it("refuses every role but a Director, over HTTP", async () => {
    for (const [role, fixture] of [
      ["manager", manager],
      ["cashier", cashier],
      ["sales_rep", salesRep],
    ] as const) {
      const { data, error } = await fixture.api.rpc("admin_add_supplier", {
        p_name: `Should Not Exist ${role}`,
        p_idempotency_key: randomUUID(),
      });
      expect(data, `${role} was allowed to register a supplier`).toBeNull();
      expect(error?.message, `${role} got no refusal`).toMatch(/not a live Director/i);
    }
  });

  it("refuses a direct table insert even though the function refused first", async () => {
    // The function is one control. This is the other: `authenticated` holds no INSERT grant, so the
    // request fails on privilege before any policy is consulted.
    const { error } = await manager.read
      .from("suppliers")
      .insert({ name: "Reached Around" });
    expect(error, "a Manager wrote directly to suppliers").not.toBeNull();
  });
});

describe("entering a supplier receipt", () => {
  it("is delegable to a Cashier and moves no stock (product.md §9.1)", async () => {
    const before = await balance(productId, "store");

    const { data, error } = await cashier.api.rpc("staff_enter_stock_receipt", {
      p_supplier_id: supplierId,
      p_location_code: "store",
      p_delivery_date: new Date().toISOString().slice(0, 10),
      p_delivery_note_ref: `DN-${randomUUID().slice(0, 6)}`,
      p_lines: [
        {
          product_id: productId,
          expected_quantity: 100,
          received_quantity: 90,
          damaged_quantity: 5,
          damage_note: "crushed in transit",
        },
      ],
      p_idempotency_key: randomUUID(),
    });

    expect(error?.message).toBeUndefined();
    expect(data?.ok, JSON.stringify(data)).toBe(true);
    expect(data.reason).toBe("entered");

    expect(await balance(productId, "store")).toBe(before);
  });

  it("refuses a Director, because §4.1 names three enterers and none of them is one", async () => {
    const { data, error } = await director.api.rpc("staff_enter_stock_receipt", {
      p_supplier_id: supplierId,
      p_location_code: "store",
      p_delivery_date: new Date().toISOString().slice(0, 10),
      p_delivery_note_ref: "DN-DIRECTOR",
      p_lines: [
        { product_id: productId, expected_quantity: 1, received_quantity: 1 },
      ],
      p_idempotency_key: randomUUID(),
    });
    expect(data).toBeNull();
    expect(error?.message).toMatch(/may not perform this command/i);
  });

  it("calculates short and excess, and lets nobody supply them", async () => {
    const { data } = await director.read
      .from("stock_receipt_lines")
      .select("short_quantity, excess_quantity, accepted_quantity")
      .eq("product_id", productId)
      .limit(1)
      .single();

    expect(Number(data?.short_quantity)).toBe(10);
    expect(Number(data?.excess_quantity)).toBe(0);
    // 90 arrived, 5 broken. Damaged goods are unsellable (§8) and never reach a balance.
    expect(Number(data?.accepted_quantity)).toBe(85);

    // A generated column cannot be written even by the role that owns the row's parent.
    const { error } = await manager.read
      .from("stock_receipt_lines")
      .update({ short_quantity: 0 })
      .eq("product_id", productId);
    expect(error, "a Manager rewrote a calculated shortage").not.toBeNull();
  });
});

describe("approving a supplier receipt", () => {
  let receiptId: string;

  beforeAll(async () => {
    const { data } = await director.read
      .from("stock_receipts")
      .select("id")
      .eq("location_code", "store")
      .order("entered_at", { ascending: false })
      .limit(1)
      .single();
    receiptId = data!.id as string;
  });

  it("refuses the Cashier who entered it and the Director above them", async () => {
    for (const [role, fixture] of [
      ["cashier", cashier],
      ["director", director],
      ["sales_rep", salesRep],
    ] as const) {
      const { data, error } = await fixture.api.rpc("staff_approve_stock_receipt", {
        p_receipt_id: receiptId,
        p_idempotency_key: randomUUID(),
      });
      expect(data, `${role} approved a receipt`).toBeNull();
      expect(error?.message).toMatch(/may not perform this command|not a live Director/i);
    }
  });

  it("adds the accepted quantity when the Manager approves", async () => {
    const before = await balance(productId, "store");

    const { data } = await manager.api.rpc("staff_approve_stock_receipt", {
      p_receipt_id: receiptId,
      p_idempotency_key: randomUUID(),
    });

    expect(data?.ok, JSON.stringify(data)).toBe(true);
    expect(data.reason).toBe("approved");
    expect(await balance(productId, "store")).toBe(before + 85);
  });

  it("refuses a second decision on a settled record", async () => {
    const { data } = await manager.api.rpc("staff_approve_stock_receipt", {
      p_receipt_id: receiptId,
      p_idempotency_key: randomUUID(),
    });
    expect(data?.ok).toBe(false);
    expect(data.reason).toBe("already_settled");
  });

  it("keeps the shortage on the record after approval (§9.1, AC-28)", async () => {
    const { data } = await director.read
      .from("stock_receipt_lines")
      .select("short_quantity")
      .eq("receipt_id", receiptId)
      .single();
    expect(Number(data?.short_quantity)).toBe(10);
  });
});

describe("a burst of identical approvals", () => {
  it("decides once and replays to everybody else", async () => {
    const noteRef = `DN-${randomUUID().slice(0, 6)}`;
    const { data: entered } = await manager.api.rpc("staff_enter_stock_receipt", {
      p_supplier_id: supplierId,
      p_location_code: "warehouse",
      p_delivery_date: new Date().toISOString().slice(0, 10),
      p_delivery_note_ref: noteRef,
      p_lines: [
        { product_id: secondProductId, expected_quantity: 20, received_quantity: 20 },
      ],
      p_idempotency_key: randomUUID(),
    });
    expect(entered?.ok, JSON.stringify(entered)).toBe(true);
    const receiptId = (entered.receipt as { id: string }).id;

    // ONE key, six simultaneous requests — the shape a double-tap on a slow connection produces.
    // The contract is one committed decision replayed to the rest, and "they all said ok" does not
    // prove it: a second caller answered `already_settled` is also a refusal for a change that
    // succeeded.
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        manager.api.rpc("staff_approve_stock_receipt", {
          p_receipt_id: receiptId,
          p_idempotency_key: key,
        }),
      ),
    );

    const reasons = results.map((result) => String(result.data?.reason));
    expect(results.every((result) => result.error === null), JSON.stringify(results)).toBe(true);
    expect(reasons.filter((reason) => reason === "approved")).toHaveLength(1);
    expect(reasons.filter((reason) => reason === "replayed")).toHaveLength(5);

    // And exactly one helping of stock, which is the fact the reasons are a proxy for.
    expect(await balance(secondProductId, "warehouse")).toBe(20);
  });
});

describe("internal transfers", () => {
  it("moves nothing at entry and moves it at approval", async () => {
    const { data: entered } = await manager.api.rpc("staff_enter_stock_transfer", {
      p_from_location: "warehouse",
      p_to_location: "yard",
      p_note: null,
      p_lines: [{ product_id: secondProductId, quantity: 8 }],
      p_idempotency_key: randomUUID(),
    });
    expect(entered?.ok, JSON.stringify(entered)).toBe(true);
    const transferId = (entered.transfer as { id: string }).id;

    expect(await balance(secondProductId, "warehouse")).toBe(20);
    expect(await balance(secondProductId, "yard")).toBe(0);

    const { data: approved } = await manager.api.rpc("staff_approve_stock_transfer", {
      p_transfer_id: transferId,
      p_idempotency_key: randomUUID(),
    });
    expect(approved?.ok, JSON.stringify(approved)).toBe(true);

    expect(await balance(secondProductId, "warehouse")).toBe(12);
    expect(await balance(secondProductId, "yard")).toBe(8);
  });

  it("refuses at approval when the source cannot cover it, and says by how much", async () => {
    const { data: entered } = await manager.api.rpc("staff_enter_stock_transfer", {
      p_from_location: "yard",
      p_to_location: "store",
      p_note: null,
      p_lines: [{ product_id: secondProductId, quantity: 500 }],
      p_idempotency_key: randomUUID(),
    });
    expect(entered?.ok).toBe(true);
    const transferId = (entered.transfer as { id: string }).id;

    const { data } = await manager.api.rpc("staff_approve_stock_transfer", {
      p_transfer_id: transferId,
      p_idempotency_key: randomUUID(),
    });

    expect(data?.ok).toBe(false);
    // The LOCATION rule, named as itself since issue #7. A transfer takes nothing out of the
    // business, so it can never consume a customer's promise — the place is the only question it
    // has to answer, and the refusal says which question it failed.
    expect(data.reason).toBe("insufficient_stock_at_location");
    expect(data.location).toBe("yard");
    // The numbers are what make the refusal actionable rather than merely negative.
    expect(Number(data.available)).toBe(8);
    expect(Number(data.requested)).toBe(500);

    expect(await balance(secondProductId, "yard")).toBe(8);
  });
});

describe("manual stock corrections", () => {
  it("is entered by a Manager and approved by a Director, and by nobody else", async () => {
    const { data: refusedEntry } = await director.api.rpc("staff_enter_stock_adjustment", {
      p_product_id: secondProductId,
      p_location_code: "yard",
      p_quantity_delta: -1,
      p_reason: "director should not enter this",
      p_idempotency_key: randomUUID(),
    });
    expect(refusedEntry).toBeNull();

    const { data: entered } = await manager.api.rpc("staff_enter_stock_adjustment", {
      p_product_id: secondProductId,
      p_location_code: "yard",
      p_quantity_delta: -3,
      p_reason: "three missing at the evening count",
      p_idempotency_key: randomUUID(),
    });
    expect(entered?.ok, JSON.stringify(entered)).toBe(true);
    const adjustmentId = (entered.adjustment as { id: string }).id;

    expect(await balance(secondProductId, "yard")).toBe(8);

    const { data: refusedApproval } = await manager.api.rpc("admin_approve_stock_adjustment", {
      p_adjustment_id: adjustmentId,
      p_idempotency_key: randomUUID(),
    });
    expect(refusedApproval).toBeNull();

    const { data: approved } = await director.api.rpc("admin_approve_stock_adjustment", {
      p_adjustment_id: adjustmentId,
      p_idempotency_key: randomUUID(),
    });
    expect(approved?.ok, JSON.stringify(approved)).toBe(true);

    expect(await balance(secondProductId, "yard")).toBe(5);
  });
});

describe("the ledger, from outside the database", () => {
  it("cannot be written, updated or deleted by a signed-in user", async () => {
    const { error: insertError } = await manager.read.from("inventory_ledger").insert({
      product_id: productId,
      location_code: "store",
      stock_state: "available",
      quantity_delta: 999,
      movement_kind: "opening_stock",
      source_type: "forged",
      source_id: randomUUID(),
      actor_id: manager.userId,
      actor_role: "manager",
      approved_by: manager.userId,
      approved_role: "manager",
      correlation_id: randomUUID(),
    });
    expect(insertError, "a Manager invented a stock movement").not.toBeNull();

    const { error: updateError } = await manager.read
      .from("inventory_ledger")
      .update({ quantity_delta: 1 })
      .eq("product_id", productId);
    expect(updateError, "a Manager rewrote a movement").not.toBeNull();

    const { error: deleteError } = await manager.read
      .from("inventory_ledger")
      .delete()
      .eq("product_id", productId);
    expect(deleteError, "a Manager deleted a movement").not.toBeNull();
  });

  it("is unreachable with the SECRET key, which holds no privilege on any stock table", async () => {
    // The §5 grant surface, re-proved for the eight tables this stage added. A leaked secret key
    // must not be able to read the yard, let alone move it.
    for (const table of [
      "inventory_ledger",
      "suppliers",
      "stock_receipts",
      "stock_receipt_lines",
      "stock_transfers",
      "stock_transfer_lines",
      "stock_adjustments",
      "opening_stock_entries",
    ]) {
      const response = await fetch(
        `${process.env.SUPABASE_URL ?? "http://127.0.0.1:54321"}/rest/v1/${table}?select=*`,
        { headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` } },
      );
      expect(response.status, `the secret key read ${table}`).toBe(403);
    }
  });

  it("exposes no stock command to the secret key", async () => {
    const { status } = await callApiRpc(
      "staff_approve_stock_receipt",
      { p_receipt_id: randomUUID(), p_idempotency_key: randomUUID() },
      SECRET_KEY,
    );
    // `service_role` holds EXECUTE on `service_*` alone; a `staff_` function is not its to call.
    expect(status).toBeGreaterThanOrEqual(400);
  });
});

describe("the reads the screens actually make", () => {
  it("resolves every embed the inventory module asks PostgREST for", async () => {
    // Each of these mirrors a select in lib/inventory/inventory.ts. An embed that names a foreign
    // key wrongly type-checks perfectly and fails only here, at the point a real request is made.
    const ledger = await director.read.from("inventory_ledger").select(`
      id, product_id, location_code, quantity_delta, movement_kind, source_type, source_id,
      occurred_at,
      actor:profiles!inventory_ledger_actor_id_fkey(full_name),
      approver:profiles!inventory_ledger_approved_by_fkey(full_name)
    `);
    expect(ledger.error, ledger.error?.message).toBeNull();

    const receipts = await director.read.from("stock_receipts").select(`
      id, supplier_id, location_code, delivery_note_ref, delivery_date, entered_role, entered_at,
      suppliers!inner(name),
      profiles!stock_receipts_entered_by_fkey(full_name)
    `);
    expect(receipts.error, receipts.error?.message).toBeNull();

    const transfers = await director.read.from("stock_transfers").select(`
      id, from_location, to_location, note, entered_at,
      profiles!stock_transfers_entered_by_fkey(full_name)
    `);
    expect(transfers.error, transfers.error?.message).toBeNull();

    const adjustments = await director.read.from("stock_adjustments").select(`
      id, product_id, location_code, quantity_delta, reason, entered_at,
      profiles!stock_adjustments_entered_by_fkey(full_name)
    `);
    expect(adjustments.error, adjustments.error?.message).toBeNull();

    const approvals = await director.read.from("approval_requests").select(`
      entity_id, status, approved_at, approved_role,
      profiles!approval_requests_approved_by_fkey(full_name)
    `);
    expect(approvals.error, approvals.error?.message).toBeNull();

    const decisions = await director.read
      .from("approval_decisions")
      .select(`
        request_id, outcome, note, decided_at, decided_role,
        approval_requests!inner(entity_id, entity_type),
        profiles!approval_decisions_decided_by_fkey(full_name)
      `)
      .eq("approval_requests.entity_type", "stock_receipt");
    expect(decisions.error, decisions.error?.message).toBeNull();
  });

  it("shows a Cashier their own receipt and hides the ledger from them", async () => {
    // §9.1 makes entry delegable, so a Cashier must be able to see what became of their work.
    const own = await cashier.read.from("stock_receipts").select("id, delivery_note_ref");
    expect(own.error, own.error?.message).toBeNull();
    expect((own.data ?? []).length).toBeGreaterThan(0);

    // "Inventory & stock" is a Manager and Director destination (design.md §4.2), and the policy
    // says so rather than the navigation alone.
    const ledger = await cashier.read.from("inventory_ledger").select("id");
    expect(ledger.error).toBeNull();
    expect(ledger.data ?? []).toHaveLength(0);
  });
});

/**
 * The evidence a receipt screen has to be able to show (product.md §4.2, §4.3).
 *
 * §4.2 makes entry and decision two separate facts, each with its own person, role and moment, and
 * the point of storing the ROLE beside each is that a person's role can change afterwards. These
 * read exactly the way `lib/inventory/inventory.ts` reads, because the risk is not that the columns
 * are empty — pgTAP already proves they are written — but that the screen's query cannot reach
 * them, or reaches the wrong one on a rejection.
 */
describe("the accountability record behind a receipt", () => {
  const nameOf = (profiles: unknown): string => {
    const value = profiles as { full_name: string } | { full_name: string }[] | null;
    return (Array.isArray(value) ? value[0]?.full_name : value?.full_name) ?? "";
  };

  async function enterReceipt(who: Fixture, locationCode: string): Promise<string> {
    const { data, error } = await who.api.rpc("staff_enter_stock_receipt", {
      p_supplier_id: supplierId,
      p_location_code: locationCode,
      p_delivery_date: new Date().toISOString().slice(0, 10),
      p_delivery_note_ref: `DN-${randomUUID().slice(0, 6)}`,
      p_lines: [{ product_id: secondProductId, expected_quantity: 12, received_quantity: 12 }],
      p_idempotency_key: randomUUID(),
    });
    expect(error?.message).toBeUndefined();
    expect(data?.ok, JSON.stringify(data)).toBe(true);
    return (data.receipt as { id: string }).id;
  }

  /** The entry half, read the way the screen reads it. */
  async function entryOf(receiptId: string) {
    const { data, error } = await director.read
      .from("stock_receipts")
      .select(`
        id, entered_role, entered_at,
        profiles!stock_receipts_entered_by_fkey(full_name)
      `)
      .eq("id", receiptId)
      .single();
    expect(error, error?.message).toBeNull();
    return data!;
  }

  /** The decision half: the request for an approval, the decision row for a rejection. */
  async function decisionOf(receiptId: string) {
    const request = await director.read
      .from("approval_requests")
      .select(`
        id, entity_id, status, approved_at, approved_role,
        profiles!approval_requests_approved_by_fkey(full_name)
      `)
      .eq("entity_type", "stock_receipt")
      .eq("entity_id", receiptId)
      .single();
    expect(request.error, request.error?.message).toBeNull();

    const decision = await director.read
      .from("approval_decisions")
      .select(`
        request_id, outcome, note, decided_at, decided_role,
        profiles!approval_decisions_decided_by_fkey(full_name)
      `)
      .eq("request_id", request.data!.id as string)
      .order("decided_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    expect(decision.error, decision.error?.message).toBeNull();

    return { request: request.data!, decision: decision.data };
  }

  it("names the enterer, their role and the moment, before anybody has decided", async () => {
    const receiptId = await enterReceipt(cashier, "store");

    const entry = await entryOf(receiptId);
    expect(nameOf(entry.profiles)).toBe("Test cashier");
    // The role AS ENTERED. §9.1 delegates entry to three roles and the record has to say which one
    // actually did it, not merely that somebody was allowed to.
    expect(entry.entered_role).toBe("cashier");
    expect(Date.parse(entry.entered_at as string)).toBeGreaterThan(0);

    // Nothing decided yet, and the record says so rather than showing a blank approver.
    const { request, decision } = await decisionOf(receiptId);
    expect(request.status).toBe("pending");
    expect(request.approved_role).toBeNull();
    expect(request.approved_at).toBeNull();
    expect(nameOf(request.profiles)).toBe("");
    expect(decision).toBeNull();
  });

  it("keeps entry and approval as two separate attributions on an APPROVED receipt", async () => {
    const receiptId = await enterReceipt(cashier, "store");

    const { data: approved } = await manager.api.rpc("staff_approve_stock_receipt", {
      p_receipt_id: receiptId,
      p_idempotency_key: randomUUID(),
    });
    expect(approved?.ok, JSON.stringify(approved)).toBe(true);

    const entry = await entryOf(receiptId);
    const { request } = await decisionOf(receiptId);

    // Two different people in two different roles. The whole value of §4.2 is that these can never
    // collapse into one line saying only that the receipt exists.
    expect(nameOf(entry.profiles)).toBe("Test cashier");
    expect(entry.entered_role).toBe("cashier");

    expect(request.status).toBe("approved");
    expect(nameOf(request.profiles)).toBe("Test manager");
    // `approved_role` is the source for an approval — the screen reads it here, not from the
    // decision row.
    expect(request.approved_role).toBe("manager");
    expect(Date.parse(request.approved_at as string)).toBeGreaterThan(0);

    // Entry came first, and the two moments are genuinely distinct facts.
    expect(Date.parse(request.approved_at as string)).toBeGreaterThanOrEqual(
      Date.parse(entry.entered_at as string),
    );
  });

  it("attributes a REJECTED receipt from the decision, because it has no approver", async () => {
    const receiptId = await enterReceipt(salesRep, "warehouse");

    const { data: rejected } = await manager.api.rpc("staff_reject_stock_receipt", {
      p_receipt_id: receiptId,
      p_reason: "delivery note does not match the load",
      p_idempotency_key: randomUUID(),
    });
    expect(rejected?.ok, JSON.stringify(rejected)).toBe(true);

    const entry = await entryOf(receiptId);
    expect(nameOf(entry.profiles)).toBe("Test sales_rep");
    expect(entry.entered_role).toBe("sales_rep");
    expect(Date.parse(entry.entered_at as string)).toBeGreaterThan(0);

    const { request, decision } = await decisionOf(receiptId);

    // AC-84: a rejection records NO approver. Reading `approved_role` here would render the
    // deciding Manager's role as blank and the rejection as unattributed, which is the exact
    // mistake this pair of assertions exists to catch.
    expect(request.status).toBe("rejected");
    expect(request.approved_role).toBeNull();
    expect(nameOf(request.profiles)).toBe("");

    expect(decision).not.toBeNull();
    expect(decision!.outcome).toBe("rejected");
    expect(nameOf(decision!.profiles)).toBe("Test manager");
    expect(decision!.decided_role).toBe("manager");
    expect(Date.parse(decision!.decided_at as string)).toBeGreaterThan(0);
    expect(decision!.note).toBe("delivery note does not match the load");
  });

  it("tells an approved and a rejected receipt apart across the whole history", async () => {
    const rows = await director.read
      .from("approval_requests")
      .select(`
        entity_id, status, approved_role,
        approval_decisions(outcome, decided_role, decided_at)
      `)
      .eq("entity_type", "stock_receipt");
    expect(rows.error, rows.error?.message).toBeNull();

    const settled = (rows.data ?? []).filter((row) => row.status !== "pending");
    expect(settled.some((row) => row.status === "approved")).toBe(true);
    expect(settled.some((row) => row.status === "rejected")).toBe(true);

    for (const row of settled) {
      // Whichever way it went, exactly one of the two sources carries the decider's role — never
      // neither, which would leave a settled receipt nobody can be held to.
      const decisions = (row.approval_decisions ?? []) as Array<{ decided_role: string | null }>;
      const role = (row.approved_role as string | null) ?? decisions[0]?.decided_role ?? null;
      expect(role, `settled receipt ${row.entity_id} has no decider role`).not.toBeNull();
      if (row.status === "approved") expect(row.approved_role).toBe("manager");
      // A rejection that grew an `approved_role` would be §4.3 broken at the source.
      if (row.status === "rejected") expect(row.approved_role).toBeNull();
    }
  });
});
