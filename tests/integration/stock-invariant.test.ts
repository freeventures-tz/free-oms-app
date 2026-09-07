import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createLiveStaff, ensureDirector, type Fixture } from "@/tests/integration/helpers";

/**
 * One stock-availability rule, over real HTTP and under genuine concurrency (issue #7).
 *
 * pgTAP 015 proves the rule inside the database, in one session, in one transaction. Two things it
 * structurally cannot prove are here instead:
 *
 *   1. THE RULE SURVIVES THE JOURNEY A BROWSER TAKES — a session token, a schema header, a JSON
 *      body — and the refusal arrives with its numbers intact rather than flattened by PostgREST.
 *
 *   2. THE RULE HOLDS UNDER RACE. This is the half the defect actually lived in. Every request
 *      below is a separate session, a separate PostgREST connection and a separate database
 *      transaction, fired with Promise.all, and the assertion is made on the COMMITTED state
 *      afterwards rather than on either call's return value.
 *
 * WHY THE CONCURRENCY TEST WOULD HAVE PASSED BEFORE THE FIX AND STILL BEEN WRONG. Inventory and
 * production locked `<location>:<product>`; sales locked `stock:<product>`. Two commands taking two
 * different keys serialise against nothing, so a reservation and a batch approval could both read
 * "a hundred bags" and both proceed. Neither over-consumed its OWN key, and the yard still went
 * negative. So the assertions below are on `available_quantity` — the §8.1 figure across both
 * mechanisms — never on one command's idea of success.
 *
 * CEMENT, deliberately. It is both a catalogue product a customer buys and a §11.1 recipe input a
 * batch consumes, and the defect lives in exactly that overlap. Every figure is measured as a DELTA
 * against a reading taken at the time, never against an absolute, because this file shares one
 * database with every other integration file and the suite's order is not its business.
 */

let director: Fixture;
let manager: Fixture;
let salesRep: Fixture;

let cementId: string;
let customerId: string;

const YARD = "yard";

beforeAll(async () => {
  director = await ensureDirector();
  manager = await createLiveStaff(director, "manager");
  salesRep = await createLiveStaff(director, "sales_rep");

  const { data: product, error } = await director.read
    .from("products")
    .select("id")
    .eq("name", "Dangote Cement 42R")
    .maybeSingle();
  expect(error, "looking up the seeded cement").toBeNull();
  expect(product, "product.md §6 seeds Dangote Cement 42R").not.toBeNull();
  cementId = (product as { id: string }).id;

  // A price, because an order cannot be written for a product nobody has priced. Already-priced is
  // the §4 rule holding, not a failure of this fixture.
  const { data: priced } = await director.api.rpc("admin_set_product_price", {
    p_product_id: cementId,
    p_price_tzs: 20000,
    p_reason: "stock invariant fixture",
    p_idempotency_key: randomUUID(),
  });
  expect(priced?.ok || priced?.reason === "price_unchanged", JSON.stringify(priced)).toBeTruthy();

  // NO opening stock is recorded here. §3 allows it once per product and location, and
  // `production.test.ts` consumes the same seeded cement — whichever file the runner happens to put
  // first would claim the slot and leave the other's fixture failing. `ensureAvailable` below tops
  // the yard up through the ordinary Manager-enters, Director-approves correction instead, which
  // can run any number of times and in any order.
  const { data: customer } = await salesRep.api.rpc("staff_add_customer", {
    p_name: `Invariant Customer ${randomUUID().slice(0, 8)}`,
    p_idempotency_key: randomUUID(),
  });
  expect(customer?.ok, JSON.stringify(customer)).toBe(true);
  customerId = (customer.customer as { id: string }).id;
});

/** The §8.1 figure, read through a session that obeys RLS. */
async function availability(): Promise<{ physical: number; promised: number; available: number }> {
  const { data, error } = await director.read
    .from("product_availability")
    .select("physical_quantity, reserved_quantity, committed_quantity, available_quantity")
    .eq("product_id", cementId)
    .maybeSingle();

  expect(error, error?.message).toBeNull();
  expect(data, "every product appears in product_availability").not.toBeNull();

  const row = data as Record<string, number>;
  return {
    physical: Number(row.physical_quantity),
    promised: Number(row.reserved_quantity) + Number(row.committed_quantity),
    available: Number(row.available_quantity),
  };
}

/** What one place physically holds, which is the other half of the rule. */
async function locationBalance(location: string): Promise<number> {
  const { data, error } = await director.read
    .from("current_stock")
    .select("quantity")
    .eq("product_id", cementId)
    .eq("location_code", location)
    .eq("stock_state", "available")
    .maybeSingle();

  expect(error, error?.message).toBeNull();
  return data ? Number(data.quantity) : 0;
}

/** An order in proforma, reserving nothing yet. */
async function draftOrder(quantity: number): Promise<string> {
  const { data } = await salesRep.api.rpc("staff_create_order", {
    p_customer_id: customerId,
    p_lines: [{ product_id: cementId, quantity }],
    p_idempotency_key: randomUUID(),
  });
  expect(data?.ok, JSON.stringify(data)).toBe(true);
  return (data.order as { id: string }).id;
}

/**
 * Every recipe input answered for, with only the cement carrying a quantity.
 *
 * `staff_enter_production_batch` refuses `incomplete_recipe_inputs` unless the batch accounts for
 * each input the recipe names (AC-39), and confirming ZERO is one of the answers it accepts — a
 * real one in a yard. The recipe is read from the database rather than listed here so a later
 * recipe change cannot leave this fixture quietly entering nothing.
 *
 * Everything this file asserts is about the cement, because the cement is the product a customer
 * buys AND a batch consumes, and that overlap is where the defect lived.
 */
let cachedRecipe: string[] | null = null;
async function recipeInputs(cementQuantity: number) {
  if (!cachedRecipe) {
    const { data } = await director.read.from("production_recipe_inputs").select("product_id");
    cachedRecipe = (data as { product_id: string }[]).map((row) => row.product_id);
    expect(cachedRecipe.length, "the reference recipe must have inputs").toBeGreaterThan(0);
    expect(cachedRecipe).toContain(cementId);
  }

  return cachedRecipe.map((productId) => ({
    product_id: productId,
    actual_quantity: productId === cementId ? cementQuantity : 0,
  }));
}

/** A batch in draft, consuming nothing yet (§11.1, AC-39). */
async function draftBatch(quantity: number, location = YARD): Promise<string> {
  const { data } = await manager.api.rpc("staff_enter_production_batch", {
    p_location_code: location,
    p_moulded_at: new Date().toISOString(),
    p_inputs: await recipeInputs(quantity),
    p_outputs: [{ product_id: await brickId(), quantity_moulded: 22 }],
    p_yield_note: null,
    p_idempotency_key: randomUUID(),
  });
  expect(data?.ok, JSON.stringify(data)).toBe(true);
  return (data.batch as { id: string }).id;
}

let cachedBrick: string | null = null;
async function brickId(): Promise<string> {
  if (cachedBrick) return cachedBrick;
  const { data } = await director.read
    .from("products")
    .select("id")
    .eq("name", 'Tofali 6"')
    .maybeSingle();
  cachedBrick = (data as { id: string }).id;
  return cachedBrick;
}

/** A correction awaiting a Director, moving nothing yet. */
async function draftAdjustment(delta: number): Promise<string> {
  const { data } = await manager.api.rpc("staff_enter_stock_adjustment", {
    p_product_id: cementId,
    p_location_code: YARD,
    p_quantity_delta: delta,
    p_reason: "stock invariant integration test",
    p_idempotency_key: randomUUID(),
  });
  expect(data?.ok, JSON.stringify(data)).toBe(true);
  return (data.adjustment as { id: string }).id;
}

async function confirmOrder(orderId: string) {
  return salesRep.api.rpc("staff_confirm_order", {
    p_order_id: orderId,
    p_idempotency_key: randomUUID(),
  });
}

async function approveBatch(batchId: string) {
  return manager.api.rpc("staff_approve_production_batch", {
    p_batch_id: batchId,
    p_idempotency_key: randomUUID(),
  });
}

async function approveAdjustment(adjustmentId: string) {
  return director.api.rpc("admin_approve_stock_adjustment", {
    p_adjustment_id: adjustmentId,
    p_idempotency_key: randomUUID(),
  });
}

/**
 * Enough unpromised stock for the test about to run, whatever the one before it left behind.
 *
 * These tests deliberately consume everything there is — that is the only way to reach the boundary
 * the rule guards — and they share one database with every other integration file. Topping up
 * through the ordinary Manager-enters, Director-approves correction path keeps each test
 * independent of the suite's order without reaching around the commands to do it.
 */
async function ensureAvailable(minimum: number): Promise<void> {
  const current = await availability();
  if (current.available >= minimum) return;

  const id = await draftAdjustment(minimum - current.available);
  const { data } = await approveAdjustment(id);
  expect(data?.ok, JSON.stringify(data)).toBe(true);
}

async function cancelOrder(orderId: string) {
  const { data } = await salesRep.api.rpc("staff_cancel_order", {
    p_order_id: orderId,
    p_reason: "stock invariant test teardown",
    p_idempotency_key: randomUUID(),
  });
  expect(data?.ok, JSON.stringify(data)).toBe(true);
}

beforeEach(async () => {
  await ensureAvailable(120);
});

/**
 * Hand the cement back.
 *
 * These tests drain the yard on purpose, and `production.test.ts` consumes the same seeded cement
 * for the same §11.1 reason. Today the file order happens to put that file first, which is not a
 * property worth relying on: restoring the balance makes this file's effect on the shared database
 * nil whichever order the runner picks.
 */
afterAll(async () => {
  await ensureAvailable(400);
});

// ---------------------------------------------------------------------------
// The defect, over HTTP
// ---------------------------------------------------------------------------
describe("a customer's promise, against production", () => {
  it("refuses a batch that would consume reserved stock, and says by how much", async () => {
    const before = await availability();
    expect(before.available, "the fixture needs stock to promise").toBeGreaterThan(10);

    // Everything unpromised is now promised, so the yard is full and none of it may be taken.
    const orderId = await draftOrder(before.available);
    const { data: confirmed } = await confirmOrder(orderId);
    expect(confirmed?.ok, JSON.stringify(confirmed)).toBe(true);

    const reserved = await availability();
    expect(reserved.available).toBe(0);
    expect(reserved.physical, "the bags have NOT moved: this is the trap").toBe(before.physical);

    const batchId = await draftBatch(5);
    const { data: refused } = await approveBatch(batchId);

    expect(refused?.ok).toBe(false);
    expect(refused.reason).toBe("insufficient_stock");

    // The numbers survive PostgREST and arrive in the shape the interface renders.
    expect(Number(refused.available)).toBe(0);
    expect(Number(refused.promised)).toBe(reserved.promised);
    expect(Number(refused.physical)).toBe(reserved.physical);
    expect(Number(refused.requested)).toBe(5);

    // Nothing was consumed by the refusal.
    expect(await availability()).toEqual(reserved);

    await cancelOrder(orderId);
  });

  it("refuses a negative correction for the same reason, through a different command", async () => {
    const before = await availability();
    const orderId = await draftOrder(before.available);
    expect((await confirmOrder(orderId)).data?.ok).toBe(true);

    const adjustmentId = await draftAdjustment(-5);
    const { data: refused } = await approveAdjustment(adjustmentId);

    expect(refused?.ok).toBe(false);
    expect(refused.reason).toBe("insufficient_stock");
    expect(Number(refused.promised)).toBeGreaterThan(0);
    expect(Number(refused.requested)).toBe(5);

    await cancelOrder(orderId);
  });

  it("allows the same batch once the promise is discharged", async () => {
    // The rule is not "production is hard"; it is "a promise is protected". Once nothing is
    // promised, the identical batch goes through and consumes exactly what it asked for.
    const before = await availability();
    expect(before.available).toBeGreaterThan(5);

    const batchId = await draftBatch(5);
    const { data: approved } = await approveBatch(batchId);
    expect(approved?.ok, JSON.stringify(approved)).toBe(true);

    const after = await availability();
    expect(after.available).toBe(before.available - 5);
    expect(after.physical).toBe(before.physical - 5);
  });

  it("keeps the location check as a separate requirement with its own refusal", async () => {
    // The business owns plenty unpromised, so the promise rule passes and the LOCATION rule is what
    // refuses — a different problem needing a different answer. Asked for one more than the store
    // actually holds, read rather than assumed, so the test does not depend on the store being empty.
    const inStore = await locationBalance("store");
    const wanted = inStore + 1;
    const before = await availability();
    expect(before.available).toBeGreaterThan(wanted);

    const batchId = await draftBatch(wanted, "store");
    const { data: refused } = await approveBatch(batchId);

    expect(refused?.ok).toBe(false);
    expect(refused.reason).toBe("insufficient_stock_at_location");
    expect(refused.location).toBe("store");
    expect(Number(refused.requested)).toBe(wanted);
    expect(Number(refused.available)).toBe(inStore);
  });
});

// ---------------------------------------------------------------------------
// The race the two lock keys used to allow
// ---------------------------------------------------------------------------
describe("commands arriving at the same moment", () => {
  it("does not let a reservation and a batch both take the last of the stock", async () => {
    const before = await availability();
    expect(before.available).toBeGreaterThan(0);

    // Both want everything there is. One of them may have it.
    const orderId = await draftOrder(before.available);
    const batchId = await draftBatch(before.available);

    const [order, batch] = await Promise.all([confirmOrder(orderId), approveBatch(batchId)]);

    const succeeded = [order, batch].filter((r) => r.error === null && r.data?.ok === true);
    expect(succeeded.length, "both succeeding is the defect").toBeLessThanOrEqual(1);

    const after = await availability();
    expect(after.available, "availability may reach zero; it may never pass it").toBeGreaterThanOrEqual(0);

    if (order.data?.ok === true) await cancelOrder(orderId);
  });

  it("does not let a batch and a negative correction both take the last of the stock", async () => {
    const before = await availability();
    expect(before.available).toBeGreaterThan(0);

    const batchId = await draftBatch(before.available);
    const adjustmentId = await draftAdjustment(-before.available);

    const [batch, adjustment] = await Promise.all([
      approveBatch(batchId),
      approveAdjustment(adjustmentId),
    ]);

    const succeeded = [batch, adjustment].filter((r) => r.error === null && r.data?.ok === true);
    expect(succeeded.length).toBeLessThanOrEqual(1);
    expect((await availability()).available).toBeGreaterThanOrEqual(0);
  });

  it("survives a burst of competing claims without going negative", async () => {
    // Top the yard back up through the ordinary correction path, so the burst has something to
    // fight over whatever the tests above left behind.
    const topUp = await draftAdjustment(60);
    expect((await approveAdjustment(topUp)).data?.ok).toBe(true);

    const before = await availability();
    expect(before.available).toBeGreaterThanOrEqual(60);

    // Four batches and four orders, each for a quarter of what exists. Eight cannot all succeed.
    const share = Math.floor(before.available / 4);
    const batches = await Promise.all([
      draftBatch(share),
      draftBatch(share),
      draftBatch(share),
      draftBatch(share),
    ]);
    const orders = await Promise.all([
      draftOrder(share),
      draftOrder(share),
      draftOrder(share),
      draftOrder(share),
    ]);

    const results = await Promise.all([
      ...batches.map((id) => approveBatch(id)),
      ...orders.map((id) => confirmOrder(id)),
    ]);

    const after = await availability();
    expect(after.available, "the §8.1 figure must never be negative").toBeGreaterThanOrEqual(0);
    expect(after.physical, "and the yard cannot hold less than nothing").toBeGreaterThanOrEqual(0);

    // Every refusal that happened was the stock rule, not a deadlock or a transport error. A
    // deadlock would surface as `error !== null` and would be a defect of its own: the whole point
    // of one documented lock order is that these commands queue rather than collide.
    for (const result of results) {
      expect(result.error, JSON.stringify(result.error)).toBeNull();
      if (result.data?.ok === false) {
        expect(["insufficient_stock", "insufficient_stock_at_location"]).toContain(
          result.data.reason,
        );
      }
    }

    for (const [index, id] of orders.entries()) {
      if (results[batches.length + index].data?.ok === true) await cancelOrder(id);
    }
  });
});

// ---------------------------------------------------------------------------
// The refusal is on the record (architecture.md §14.2)
// ---------------------------------------------------------------------------
describe("a refusal that committed", () => {
  it("is written to the audit trail with its actor, role, operation and numbers", async () => {
    const before = await availability();
    const orderId = await draftOrder(before.available);
    expect((await confirmOrder(orderId)).data?.ok).toBe(true);

    const batchId = await draftBatch(3);
    const { data: refused } = await approveBatch(batchId);
    expect(refused?.ok).toBe(false);

    const { data: rows, error } = await director.read
      .from("audit_events")
      .select("actor_id, actor_role, entity_type, entity_id, after_state, correlation_id, occurred_at")
      .eq("action", "command_refused")
      .eq("source_operation", "api.staff_approve_production_batch")
      .eq("entity_id", batchId);

    expect(error, error?.message).toBeNull();
    expect(rows, "the refusal committed, so it must be there").toHaveLength(1);

    const row = (rows as Record<string, unknown>[])[0];
    expect(row.actor_id).toBe(manager.userId);
    expect(row.actor_role).toBe("manager");
    expect(row.entity_type).toBe("production_batch");
    expect(row.correlation_id).not.toBeNull();
    expect(row.occurred_at).not.toBeNull();

    const state = row.after_state as Record<string, unknown>;
    expect(state.outcome).toBe("refused");
    expect(state.reason).toBe("insufficient_stock");
    expect(Number(state.requested)).toBe(3);
    expect(Number(state.promised)).toBeGreaterThan(0);

    await cancelOrder(orderId);
  });

  it("records nothing for a command that succeeded", async () => {
    const before = await availability();
    expect(before.available).toBeGreaterThan(2);

    const batchId = await draftBatch(2);
    expect((await approveBatch(batchId)).data?.ok).toBe(true);

    const { count } = await director.read
      .from("audit_events")
      .select("id", { count: "exact", head: true })
      .eq("action", "command_refused")
      .eq("entity_id", batchId);

    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Boundaries this ticket must not have loosened
// ---------------------------------------------------------------------------
describe("the roles that own stock", () => {
  it("still lets nobody but a Director register a supplier or set opening stock", async () => {
    for (const [role, fixture] of [
      ["manager", manager],
      ["sales_rep", salesRep],
    ] as const) {
      const { error: supplierError } = await fixture.api.rpc("admin_add_supplier", {
        p_name: `Refused ${randomUUID().slice(0, 8)}`,
        p_idempotency_key: randomUUID(),
      });
      expect(supplierError, `${role} registering a supplier`).not.toBeNull();

      const { error: openingError } = await fixture.api.rpc("admin_record_opening_stock", {
        p_product_id: cementId,
        p_location_code: "store",
        p_quantity: 1,
        p_note: null,
        p_idempotency_key: randomUUID(),
      });
      expect(openingError, `${role} recording opening stock`).not.toBeNull();
    }
  });

  it("still keeps receipt entry and approval as separate transitions in separate hands", async () => {
    const { data: supplier } = await director.api.rpc("admin_add_supplier", {
      p_name: `Invariant Supplier ${randomUUID().slice(0, 8)}`,
      p_idempotency_key: randomUUID(),
    });
    expect(supplier?.ok, JSON.stringify(supplier)).toBe(true);

    const cashier = await createLiveStaff(director, "cashier");
    const before = await availability();

    const { data: entered } = await cashier.api.rpc("staff_enter_stock_receipt", {
      p_supplier_id: (supplier.supplier as { id: string }).id,
      p_location_code: YARD,
      p_delivery_date: new Date().toISOString().slice(0, 10),
      p_delivery_note_ref: `DN-${randomUUID().slice(0, 8)}`,
      p_lines: [
        { product_id: cementId, expected_quantity: 10, received_quantity: 10, damaged_quantity: 0 },
      ],
      p_idempotency_key: randomUUID(),
    });
    expect(entered?.ok, "a Cashier may ENTER a receipt (§9.1)").toBe(true);

    // Entry moved nothing: the two transitions are separate and only the second one is a movement.
    expect((await availability()).physical).toBe(before.physical);

    const receiptId = (entered.receipt as { id: string }).id;

    const { error: cashierError } = await cashier.api.rpc("staff_approve_stock_receipt", {
      p_receipt_id: receiptId,
      p_idempotency_key: randomUUID(),
    });
    expect(cashierError, "but may not approve it — that is the Manager's (§9.1)").not.toBeNull();

    const { data: approved } = await manager.api.rpc("staff_approve_stock_receipt", {
      p_receipt_id: receiptId,
      p_idempotency_key: randomUUID(),
    });
    expect(approved?.ok, JSON.stringify(approved)).toBe(true);
    expect((await availability()).physical).toBe(before.physical + 10);
  });
});
