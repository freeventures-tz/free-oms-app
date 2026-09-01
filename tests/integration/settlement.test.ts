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

  const VIEWS = ["invoice_settlement", "paid_but_unreleased", "customer_credit_exposure"];

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
  });
});
