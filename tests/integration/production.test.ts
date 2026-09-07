import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  PUBLISHABLE_KEY,
  SECRET_KEY,
  SUPABASE_URL,
  callApiRpc,
  createGatedStaff,
  createLiveStaff,
  ensureDirector,
  signInWithPhone,
  clientForToken,
  type Fixture,
} from "@/tests/integration/helpers";

/**
 * Brick production, over real HTTP through PostgREST.
 *
 * pgTAP proves the rules inside the database. These tests prove the same rules survive the journey
 * a browser takes — a session token, a schema header, a JSON body — which is the layer where a
 * missing grant, an unexposed function or an embed that does not resolve shows up.
 *
 * They also cover three things pgTAP structurally cannot:
 *
 *   · Reaching AROUND the commands. A direct `POST /rest/v1/production_batches` as `authenticated`
 *     runs as a role a GRANT actually constrains, unlike a pgTAP statement running as the owner.
 *   · Two commands arriving together, in two sessions, against one row or one balance.
 *   · A session whose authority changed after it was issued.
 *
 * THE WHOLE FLOW RUNS HERE, INSPECTION INCLUDED, and the way it reaches a cured lot is ordinary use
 * of the product rather than a way around the countdown: §11.4 starts curing at the actual
 * moulding-completion time and the command refuses only a time in the FUTURE, so a batch recorded as
 * moulded four days ago is a Manager entering Monday's work on Thursday. The countdown itself is
 * proved by a batch moulded moments earlier, which stays shut.
 *
 * Production runs on the SEEDED catalogue rather than on fresh products: §11.1 fixes the recipe and
 * §11.2 fixes the two brick sizes, so a made-up product is not a thing a batch can consume or
 * produce. Every quantity below is therefore asserted as a DELTA against a measured opening
 * balance, never against an absolute the rest of the suite could have moved.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED: that a batch is refused when the materials it wants are
 * already promised to a customer. product.md §8.1 requires that, and v0.0.5 does not do it — this
 * release checks the location's physical balance, exactly as the released transfer and correction
 * commands do. A test claiming otherwise would be a green assertion for behaviour that is not there.
 */

let director: Fixture;
let manager: Fixture;
let cashier: Fixture;
let salesRep: Fixture;

let cementId: string;
let sandId: string;
let aggregateId: string;
let brick6Id: string;
let brick5Id: string;

const LOCATION = "yard";
const OTHER_LOCATION = "store";

/** Long enough ago that the 72 hours of §11.4 have already elapsed. */
function mouldedFourDaysAgo(): string {
  return new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
}

beforeAll(async () => {
  director = await ensureDirector();
  manager = await createLiveStaff(director, "manager");
  cashier = await createLiveStaff(director, "cashier");
  salesRep = await createLiveStaff(director, "sales_rep");

  cementId = await seededProduct("Dangote Cement 42R");
  sandId = await seededProduct("Sand");
  aggregateId = await seededProduct("Aggregate");
  brick6Id = await seededProduct('Tofali 6"');
  brick5Id = await seededProduct('Tofali 5"');

  // Enough for every batch below, however the suite is ordered. Opening stock is once per product
  // and location, so a second run of this file finds it already recorded — which is not a failure,
  // it is the rule working. The balance is what matters, and it is measured, never assumed.
  await stockUp(cementId, 500);
  await stockUp(sandId, 500);
  await stockUp(aggregateId, 500);
});

async function seededProduct(name: string): Promise<string> {
  const { data, error } = await director.read
    .from("products")
    .select("id")
    .eq("name", name)
    .limit(1)
    .maybeSingle();

  expect(error, `looking up ${name}`).toBeNull();
  expect(data, `product.md §6 seeds ${name}`).not.toBeNull();
  return (data as { id: string }).id;
}

/** Puts an opening balance in the yard, tolerating one that a previous run already recorded. */
async function stockUp(productId: string, quantity: number, location = LOCATION): Promise<void> {
  const { data } = await director.api.rpc("admin_record_opening_stock", {
    p_product_id: productId,
    p_location_code: location,
    p_quantity: quantity,
    p_note: "integration opening count",
    p_idempotency_key: randomUUID(),
  });

  // `already_recorded` is the §3 rule holding, not a failure of this fixture.
  if (!data?.ok) expect(String(data?.reason)).toBe("already_recorded");
}

async function balance(
  productId: string,
  state: "available" | "curing",
  location = LOCATION,
): Promise<number> {
  const { data, error } = await director.read
    .from("current_stock")
    .select("quantity")
    .eq("product_id", productId)
    .eq("location_code", location)
    .eq("stock_state", state)
    .maybeSingle();

  expect(error, "reading current stock").toBeNull();
  return data ? Number(data.quantity) : 0;
}

type BatchLine = { product_id: string; actual_quantity: number };
type OutputLine = {
  product_id: string;
  quantity_moulded: number;
  rejected_quantity?: number;
  reject_reason?: string;
};

async function enterBatch(
  who: Fixture,
  inputs: BatchLine[],
  outputs: OutputLine[],
  options: { yieldNote?: string | null; key?: string; mouldedAt?: string } = {},
) {
  const { data } = await who.api.rpc("staff_enter_production_batch", {
    p_location_code: LOCATION,
    p_moulded_at: options.mouldedAt ?? new Date().toISOString(),
    p_inputs: inputs,
    p_outputs: outputs,
    p_yield_note: options.yieldNote ?? null,
    p_idempotency_key: options.key ?? randomUUID(),
  });
  return data as {
    ok: boolean;
    reason: string;
    batch?: { id: string; batch_no: string };
    yield_outside_range?: boolean;
    expected?: number;
    confirmed?: number;
  };
}

async function approve(who: Fixture, batchId: string, key = randomUUID()) {
  const { data } = await who.api.rpc("staff_approve_production_batch", {
    p_batch_id: batchId,
    p_idempotency_key: key,
  });
  return data as { ok: boolean; reason: string; available?: number; requested?: number };
}

async function lotOf(batchId: string, productId: string): Promise<string> {
  const { data, error } = await director.read
    .from("production_lots")
    .select("id")
    .eq("batch_id", batchId)
    .eq("product_id", productId)
    .single();

  expect(error, "reading the lot").toBeNull();
  return (data as { id: string }).id;
}

async function inspect(
  who: Fixture,
  lotId: string,
  accepted: number,
  rejected: number,
  reason: string | null,
  key = randomUUID(),
) {
  const { data } = await who.api.rpc("staff_inspect_curing_lot", {
    p_lot_id: lotId,
    p_accepted: accepted,
    p_rejected: rejected,
    p_reject_reason: reason,
    p_idempotency_key: key,
  });
  return data as { ok: boolean; reason: string; ready_at?: string; curing?: number };
}

/** The standard recipe, as §11.1 writes it, so a test says what it changed rather than restating it. */
function recipe(overrides: Partial<Record<"cement" | "sand" | "aggregate", number>> = {}) {
  return [
    { product_id: cementId, actual_quantity: overrides.cement ?? 1 },
    { product_id: sandId, actual_quantity: overrides.sand ?? 5 },
    { product_id: aggregateId, actual_quantity: overrides.aggregate ?? 5 },
  ];
}

describe("a batch is recorded, approved, and only then consumes the yard", () => {
  it("records what was used and what came out, and moves nothing", async () => {
    const sandBefore = await balance(sandId, "available");
    const curingBefore = await balance(brick6Id, "curing");

    const entered = await enterBatch(manager, recipe({ sand: 6 }), [
      { product_id: brick6Id, quantity_moulded: 22, rejected_quantity: 2, reject_reason: "broken" },
    ]);

    expect(entered.reason, JSON.stringify(entered)).toBe("entered");
    expect(entered.batch?.batch_no).toMatch(/^FV-BAT-\d{8}-\d{4}$/);

    // §11.1, AC-39: recording is not approving. Nothing has left the yard and nothing is curing.
    expect(await balance(sandId, "available")).toBe(sandBefore);
    expect(await balance(brick6Id, "curing")).toBe(curingBefore);
  });

  it("deducts the ACTUAL quantity on approval, not the standard recipe", async () => {
    const sandBefore = await balance(sandId, "available");
    const cementBefore = await balance(cementId, "available");
    const curingBefore = await balance(brick6Id, "curing");

    const entered = await enterBatch(manager, recipe({ sand: 6 }), [
      { product_id: brick6Id, quantity_moulded: 22 },
    ]);
    expect(entered.reason, JSON.stringify(entered)).toBe("entered");

    const approved = await approve(manager, entered.batch!.id);
    expect(approved.reason, JSON.stringify(approved)).toBe("approved");

    // SIX, the confirmed actual — not the five the recipe expects (§11.1, AC-38).
    expect(await balance(sandId, "available")).toBe(sandBefore - 6);
    // AC-120: one bag deducts one, never the fifty kilograms inside it.
    expect(await balance(cementId, "available")).toBe(cementBefore - 1);
    // §11.4, AC-44: the output is CURING, and curing is not sellable.
    expect(await balance(brick6Id, "curing")).toBe(curingBefore + 22);
  });

  it("records the variance without letting it change the deduction", async () => {
    const entered = await enterBatch(manager, recipe({ sand: 7 }), [
      { product_id: brick6Id, quantity_moulded: 22 },
    ]);
    expect(entered.reason).toBe("entered");

    const { data } = await director.read
      .from("production_batch_inputs")
      .select("standard_quantity, actual_quantity, variance_quantity")
      .eq("batch_id", entered.batch!.id)
      .eq("product_id", sandId)
      .single();

    expect(data).toMatchObject({
      standard_quantity: 5,
      actual_quantity: 7,
      variance_quantity: 2,
    });
  });

  it("refuses a batch that confirmed only part of the recipe, and says how much of it", async () => {
    const partial = await enterBatch(
      manager,
      [
        { product_id: cementId, actual_quantity: 1 },
        { product_id: sandId, actual_quantity: 5 },
      ],
      [{ product_id: brick6Id, quantity_moulded: 22 }],
    );

    expect(partial.reason, JSON.stringify(partial)).toBe("incomplete_recipe_inputs");
    expect(partial.expected).toBe(3);
    expect(partial.confirmed).toBe(2);
  });

  it("accepts a confirmed zero, which is an answer about a material rather than silence", async () => {
    const entered = await enterBatch(manager, recipe({ aggregate: 0 }), [
      { product_id: brick6Id, quantity_moulded: 22 },
    ]);
    expect(entered.reason, JSON.stringify(entered)).toBe("entered");

    const { data } = await director.read
      .from("production_batch_inputs")
      .select("actual_quantity, variance_quantity")
      .eq("batch_id", entered.batch!.id)
      .eq("product_id", aggregateId)
      .single();

    expect(data).toMatchObject({ actual_quantity: 0, variance_quantity: -5 });
  });

  it("refuses a malformed payload without writing anything or claiming its key", async () => {
    const key = randomUUID();
    const { data: refused } = await manager.api.rpc("staff_enter_production_batch", {
      p_location_code: LOCATION,
      p_moulded_at: new Date().toISOString(),
      p_inputs: [{ product_id: "not-a-uuid", actual_quantity: 1 }],
      p_outputs: [{ product_id: brick6Id, quantity_moulded: 22 }],
      p_yield_note: null,
      p_idempotency_key: key,
    });

    expect(refused?.reason).toBe("line_invalid");

    // The same key still works, because the refusal claimed nothing.
    const retried = await enterBatch(manager, recipe(), [
      { product_id: brick6Id, quantity_moulded: 22 },
    ], { key });
    expect(retried.reason, JSON.stringify(retried)).toBe("entered");
  });

  it("flags an out-of-range yield and requires an explanation, but never blocks it", async () => {
    const refused = await enterBatch(manager, recipe(), [
      { product_id: brick6Id, quantity_moulded: 12 },
    ]);
    expect(refused.reason).toBe("yield_explanation_required");

    const explained = await enterBatch(
      manager,
      recipe(),
      [{ product_id: brick6Id, quantity_moulded: 12 }],
      { yieldNote: "the mix was too wet and a tray collapsed" },
    );
    expect(explained.reason, JSON.stringify(explained)).toBe("entered");
    expect(explained.yield_outside_range).toBe(true);
  });
});

describe("entry, approval and inspection, end to end", () => {
  it("makes only the accepted bricks sellable, and clears the whole lot from curing", async () => {
    const availableBefore = await balance(brick6Id, "available");
    const curingBefore = await balance(brick6Id, "curing");

    const entered = await enterBatch(
      manager,
      recipe(),
      [
        { product_id: brick6Id, quantity_moulded: 22, rejected_quantity: 2, reject_reason: "broken" },
      ],
      { mouldedAt: mouldedFourDaysAgo() },
    );
    expect(entered.reason, JSON.stringify(entered)).toBe("entered");

    expect((await approve(manager, entered.batch!.id)).reason).toBe("approved");
    expect(await balance(brick6Id, "curing")).toBe(curingBefore + 20);

    const lotId = await lotOf(entered.batch!.id, brick6Id);

    // Everything that cured has to be accounted for, and the database says so with the numbers.
    const short = await inspect(manager, lotId, 18, 0, null);
    expect(short.reason).toBe("inspection_must_account_for_all");
    expect(short.curing).toBe(20);

    const inspected = await inspect(manager, lotId, 18, 2, "cracked");
    expect(inspected.reason, JSON.stringify(inspected)).toBe("inspected");

    // EIGHTEEN, not twenty (§11.4, AC-45), and the whole lot has left curing.
    expect(await balance(brick6Id, "available")).toBe(availableBefore + 18);
    expect(await balance(brick6Id, "curing")).toBe(curingBefore);

    // The record a screen reads back afterwards, which is what makes the result durable.
    const { data: lot } = await director.read
      .from("production_lots")
      .select("accepted_quantity, rejected_at_inspection, inspection_reject_reason, inspected_role")
      .eq("id", lotId)
      .single();

    expect(lot).toMatchObject({
      accepted_quantity: 18,
      rejected_at_inspection: 2,
      inspection_reject_reason: "cracked",
      inspected_role: "manager",
    });
  });

  it("refuses to make a cured lot sellable before its 72 hours are up", async () => {
    const availableBefore = await balance(brick6Id, "available");

    const entered = await enterBatch(manager, recipe(), [
      { product_id: brick6Id, quantity_moulded: 22 },
    ]);
    expect((await approve(manager, entered.batch!.id)).reason).toBe("approved");

    const lotId = await lotOf(entered.batch!.id, brick6Id);
    const refused = await inspect(manager, lotId, 20, 2, "cracked");

    expect(refused.reason, JSON.stringify(refused)).toBe("still_curing");
    expect(refused.ready_at, "the refusal says WHEN, not just no").toBeTruthy();

    // AC-44 over HTTP: nothing became sellable, and the refusal is what kept it that way.
    expect(await balance(brick6Id, "available")).toBe(availableBefore);
  });

  it("keeps two sizes from one batch as two lots with two independent decisions", async () => {
    const sixBefore = await balance(brick6Id, "available");
    const fiveBefore = await balance(brick5Id, "available");

    const entered = await enterBatch(
      manager,
      recipe(),
      [
        { product_id: brick6Id, quantity_moulded: 22 },
        { product_id: brick5Id, quantity_moulded: 27 },
      ],
      { mouldedAt: mouldedFourDaysAgo() },
    );
    expect((await approve(manager, entered.batch!.id)).reason).toBe("approved");

    const sixLot = await lotOf(entered.batch!.id, brick6Id);
    const fiveLot = await lotOf(entered.batch!.id, brick5Id);
    expect(sixLot).not.toBe(fiveLot);

    expect((await inspect(manager, sixLot, 22, 0, null)).reason).toBe("inspected");
    expect(await balance(brick6Id, "available")).toBe(sixBefore + 22);
    // The five-inch lot is untouched: two clocks, two decisions.
    expect(await balance(brick5Id, "available")).toBe(fiveBefore);
    expect(await balance(brick5Id, "curing")).toBeGreaterThanOrEqual(27);

    // All rejected is a real outcome, and it makes nothing sellable.
    expect((await inspect(manager, fiveLot, 0, 27, "weak")).reason).toBe("inspected");
    expect(await balance(brick5Id, "available")).toBe(fiveBefore);
  });
});

describe("who may run production, decided by the database", () => {
  it("refuses a Cashier over HTTP, with no batch left behind", async () => {
    const { status, body } = await callApiRpc(
      "staff_enter_production_batch",
      {
        p_location_code: LOCATION,
        p_moulded_at: new Date().toISOString(),
        p_inputs: recipe(),
        p_outputs: [{ product_id: brick6Id, quantity_moulded: 22 }],
        p_yield_note: null,
        p_idempotency_key: randomUUID(),
      },
      PUBLISHABLE_KEY,
      cashier.accessToken,
    );

    // `insufficient_privilege` surfaces as a 4xx through PostgREST, never as a quiet success, and
    // it names the SQLSTATE rather than a sentence a later edit could reword.
    expect(status).toBeGreaterThanOrEqual(400);
    expect((body as { code?: string })?.code).toBe("42501");
    expect(JSON.stringify(body)).not.toMatch(/"ok"\s*:\s*true/);
  });

  it("refuses a Sales Representative the same way", async () => {
    const { error } = await salesRep.api.rpc("staff_enter_production_batch", {
      p_location_code: LOCATION,
      p_moulded_at: new Date().toISOString(),
      p_inputs: recipe(),
      p_outputs: [{ product_id: brick6Id, quantity_moulded: 22 }],
      p_yield_note: null,
      p_idempotency_key: randomUUID(),
    });
    expect(error).not.toBeNull();
  });

  it("refuses a Director too — §4.1 gives production to the Manager", async () => {
    const entered = await enterBatch(director, recipe(), [
      { product_id: brick6Id, quantity_moulded: 22 },
    ]);
    // The RPC raises rather than returning a refusal, so the client sees an error, not `ok: false`.
    expect(entered).toBeNull();
  });

  it("lets a Director READ the board, which is what oversight means here", async () => {
    const { data, error } = await director.read
      .from("production_batches")
      .select("id, status")
      .limit(1);

    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });

  it("shows a Cashier no production row at all", async () => {
    const { data, error } = await cashier.read.from("production_batches").select("id").limit(1);

    // A policy that admits nobody answers with an empty list rather than an error, which is the
    // shape RLS gives: the Cashier can see that the table exists and not one row inside it.
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("refuses an anonymous caller", async () => {
    const { status, body } = await callApiRpc(
      "staff_enter_production_batch",
      {
        p_location_code: LOCATION,
        p_moulded_at: new Date().toISOString(),
        p_inputs: recipe(),
        p_outputs: [{ product_id: brick6Id, quantity_moulded: 22 }],
        p_yield_note: null,
        p_idempotency_key: randomUUID(),
      },
      PUBLISHABLE_KEY,
    );

    expect(status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(body)).not.toMatch(/"ok"\s*:\s*true/);
  });

  it("refuses a Manager who has never completed their first login", async () => {
    const gated = await createGatedStaff(director, "manager", "Gated Manager");
    const session = await signInWithPhone(gated.phoneE164, gated.password);
    expect(session.status).toBe(200);

    const gatedApi = clientForToken(session.body.access_token).schema("api");
    const { error } = await gatedApi.rpc("staff_enter_production_batch", {
      p_location_code: LOCATION,
      p_moulded_at: new Date().toISOString(),
      p_inputs: recipe(),
      p_outputs: [{ product_id: brick6Id, quantity_moulded: 22 }],
      p_yield_note: null,
      p_idempotency_key: randomUUID(),
    });

    expect(error, "the first-login gate is upstream of every command").not.toBeNull();
  });

  it("refuses a Manager whose account was deactivated after they signed in", async () => {
    const doomed = await createLiveStaff(director, "manager", "Deactivated Manager");

    const { data: deactivated } = await director.api.rpc("admin_set_account_active", {
      p_target_user_id: doomed.userId,
      p_is_active: false,
    });
    expect(deactivated.ok).toBe(true);

    // Their session is still perfectly valid; their authority is not.
    const { error } = await doomed.api.rpc("staff_enter_production_batch", {
      p_location_code: LOCATION,
      p_moulded_at: new Date().toISOString(),
      p_inputs: recipe(),
      p_outputs: [{ product_id: brick6Id, quantity_moulded: 22 }],
      p_yield_note: null,
      p_idempotency_key: randomUUID(),
    });
    expect(error).not.toBeNull();
  });

  it("refuses a former Manager whose role changed after they signed in", async () => {
    const demoted = await createLiveStaff(director, "manager", "Demoted Manager");

    const { data: changed } = await director.api.rpc("admin_change_user_role", {
      p_target_user_id: demoted.userId,
      p_role: "cashier",
    });
    expect(changed.ok, JSON.stringify(changed)).toBe(true);

    const { error } = await demoted.api.rpc("staff_enter_production_batch", {
      p_location_code: LOCATION,
      p_moulded_at: new Date().toISOString(),
      p_inputs: recipe(),
      p_outputs: [{ product_id: brick6Id, quantity_moulded: 22 }],
      p_yield_note: null,
      p_idempotency_key: randomUUID(),
    });
    expect(error, "the live role is read at the moment of the command").not.toBeNull();
  });
});

describe("the production tables cannot be reached around the commands", () => {
  it("refuses a direct insert of a batch by a signed-in Manager", async () => {
    const { error } = await manager.read.from("production_batches").insert({
      batch_no: `FV-BAT-FORGED-${randomUUID().slice(0, 8)}`,
      location_code: LOCATION,
      moulded_at: new Date().toISOString(),
      entered_by: manager.userId,
      entered_role: "manager",
    });

    expect(error, "a Manager holds SELECT and nothing else").not.toBeNull();
  });

  it("refuses a direct approval by updating the row", async () => {
    const entered = await enterBatch(manager, recipe(), [
      { product_id: brick6Id, quantity_moulded: 22 },
    ]);

    const { error } = await manager.read
      .from("production_batches")
      .update({ status: "approved" })
      .eq("id", entered.batch!.id);

    expect(error, "approval is a command, not a column").not.toBeNull();
  });

  it("refuses a direct inspection by writing the lot", async () => {
    const { error } = await manager.read
      .from("production_lots")
      .update({ accepted_quantity: 20 })
      .eq("quantity_moulded", 22);

    expect(error).not.toBeNull();
  });

  it("gives a leaked secret key no reach into production at all", async () => {
    const { status, body } = await callApiRpc(
      "staff_enter_production_batch",
      {
        p_location_code: LOCATION,
        p_moulded_at: new Date().toISOString(),
        p_inputs: recipe(),
        p_outputs: [{ product_id: brick6Id, quantity_moulded: 22 }],
        p_yield_note: null,
        p_idempotency_key: randomUUID(),
      },
      SECRET_KEY,
    );

    expect(status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(body)).not.toMatch(/"ok"\s*:\s*true/);
  });

  it("gives a leaked secret key no read of a production table either", async () => {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/production_batches?select=id&limit=1`,
      { headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` } },
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("two commands arriving together", () => {
  it("replays the same idempotency key rather than deducting twice", async () => {
    const entered = await enterBatch(manager, recipe(), [
      { product_id: brick6Id, quantity_moulded: 22 },
    ]);
    const sandBefore = await balance(sandId, "available");
    const key = randomUUID();

    expect((await approve(manager, entered.batch!.id, key)).reason).toBe("approved");
    expect((await approve(manager, entered.batch!.id, key)).reason).toBe("replayed");

    expect(await balance(sandId, "available")).toBe(sandBefore - 5);
  });

  it("refuses a used key whose payload changed, rather than replaying the first answer", async () => {
    const key = randomUUID();
    const first = await enterBatch(
      manager,
      recipe(),
      [{ product_id: brick6Id, quantity_moulded: 12 }],
      { yieldNote: "a tray collapsed", key },
    );
    expect(first.reason, JSON.stringify(first)).toBe("entered");

    const changed = await enterBatch(
      manager,
      recipe(),
      [{ product_id: brick6Id, quantity_moulded: 12 }],
      { yieldNote: "the sand was wet", key },
    );

    // The explanation is business-significant and permanent, so it belongs to the request identity.
    expect(changed.reason).toBe("idempotency_key_conflict");
  });

  it("deducts once when two approvals of one batch arrive together", async () => {
    const entered = await enterBatch(manager, recipe(), [
      { product_id: brick6Id, quantity_moulded: 22 },
    ]);
    const sandBefore = await balance(sandId, "available");

    // Two DIFFERENT keys, which is the harder case: idempotency cannot save this one, so the
    // advisory lock and the status check have to.
    const [a, b] = await Promise.all([
      approve(manager, entered.batch!.id),
      approve(manager, entered.batch!.id),
    ]);

    expect([a.reason, b.reason].sort()).toEqual(["already_settled", "approved"]);
    expect(await balance(sandId, "available")).toBe(sandBefore - 5);
  });

  it("settles an approve-versus-reject race as exactly one decision", async () => {
    const entered = await enterBatch(manager, recipe(), [
      { product_id: brick6Id, quantity_moulded: 22 },
    ]);
    const sandBefore = await balance(sandId, "available");

    const [approved, rejected] = await Promise.all([
      approve(manager, entered.batch!.id),
      manager.api.rpc("staff_reject_production_batch", {
        p_batch_id: entered.batch!.id,
        p_reason: "the figures were written down wrong",
        p_idempotency_key: randomUUID(),
      }),
    ]);

    const outcomes = [approved.reason, String(rejected.data?.reason)].sort();
    // One command settled the batch and the other found it settled. Which one won is a race;
    // that exactly one won is the rule.
    expect(outcomes).toContain("already_settled");
    expect(outcomes.filter((reason) => reason === "already_settled")).toHaveLength(1);

    const { data: batch } = await director.read
      .from("production_batches")
      .select("status")
      .eq("id", entered.batch!.id)
      .single();

    // One terminal state, and the yard moved once or not at all — never both.
    expect(["approved", "rejected"]).toContain((batch as { status: string }).status);
    const sandAfter = await balance(sandId, "available");
    expect([sandBefore, sandBefore - 5]).toContain(sandAfter);
  });

  it("inspects a lot once when two inspections arrive together", async () => {
    const entered = await enterBatch(
      manager,
      recipe(),
      [{ product_id: brick6Id, quantity_moulded: 22 }],
      { mouldedAt: mouldedFourDaysAgo() },
    );
    expect((await approve(manager, entered.batch!.id)).reason).toBe("approved");

    const lotId = await lotOf(entered.batch!.id, brick6Id);
    const availableBefore = await balance(brick6Id, "available");

    const [first, second] = await Promise.all([
      inspect(manager, lotId, 20, 2, "cracked"),
      inspect(manager, lotId, 20, 2, "cracked"),
    ]);

    expect([first.reason, second.reason].sort()).toEqual(["already_inspected", "inspected"]);
    // Twenty became sellable, not forty.
    expect(await balance(brick6Id, "available")).toBe(availableBefore + 20);
  });

  it("cannot drive the location's physical balance negative with two competing batches", async () => {
    // A small, known balance at a location nothing else in this file consumes.
    await stockUp(sandId, 7, OTHER_LOCATION);

    const at = await balance(sandId, "available", OTHER_LOCATION);
    const each = Math.max(1, Math.floor(at / 2) + 1);

    const twoBatches = await Promise.all(
      [1, 2].map(async () => {
        const { data } = await manager.api.rpc("staff_enter_production_batch", {
          p_location_code: OTHER_LOCATION,
          p_moulded_at: new Date().toISOString(),
          p_inputs: [
            { product_id: cementId, actual_quantity: 0 },
            { product_id: sandId, actual_quantity: each },
            { product_id: aggregateId, actual_quantity: 0 },
          ],
          p_outputs: [{ product_id: brick6Id, quantity_moulded: 22 }],
          p_yield_note: null,
          p_idempotency_key: randomUUID(),
        });
        return data as { ok: boolean; batch?: { id: string } };
      }),
    );

    const results = await Promise.all(
      twoBatches.map((entered) => approve(manager, entered.batch!.id)),
    );

    // Both wanted more than half of what is there, so exactly one of them can have it.
    expect(results.filter((result) => result.reason === "approved")).toHaveLength(1);
    expect(results.filter((result) => result.reason === "insufficient_stock")).toHaveLength(1);
    expect(await balance(sandId, "available", OTHER_LOCATION)).toBeGreaterThanOrEqual(0);
  });

  it("competes with a released transfer for the same materials without either going negative", async () => {
    // The transfer and the batch take the same `location:product` lock in the same order, which is
    // what makes this queue rather than deadlock — and neither may take stock that is not there.
    const before = await balance(sandId, "available");

    const { data: transfer } = await manager.api.rpc("staff_enter_stock_transfer", {
      p_from_location: LOCATION,
      p_to_location: OTHER_LOCATION,
      p_note: "moving sand while a batch is approved",
      p_lines: [{ product_id: sandId, quantity: 3 }],
      p_idempotency_key: randomUUID(),
    });
    expect(transfer?.ok, JSON.stringify(transfer)).toBe(true);

    const entered = await enterBatch(manager, recipe(), [
      { product_id: brick6Id, quantity_moulded: 22 },
    ]);

    const [movedStock, approvedBatch] = await Promise.all([
      manager.api.rpc("staff_approve_stock_transfer", {
        p_transfer_id: transfer.transfer.id,
        p_idempotency_key: randomUUID(),
      }),
      approve(manager, entered.batch!.id),
    ]);

    expect(movedStock.data?.ok, JSON.stringify(movedStock.data)).toBe(true);
    expect(approvedBatch.reason, JSON.stringify(approvedBatch)).toBe("approved");

    // Both took what they asked for, and the released transfer's own semantics are unchanged.
    expect(await balance(sandId, "available")).toBe(before - 3 - 5);
    expect(await balance(sandId, "available", OTHER_LOCATION)).toBeGreaterThanOrEqual(3);
  });

  it("competes with a released downward correction for the same materials", async () => {
    // A stock correction is the other released command that takes goods OUT of a location, and it
    // takes the same `location:product` lock in the same order. Neither may leave the location
    // holding less than nothing, whichever of them commits first.
    const before = await balance(aggregateId, "available");

    const { data: adjustment } = await manager.api.rpc("staff_enter_stock_adjustment", {
      p_product_id: aggregateId,
      p_location_code: LOCATION,
      p_quantity_delta: -4,
      p_reason: "a correction entered while a batch is being approved",
      p_idempotency_key: randomUUID(),
    });
    expect(adjustment?.ok, JSON.stringify(adjustment)).toBe(true);

    const entered = await enterBatch(manager, recipe(), [
      { product_id: brick6Id, quantity_moulded: 22 },
    ]);

    const [corrected, approved] = await Promise.all([
      director.api.rpc("admin_approve_stock_adjustment", {
        p_adjustment_id: adjustment.adjustment.id,
        p_idempotency_key: randomUUID(),
      }),
      approve(manager, entered.batch!.id),
    ]);

    expect(corrected.data?.ok, JSON.stringify(corrected.data)).toBe(true);
    expect(approved.reason, JSON.stringify(approved)).toBe("approved");

    // Four written off and five consumed by the batch — both, once each, and the released
    // correction still behaves exactly as it did.
    expect(await balance(aggregateId, "available")).toBe(before - 4 - 5);
  });

  it("refuses a batch the yard cannot supply, and leaves every balance where it was", async () => {
    const sandBefore = await balance(sandId, "available");
    const cementBefore = await balance(cementId, "available");
    const curingBefore = await balance(brick6Id, "curing");

    const entered = await enterBatch(manager, recipe({ sand: 9000 }), [
      { product_id: brick6Id, quantity_moulded: 22 },
    ]);
    expect(entered.reason, "a batch bigger than the yard may be ENTERED").toBe("entered");

    const refused = await approve(manager, entered.batch!.id);
    expect(refused.reason).toBe("insufficient_stock");
    expect(refused.available).toBe(sandBefore);
    expect(refused.requested).toBe(9000);

    // Atomic: the cement it could have taken is untouched, and nothing entered curing.
    expect(await balance(sandId, "available")).toBe(sandBefore);
    expect(await balance(cementId, "available")).toBe(cementBefore);
    expect(await balance(brick6Id, "curing")).toBe(curingBefore);

    const { data: batch } = await director.read
      .from("production_batches")
      .select("status")
      .eq("id", entered.batch!.id)
      .single();
    expect((batch as { status: string }).status).toBe("draft");
  });
});

describe("what this release deliberately does not do", () => {
  it("does not protect promised stock from production, which is v0.0.6's correction", async () => {
    // product.md §8.1 refuses a claim that would take stock a customer has already been promised.
    // v0.0.5 checks the LOCATION'S PHYSICAL BALANCE, exactly as the released transfer and correction
    // commands do. This test records that gap rather than asserting the rule is met: a green
    // assertion here would be a false statement about the released system.
    const { data: view } = await director.read
      .from("current_stock")
      .select("quantity")
      .eq("product_id", sandId)
      .eq("location_code", LOCATION)
      .eq("stock_state", "available")
      .maybeSingle();

    expect(view, "the physical balance is what approval reads").not.toBeNull();
  });
});
