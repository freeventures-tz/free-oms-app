import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  SECRET_KEY,
  createLiveStaff,
  ensureDirector,
  type Fixture,
} from "@/tests/integration/helpers";

/**
 * Payments, credit, dispatch and release, over real HTTP through PostgREST.
 *
 * pgTAP proves the rules inside the database. These prove the same rules survive the journey a
 * browser takes, and cover the one thing pgTAP structurally cannot: reaching AROUND the commands as
 * `authenticated`, a role a GRANT actually constrains.
 */

/**
 * Runs SQL as the database owner, for the one thing a test cannot do through the product: put a
 * database into a state that takes years of trading to reach.
 *
 * `scripts/run-advisors.mjs` reaches the database exactly this way, with the same docker fallback,
 * so this is the established path rather than a new one. It is used ONLY to seed volume — every
 * assertion below still goes through PostgREST as a signed-in person.
 */
function asOwner(sql: string): void {
  const url =
    process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  try {
    execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"], {
      input: sql,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
    execFileSync(
      "docker",
      [
        "exec", "-i",
        process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_free-oms-app",
        "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q",
      ],
      { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
  }
}

let director: Fixture;
let manager: Fixture;
let cashier: Fixture;
let salesRep: Fixture;

let customerId: string;
let cashCustomerId: string;
let productId: string;
let storekeeperId: string;
/** A second product, so one invoice can hold two assignable lines. */
let secondProductId: string;

const UNIT_PRICE = 100_000;

beforeAll(async () => {
  director = await ensureDirector();
  manager = await createLiveStaff(director, "manager");
  cashier = await createLiveStaff(director, "cashier");
  salesRep = await createLiveStaff(director, "sales_rep");

  const { data: product } = await director.api.rpc("admin_add_product", {
    p_name: `Settlement Product ${randomUUID().slice(0, 8)}`,
    p_specification: null,
    p_unit_code: "piece",
    p_unit_content: null,
    p_idempotency_key: randomUUID(),
  });
  productId = (product!.product as { id: string }).id;

  await director.api.rpc("admin_set_product_price", {
    p_product_id: productId,
    p_price_tzs: UNIT_PRICE,
    p_reason: "integration fixture",
    p_idempotency_key: randomUUID(),
  });

  await director.api.rpc("admin_record_opening_stock", {
    p_product_id: productId,
    p_location_code: "store",
    p_quantity: 1000,
    p_note: null,
    p_idempotency_key: randomUUID(),
  });

  const { data: second } = await director.api.rpc("admin_add_product", {
    p_name: `Settlement Second ${randomUUID().slice(0, 8)}`,
    p_specification: null,
    p_unit_code: "piece",
    p_unit_content: null,
    p_idempotency_key: randomUUID(),
  });
  secondProductId = (second!.product as { id: string }).id;

  await director.api.rpc("admin_set_product_price", {
    p_product_id: secondProductId,
    p_price_tzs: UNIT_PRICE,
    p_reason: "integration fixture",
    p_idempotency_key: randomUUID(),
  });

  await director.api.rpc("admin_record_opening_stock", {
    p_product_id: secondProductId,
    p_location_code: "store",
    p_quantity: 1000,
    p_note: null,
    p_idempotency_key: randomUUID(),
  });

  const { data: customer } = await salesRep.api.rpc("staff_add_customer", {
    p_name: `Settlement Customer ${randomUUID().slice(0, 8)}`,
    p_idempotency_key: randomUUID(),
  });
  customerId = (customer!.customer as { id: string }).id;

  const { data: cash } = await director.read
    .from("customers")
    .select("id")
    .eq("is_cash_customer", true)
    .single();
  cashCustomerId = cash!.id as string;

  const { data: keeper } = await director.api.rpc("admin_add_storekeeper", {
    p_full_name: `Keeper ${randomUUID().slice(0, 8)}`,
    p_phone: null,
    p_start_date: new Date().toISOString().slice(0, 10),
    p_note: null,
    p_idempotency_key: randomUUID(),
  });
  expect(keeper?.ok, JSON.stringify(keeper)).toBe(true);
  storekeeperId = (keeper.storekeeper as { id: string }).id;
});

/** An order confirmed into an invoice, ready to settle. */
async function invoicedOrder(quantity: number) {
  const { data: order } = await salesRep.api.rpc("staff_create_order", {
    p_customer_id: customerId,
    p_lines: [{ product_id: productId, quantity }],
    p_idempotency_key: randomUUID(),
  });
  const orderId = (order!.order as { id: string }).id;

  const { data: confirmed } = await salesRep.api.rpc("staff_confirm_order", {
    p_order_id: orderId,
    p_idempotency_key: randomUUID(),
  });
  expect(confirmed?.ok, JSON.stringify(confirmed)).toBe(true);

  return { orderId, invoiceId: (confirmed.invoice as { id: string }).id };
}

async function settlementOf(invoiceId: string) {
  const { data, error } = await director.read
    .from("invoice_settlement")
    .select("total_tzs, amount_paid_tzs, approved_credit_tzs, outstanding_tzs, status, releasable")
    .eq("invoice_id", invoiceId)
    .single();
  expect(error, error?.message).toBeNull();
  return {
    total: Number(data!.total_tzs),
    paid: Number(data!.amount_paid_tzs),
    credit: Number(data!.approved_credit_tzs),
    outstanding: Number(data!.outstanding_tzs),
    status: data!.status as string,
    releasable: data!.releasable as boolean,
  };
}

/**
 * What is still ASSIGNABLE on one claim: what the customer is owed, less whatever an in-progress
 * dispatch already covers. The screen computes this the same way, and the command checks it again.
 */
async function assignableOn(allocationId: string): Promise<number> {
  const { data: claim } = await director.read
    .from("stock_allocations")
    .select("quantity, released_quantity")
    .eq("id", allocationId)
    .single();

  const { data: lines } = await director.read
    .from("dispatch_lines")
    .select("quantity, dispatches!inner(status)")
    .eq("allocation_id", allocationId)
    .in("dispatches.status", ["assigned", "note_recorded"]);

  const claimed = (lines ?? []).reduce((total, row) => total + Number(row.quantity), 0);
  return Number(claim!.quantity) - Number(claim!.released_quantity) - claimed;
}

/** The approval request behind one credit authorisation, for reading its decision history. */
async function requestIdFor(creditId: string): Promise<string | undefined> {
  const { data } = await director.read
    .from("approval_requests")
    .select("id")
    .eq("entity_type", "credit_authorisation")
    .eq("entity_id", creditId)
    .single();
  return data?.id as string | undefined;
}

/** A fully paid, settled invoice with its stock claim, ready to be assigned to a storekeeper. */
async function settledInvoice(quantity: number) {
  const created = await invoicedOrder(quantity);

  await cashier.api.rpc("staff_record_payment", {
    p_invoice_id: created.invoiceId,
    p_method: "cash",
    p_amount_tzs: quantity * UNIT_PRICE,
    p_idempotency_key: randomUUID(),
  });
  await cashier.api.rpc("staff_approve_settlement", {
    p_invoice_id: created.invoiceId,
    p_idempotency_key: randomUUID(),
  });

  const { data: allocation } = await director.read
    .from("stock_allocations")
    .select("id")
    .eq("order_id", created.orderId)
    .single();

  return { ...created, allocationId: allocation!.id as string };
}

async function stockAt(location: string) {
  const { data } = await director.read
    .from("current_stock")
    .select("quantity")
    .eq("product_id", productId)
    .eq("location_code", location)
    .eq("stock_state", "available")
    .maybeSingle();
  return data ? Number(data.quantity) : 0;
}

describe("who may take money", () => {
  it("refuses every role but the Cashier, over HTTP", async () => {
    const { invoiceId } = await invoicedOrder(1);

    for (const [role, fixture] of [
      ["manager", manager],
      ["director", director],
      ["sales_rep", salesRep],
    ] as const) {
      const { data, error } = await fixture.api.rpc("staff_record_payment", {
        p_invoice_id: invoiceId,
        p_method: "cash",
        p_amount_tzs: 1000,
        p_idempotency_key: randomUUID(),
      });
      expect(data, `${role} took money`).toBeNull();
      expect(error?.message).toMatch(/may not perform this command|not a live Director/i);
    }
  });

  it("refuses a direct insert into payments", async () => {
    const { invoiceId } = await invoicedOrder(1);
    const { error } = await cashier.read.from("payments").insert({
      invoice_id: invoiceId,
      amount_tzs: 1,
      method: "cash",
      received_by: cashier.userId,
      received_role: "cashier",
      business_date: new Date().toISOString().slice(0, 10),
      correlation_id: randomUUID(),
    });
    expect(error, "a Cashier wrote directly to payments").not.toBeNull();
  });
});

describe("invoice status is calculated from money received", () => {
  it("moves unpaid to partly paid to paid, and never from a column", async () => {
    const { invoiceId } = await invoicedOrder(4); // 400 000

    expect((await settlementOf(invoiceId)).status).toBe("unpaid");

    await cashier.api.rpc("staff_record_payment", {
      p_invoice_id: invoiceId,
      p_method: "cash",
      p_amount_tzs: 150_000,
      p_idempotency_key: randomUUID(),
    });

    let state = await settlementOf(invoiceId);
    expect(state.status).toBe("partially_paid");
    expect(state.outstanding).toBe(250_000);

    await cashier.api.rpc("staff_record_payment", {
      p_invoice_id: invoiceId,
      p_method: "crdb_transfer",
      p_amount_tzs: 250_000,
      p_idempotency_key: randomUUID(),
    });

    state = await settlementOf(invoiceId);
    expect(state.status).toBe("paid");
    expect(state.outstanding).toBe(0);
  });

  it("refuses more than is owed", async () => {
    const { invoiceId } = await invoicedOrder(1);

    const { data } = await cashier.api.rpc("staff_record_payment", {
      p_invoice_id: invoiceId,
      p_method: "cash",
      p_amount_tzs: UNIT_PRICE + 1,
      p_idempotency_key: randomUUID(),
    });

    expect(data?.ok).toBe(false);
    expect(data.reason).toBe("payment_exceeds_balance");
    expect(Number(data.outstanding)).toBe(UNIT_PRICE);
  });
});

describe("credit is not a tender (product.md §12.5)", () => {
  it("records no payment, and an invoice settled on credit alone stays Unpaid", async () => {
    const { invoiceId } = await invoicedOrder(3); // 300 000, inside the Manager limit

    const { data: requested } = await cashier.api.rpc("staff_request_credit", {
      p_invoice_id: invoiceId,
      p_amount_tzs: 300_000,
      p_reason: "regular customer, pays monthly",
      p_idempotency_key: randomUUID(),
    });
    expect(requested?.ok, JSON.stringify(requested)).toBe(true);
    expect(requested.required_role).toBe("manager");

    const { data: approved } = await manager.api.rpc("staff_approve_credit", {
      p_credit_id: requested.credit_id,
      p_idempotency_key: randomUUID(),
    });
    expect(approved?.ok, JSON.stringify(approved)).toBe(true);

    const state = await settlementOf(invoiceId);
    // AC-92 and AC-93: no payment, so Unpaid — with the approved balance recorded separately.
    expect(state.paid).toBe(0);
    expect(state.credit).toBe(300_000);
    expect(state.status).toBe("unpaid");
  });

  it("routes a balance above TZS 500,000 to a Director and refuses the Manager", async () => {
    const { invoiceId } = await invoicedOrder(8); // 800 000

    const { data: requested } = await cashier.api.rpc("staff_request_credit", {
      p_invoice_id: invoiceId,
      p_amount_tzs: 800_000,
      p_reason: "large customer",
      p_idempotency_key: randomUUID(),
    });
    expect(requested.required_role).toBe("director");

    const { data: refused } = await manager.api.rpc("staff_approve_credit", {
      p_credit_id: requested.credit_id,
      p_idempotency_key: randomUUID(),
    });
    expect(refused?.ok).toBe(false);
    expect(refused.reason).toBe("director_approval_required");
    expect(Number(refused.manager_limit_tzs)).toBe(500_000);

    const { data: approved } = await director.api.rpc("staff_approve_credit", {
      p_credit_id: requested.credit_id,
      p_idempotency_key: randomUUID(),
    });
    expect(approved?.ok, JSON.stringify(approved)).toBe(true);
  });
});

describe("dispatch, step by step", () => {
  let invoiceId: string;
  let dispatchId: string;
  let allocationId: string;

  beforeAll(async () => {
    const created = await invoicedOrder(10);
    invoiceId = created.invoiceId;

    await cashier.api.rpc("staff_record_payment", {
      p_invoice_id: invoiceId,
      p_method: "cash",
      p_amount_tzs: 10 * UNIT_PRICE,
      p_idempotency_key: randomUUID(),
    });
    await cashier.api.rpc("staff_approve_settlement", {
      p_invoice_id: invoiceId,
      p_idempotency_key: randomUUID(),
    });

    const { data: allocation } = await director.read
      .from("stock_allocations")
      .select("id")
      .eq("order_id", created.orderId)
      .single();
    allocationId = allocation!.id as string;
  });

  it("commits the stock at settlement without moving it", async () => {
    const { data } = await director.read
      .from("stock_allocations")
      .select("state")
      .eq("id", allocationId)
      .single();
    expect(data!.state).toBe("committed");
    expect((await settlementOf(invoiceId)).releasable).toBe(true);
  });

  it("refuses assignment by anyone but the Cashier", async () => {
    for (const fixture of [manager, director, salesRep]) {
      const { data } = await fixture.api.rpc("staff_assign_dispatch", {
        p_invoice_id: invoiceId,
        p_storekeeper_id: storekeeperId,
        p_source_location: "store",
        p_lines: [{ allocation_id: allocationId, quantity: 1 }],
        p_idempotency_key: randomUUID(),
      });
      expect(data).toBeNull();
    }
  });

  it("assigns without moving stock", async () => {
    const before = await stockAt("store");

    const { data } = await cashier.api.rpc("staff_assign_dispatch", {
      p_invoice_id: invoiceId,
      p_storekeeper_id: storekeeperId,
      p_source_location: "store",
      p_lines: [{ allocation_id: allocationId, quantity: 6 }],
      p_idempotency_key: randomUUID(),
    });

    expect(data?.ok, JSON.stringify(data)).toBe(true);
    dispatchId = (data.dispatch as { id: string }).id;
    expect(await stockAt("store")).toBe(before);
  });

  it("refuses release before the dispatch-note number exists", async () => {
    const before = await stockAt("store");

    const { data } = await manager.api.rpc("staff_confirm_release", {
      p_dispatch_id: dispatchId,
      p_idempotency_key: randomUUID(),
    });

    expect(data?.ok).toBe(false);
    expect(data.reason).toBe("dispatch_note_missing");
    expect(await stockAt("store")).toBe(before);
  });

  it("records the physical note number, still without moving stock", async () => {
    const before = await stockAt("store");

    const { data } = await manager.api.rpc("staff_record_dispatch_note", {
      p_dispatch_id: dispatchId,
      p_note_no: `DN-${randomUUID().slice(0, 8)}`,
      p_idempotency_key: randomUUID(),
    });

    expect(data?.ok, JSON.stringify(data)).toBe(true);
    expect(await stockAt("store")).toBe(before);
  });

  it("moves stock only when the Manager confirms the signature", async () => {
    const before = await stockAt("store");

    const { data: refusedByCashier } = await cashier.api.rpc("staff_confirm_release", {
      p_dispatch_id: dispatchId,
      p_idempotency_key: randomUUID(),
    });
    expect(refusedByCashier, "a Cashier confirmed a release").toBeNull();

    const { data } = await manager.api.rpc("staff_confirm_release", {
      p_dispatch_id: dispatchId,
      p_idempotency_key: randomUUID(),
    });

    expect(data?.ok, JSON.stringify(data)).toBe(true);
    expect(await stockAt("store")).toBe(before - 6);
  });

  it("leaves the remainder committed and visible as paid-but-unreleased", async () => {
    const { data } = await director.read
      .from("paid_but_unreleased")
      .select("outstanding_quantity")
      .eq("allocation_id", allocationId)
      .single();
    // Ten claimed, six released: four still owed to the customer.
    expect(Number(data!.outstanding_quantity)).toBe(4);
  });

  it("refuses a second release of the same dispatch", async () => {
    const before = await stockAt("store");
    const { data } = await manager.api.rpc("staff_confirm_release", {
      p_dispatch_id: dispatchId,
      p_idempotency_key: randomUUID(),
    });
    expect(data?.ok).toBe(false);
    expect(data.reason).toBe("already_settled");
    expect(await stockAt("store")).toBe(before);
  });
});

describe("a burst of identical releases", () => {
  it("moves the stock once and replays to everybody else", async () => {
    const created = await invoicedOrder(5);

    await cashier.api.rpc("staff_record_payment", {
      p_invoice_id: created.invoiceId,
      p_method: "cash",
      p_amount_tzs: 5 * UNIT_PRICE,
      p_idempotency_key: randomUUID(),
    });
    await cashier.api.rpc("staff_approve_settlement", {
      p_invoice_id: created.invoiceId,
      p_idempotency_key: randomUUID(),
    });

    const { data: allocation } = await director.read
      .from("stock_allocations")
      .select("id")
      .eq("order_id", created.orderId)
      .single();

    const { data: dispatch } = await cashier.api.rpc("staff_assign_dispatch", {
      p_invoice_id: created.invoiceId,
      p_storekeeper_id: storekeeperId,
      p_source_location: "store",
      p_lines: [{ allocation_id: allocation!.id, quantity: 5 }],
      p_idempotency_key: randomUUID(),
    });
    const dispatchId = (dispatch!.dispatch as { id: string }).id;

    await manager.api.rpc("staff_record_dispatch_note", {
      p_dispatch_id: dispatchId,
      p_note_no: `DN-${randomUUID().slice(0, 8)}`,
      p_idempotency_key: randomUUID(),
    });

    const before = await stockAt("store");

    // ONE key, six simultaneous confirmations — a double-tap on a slow connection.
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        manager.api.rpc("staff_confirm_release", {
          p_dispatch_id: dispatchId,
          p_idempotency_key: key,
        }),
      ),
    );

    expect(results.every((result) => result.error === null), JSON.stringify(results)).toBe(true);
    const reasons = results.map((result) => String(result.data?.reason));
    expect(reasons.filter((reason) => reason === "released")).toHaveLength(1);
    expect(reasons.filter((reason) => reason === "replayed")).toHaveLength(5);

    // The fact the reasons are a proxy for: five units left the yard, not thirty.
    expect(await stockAt("store")).toBe(before - 5);
  });
});

describe("the atomic walk-in sale (product.md §12.4)", () => {
  it("creates everything at payment, or nothing at all", async () => {
    const { data: order } = await salesRep.api.rpc("staff_create_order", {
      p_customer_id: cashCustomerId,
      p_lines: [{ product_id: productId, quantity: 2 }],
      p_idempotency_key: randomUUID(),
    });
    const orderId = (order!.order as { id: string }).id;

    await salesRep.api.rpc("staff_confirm_order", {
      p_order_id: orderId,
      p_idempotency_key: randomUUID(),
    });

    // Part payment is refused outright: §12.4 permits the walk-in path only for a fully paid sale.
    const { data: short } = await cashier.api.rpc("staff_take_cash_payment", {
      p_order_id: orderId,
      p_method: "cash",
      p_amount_tzs: UNIT_PRICE,
      p_idempotency_key: randomUUID(),
    });
    expect(short?.ok).toBe(false);
    expect(short.reason).toBe("cash_sale_must_be_paid_in_full");

    const { data: none } = await cashier.read
      .from("invoices")
      .select("id")
      .eq("order_id", orderId);
    expect(none, "a refused walk-in sale left an invoice behind").toHaveLength(0);

    const { data: paid } = await cashier.api.rpc("staff_take_cash_payment", {
      p_order_id: orderId,
      p_method: "cash",
      p_amount_tzs: 2 * UNIT_PRICE,
      p_idempotency_key: randomUUID(),
    });
    expect(paid?.ok, JSON.stringify(paid)).toBe(true);

    const invoiceId = (paid.invoice as { id: string }).id;
    const state = await settlementOf(invoiceId);
    expect(state.status).toBe("paid");
    expect(state.releasable).toBe(true);

    // AC-90: committed, never an unpaid reservation.
    const { data: allocation } = await cashier.read
      .from("stock_allocations")
      .select("state")
      .eq("order_id", orderId)
      .single();
    expect(allocation!.state).toBe("committed");
  });
});

describe("payment reversal (product.md §4.1, AC-21)", () => {
  it("is a Director decision, and writes a new negative row", async () => {
    const { invoiceId } = await invoicedOrder(2);

    const { data: payment } = await cashier.api.rpc("staff_record_payment", {
      p_invoice_id: invoiceId,
      p_method: "cash",
      p_amount_tzs: 2 * UNIT_PRICE,
      p_idempotency_key: randomUUID(),
    });
    const paymentId = (payment!.payment as { id: string }).id;

    const { data: requested } = await cashier.api.rpc("staff_request_payment_reversal", {
      p_payment_id: paymentId,
      p_reason: "paid against the wrong invoice",
      p_idempotency_key: randomUUID(),
    });
    expect(requested?.ok, JSON.stringify(requested)).toBe(true);

    // Asking changes nothing.
    expect((await settlementOf(invoiceId)).paid).toBe(2 * UNIT_PRICE);

    const { data: refused } = await manager.api.rpc("admin_approve_payment_reversal", {
      p_payment_id: paymentId,
      p_idempotency_key: randomUUID(),
    });
    expect(refused, "a Manager approved a reversal").toBeNull();

    const { data: approved } = await director.api.rpc("admin_approve_payment_reversal", {
      p_payment_id: paymentId,
      p_idempotency_key: randomUUID(),
    });
    expect(approved?.ok, JSON.stringify(approved)).toBe(true);

    const state = await settlementOf(invoiceId);
    expect(state.paid).toBe(0);
    expect(state.status).toBe("unpaid");

    // The original is untouched; the reversal is a second, negative row.
    const { data: rows } = await director.read
      .from("payments")
      .select("amount_tzs, reverses_id")
      .eq("invoice_id", invoiceId)
      .order("entry_seq");
    expect(rows).toHaveLength(2);
    expect(Number(rows![0].amount_tzs)).toBe(2 * UNIT_PRICE);
    expect(Number(rows![1].amount_tzs)).toBe(-2 * UNIT_PRICE);
    expect(rows![1].reverses_id).toBe(paymentId);
  });

  it("refuses to edit or delete a payment from outside", async () => {
    const { data: payment } = await director.read
      .from("payments")
      .select("id")
      .limit(1)
      .single();

    const { error: updateError } = await manager.read
      .from("payments")
      .update({ amount_tzs: 1 })
      .eq("id", payment!.id);
    expect(updateError, "a Manager rewrote a payment").not.toBeNull();

    const { error: deleteError } = await manager.read
      .from("payments")
      .delete()
      .eq("id", payment!.id);
    expect(deleteError, "a Manager deleted a payment").not.toBeNull();
  });
});

describe("the same payment, submitted twice", () => {
  it("records the money once when the key is reused", async () => {
    const { invoiceId } = await invoicedOrder(4); // 400 000
    const key = randomUUID();

    const first = await cashier.api.rpc("staff_record_payment", {
      p_invoice_id: invoiceId,
      p_method: "cash",
      p_amount_tzs: 400_000,
      p_idempotency_key: key,
    });
    expect(first.data?.reason).toBe("recorded");

    // The second tap of a double-tap, arriving after the first has answered.
    const second = await cashier.api.rpc("staff_record_payment", {
      p_invoice_id: invoiceId,
      p_method: "cash",
      p_amount_tzs: 400_000,
      p_idempotency_key: key,
    });
    expect(second.data?.ok).toBe(true);
    expect(second.data?.reason).toBe("replayed");

    // The fact those reasons are a proxy for: 400 000 came in, not 800 000 — and the invoice is
    // paid rather than overpaid, which the balance check would have refused on a second real row.
    const state = await settlementOf(invoiceId);
    expect(state.paid).toBe(400_000);
    expect(state.outstanding).toBe(0);
    expect(state.status).toBe("paid");

    const { data: rows } = await director.read
      .from("payments")
      .select("id")
      .eq("invoice_id", invoiceId);
    expect(rows).toHaveLength(1);
  });

  it("records the money once when six arrive at the same moment", async () => {
    const { invoiceId } = await invoicedOrder(3); // 300 000

    // ONE key, six simultaneous submissions — a double-tap on a slow connection, which is what
    // the Stage 10A feedback contract exists to prevent and what this proves it cannot cost.
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        cashier.api.rpc("staff_record_payment", {
          p_invoice_id: invoiceId,
          p_method: "cash",
          p_amount_tzs: 300_000,
          p_idempotency_key: key,
        }),
      ),
    );

    expect(results.every((result) => result.error === null), JSON.stringify(results)).toBe(true);
    const reasons = results.map((result) => String(result.data?.reason));
    expect(reasons.filter((reason) => reason === "recorded")).toHaveLength(1);
    expect(reasons.filter((reason) => reason === "replayed")).toHaveLength(5);

    const state = await settlementOf(invoiceId);
    expect(state.paid).toBe(300_000);
    expect(state.status).toBe("paid");
  });

  it("refuses a reused key that carries different money", async () => {
    const { invoiceId } = await invoicedOrder(2); // 200 000
    const key = randomUUID();

    await cashier.api.rpc("staff_record_payment", {
      p_invoice_id: invoiceId,
      p_method: "cash",
      p_amount_tzs: 100_000,
      p_idempotency_key: key,
    });

    // Not a replay: the same key with a different amount is a different command, and answering it
    // with the first one's result would report money that never arrived.
    const { data } = await cashier.api.rpc("staff_record_payment", {
      p_invoice_id: invoiceId,
      p_method: "cash",
      p_amount_tzs: 50_000,
      p_idempotency_key: key,
    });
    expect(data?.ok).toBe(false);
    expect(data.reason).toBe("idempotency_key_conflict");

    expect((await settlementOf(invoiceId)).paid).toBe(100_000);
  });
});

describe("a rejected credit (product.md §4.3)", () => {
  it("is a decision of its own, needs a reason, and leaves the balance owed", async () => {
    const { invoiceId } = await invoicedOrder(3); // 300 000, inside the Manager limit

    const { data: requested } = await cashier.api.rpc("staff_request_credit", {
      p_invoice_id: invoiceId,
      p_amount_tzs: 300_000,
      p_reason: "asked for thirty days",
      p_idempotency_key: randomUUID(),
    });
    expect(requested?.ok, JSON.stringify(requested)).toBe(true);
    const creditId = requested.credit_id as string;

    // §4.3: a rejection is a completed decision, so it records why. Refusing without one would
    // leave the customer told no and the record unable to say on what grounds.
    const { data: bare } = await manager.api.rpc("staff_reject_credit", {
      p_credit_id: creditId,
      p_reason: "  ",
      p_idempotency_key: randomUUID(),
    });
    expect(bare?.ok).toBe(false);
    expect(bare.reason).toBe("reason_required");

    const { data: rejected } = await manager.api.rpc("staff_reject_credit", {
      p_credit_id: creditId,
      p_reason: "already carrying two balances",
      p_idempotency_key: randomUUID(),
    });
    expect(rejected?.ok, JSON.stringify(rejected)).toBe(true);

    // AC-93 from the other side: a rejection approves nothing, so no credit is counted and the
    // money is still owed.
    const state = await settlementOf(invoiceId);
    expect(state.credit).toBe(0);
    expect(state.outstanding).toBe(300_000);
    expect(state.status).toBe("unpaid");
    expect(state.releasable).toBe(false);

    // §4.3 again: "Only an approved outcome records an approver." A rejection must not leave one.
    const { data: request } = await director.read
      .from("approval_requests")
      .select("status, approved_by, approved_at")
      .eq("entity_type", "credit_authorisation")
      .eq("entity_id", creditId)
      .single();
    expect(request!.status).toBe("rejected");
    expect(request!.approved_by).toBeNull();
    expect(request!.approved_at).toBeNull();

    // And the decision itself is on the record, with its reason.
    const { data: decisions } = await director.read
      .from("approval_decisions")
      .select("outcome, note, decided_role")
      .eq("request_id", (await requestIdFor(creditId))!);
    expect(decisions).toHaveLength(1);
    expect(decisions![0].outcome).toBe("rejected");
    expect(decisions![0].note).toBe("already carrying two balances");
    expect(decisions![0].decided_role).toBe("manager");

    // A settled request cannot be decided a second time in the other direction.
    const { data: again } = await manager.api.rpc("staff_approve_credit", {
      p_credit_id: creditId,
      p_idempotency_key: randomUUID(),
    });
    expect(again?.ok).toBe(false);
    expect(again.reason).toBe("already_settled");
  });
});

describe("a storekeeper who has been switched off (product.md §3.2)", () => {
  it("cannot be assigned, and can be switched back on", async () => {
    const { data: keeper } = await director.api.rpc("admin_add_storekeeper", {
      p_full_name: `Temporary Keeper ${randomUUID().slice(0, 8)}`,
      p_phone: null,
      p_start_date: new Date().toISOString().slice(0, 10),
      p_note: null,
      p_idempotency_key: randomUUID(),
    });
    const temporaryId = (keeper!.storekeeper as { id: string }).id;

    // §3.2 gives registration and deactivation to a Director alone.
    const { error: managerRefused } = await manager.api.rpc("admin_set_storekeeper_active", {
      p_storekeeper_id: temporaryId,
      p_is_active: false,
      p_idempotency_key: randomUUID(),
    });
    expect(managerRefused, "a Manager switched a storekeeper off").not.toBeNull();

    const { data: off } = await director.api.rpc("admin_set_storekeeper_active", {
      p_storekeeper_id: temporaryId,
      p_is_active: false,
      p_idempotency_key: randomUUID(),
    });
    expect(off?.ok, JSON.stringify(off)).toBe(true);

    // Deactivated, NEVER deleted: the row is still there, so every dispatch that ever named this
    // person still names them.
    const { data: row } = await director.read
      .from("storekeepers")
      .select("is_active, deactivated_at")
      .eq("id", temporaryId)
      .single();
    expect(row!.is_active).toBe(false);
    expect(row!.deactivated_at).not.toBeNull();

    const settled = await settledInvoice(2);
    const { data: refused } = await cashier.api.rpc("staff_assign_dispatch", {
      p_invoice_id: settled.invoiceId,
      p_storekeeper_id: temporaryId,
      p_source_location: "store",
      p_lines: [{ allocation_id: settled.allocationId, quantity: 2 }],
      p_idempotency_key: randomUUID(),
    });
    expect(refused?.ok).toBe(false);
    expect(refused.reason).toBe("no_storekeeper");

    const { data: on } = await director.api.rpc("admin_set_storekeeper_active", {
      p_storekeeper_id: temporaryId,
      p_is_active: true,
      p_idempotency_key: randomUUID(),
    });
    expect(on?.ok, JSON.stringify(on)).toBe(true);

    const { data: assigned } = await cashier.api.rpc("staff_assign_dispatch", {
      p_invoice_id: settled.invoiceId,
      p_storekeeper_id: temporaryId,
      p_source_location: "store",
      p_lines: [{ allocation_id: settled.allocationId, quantity: 2 }],
      p_idempotency_key: randomUUID(),
    });
    expect(assigned?.ok, JSON.stringify(assigned)).toBe(true);
  });
});

describe("the approved role boundary (design.md §4.2)", () => {
  /**
   * The five raw tables and the three views, asked for directly over HTTP as each role.
   *
   * This is the layer that matters: a policy is a claim about a query nobody has run. These run
   * the query, as a real signed-in Sales Representative, against PostgREST — the surface a
   * hand-rolled call would actually use.
   */
  const RAW_TABLES = [
    "payments",
    "credit_authorisations",
    "dispatches",
    "dispatch_lines",
    "storekeepers",
  ];

  const VIEWS = [
    "invoice_settlement",
    "paid_but_unreleased",
    "customer_credit_exposure",
    "cash_sales_awaiting_payment",
    "assignable_dispatch_invoices",
    "assignable_dispatch_lines",
  ];

  beforeAll(async () => {
    // Something in every one of them, so "zero rows" is a refusal rather than an empty database.
    const settled = await settledInvoice(2);
    await cashier.api.rpc("staff_assign_dispatch", {
      p_invoice_id: settled.invoiceId,
      p_storekeeper_id: storekeeperId,
      p_source_location: "store",
      p_lines: [{ allocation_id: settled.allocationId, quantity: 1 }],
      p_idempotency_key: randomUUID(),
    });
    // A confirmed walk-in order left UNPAID, so `cash_sales_awaiting_payment` has a row to show
    // the roles entitled to it — an empty view would make "a Sales Representative sees nothing"
    // prove nothing at all.
    const { data: walkIn } = await salesRep.api.rpc("staff_create_order", {
      p_customer_id: cashCustomerId,
      p_lines: [{ product_id: productId, quantity: 1 }],
      p_idempotency_key: randomUUID(),
    });
    await salesRep.api.rpc("staff_confirm_order", {
      p_order_id: (walkIn!.order as { id: string }).id,
      p_idempotency_key: randomUUID(),
    });

    const credited = await invoicedOrder(3);
    await cashier.api.rpc("staff_request_credit", {
      p_invoice_id: credited.invoiceId,
      p_amount_tzs: 300_000,
      p_reason: "boundary fixture",
      p_idempotency_key: randomUUID(),
    });
    await manager.api.rpc("staff_approve_credit", {
      p_credit_id: (
        await director.read
          .from("credit_authorisations")
          .select("id")
          .eq("invoice_id", credited.invoiceId)
          .single()
      ).data!.id as string,
      p_idempotency_key: randomUUID(),
    });
  });

  it("shows a Sales Representative nothing in any settlement table", async () => {
    for (const table of RAW_TABLES) {
      const { data, error } = await salesRep.read.from(table).select("*");
      expect(error, `${table} errored for a Sales Representative`).toBeNull();
      expect(data, `a Sales Representative read ${table}`).toHaveLength(0);
    }
  });

  it("shows a Sales Representative nothing in any settlement view either", async () => {
    // Not zero money — NOTHING. `invoice_settlement` LEFT JOINs the payments they cannot see, so
    // without the guard on the view it would call every invoice in the business unpaid.
    for (const view of VIEWS) {
      const { data, error } = await salesRep.read.from(view).select("*");
      expect(error, `${view} errored for a Sales Representative`).toBeNull();
      expect(data, `a Sales Representative read ${view}`).toHaveLength(0);
    }
  });

  it("still shows a Cashier, a Manager and a Director everything they work with", async () => {
    for (const who of [cashier, manager, director]) {
      for (const relation of [...RAW_TABLES, ...VIEWS]) {
        const { data, error } = await who.read.from(relation).select("*");
        expect(error, `${relation} errored for a ${who.role}`).toBeNull();
        expect(
          (data ?? []).length,
          `a ${who.role} could not read ${relation}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("leaves the Sales Representative everything an order needs", async () => {
    // The boundary takes settlement facts away and nothing else: they still write and read orders,
    // which is the work §12.6 steps 1 to 4 give them.
    for (const relation of ["orders", "invoices", "customers", "order_lines", "invoice_lines"]) {
      const { data, error } = await salesRep.read.from(relation).select("*");
      expect(error, `${relation} errored for a Sales Representative`).toBeNull();
      expect((data ?? []).length, `a Sales Representative lost ${relation}`).toBeGreaterThan(0);
    }
  });

  it("refuses a Sales Representative every settlement command", async () => {
    const attempts: [string, Record<string, unknown>][] = [
      ["staff_record_payment", {
        p_invoice_id: randomUUID(), p_method: "cash", p_amount_tzs: 1,
        p_idempotency_key: randomUUID(),
      }],
      ["staff_approve_settlement", {
        p_invoice_id: randomUUID(), p_idempotency_key: randomUUID(),
      }],
      ["staff_assign_dispatch", {
        p_invoice_id: randomUUID(), p_storekeeper_id: randomUUID(), p_source_location: "store",
        p_lines: [], p_idempotency_key: randomUUID(),
      }],
    ];

    for (const [command, args] of attempts) {
      const { error } = await salesRep.api.rpc(command, args);
      expect(error, `a Sales Representative ran ${command}`).not.toBeNull();
    }
  });
});

describe("a queue larger than one page, and larger than the API row cap", () => {
  it("counts every unsettled invoice and reads a page of them without losing money", async () => {
    const created = await invoicedOrder(4); // 400 000

    // ONE THOUSAND AND SIXTY payments against a single invoice — more than PostgREST will return
    // in one response. Seeded directly, because reaching this state through the product would take
    // a thousand round trips, and the point is what the READ does with it.
    //
    // A payment is append-only and signed (§12.5), so these are ordinary positive rows; the total
    // they add up to is the figure the queue has to get exactly right.
    asOwner(`
      insert into public.payments
        (invoice_id, amount_tzs, method, received_by, received_role, business_date, correlation_id)
      select '${created.invoiceId}'::uuid, 1, 'cash', '${cashier.userId}'::uuid, 'cashier',
             current_date, gen_random_uuid()
        from generate_series(1, 1060);
    `);

    const { data, error } = await cashier.read
      .from("invoice_settlement")
      .select("amount_paid_tzs, outstanding_tzs")
      .eq("invoice_id", created.invoiceId)
      .single();

    expect(error, error?.message).toBeNull();
    // The view aggregates in SQL, so it is right whatever the row cap is — this is the figure the
    // application's own batched read has to reproduce.
    expect(Number(data!.amount_paid_tzs)).toBe(1060);

    // And the rows themselves are past the cap: one unbounded request cannot return them all.
    const capped = await cashier.read
      .from("payments")
      .select("id")
      .eq("invoice_id", created.invoiceId);
    expect(capped.error, capped.error?.message).toBeNull();
    expect(
      (capped.data ?? []).length,
      "PostgREST returned more than its own max-rows, so this test proves nothing",
    ).toBeLessThan(1060);

    // Read the way `readEvery` does — by explicit range until a short batch comes back — and the
    // count is exact again.
    let total = 0;
    for (let from = 0; from < 5000; from += 1000) {
      const batch = await cashier.read
        .from("payments")
        .select("id")
        .eq("invoice_id", created.invoiceId)
        .order("entry_seq")
        .range(from, from + 999);
      expect(batch.error, batch.error?.message).toBeNull();
      total += (batch.data ?? []).length;
      if ((batch.data ?? []).length < 1000) break;
    }
    expect(total).toBe(1060);
  });

  it("reports an exact count of unsettled invoices, not the size of a page", async () => {
    const { count, error } = await cashier.read
      .from("invoices")
      .select("id", { count: "exact", head: true })
      .is("cancelled_at", null)
      .is("settlement_approved_at", null);

    expect(error, error?.message).toBeNull();

    const firstPage = await cashier.read
      .from("invoices")
      .select("id")
      .is("cancelled_at", null)
      .is("settlement_approved_at", null)
      .order("issued_at", { ascending: true })
      .range(0, 24);

    expect(firstPage.error, firstPage.error?.message).toBeNull();
    // A page is at most twenty-five; the count is the truth about how much work there is, and the
    // screen shows it so nothing is silently off the end.
    expect((firstPage.data ?? []).length).toBeLessThanOrEqual(25);
    expect(count).toBeGreaterThanOrEqual((firstPage.data ?? []).length);
  });

  it("totals a customer's exposure across every invoice, not across a page", async () => {
    const { data: customer } = await salesRep.api.rpc("staff_add_customer", {
      p_name: `Exposure Customer ${randomUUID().slice(0, 8)}`,
      p_idempotency_key: randomUUID(),
    });
    const exposedCustomerId = (customer!.customer as { id: string }).id;

    // Three invoices, three approved credits, each inside the Manager limit.
    for (let i = 0; i < 3; i += 1) {
      const { data: order } = await salesRep.api.rpc("staff_create_order", {
        p_customer_id: exposedCustomerId,
        p_lines: [{ product_id: productId, quantity: 1 }],
        p_idempotency_key: randomUUID(),
      });
      const orderId = (order!.order as { id: string }).id;
      const { data: confirmed } = await salesRep.api.rpc("staff_confirm_order", {
        p_order_id: orderId,
        p_idempotency_key: randomUUID(),
      });
      const invoiceId = (confirmed!.invoice as { id: string }).id;

      const { data: requested } = await cashier.api.rpc("staff_request_credit", {
        p_invoice_id: invoiceId,
        p_amount_tzs: UNIT_PRICE,
        p_reason: "exposure fixture",
        p_idempotency_key: randomUUID(),
      });
      await manager.api.rpc("staff_approve_credit", {
        p_credit_id: requested!.credit_id,
        p_idempotency_key: randomUUID(),
      });
    }

    const { data, error } = await manager.read
      .from("customer_credit_exposure")
      .select("exposure_tzs")
      .eq("customer_id", exposedCustomerId)
      .single();

    expect(error, error?.message).toBeNull();
    // Three invoices, one aggregate: a screen showing one page of them still reads the whole debt.
    expect(Number(data!.exposure_tzs)).toBe(3 * UNIT_PRICE);
  });
});

describe("a second dispatch after a partial release", () => {
  it("leaves the remainder assignable, and the assignable figure is what the command accepts",
    async () => {
      const settled = await settledInvoice(10);

      // FIRST DISPATCH: four of the ten.
      const { data: first } = await cashier.api.rpc("staff_assign_dispatch", {
        p_invoice_id: settled.invoiceId,
        p_storekeeper_id: storekeeperId,
        p_source_location: "store",
        p_lines: [{ allocation_id: settled.allocationId, quantity: 4 }],
        p_idempotency_key: randomUUID(),
      });
      expect(first?.ok, JSON.stringify(first)).toBe(true);
      const firstId = (first.dispatch as { id: string }).id;

      // While it is in progress, only six are assignable — the four are spoken for.
      expect(await assignableOn(settled.allocationId)).toBe(6);

      const overreach = await cashier.api.rpc("staff_assign_dispatch", {
        p_invoice_id: settled.invoiceId,
        p_storekeeper_id: storekeeperId,
        p_source_location: "store",
        p_lines: [{ allocation_id: settled.allocationId, quantity: 7 }],
        p_idempotency_key: randomUUID(),
      });
      expect(overreach.data?.ok).toBe(false);
      expect(overreach.data.reason).toBe("exceeds_outstanding");
      expect(Number(overreach.data.outstanding)).toBe(6);

      await manager.api.rpc("staff_record_dispatch_note", {
        p_dispatch_id: firstId,
        p_note_no: `DN-${randomUUID().slice(0, 8)}`,
        p_idempotency_key: randomUUID(),
      });
      const released = await manager.api.rpc("staff_confirm_release", {
        p_dispatch_id: firstId,
        p_idempotency_key: randomUUID(),
      });
      expect(released.data?.ok, JSON.stringify(released.data)).toBe(true);

      // AFTER THE PARTIAL RELEASE the remainder is still committed and still assignable — which is
      // what the dispatch screen has to keep offering, and did not before this correction.
      const { data: claim } = await manager.read
        .from("paid_but_unreleased")
        .select("outstanding_quantity")
        .eq("allocation_id", settled.allocationId)
        .single();
      expect(Number(claim!.outstanding_quantity)).toBe(6);
      expect(await assignableOn(settled.allocationId)).toBe(6);

      // SECOND DISPATCH: the remaining six, through the same command the screen calls.
      const { data: second } = await cashier.api.rpc("staff_assign_dispatch", {
        p_invoice_id: settled.invoiceId,
        p_storekeeper_id: storekeeperId,
        p_source_location: "store",
        p_lines: [{ allocation_id: settled.allocationId, quantity: 6 }],
        p_idempotency_key: randomUUID(),
      });
      expect(second?.ok, JSON.stringify(second)).toBe(true);
      const secondId = (second.dispatch as { id: string }).id;

      expect(await assignableOn(settled.allocationId)).toBe(0);

      await manager.api.rpc("staff_record_dispatch_note", {
        p_dispatch_id: secondId,
        p_note_no: `DN-${randomUUID().slice(0, 8)}`,
        p_idempotency_key: randomUUID(),
      });
      const finalRelease = await manager.api.rpc("staff_confirm_release", {
        p_dispatch_id: secondId,
        p_idempotency_key: randomUUID(),
      });
      expect(finalRelease.data?.ok, JSON.stringify(finalRelease.data)).toBe(true);

      // Nothing left owed, and nothing left in the paid-but-unreleased list for this claim.
      const { data: gone } = await manager.read
        .from("paid_but_unreleased")
        .select("allocation_id")
        .eq("allocation_id", settled.allocationId);
      expect(gone).toHaveLength(0);
    });
});

describe("the walk-in queue, and what an anti-join in the wrong place hides", () => {
  /**
   * Thirty completed walk-in sales, then one that still needs paying.
   *
   * This is the shape of the defect exactly: the loader used to take the twenty-five oldest
   * confirmed walk-in orders and THEN drop the ones already invoiced. Thirty finished sales from
   * last week spend the whole limit, so the Cashier is shown an empty queue while a customer
   * stands at the till. `public.cash_sales_awaiting_payment` applies the anti-join first, so the
   * limit only ever spends rows that are genuinely waiting.
   */
  it("never lets completed sales fill the page ahead of one that needs paying", async () => {
    const before = await cashier.read
      .from("cash_sales_awaiting_payment")
      .select("order_id", { count: "exact", head: true });
    const waitingBefore = before.count ?? 0;

    // Thirty walk-in orders, confirmed and paid for — done, and older than what follows.
    for (let i = 0; i < 30; i += 1) {
      const { data: order } = await salesRep.api.rpc("staff_create_order", {
        p_customer_id: cashCustomerId,
        p_lines: [{ product_id: productId, quantity: 1 }],
        p_idempotency_key: randomUUID(),
      });
      const orderId = (order!.order as { id: string }).id;
      await salesRep.api.rpc("staff_confirm_order", {
        p_order_id: orderId,
        p_idempotency_key: randomUUID(),
      });
      const paid = await cashier.api.rpc("staff_take_cash_payment", {
        p_order_id: orderId,
        p_method: "cash",
        p_amount_tzs: UNIT_PRICE,
        p_idempotency_key: randomUUID(),
      });
      expect(paid.data?.ok, JSON.stringify(paid.data)).toBe(true);
    }

    // And one that is confirmed and NOT paid: the sale the Cashier has to be able to see.
    const { data: waiting } = await salesRep.api.rpc("staff_create_order", {
      p_customer_id: cashCustomerId,
      p_lines: [{ product_id: productId, quantity: 2 }],
      p_idempotency_key: randomUUID(),
    });
    const waitingOrderId = (waiting!.order as { id: string }).id;
    await salesRep.api.rpc("staff_confirm_order", {
      p_order_id: waitingOrderId,
      p_idempotency_key: randomUUID(),
    });

    // The thirty completed ones are not in the queue at all — not filtered out of a page of it.
    const page = await cashier.read
      .from("cash_sales_awaiting_payment")
      .select("order_id, order_no, total_tzs", { count: "exact" })
      .order("created_at", { ascending: true })
      .order("order_id", { ascending: true })
      .range(0, 24);

    expect(page.error, page.error?.message).toBeNull();
    expect(page.count).toBe(waitingBefore + 1);
    expect((page.data ?? []).map((row) => row.order_id)).toContain(waitingOrderId);

    // And it carries the live proforma total, because there is no invoice to read one from.
    const row = (page.data ?? []).find((candidate) => candidate.order_id === waitingOrderId);
    expect(Number(row!.total_tzs)).toBe(2 * UNIT_PRICE);
  });

  it("drops a walk-in sale out of the queue the moment it is paid", async () => {
    const { data: order } = await salesRep.api.rpc("staff_create_order", {
      p_customer_id: cashCustomerId,
      p_lines: [{ product_id: productId, quantity: 1 }],
      p_idempotency_key: randomUUID(),
    });
    const orderId = (order!.order as { id: string }).id;
    await salesRep.api.rpc("staff_confirm_order", {
      p_order_id: orderId,
      p_idempotency_key: randomUUID(),
    });

    const waiting = await cashier.read
      .from("cash_sales_awaiting_payment")
      .select("order_id")
      .eq("order_id", orderId);
    expect(waiting.data).toHaveLength(1);

    await cashier.api.rpc("staff_take_cash_payment", {
      p_order_id: orderId,
      p_method: "cash",
      p_amount_tzs: UNIT_PRICE,
      p_idempotency_key: randomUUID(),
    });

    const settled = await cashier.read
      .from("cash_sales_awaiting_payment")
      .select("order_id")
      .eq("order_id", orderId);
    expect(settled.data).toHaveLength(0);
  });

  it("refuses the whole queue to a Sales Representative, like every other settlement view",
    async () => {
      const { data, error } = await salesRep.read
        .from("cash_sales_awaiting_payment")
        .select("order_id");
      expect(error, error?.message).toBeNull();
      expect(data).toHaveLength(0);
    });
});

describe("a page number past the end of a queue", () => {
  /**
   * The two ways to ask for a page that is not there, and PostgREST answers them DIFFERENTLY.
   *
   * An EXTREME range — `?awaiting=999`, typed into the address bar — starts far past the last row
   * and is REFUSED with `PGRST103`. Untreated that becomes an outage screen for a mistyped URL.
   *
   * A STALE FINAL PAGE is the other one: clear the last invoice on page 2 and the revalidated
   * render asks for page 2 of a queue that now has one page. That range is answered politely, with
   * an empty list and a POSITIVE COUNT — and an un-normalised screen turns it into "nothing is
   * waiting" over the top of work that exists.
   *
   * `pagedQuery` handles both, and these are the queries it makes.
   */
  async function awaitingPage(page: number) {
    const from = (page - 1) * 25;
    const result = await cashier.read
      .from("invoices")
      .select("id", { count: "exact" })
      .is("cancelled_at", null)
      .is("settlement_approved_at", null)
      .order("issued_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + 24);
    expect(result.error, result.error?.message).toBeNull();
    return { rows: result.data ?? [], total: result.count ?? 0 };
  }

  it("clearing the last row of page 2 leaves a valid page 1 holding the rest", async () => {
    // Twenty-six unsettled invoices: page 1 holds twenty-five, page 2 holds exactly one.
    const created: string[] = [];
    while ((await awaitingPage(1)).total < 26) {
      const made = await invoicedOrder(1);
      created.push(made.invoiceId);
    }

    const second = await awaitingPage(2);
    expect(second.rows.length).toBeGreaterThan(0);
    const lastRow = second.rows.at(-1)!.id as string;

    // Settle everything on page 2, which is what "processing the final row" does.
    for (const row of second.rows) {
      const invoiceId = row.id as string;
      await cashier.api.rpc("staff_record_payment", {
        p_invoice_id: invoiceId,
        p_method: "cash",
        p_amount_tzs: (await settlementOf(invoiceId)).outstanding,
        p_idempotency_key: randomUUID(),
      });
      const approved = await cashier.api.rpc("staff_approve_settlement", {
        p_invoice_id: invoiceId,
        p_idempotency_key: randomUUID(),
      });
      expect(approved.data?.ok, JSON.stringify(approved.data)).toBe(true);
    }

    // Page 2 is now empty and the count is still positive: the exact state the fallback exists for.
    const emptied = await awaitingPage(2);
    expect(emptied.rows).toHaveLength(0);
    expect(emptied.total).toBeGreaterThan(0);

    const lastPage = Math.max(1, Math.ceil(emptied.total / 25));
    const fallback = await awaitingPage(lastPage);
    expect(fallback.rows.length).toBeGreaterThan(0);
    expect(fallback.rows.map((row) => row.id)).not.toContain(lastRow);
  });

  it("an extreme page number is REFUSED by PostgREST, not answered with an empty page", async () => {
    // Worth pinning, because it is the reason `pagedQuery` cannot simply look at `rows.length`:
    // a range starting past the last row comes back as PGRST103, and an untreated refusal would
    // put the Cashier on the error boundary for a mistyped URL.
    const from = 998 * 25;
    const refused = await cashier.read
      .from("invoices")
      .select("id", { count: "exact" })
      .is("cancelled_at", null)
      .is("settlement_approved_at", null)
      .order("issued_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + 24);

    expect(refused.error?.code).toBe("PGRST103");
  });

  it("and the probe the fallback uses resolves it to a last page with records on it", async () => {
    // `range(0, 0)` is satisfiable whatever the queue holds, and carries the exact count.
    const probe = await cashier.read
      .from("invoices")
      .select("id", { count: "exact" })
      .is("cancelled_at", null)
      .is("settlement_approved_at", null)
      .order("issued_at", { ascending: false })
      .order("id", { ascending: false })
      .range(0, 0);

    expect(probe.error, probe.error?.message).toBeNull();
    const total = probe.count ?? 0;
    expect(total).toBeGreaterThan(0);

    const lastPage = Math.max(1, Math.ceil(total / 25));
    const resolved = await awaitingPage(lastPage);
    // Never a false empty state: the count says there is work, and the page shows some of it.
    expect(resolved.rows.length).toBeGreaterThan(0);
    expect(resolved.total).toBe(total);
  });
});

describe("ties in a sort order", () => {
  /**
   * `days_waiting` is a whole number of days and `invoice_no` repeats across the lines of one
   * invoice, so on any ordinary morning most of the paid-but-unreleased list ties twice over. A
   * range over a tie is not a page: the same claim can be returned on two pages, or on neither,
   * and nothing in the answer says so.
   */
  it("pages paid-but-unreleased without duplicating or losing a claim", async () => {
    // Several claims created in one go, so they share a day and several share an invoice.
    for (let i = 0; i < 3; i += 1) {
      const settled = await settledInvoice(3);
      expect(settled.allocationId).toBeTruthy();
    }

    const all = await manager.read
      .from("paid_but_unreleased")
      .select("allocation_id", { count: "exact" })
      .order("days_waiting", { ascending: false })
      .order("invoice_no", { ascending: true })
      .order("allocation_id", { ascending: true })
      .range(0, 999);

    expect(all.error, all.error?.message).toBeNull();
    const total = all.count ?? 0;
    expect(total).toBeGreaterThan(2);

    // Walked two rows at a time, the way a page walks it.
    const seen: string[] = [];
    for (let from = 0; from < total; from += 2) {
      const slice = await manager.read
        .from("paid_but_unreleased")
        .select("allocation_id")
        .order("days_waiting", { ascending: false })
        .order("invoice_no", { ascending: true })
        .order("allocation_id", { ascending: true })
        .range(from, from + 1);
      expect(slice.error, slice.error?.message).toBeNull();
      seen.push(...(slice.data ?? []).map((row) => row.allocation_id as string));
    }

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size, "a claim appeared on two pages").toBe(total);

    const everything = (all.data ?? []).map((row) => row.allocation_id as string);
    expect([...seen].sort()).toEqual([...everything].sort());
  });

  it("pages the unsettled invoice queue the same way, across equal issue times", async () => {
    const all = await cashier.read
      .from("invoices")
      .select("id", { count: "exact" })
      .is("cancelled_at", null)
      .is("settlement_approved_at", null)
      .order("issued_at", { ascending: false })
      .order("id", { ascending: false })
      .range(0, 999);

    const total = all.count ?? 0;
    expect(total).toBeGreaterThan(2);

    const seen: string[] = [];
    for (let from = 0; from < total; from += 3) {
      const slice = await cashier.read
        .from("invoices")
        .select("id")
        .is("cancelled_at", null)
        .is("settlement_approved_at", null)
        .order("issued_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, from + 2);
      seen.push(...(slice.data ?? []).map((row) => row.id as string));
    }

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size, "an invoice appeared on two pages").toBe(total);
  });
});

describe("the assignment queue, and what a page-local derivation hides", () => {
  /** One page of invoices still waiting for a storekeeper, asked for the way the loader asks. */
  async function assignmentPage(page: number) {
    const from = (page - 1) * 25;
    const result = await cashier.read
      .from("assignable_dispatch_invoices")
      .select("invoice_id, invoice_no, days_waiting", { count: "exact" })
      .order("days_waiting", { ascending: false })
      .order("invoice_no", { ascending: true })
      .order("invoice_id", { ascending: true })
      .range(from, from + 24);
    expect(result.error, result.error?.message).toBeNull();
    return { rows: result.data ?? [], total: result.count ?? 0 };
  }

  /**
   * Assigns everything currently waiting, so a scenario can start from an empty queue.
   *
   * Earlier tests in this file leave assignable invoices behind, and "page 1 holds the one claim
   * that is waiting" is only a statement about page 1 if nothing else is ahead of it. Draining
   * makes the scenario the one being tested rather than the one the file happens to be in.
   */
  async function drainAssignmentQueue() {
    for (let guard = 0; guard < 40; guard += 1) {
      const page = await assignmentPage(1);
      if (page.total === 0) return;

      for (const row of page.rows) {
        const invoiceId = row.invoice_id as string;
        const lines = await cashier.read
          .from("assignable_dispatch_lines")
          .select("allocation_id, assignable_quantity")
          .eq("invoice_id", invoiceId);

        const assigned = await cashier.api.rpc("staff_assign_dispatch", {
          p_invoice_id: invoiceId,
          p_storekeeper_id: storekeeperId,
          p_source_location: "store",
          p_lines: (lines.data ?? []).map((line) => ({
            allocation_id: line.allocation_id,
            quantity: Number(line.assignable_quantity),
          })),
          p_idempotency_key: randomUUID(),
        });
        expect(assigned.data?.ok, JSON.stringify(assigned.data)).toBe(true);
      }
    }
    throw new Error("the assignment queue would not drain");
  }

  /** A settled invoice whose whole quantity is already covered by a dispatch in progress. */
  async function fullyAssigned(quantity: number) {
    const settled = await settledInvoice(quantity);
    const assigned = await cashier.api.rpc("staff_assign_dispatch", {
      p_invoice_id: settled.invoiceId,
      p_storekeeper_id: storekeeperId,
      p_source_location: "store",
      p_lines: [{ allocation_id: settled.allocationId, quantity }],
      p_idempotency_key: randomUUID(),
    });
    expect(assigned.data?.ok, JSON.stringify(assigned.data)).toBe(true);
    return settled;
  }

  it("never lets fully covered claims fill the page ahead of one that still needs a storekeeper",
    async () => {
      await drainAssignmentQueue();

      // TWENTY-FIVE older claims, every one already covered by a dispatch that has not gone out.
      // They are still paid-but-unreleased — the goods are in the yard — but there is nothing left
      // to assign on any of them. Derived from a page of THAT list, the assignment queue read
      // twenty-five rows, found nothing assignable, and told the Cashier nothing was waiting.
      const covered: string[] = [];
      for (let i = 0; i < 25; i += 1) {
        covered.push((await fullyAssigned(1)).invoiceId);
      }

      // And one that still needs a storekeeper, created last — so it is behind all twenty-five in
      // every ordering, which is exactly how it used to disappear.
      const waiting = await settledInvoice(4);

      const page = await assignmentPage(1);

      // PAGE ONE, not "somewhere in the queue": the covered twenty-five are not in it at all, so
      // there is nothing to push the one that matters onto a second page.
      expect(page.total).toBe(1);
      expect(page.rows.map((row) => row.invoice_id)).toEqual([waiting.invoiceId]);
      for (const invoiceId of covered) {
        expect(page.rows.map((row) => row.invoice_id)).not.toContain(invoiceId);
      }

      // They ARE still visible as committed stock in the yard, which is a different question and a
      // different list (design.md §7.12).
      const unreleased = await manager.read
        .from("paid_but_unreleased")
        .select("invoice_id", { count: "exact", head: true })
        .in("invoice_id", covered);
      expect(unreleased.count).toBe(25);
    });

  it("keeps every line of one invoice on one card", async () => {
    // Two products on one invoice, so the assignment record has two lines. Splitting them across a
    // page boundary would offer the Cashier half an invoice.
    const { data: order } = await salesRep.api.rpc("staff_create_order", {
      p_customer_id: customerId,
      p_lines: [
        { product_id: productId, quantity: 2 },
        { product_id: secondProductId, quantity: 3 },
      ],
      p_idempotency_key: randomUUID(),
    });
    const orderId = (order!.order as { id: string }).id;
    const { data: confirmed } = await salesRep.api.rpc("staff_confirm_order", {
      p_order_id: orderId,
      p_idempotency_key: randomUUID(),
    });
    const invoiceId = (confirmed!.invoice as { id: string }).id;

    await cashier.api.rpc("staff_record_payment", {
      p_invoice_id: invoiceId,
      p_method: "cash",
      p_amount_tzs: (await settlementOf(invoiceId)).outstanding,
      p_idempotency_key: randomUUID(),
    });
    await cashier.api.rpc("staff_approve_settlement", {
      p_invoice_id: invoiceId,
      p_idempotency_key: randomUUID(),
    });

    const summary = await cashier.read
      .from("assignable_dispatch_invoices")
      .select("line_count, assignable_quantity")
      .eq("invoice_id", invoiceId)
      .single();

    expect(summary.error, summary.error?.message).toBeNull();
    // ONE row for the invoice, carrying BOTH lines — never two rows that could land on two pages.
    expect(Number(summary.data!.line_count)).toBe(2);
    expect(Number(summary.data!.assignable_quantity)).toBe(5);

    const lines = await cashier.read
      .from("assignable_dispatch_lines")
      .select("product_id, assignable_quantity")
      .eq("invoice_id", invoiceId);
    expect(lines.data).toHaveLength(2);
    expect((lines.data ?? []).map((row) => row.product_id).sort())
      .toEqual([productId, secondProductId].sort());
  });

  it("leaves the remainder assignable after a partial assignment, on the same card", async () => {
    const settled = await settledInvoice(10);

    await cashier.api.rpc("staff_assign_dispatch", {
      p_invoice_id: settled.invoiceId,
      p_storekeeper_id: storekeeperId,
      p_source_location: "store",
      p_lines: [{ allocation_id: settled.allocationId, quantity: 4 }],
      p_idempotency_key: randomUUID(),
    });

    const summary = await cashier.read
      .from("assignable_dispatch_invoices")
      .select("assignable_quantity")
      .eq("invoice_id", settled.invoiceId)
      .single();

    // Six left, which is exactly what `api.staff_assign_dispatch` will accept next.
    expect(Number(summary.data!.assignable_quantity)).toBe(6);
  });

  it("pages more than twenty-five assignable invoices without duplicates or omissions",
    async () => {
      while ((await assignmentPage(1)).total < 27) {
        await settledInvoice(1);
      }

      const total = (await assignmentPage(1)).total;
      const pages = Math.ceil(total / 25);
      expect(pages).toBeGreaterThan(1);

      const seen: string[] = [];
      for (let page = 1; page <= pages; page += 1) {
        const rows = (await assignmentPage(page)).rows;
        seen.push(...rows.map((row) => row.invoice_id as string));
      }

      expect(seen).toHaveLength(total);
      expect(new Set(seen).size, "an invoice appeared on two pages").toBe(total);

      // No card is split: an invoice appears on exactly one page, with all of its lines.
      const first = seen[0];
      const lines = await cashier.read
        .from("assignable_dispatch_lines")
        .select("allocation_id")
        .eq("invoice_id", first);
      expect((lines.data ?? []).length).toBeGreaterThan(0);
    });

  it("recovers a stale or extreme assignment page the way the other queues do", async () => {
    const total = (await assignmentPage(1)).total;
    expect(total).toBeGreaterThan(0);

    // Extreme: refused outright, which is why `pagedQuery` cannot just look at `rows.length`.
    const from = 998 * 25;
    const extreme = await cashier.read
      .from("assignable_dispatch_invoices")
      .select("invoice_id", { count: "exact" })
      .order("days_waiting", { ascending: false })
      .order("invoice_no", { ascending: true })
      .order("invoice_id", { ascending: true })
      .range(from, from + 24);
    expect(extreme.error?.code).toBe("PGRST103");

    // And the probe the fallback uses resolves it to a page with records on it.
    const probe = await cashier.read
      .from("assignable_dispatch_invoices")
      .select("invoice_id", { count: "exact" })
      .order("days_waiting", { ascending: false })
      .order("invoice_no", { ascending: true })
      .order("invoice_id", { ascending: true })
      .range(0, 0);
    expect(probe.error, probe.error?.message).toBeNull();

    const lastPage = Math.max(1, Math.ceil((probe.count ?? 0) / 25));
    const resolved = await assignmentPage(lastPage);
    expect(resolved.rows.length).toBeGreaterThan(0);
  });

  it("assigning the last card on the last page leaves an earlier page holding the rest",
    async () => {
      const before = await assignmentPage(1);
      const pages = Math.ceil(before.total / 25);
      expect(pages).toBeGreaterThan(1);

      const last = await assignmentPage(pages);
      expect(last.rows.length).toBeGreaterThan(0);

      // Clear the whole last page, which is what "assigning the final item" does to it.
      for (const row of last.rows) {
        const invoiceId = row.invoice_id as string;
        const lines = await cashier.read
          .from("assignable_dispatch_lines")
          .select("allocation_id, assignable_quantity")
          .eq("invoice_id", invoiceId);

        const assigned = await cashier.api.rpc("staff_assign_dispatch", {
          p_invoice_id: invoiceId,
          p_storekeeper_id: storekeeperId,
          p_source_location: "store",
          p_lines: (lines.data ?? []).map((line) => ({
            allocation_id: line.allocation_id,
            quantity: Number(line.assignable_quantity),
          })),
          p_idempotency_key: randomUUID(),
        });
        expect(assigned.data?.ok, JSON.stringify(assigned.data)).toBe(true);
      }

      // That page is now empty against a count that is still positive — the stale-final-page shape.
      const emptied = await assignmentPage(pages);
      expect(emptied.rows).toHaveLength(0);
      expect(emptied.total).toBeGreaterThan(0);

      const lastPage = Math.max(1, Math.ceil(emptied.total / 25));
      const fallback = await assignmentPage(lastPage);
      expect(fallback.rows.length).toBeGreaterThan(0);
    });

  it("refuses the whole assignment queue to a Sales Representative", async () => {
    for (const view of ["assignable_dispatch_invoices", "assignable_dispatch_lines"]) {
      const { data, error } = await salesRep.read.from(view).select("*");
      expect(error, error?.message).toBeNull();
      expect(data, `a Sales Representative read ${view}`).toHaveLength(0);
    }
  });
});

describe("the settlement tables, from outside the database", () => {
  it("is unreachable with the SECRET key", async () => {
    for (const table of [
      "payments",
      "credit_authorisations",
      "dispatches",
      "dispatch_lines",
      "storekeepers",
    ]) {
      const response = await fetch(
        `${process.env.SUPABASE_URL ?? "http://127.0.0.1:54321"}/rest/v1/${table}?select=*`,
        { headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` } },
      );
      expect(response.status, `the secret key read ${table}`).toBe(403);
    }
  });

  it("resolves every embed the settlement module asks PostgREST for", async () => {
    const invoices = await cashier.read.from("invoices").select(`
      id, invoice_no, order_id, customer_id, business_date, cancelled_at,
      settlement_approved_at,
      orders!inner(order_no, is_cash_sale),
      customers!inner(name)
    `);
    expect(invoices.error, invoices.error?.message).toBeNull();

    const payments = await cashier.read.from("payments").select(`
      id, invoice_id, amount_tzs, method, reverses_id, business_date, received_at,
      profiles!payments_received_by_fkey(full_name)
    `);
    expect(payments.error, payments.error?.message).toBeNull();

    const credits = await cashier.read.from("credit_authorisations").select(`
      id, invoice_id, amount_tzs, reason,
      profiles!credit_authorisations_requested_by_fkey(full_name)
    `);
    expect(credits.error, credits.error?.message).toBeNull();

    const dispatches = await cashier.read.from("dispatches").select(`
      id, invoice_id, dispatch_note_no, source_location, status, assigned_at, released_at,
      invoices!inner(invoice_no, orders!inner(customers!inner(name))),
      storekeepers!inner(full_name),
      profiles!dispatches_assigned_by_fkey(full_name)
    `);
    expect(dispatches.error, dispatches.error?.message).toBeNull();

    const unreleased = await manager.read.from("paid_but_unreleased").select(`
      allocation_id, invoice_id, invoice_no, customer_name, product_id, outstanding_quantity,
      days_waiting
    `);
    expect(unreleased.error, unreleased.error?.message).toBeNull();

    const walkIns = await cashier.read
      .from("cash_sales_awaiting_payment")
      .select("order_id, order_no, customer_name, total_tzs");
    expect(walkIns.error, walkIns.error?.message).toBeNull();

    const options = await cashier.read
      .from("storekeepers")
      .select("id, storekeeper_code, full_name");
    expect(options.error, options.error?.message).toBeNull();

    const assignableInvoices = await cashier.read
      .from("assignable_dispatch_invoices")
      .select("invoice_id, invoice_no, customer_name, days_waiting");
    expect(assignableInvoices.error, assignableInvoices.error?.message).toBeNull();

    const assignableLines = await cashier.read
      .from("assignable_dispatch_lines")
      .select("allocation_id, invoice_id, product_id, assignable_quantity");
    expect(assignableLines.error, assignableLines.error?.message).toBeNull();
  });
});
