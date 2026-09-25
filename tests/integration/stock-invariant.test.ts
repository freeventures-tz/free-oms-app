import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createLiveStaff,
  ensureDirector,
  mouldedJustNow,
  type Fixture,
} from "@/tests/integration/helpers";

/**
 * One stock-availability rule, over real HTTP and under genuine concurrency (issue #7).
 *
 * pgTAP 014 proves the rule inside the database, in one session, in one transaction. Two things it
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
/** The till. §12.4 gives the walk-in sale and §12.5 the settlement to this role. */
let cashier: Fixture;

let cementId: string;
/** A SECOND product a batch consumes and a customer buys, for the overlapping-product races. */
let sandId: string;
let customerId: string;
/** §12.4's permanent one-click row, which is what a walk-in sale is written against. */
let cashCustomerId: string;
/** §3.2: someone who moves goods but does not use the system. Every dispatch names one. */
let storekeeperId: string;

const YARD = "yard";
const UNIT_PRICE = 20_000;

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

  // ---------------------------------------------------------------------
  // The rest of the cast, for the committed-stock and cross-command races
  // ---------------------------------------------------------------------
  cashier = await createLiveStaff(director, "cashier");

  const { data: sand } = await director.read
    .from("products")
    .select("id")
    .eq("name", "Sand")
    .maybeSingle();
  expect(sand, "product.md §6 seeds Sand, which §11.1 also makes a recipe input").not.toBeNull();
  sandId = (sand as { id: string }).id;

  // Sand is priced too, because the overlapping-product race sells it as well as consuming it.
  const { data: sandPriced } = await director.api.rpc("admin_set_product_price", {
    p_product_id: sandId,
    p_price_tzs: UNIT_PRICE,
    p_reason: "stock invariant fixture",
    p_idempotency_key: randomUUID(),
  });
  expect(
    sandPriced?.ok || sandPriced?.reason === "price_unchanged",
    JSON.stringify(sandPriced),
  ).toBeTruthy();

  // §12.4 seeds exactly one Cash Customer, forever. It is found, never created.
  const { data: cash } = await salesRep.read
    .from("customers")
    .select("id")
    .eq("is_cash_customer", true)
    .maybeSingle();
  expect(cash, "product.md §12.4 seeds the permanent Cash Customer").not.toBeNull();
  cashCustomerId = (cash as { id: string }).id;

  // One storekeeper for the whole file. Already-registered is the rule holding, not a failure.
  const { data: keeper } = await director.api.rpc("admin_add_storekeeper", {
    p_full_name: `Invariant Storekeeper ${randomUUID().slice(0, 8)}`,
    p_phone: `07${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
    p_start_date: new Date().toISOString().slice(0, 10),
    p_note: null,
    p_idempotency_key: randomUUID(),
  });
  expect(keeper?.ok, JSON.stringify(keeper)).toBe(true);
  storekeeperId = (keeper.storekeeper as { id: string }).id;
});

/**
 * The §8.1 figures, read through a session that obeys RLS.
 *
 * RESERVED AND COMMITTED ARE REPORTED SEPARATELY as well as summed. §8.1 lists them as two states
 * of one promise and subtracts both, but they are not interchangeable — a claim moves from one to
 * the other when the customer pays — and a test that only ever saw the sum could not tell whether
 * a refusal was protecting an unpaid order or a paid one.
 */
type Availability = {
  physical: number;
  reserved: number;
  committed: number;
  promised: number;
  available: number;
};

async function availabilityOf(productId: string): Promise<Availability> {
  const { data, error } = await director.read
    .from("product_availability")
    .select("physical_quantity, reserved_quantity, committed_quantity, available_quantity")
    .eq("product_id", productId)
    .maybeSingle();

  expect(error, error?.message).toBeNull();
  expect(data, "every product appears in product_availability").not.toBeNull();

  const row = data as Record<string, number>;
  return {
    physical: Number(row.physical_quantity),
    reserved: Number(row.reserved_quantity),
    committed: Number(row.committed_quantity),
    promised: Number(row.reserved_quantity) + Number(row.committed_quantity),
    available: Number(row.available_quantity),
  };
}

async function availability(): Promise<Availability> {
  return availabilityOf(cementId);
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
    p_moulded_at: mouldedJustNow(),
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

/**
 * A batch consuming SEVERAL products at once, for the overlapping-product race.
 *
 * `draftBatch` above puts the whole quantity on the cement because every other test in this file
 * is about one product. This one names each product it wants and confirms the rest of the recipe at
 * zero, which is what lets two batches contend for two products simultaneously.
 */
async function draftBatchOf(
  lines: { productId: string; quantity: number }[],
  location = YARD,
): Promise<string> {
  const wanted = new Map(lines.map((line) => [line.productId, line.quantity]));

  if (!cachedRecipe) await recipeInputs(0);
  for (const productId of wanted.keys()) {
    expect(cachedRecipe, "every product raced here must be a recipe input").toContain(productId);
  }

  const { data } = await manager.api.rpc("staff_enter_production_batch", {
    p_location_code: location,
    p_moulded_at: mouldedJustNow(),
    p_inputs: cachedRecipe!.map((productId) => ({
      product_id: productId,
      actual_quantity: wanted.get(productId) ?? 0,
    })),
    p_outputs: [{ product_id: await brickId(), quantity_moulded: 22 }],
    p_yield_note: null,
    p_idempotency_key: randomUUID(),
  });
  expect(data?.ok, JSON.stringify(data)).toBe(true);
  return (data.batch as { id: string }).id;
}

/** A correction on any product, not only the cement. */
async function draftAdjustmentOf(productId: string, delta: number): Promise<string> {
  const { data } = await manager.api.rpc("staff_enter_stock_adjustment", {
    p_product_id: productId,
    p_location_code: YARD,
    p_quantity_delta: delta,
    p_reason: "stock invariant integration test",
    p_idempotency_key: randomUUID(),
  });
  expect(data?.ok, JSON.stringify(data)).toBe(true);
  return (data.adjustment as { id: string }).id;
}

/** What one location holds of one product, in the available state. */
async function balanceOf(productId: string, location: string): Promise<number> {
  const { data, error } = await director.read
    .from("current_stock")
    .select("quantity")
    .eq("product_id", productId)
    .eq("location_code", location)
    .eq("stock_state", "available")
    .maybeSingle();

  expect(error, error?.message).toBeNull();
  return data ? Number((data as { quantity: number | string }).quantity) : 0;
}

/** Every location holding this product, so the fixture can see what it does not control. */
async function locationsHolding(
  productId: string,
): Promise<Array<{ location: string; quantity: number }>> {
  const { data, error } = await director.read
    .from("current_stock")
    .select("location_code, quantity")
    .eq("product_id", productId)
    .eq("stock_state", "available");

  expect(error, error?.message).toBeNull();
  return ((data ?? []) as Array<{ location_code: string; quantity: number | string }>)
    .map((row) => ({ location: row.location_code, quantity: Number(row.quantity) }))
    .filter((row) => row.quantity !== 0);
}

/** A correction at ANY location, through the ordinary two-hand path. */
async function correctAt(productId: string, location: string, delta: number): Promise<void> {
  const { data } = await manager.api.rpc("staff_enter_stock_adjustment", {
    p_product_id: productId,
    p_location_code: location,
    p_quantity_delta: delta,
    p_reason: "stock invariant integration test",
    p_idempotency_key: randomUUID(),
  });
  expect(data?.ok, JSON.stringify(data)).toBe(true);

  const { data: approved } = await approveAdjustment((data.adjustment as { id: string }).id);
  expect(approved?.ok, JSON.stringify(approved)).toBe(true);
}

/**
 * A determinate position for a race whose commands ask TWO questions.
 *
 * `private.claim_stock_for_withdrawal` refuses on two separate grounds: the business must own the
 * quantity unpromised — a product-wide figure — and the PLACE must physically hold it. Setting
 * availability alone satisfies the first and says nothing about the second, so the yard can be short
 * while availability reads exactly right, and a batch is then refused for the LOCATION with
 * availability still positive. The arithmetic below reads that as stock nobody claimed, because from
 * where it stands that is what it looks like.
 *
 * Demonstrated rather than assumed: with six units of sand at the store, availability reads 60 while
 * the yard holds 54, and two of the four commands are refused `insufficient_stock_at_location` for
 * 24 against 30. The same race from the position this establishes refuses only for
 * `insufficient_stock`, which is the resource genuinely running out.
 *
 * So this brings BOTH to a stated position: nothing left anywhere these four commands do not look,
 * and the yard carrying the promises as well as the target, because availability is physical minus
 * what is promised.
 */
async function setRaceStock(productId: string, target: number): Promise<void> {
  for (const row of await locationsHolding(productId)) {
    if (row.location !== YARD && row.quantity > 0) {
      await correctAt(productId, row.location, -row.quantity);
    }
  }

  const before = await availabilityOf(productId);
  const wantAtYard = target + before.promised;
  const atYard = await balanceOf(productId, YARD);
  if (atYard !== wantAtYard) await correctAt(productId, YARD, wantAtYard - atYard);

  expect(
    (await availabilityOf(productId)).available,
    "the business owns exactly the target, unpromised",
  ).toBe(target);
  expect(
    await balanceOf(productId, YARD),
    "and the yard holds enough of it to serve every claim",
  ).toBeGreaterThanOrEqual(target);
  expect(
    (await locationsHolding(productId)).filter((row) => row.location !== YARD),
    "with nothing left where none of these commands looks",
  ).toEqual([]);
}

/**
 * Availability moved to an EXACT figure, up or down, through the ordinary correction path.
 *
 * A race can only require a determinate outcome if it starts from a determinate position.
 * `ensureAvailable` tops up to a floor, which leaves whatever the previous test happened to
 * finish with — enough for "nothing went negative", not enough to say how many commands had to
 * succeed.
 */
async function setAvailableTo(productId: string, target: number): Promise<void> {
  const current = await availabilityOf(productId);
  if (current.available === target) return;

  const id = await draftAdjustmentOf(productId, target - current.available);
  const { data } = await approveAdjustment(id);
  expect(data?.ok, JSON.stringify(data)).toBe(true);
  expect((await availabilityOf(productId)).available).toBe(target);
}

/**
 * An order for the Cash Customer, confirmed and waiting at the till (§12.4).
 *
 * IT IS CONFIRMED AND STILL RESERVES NOTHING, which is the whole shape of the walk-in path and the
 * reason this races the way it does. `staff_confirm_order` branches on the cash sale and returns
 * `confirmed_cash_sale` WITHOUT writing an allocation; `staff_take_cash_payment` is the single
 * command that takes the stock, invoices it and settles it together, and it creates the claim
 * already COMMITTED because the money is already in. So the §8.1 contention is at payment, not at
 * confirmation, and that is the moment worth racing a batch against.
 */
async function draftCashOrder(quantity: number, productId = cementId): Promise<string> {
  const { data } = await salesRep.api.rpc("staff_create_order", {
    p_customer_id: cashCustomerId,
    p_lines: [{ product_id: productId, quantity }],
    p_idempotency_key: randomUUID(),
  });
  expect(data?.ok, JSON.stringify(data)).toBe(true);
  const orderId = (data.order as { id: string }).id;

  const { data: confirmed } = await salesRep.api.rpc("staff_confirm_order", {
    p_order_id: orderId,
    p_idempotency_key: randomUUID(),
  });
  expect(confirmed?.ok, JSON.stringify(confirmed)).toBe(true);
  expect(
    confirmed.reason,
    "a cash sale confirms without reserving; the till is what takes the stock",
  ).toBe("confirmed_cash_sale");

  return orderId;
}

/** The till taking the money for a walk-in, in full, which §12.4 requires. */
async function takeCashPayment(orderId: string, quantity: number) {
  return cashier.api.rpc("staff_take_cash_payment", {
    p_order_id: orderId,
    p_method: "cash",
    p_amount_tzs: quantity * UNIT_PRICE,
    p_idempotency_key: randomUUID(),
  });
}

/**
 * A claim carried all the way from RESERVED to COMMITTED: confirmed, paid in full, settled.
 *
 * This is the state the review found untested. Everything else in this file refuses against a
 * reservation — an order somebody might still cancel. Once the money is in, §8 says the goods stay
 * physically present and cannot be sold again, so the rule has to hold harder here, not less.
 */
async function commitStock(quantity: number): Promise<{ invoiceId: string; allocationId: string }> {
  const orderId = await draftOrder(quantity);

  const { data: confirmed } = await confirmOrder(orderId);
  expect(confirmed?.ok, JSON.stringify(confirmed)).toBe(true);
  const invoiceId = (confirmed.invoice as { id: string }).id;

  const { data: paid } = await cashier.api.rpc("staff_record_payment", {
    p_invoice_id: invoiceId,
    p_method: "cash",
    p_amount_tzs: quantity * UNIT_PRICE,
    p_idempotency_key: randomUUID(),
  });
  expect(paid?.ok, JSON.stringify(paid)).toBe(true);

  const { data: settled } = await cashier.api.rpc("staff_approve_settlement", {
    p_invoice_id: invoiceId,
    p_idempotency_key: randomUUID(),
  });
  expect(settled?.ok, JSON.stringify(settled)).toBe(true);

  const { data: allocation } = await director.read
    .from("stock_allocations")
    .select("id, state, quantity")
    .eq("product_id", cementId)
    .eq("state", "committed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  expect(allocation, "settlement commits the claim").not.toBeNull();

  return { invoiceId, allocationId: (allocation as { id: string }).id };
}

/** Assigned to a storekeeper and given its paper number — still moving nothing (§14). */
async function assignDispatch(
  invoiceId: string,
  allocationId: string,
  quantity: number,
  location: string,
): Promise<string> {
  const { data } = await cashier.api.rpc("staff_assign_dispatch", {
    p_invoice_id: invoiceId,
    p_storekeeper_id: storekeeperId,
    p_source_location: location,
    p_lines: [{ allocation_id: allocationId, quantity }],
    p_idempotency_key: randomUUID(),
  });
  expect(data?.ok, JSON.stringify(data)).toBe(true);

  const dispatchId = (data.dispatch as { id: string }).id;

  const { data: noted } = await manager.api.rpc("staff_record_dispatch_note", {
    p_dispatch_id: dispatchId,
    p_note_no: `DN-${randomUUID().slice(0, 8).toUpperCase()}`,
    p_idempotency_key: randomUUID(),
  });
  expect(noted?.ok, JSON.stringify(noted)).toBe(true);

  return dispatchId;
}

/** The signature that lets goods leave (§14). Takes the LOCATION key alone, and no more. */
async function confirmRelease(dispatchId: string) {
  return manager.api.rpc("staff_confirm_release", {
    p_dispatch_id: dispatchId,
    p_idempotency_key: randomUUID(),
  });
}

/**
 * Every result of a concurrent burst reached the database and came back.
 *
 * A DEADLOCK OR A DROPPED CONNECTION IS NOT A REFUSAL, and the difference is the whole point of one
 * documented lock order. Without this, "nobody succeeded" would satisfy a test that only counted
 * successes — which is precisely the hole the review found in the two races below.
 */
function expectNoTransportFailure(results: { error: unknown; data?: unknown }[]): void {
  for (const result of results) {
    expect(result.error, `a command failed in transport: ${JSON.stringify(result.error)}`).toBeNull();

    // AND IT ANSWERED IN THE SHAPE IT PROMISES. A null body, an array, or a missing `ok` is not a
    // refusal and must not be counted as one: PostgREST answers a raised exception with no body at
    // all, and a proxy can produce one with no error beside it. Without this, "not ok" would
    // quietly include "did not answer".
    const body = result.data;
    expect(
      body !== null && typeof body === "object" && !Array.isArray(body),
      `a command answered with ${body === null ? "null" : typeof body}: ${JSON.stringify(body)}`,
    ).toBe(true);
    expect(
      typeof (body as Record<string, unknown>).ok,
      `a command answered without a boolean ok: ${JSON.stringify(body)}`,
    ).toBe("boolean");
  }
}

/** The refusals a stock command is allowed to give. Anything else is a defect wearing a reason. */
const STOCK_REFUSALS = ["insufficient_stock", "insufficient_stock_at_location"];

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

    // BOTH REACHED THE DATABASE. Asserted before anything is counted, because two commands that
    // deadlocked would otherwise look like a well-behaved race with one winner — or with none.
    expectNoTransportFailure([order, batch]);

    const succeeded = [order, batch].filter((r) => r.data?.ok === true);
    const refused = [order, batch].filter((r) => r.data?.ok === false);

    // EXACTLY one, not at most one. Both wanted everything there is, and one of them can have it:
    // "neither succeeded" is a serialisation failure, not a safe outcome, and this is what the
    // earlier `toBeLessThanOrEqual(1)` could not tell apart.
    expect(succeeded.length, "exactly one of the two may take the last of the stock").toBe(1);
    expect(refused.length).toBe(1);
    expect(STOCK_REFUSALS, JSON.stringify(refused[0].data)).toContain(refused[0].data.reason);

    const after = await availability();
    expect(after.available, "availability may reach zero; it may never pass it").toBeGreaterThanOrEqual(0);

    // EXACT, not merely non-negative. Whichever won took the whole of what was there.
    expect(after.available).toBe(0);
    if (batch.data?.ok === true) {
      expect(after.physical, "the batch consumed it").toBe(before.physical - before.available);
      expect(after.promised).toBe(before.promised);
    } else {
      expect(after.physical, "the reservation moved nothing").toBe(before.physical);
      expect(after.promised).toBe(before.promised + before.available);
    }

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

    expectNoTransportFailure([batch, adjustment]);

    const succeeded = [batch, adjustment].filter((r) => r.data?.ok === true);
    const refused = [batch, adjustment].filter((r) => r.data?.ok === false);

    expect(succeeded.length, "exactly one of the two may take the last of the stock").toBe(1);
    expect(refused.length).toBe(1);
    expect(STOCK_REFUSALS, JSON.stringify(refused[0].data)).toContain(refused[0].data.reason);

    // Both take stock OUT of the business, so whichever won, the arithmetic is the same.
    const after = await availability();
    expect(after.available).toBe(0);
    expect(after.physical).toBe(before.physical - before.available);
    expect(after.promised).toBe(before.promised);
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
// COMMITTED stock — the half of §8.1 the reservation tests never reach
//
// Every refusal above protects a RESERVED claim: an order confirmed and not yet paid, which the
// customer might still cancel. §8.1 subtracts committed stock by the same arithmetic, and §8 is
// blunter about why: paid items remain physically present until signature and cannot be sold
// again. So the rule has to hold at least as hard once the money is in — and then the dispatch it
// protected has to go out, which is the entire purpose of refusing anything.
// ---------------------------------------------------------------------------
describe("stock a customer has already paid for", () => {
  it("refuses production and a write-off while committed, then lets the dispatch out", async () => {
    const start = await availability();

    const promisedQuantity = 40;
    const { invoiceId, allocationId } = await commitStock(promisedQuantity);

    const committed = await availability();
    expect(committed.committed, "settlement moved the claim into committed").toBe(
      start.committed + promisedQuantity,
    );
    expect(committed.reserved, "and out of reserved").toBe(start.reserved);
    expect(committed.physical, "the bags have not moved").toBe(start.physical);
    expect(committed.available).toBe(start.available - promisedQuantity);

    // MORE than is free, LESS than is physically there: the location can supply it and the
    // business cannot. That gap is exactly what the committed claim creates.
    const overreach = committed.available + 10;
    expect(overreach, "the fixture needs the yard to hold more than is free").toBeLessThanOrEqual(
      await locationBalance(YARD),
    );

    const batchId = await draftBatch(overreach);
    const { data: refusedBatch, error: batchError } = await approveBatch(batchId);

    expect(batchError, JSON.stringify(batchError)).toBeNull();
    expect(refusedBatch?.ok).toBe(false);
    expect(refusedBatch.reason).toBe("insufficient_stock");
    expect(Number(refusedBatch.available)).toBe(committed.available);
    expect(Number(refusedBatch.promised)).toBe(committed.promised);
    expect(Number(refusedBatch.physical)).toBe(committed.physical);
    expect(Number(refusedBatch.requested)).toBe(overreach);

    const adjustmentId = await draftAdjustment(-overreach);
    const { data: refusedWriteOff, error: writeOffError } = await approveAdjustment(adjustmentId);

    expect(writeOffError, JSON.stringify(writeOffError)).toBeNull();
    expect(refusedWriteOff?.ok).toBe(false);
    expect(refusedWriteOff.reason).toBe("insufficient_stock");
    expect(Number(refusedWriteOff.promised)).toBe(committed.promised);

    // Two refusals, and not one figure moved by either.
    const afterRefusals = await availability();
    expect(afterRefusals).toEqual(committed);

    // ---------------------------------------------------------------------
    // And now the point of all of it: the customer gets their goods.
    // ---------------------------------------------------------------------
    const dispatchId = await assignDispatch(invoiceId, allocationId, promisedQuantity, YARD);
    const { data: released, error: releaseError } = await confirmRelease(dispatchId);

    expect(releaseError, JSON.stringify(releaseError)).toBeNull();
    expect(released?.ok, JSON.stringify(released)).toBe(true);

    // The ledger falls by what left AND the claim that covered it falls with it, so the §8.1
    // figure is unmoved. That is why a release needs no product lock.
    const afterRelease = await availability();
    expect(afterRelease.physical).toBe(committed.physical - promisedQuantity);
    expect(afterRelease.committed).toBe(start.committed);
    expect(afterRelease.reserved).toBe(start.reserved);
    expect(afterRelease.available, "availability is unchanged by a release").toBe(
      committed.available,
    );
  });
});

// ---------------------------------------------------------------------------
// The two sales commands this ticket did NOT re-issue, raced against the two it did
//
// Scope kept `staff_take_cash_payment` and `staff_confirm_release` out of migration 36 — Stage 12B
// re-issues them. The claim made for that decision is that nothing is unprotected by the wait:
// the walk-in already takes `stock:<product>`, and release takes the location key alone and needs
// no more. A claim of that shape is worth exactly as much as the test that fires the commands at
// each other, which is what this block does.
// ---------------------------------------------------------------------------
describe("the sales commands that were left alone", () => {
  it("does not let a walk-in sale and a batch both take the last of the stock", async () => {
    const before = await availability();
    expect(before.available).toBeGreaterThan(0);

    const orderId = await draftCashOrder(before.available);
    const batchId = await draftBatch(before.available);

    const [sale, batch] = await Promise.all([
      takeCashPayment(orderId, before.available),
      approveBatch(batchId),
    ]);

    expectNoTransportFailure([sale, batch]);

    const succeeded = [sale, batch].filter((r) => r.data?.ok === true);
    const refused = [sale, batch].filter((r) => r.data?.ok === false);

    expect(succeeded.length, "the till and the yard cannot both have it").toBe(1);
    expect(refused.length).toBe(1);

    const after = await availability();
    expect(after.available, "and the figure lands exactly on zero").toBe(0);

    if (sale.data?.ok === true) {
      // A walk-in is paid at the till, so the claim is COMMITTED the moment it exists (§12.4).
      expect(refused[0].data.reason).toBe("insufficient_stock");
      expect(after.committed).toBe(before.committed + before.available);
      expect(after.physical).toBe(before.physical);
    } else {
      expect(STOCK_REFUSALS, JSON.stringify(refused[0].data)).toContain(refused[0].data.reason);
      expect(after.physical).toBe(before.physical - before.available);
      expect(after.promised).toBe(before.promised);
    }
  });

  it("lets a release, a batch and a write-off through together, claiming different things", async () => {
    const start = await availability();

    const promisedQuantity = 30;
    const { invoiceId, allocationId } = await commitStock(promisedQuantity);
    const dispatchId = await assignDispatch(invoiceId, allocationId, promisedQuantity, YARD);

    const committed = await availability();

    // BOTH changed commands, raced against the release at once. The batch and the write-off split
    // the UNPROMISED remainder exactly between them, so all three may succeed and any refusal is a
    // finding: the release discharges a claim that was already subtracted, and neither of the other
    // two touches the goods it is carrying out. All three want the same LOCATION in the same
    // moment, which is the contention the shared location key exists to order rather than refuse.
    const forBatch = Math.floor(committed.available / 2);
    const forWriteOff = committed.available - forBatch;
    expect(forBatch, "the remainder has to split into two real halves").toBeGreaterThan(0);

    const batchId = await draftBatch(forBatch);
    const writeOffId = await draftAdjustment(-forWriteOff);

    const [release, batch, writeOff] = await Promise.all([
      confirmRelease(dispatchId),
      approveBatch(batchId),
      approveAdjustment(writeOffId),
    ]);

    expectNoTransportFailure([release, batch, writeOff]);
    expect(release.data?.ok, JSON.stringify(release.data)).toBe(true);
    expect(batch.data?.ok, JSON.stringify(batch.data)).toBe(true);
    expect(writeOff.data?.ok, JSON.stringify(writeOff.data)).toBe(true);

    const after = await availability();
    expect(after.physical, "all three movements left the ledger").toBe(
      committed.physical - promisedQuantity - committed.available,
    );
    expect(after.committed, "the claim went out with the goods").toBe(start.committed);
    expect(after.reserved).toBe(start.reserved);
    expect(after.available, "and the yard is empty of unpromised stock").toBe(0);
  });

  it("keeps two products straight when four commands take them at once", async () => {
    // OVERLAPPING PRODUCTS, which is the case one product can never exercise: four commands, two
    // products, one moment.
    //
    // THE INPUT ORDER IS NOT THE LOCK ORDER, and an earlier version of this comment claimed the two
    // batches were sent in opposite orders when both arrays are built the same way. They are, and it
    // would make no difference if they were not: `api.staff_approve_production_batch` reads its
    // inputs `order by product_id`, so the caller cannot choose the order the locks are taken in.
    // That is exactly the property being relied on — the ordering is the command's, not the
    // caller's — and it is why four commands crossing two products queue rather than deadlock. A
    // deadlock would surface as a transport error rather than a refusal, which is what
    // `expectNoTransportFailure` separates below.
    //
    // BOTH PRODUCTS ARE SET TO EXACTLY TWICE THE SHARE, because that is what turns "nothing went
    // negative" into a claim about progress. With 2q of each and four commands wanting q —
    // two batches taking q of BOTH, a walk-in taking q of the cement, a write-off taking q of the
    // sand — the arithmetic is determinate:
    //
    //   · no more than 2q of either product can be taken, so at most two of the four claims on
    //     each product can win;
    //   · whichever order the locks are granted in, the yard ends at exactly zero available for
    //     both products — every unit that could be claimed is claimed;
    //   · and therefore AT LEAST TWO commands must succeed. Two batches alone drain both products;
    //     any other winning combination needs three. One success cannot drain 2q of both, and zero
    //     successes is not a safe outcome — it is a serialisation failure wearing the same face.
    const share = 30;
    await setRaceStock(cementId, 2 * share);
    await setRaceStock(sandId, 2 * share);

    const cement = await availability();
    const sand = await availabilityOf(sandId);

    // Two batches, each consuming BOTH products; a walk-in taking cement; a write-off taking sand.
    const batchOne = await draftBatchOf([
      { productId: cementId, quantity: share },
      { productId: sandId, quantity: share },
    ]);
    const batchTwo = await draftBatchOf([
      { productId: cementId, quantity: share },
      { productId: sandId, quantity: share },
    ]);
    const cashOrderId = await draftCashOrder(share);
    const writeOffId = await draftAdjustmentOf(sandId, -share);

    const results = await Promise.all([
      approveBatch(batchOne),
      approveBatch(batchTwo),
      takeCashPayment(cashOrderId, share),
      approveAdjustment(writeOffId),
    ]);

    // NOT ONE of the four failed in transport. Four commands crossing two products in one moment
    // is the deadlock case, and one documented lock order is the only reason it is not one.
    expectNoTransportFailure(results);

    for (const result of results) {
      if (result.data?.ok === false) {
        expect(STOCK_REFUSALS, JSON.stringify(result.data)).toContain(result.data.reason);
      }
    }

    // EXACT finals for both products, derived from which commands actually reported success —
    // deterministic given the outcome, rather than a range that would accept anything.
    const [one, two, sale, writeOff] = results;
    const wonOne = one.data?.ok === true;
    const wonTwo = two.data?.ok === true;
    const wonSale = sale.data?.ok === true;
    const wonWriteOff = writeOff.data?.ok === true;

    const cementConsumed = (wonOne ? share : 0) + (wonTwo ? share : 0);
    const sandConsumed = (wonOne ? share : 0) + (wonTwo ? share : 0) + (wonWriteOff ? share : 0);

    const cementAfter = await availability();
    const sandAfter = await availabilityOf(sandId);

    expect(cementAfter.physical).toBe(cement.physical - cementConsumed);
    expect(cementAfter.committed).toBe(cement.committed + (wonSale ? share : 0));
    expect(cementAfter.available).toBe(cement.available - cementConsumed - (wonSale ? share : 0));

    expect(sandAfter.physical).toBe(sand.physical - sandConsumed);
    expect(sandAfter.promised).toBe(sand.promised);
    expect(sandAfter.available).toBe(sand.available - sandConsumed);

    // Neither product may pass through zero, whoever won.
    expect(cementAfter.available).toBeGreaterThanOrEqual(0);
    expect(sandAfter.available).toBeGreaterThanOrEqual(0);

    // ---------------------------------------------------------------------
    // SUCCESSFUL PROGRESS, required rather than hoped for
    //
    // Everything above would be satisfied by four refusals: no transport failure, no negative
    // figure, exact finals of "nothing moved". That is not the system working, it is the system
    // refusing everybody, and the two are told apart here.
    // ---------------------------------------------------------------------
    const succeeded = results.filter((result) => result.data?.ok === true).length;
    expect(
      succeeded,
      `at least two of the four had to get through; ${succeeded} did: ` +
        JSON.stringify(results.map((r) => r.data?.reason ?? r.error)),
    ).toBeGreaterThanOrEqual(2);

    // And every unit that could be claimed WAS claimed: 2q of each product, gone, with no room
    // left over. A run that refused a command it could have served would land above zero here.
    expect(cementAfter.available, "the cement is fully claimed").toBe(0);
    expect(sandAfter.available, "and so is the sand").toBe(0);
    expect(cementConsumed + (wonSale ? share : 0), "2q of cement claimed").toBe(2 * share);
    expect(sandConsumed, "2q of sand claimed").toBe(2 * share);
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
