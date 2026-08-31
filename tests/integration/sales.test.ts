import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  SECRET_KEY,
  createLiveStaff,
  ensureDirector,
  type Fixture,
} from "@/tests/integration/helpers";

/**
 * Orders, proformas, invoices and reservations, over real HTTP through PostgREST.
 *
 * pgTAP proves the rules inside the database. These prove the same rules survive the journey a
 * browser takes — a session token, a schema header, a JSON body — and they cover the one thing
 * pgTAP structurally cannot: reaching AROUND the commands as `authenticated`, which is a role a
 * GRANT actually constrains, unlike a pgTAP statement running as the table owner.
 */

let director: Fixture;
let manager: Fixture;
let cashier: Fixture;
let salesRep: Fixture;
/** A second Sales Representative, because §12.6 lets any of them confirm any order. */
let otherRep: Fixture;

let customerId: string;
let cashCustomerId: string;
let productId: string;

beforeAll(async () => {
  director = await ensureDirector();
  manager = await createLiveStaff(director, "manager");
  cashier = await createLiveStaff(director, "cashier");
  salesRep = await createLiveStaff(director, "sales_rep");
  // Named apart, so "B sees A's name" cannot pass by B seeing their own row — which is the one
  // `profiles` row RLS has always let them read.
  otherRep = await createLiveStaff(director, "sales_rep", "Amina The Other Rep");

  // A product with a price and stock, created through the real commands.
  const { data: product } = await director.api.rpc("admin_add_product", {
    p_name: `Sales Product ${randomUUID().slice(0, 8)}`,
    p_specification: null,
    p_unit_code: "piece",
    p_unit_content: null,
    p_idempotency_key: randomUUID(),
  });
  expect(product?.ok, JSON.stringify(product)).toBe(true);
  productId = (product.product as { id: string }).id;

  const { data: priced } = await director.api.rpc("admin_set_product_price", {
    p_product_id: productId,
    p_price_tzs: 50_000,
    p_reason: "integration fixture",
    p_idempotency_key: randomUUID(),
  });
  expect(priced?.ok, JSON.stringify(priced)).toBe(true);

  const { data: stocked } = await director.api.rpc("admin_record_opening_stock", {
    p_product_id: productId,
    p_location_code: "store",
    p_quantity: 500,
    p_note: null,
    p_idempotency_key: randomUUID(),
  });
  expect(stocked?.ok, JSON.stringify(stocked)).toBe(true);

  const { data: customer } = await salesRep.api.rpc("staff_add_customer", {
    p_name: `Integration Customer ${randomUUID().slice(0, 8)}`,
    p_idempotency_key: randomUUID(),
  });
  expect(customer?.ok, JSON.stringify(customer)).toBe(true);
  customerId = (customer.customer as { id: string }).id;

  const { data: cash } = await director.read
    .from("customers")
    .select("id")
    .eq("is_cash_customer", true)
    .single();
  cashCustomerId = cash!.id as string;
});

async function availability(product: string) {
  const { data, error } = await director.read
    .from("product_availability")
    .select("physical_quantity, reserved_quantity, committed_quantity, available_quantity")
    .eq("product_id", product)
    .single();
  expect(error, error?.message).toBeNull();
  return {
    physical: Number(data!.physical_quantity),
    reserved: Number(data!.reserved_quantity),
    available: Number(data!.available_quantity),
  };
}

async function createOrder(fixture: Fixture, customer: string, quantity: number) {
  const { data, error } = await fixture.api.rpc("staff_create_order", {
    p_customer_id: customer,
    p_lines: [{ product_id: productId, quantity }],
    p_idempotency_key: randomUUID(),
  });
  expect(error?.message).toBeUndefined();
  expect(data?.ok, JSON.stringify(data)).toBe(true);
  return (data.order as { id: string; order_no: string }).id;
}

describe("who may create an order", () => {
  it("refuses a Cashier, who settles orders rather than writing them", async () => {
    const { data, error } = await cashier.api.rpc("staff_create_order", {
      p_customer_id: customerId,
      p_lines: [{ product_id: productId, quantity: 1 }],
      p_idempotency_key: randomUUID(),
    });
    expect(data).toBeNull();
    expect(error?.message).toMatch(/may not perform this command/i);
  });

  it("refuses a direct table insert even though the function refused first", async () => {
    const { error } = await cashier.read
      .from("orders")
      .insert({ order_no: "FORGED", customer_id: customerId, is_cash_sale: false });
    expect(error, "a Cashier wrote directly to orders").not.toBeNull();
  });
});

describe("creating an order", () => {
  let orderId: string;

  it("generates a proforma automatically and reserves nothing", async () => {
    const before = await availability(productId);
    orderId = await createOrder(salesRep, customerId, 10);

    const { data: proformas } = await salesRep.read
      .from("proformas")
      .select("version, proforma_no, total_tzs, valid_until")
      .eq("order_id", orderId);

    expect(proformas).toHaveLength(1);
    expect(Number(proformas![0].total_tzs)).toBe(500_000);
    expect(String(proformas![0].proforma_no)).toMatch(/^FV-PRO-\d{8}-\d{4}$/);

    const { data: invoices } = await salesRep.read
      .from("invoices")
      .select("id")
      .eq("order_id", orderId);
    expect(invoices, "a proforma created an invoice").toHaveLength(0);

    const after = await availability(productId);
    expect(after.reserved).toBe(before.reserved);
    expect(after.available).toBe(before.available);
  });

  it("refuses a product no Director has priced", async () => {
    const { data: unpriced } = await director.api.rpc("admin_add_product", {
      p_name: `Unpriced ${randomUUID().slice(0, 8)}`,
      p_specification: null,
      p_unit_code: "piece",
      p_unit_content: null,
      p_idempotency_key: randomUUID(),
    });

    const { data } = await salesRep.api.rpc("staff_create_order", {
      p_customer_id: customerId,
      p_lines: [{ product_id: (unpriced.product as { id: string }).id, quantity: 1 }],
      p_idempotency_key: randomUUID(),
    });

    expect(data?.ok).toBe(false);
    expect(data.reason).toBe("product_has_no_price");
  });

  it("revises the quotation into a new version and supersedes the old", async () => {
    const { data } = await salesRep.api.rpc("staff_revise_proforma", {
      p_order_id: orderId,
      p_lines: [{ product_id: productId, quantity: 20 }],
      p_idempotency_key: randomUUID(),
    });
    expect(data?.ok, JSON.stringify(data)).toBe(true);

    const { data: proformas } = await salesRep.read
      .from("proformas")
      .select("version, total_tzs, superseded_at")
      .eq("order_id", orderId)
      .order("version");

    expect(proformas).toHaveLength(2);
    expect(proformas![0].superseded_at, "version 1 was not superseded").not.toBeNull();
    // The earlier version still says exactly what the customer was first quoted.
    expect(Number(proformas![0].total_tzs)).toBe(500_000);
    expect(Number(proformas![1].total_tzs)).toBe(1_000_000);
  });

  it("confirms into exactly one invoice and one reservation", async () => {
    const before = await availability(productId);

    const { data } = await salesRep.api.rpc("staff_confirm_order", {
      p_order_id: orderId,
      p_idempotency_key: randomUUID(),
    });
    expect(data?.ok, JSON.stringify(data)).toBe(true);
    expect(data.reason).toBe("confirmed");

    const invoice = data.invoice as { invoice_no: string; total_tzs: number };
    expect(invoice.invoice_no).toMatch(/^FV-INV-\d{8}-\d{4}$/);
    expect(Number(invoice.total_tzs)).toBe(1_000_000);

    const after = await availability(productId);
    // Reserved, not moved: the goods are still physically there (AC-34).
    expect(after.physical).toBe(before.physical);
    expect(after.reserved).toBe(before.reserved + 20);
    expect(after.available).toBe(before.available - 20);
  });

  it("cannot produce a second invoice, however the command is called", async () => {
    const { data } = await salesRep.api.rpc("staff_confirm_order", {
      p_order_id: orderId,
      p_idempotency_key: randomUUID(),
    });
    expect(data?.ok).toBe(false);
    expect(data.reason).toBe("order_not_confirmable");

    const { data: invoices } = await salesRep.read
      .from("invoices")
      .select("id")
      .eq("order_id", orderId);
    expect(invoices).toHaveLength(1);
  });

  it("refuses every attempt to amend the invoice from outside", async () => {
    const { data: invoice } = await manager.read
      .from("invoices")
      .select("id")
      .eq("order_id", orderId)
      .single();

    const { error: updateError } = await manager.read
      .from("invoices")
      .update({ total_tzs: 1 })
      .eq("id", invoice!.id);
    expect(updateError, "a Manager rewrote an invoice").not.toBeNull();

    const { error: deleteError } = await manager.read
      .from("invoices")
      .delete()
      .eq("id", invoice!.id);
    expect(deleteError, "a Manager deleted an invoice").not.toBeNull();

    const { error: lineError } = await manager.read
      .from("invoice_lines")
      .update({ quantity: 1 })
      .eq("invoice_id", invoice!.id);
    expect(lineError, "a Manager rewrote an invoice line").not.toBeNull();
  });
});

describe("a burst of identical confirmations", () => {
  it("produces one invoice and one reservation, and replays to everybody else", async () => {
    const orderId = await createOrder(salesRep, customerId, 5);
    const before = await availability(productId);

    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        salesRep.api.rpc("staff_confirm_order", {
          p_order_id: orderId,
          p_idempotency_key: key,
        }),
      ),
    );

    expect(results.every((result) => result.error === null), JSON.stringify(results)).toBe(true);
    const reasons = results.map((result) => String(result.data?.reason));
    expect(reasons.filter((reason) => reason === "confirmed")).toHaveLength(1);
    expect(reasons.filter((reason) => reason === "replayed")).toHaveLength(5);

    const { data: invoices } = await salesRep.read
      .from("invoices")
      .select("id")
      .eq("order_id", orderId);
    expect(invoices, "six taps produced more than one invoice").toHaveLength(1);

    const after = await availability(productId);
    expect(after.reserved, "six taps reserved the stock more than once").toBe(before.reserved + 5);
  });
});

describe("the discount limits of product.md §4", () => {
  it("routes a small discount on a small order to a DIRECTOR, and refuses the Manager", async () => {
    // 5 × 50 000 = 250 000, at or below TZS 1 000 000 — so any discount is a Director's (AC-18).
    const orderId = await createOrder(salesRep, customerId, 5);

    const { data: requested } = await salesRep.api.rpc("staff_request_discount", {
      p_order_id: orderId,
      p_percent: 2,
      p_reason: "regular customer",
      p_idempotency_key: randomUUID(),
    });
    expect(requested?.ok, JSON.stringify(requested)).toBe(true);
    expect(requested.required_role).toBe("director");

    const { data: refused } = await manager.api.rpc("staff_approve_discount", {
      p_order_id: orderId,
      p_idempotency_key: randomUUID(),
    });
    expect(refused?.ok).toBe(false);
    expect(refused.reason).toBe("director_approval_required");

    const { data: approved } = await director.api.rpc("staff_approve_discount", {
      p_order_id: orderId,
      p_idempotency_key: randomUUID(),
    });
    expect(approved?.ok, JSON.stringify(approved)).toBe(true);

    const { data: order } = await salesRep.read
      .from("orders")
      .select("discount_percent")
      .eq("id", orderId)
      .single();
    expect(Number(order!.discount_percent)).toBe(2);
  });

  it("lets a Manager approve up to 5% on an order above TZS 1,000,000", async () => {
    // 30 × 50 000 = 1 500 000, above the threshold, at 5% — inside a Manager's authority (§4).
    const orderId = await createOrder(salesRep, customerId, 30);

    const { data: requested } = await salesRep.api.rpc("staff_request_discount", {
      p_order_id: orderId,
      p_percent: 5,
      p_reason: "bulk order",
      p_idempotency_key: randomUUID(),
    });
    expect(requested.required_role).toBe("manager");

    const { data: approved } = await manager.api.rpc("staff_approve_discount", {
      p_order_id: orderId,
      p_idempotency_key: randomUUID(),
    });
    expect(approved?.ok, JSON.stringify(approved)).toBe(true);

    // Approving re-quotes the customer: a new proforma version, not a silent edit of the one they
    // already hold (§12.1 point 4).
    const { data: proformas } = await salesRep.read
      .from("proformas")
      .select("version, total_tzs")
      .eq("order_id", orderId)
      .order("version", { ascending: false });

    expect(proformas![0].version).toBe(2);
    expect(Number(proformas![0].total_tzs)).toBe(1_425_000);
  });

  it("refuses a Manager above 5% even on a large order", async () => {
    const orderId = await createOrder(salesRep, customerId, 30);

    const { data: requested } = await salesRep.api.rpc("staff_request_discount", {
      p_order_id: orderId,
      p_percent: 6,
      p_reason: "big customer",
      p_idempotency_key: randomUUID(),
    });
    expect(requested.required_role).toBe("director");

    const { data } = await manager.api.rpc("staff_approve_discount", {
      p_order_id: orderId,
      p_idempotency_key: randomUUID(),
    });
    expect(data?.ok).toBe(false);
    expect(data.reason).toBe("director_approval_required");
  });

  it("refuses a Manager the REJECTION of a discount only a Director may approve", async () => {
    // 5 × 50 000 = 250 000, at or below the threshold, so §4 gives the whole decision to a
    // Director. Rejecting is deciding: §4.3 makes a rejection a completed decision that closes the
    // request, so a Manager allowed to refuse it would settle it without a Director ever seeing it.
    const orderId = await createOrder(salesRep, customerId, 5);

    await salesRep.api.rpc("staff_request_discount", {
      p_order_id: orderId,
      p_percent: 3,
      p_reason: "regular customer",
      p_idempotency_key: randomUUID(),
    });

    const { data: refused } = await manager.api.rpc("staff_reject_discount", {
      p_order_id: orderId,
      p_reason: "too generous for this order",
      p_idempotency_key: randomUUID(),
    });
    expect(refused?.ok).toBe(false);
    expect(refused.reason).toBe("director_approval_required");
    // The figures, because "no" on its own leaves the Manager guessing what to do next.
    expect(Number(refused.requested_percent)).toBe(3);
    expect(Number(refused.subtotal_tzs)).toBe(250_000);

    const { data: request } = await salesRep.read
      .from("approval_requests")
      .select("status")
      .eq("entity_id", orderId)
      .single();
    expect(request!.status, "a refused rejection settled the request anyway").toBe("pending");

    // And the Director it was always waiting for can still decide it, either way.
    const { data: rejected } = await director.api.rpc("staff_reject_discount", {
      p_order_id: orderId,
      p_reason: "not this month",
      p_idempotency_key: randomUUID(),
    });
    expect(rejected?.ok, JSON.stringify(rejected)).toBe(true);
  });

  it("judges a rejection on the order total AS IT IS, not on the role written when it was raised", async () => {
    // Raised on an order above the threshold at 5%, so it is a Manager's. The order is then revised
    // DOWN below the threshold, which makes it a Director's — and a stale `required_role` must not
    // be what decides that.
    const orderId = await createOrder(salesRep, customerId, 30);

    const { data: requested } = await salesRep.api.rpc("staff_request_discount", {
      p_order_id: orderId,
      p_percent: 5,
      p_reason: "bulk order",
      p_idempotency_key: randomUUID(),
    });
    expect(requested.required_role).toBe("manager");

    await salesRep.api.rpc("staff_revise_proforma", {
      p_order_id: orderId,
      p_lines: [{ product_id: productId, quantity: 4 }],
      p_idempotency_key: randomUUID(),
    });

    const { data } = await manager.api.rpc("staff_reject_discount", {
      p_order_id: orderId,
      p_reason: "no longer a bulk order",
      p_idempotency_key: randomUUID(),
    });
    expect(data?.ok).toBe(false);
    expect(data.reason).toBe("director_approval_required");
    expect(Number(data.subtotal_tzs)).toBe(200_000);
  });

  it("lets a Manager reject one that is genuinely theirs to decide", async () => {
    const orderId = await createOrder(salesRep, customerId, 30);

    await salesRep.api.rpc("staff_request_discount", {
      p_order_id: orderId,
      p_percent: 4,
      p_reason: "bulk order",
      p_idempotency_key: randomUUID(),
    });

    const { data } = await manager.api.rpc("staff_reject_discount", {
      p_order_id: orderId,
      p_reason: "margin is already thin",
      p_idempotency_key: randomUUID(),
    });
    expect(data?.ok, JSON.stringify(data)).toBe(true);

    const { data: request } = await salesRep.read
      .from("approval_requests")
      .select("status, approved_by")
      .eq("entity_id", orderId)
      .single();
    expect(request!.status).toBe("rejected");
    // §4.3, AC-84: only an approved outcome records an approver.
    expect(request!.approved_by).toBeNull();
  });

  it("shows a SECOND Sales Representative the pending discount, and refuses their confirmation", async () => {
    const orderId = await createOrder(salesRep, customerId, 3);

    await salesRep.api.rpc("staff_request_discount", {
      p_order_id: orderId,
      p_percent: 1,
      p_reason: "goodwill",
      p_idempotency_key: randomUUID(),
    });

    // The screen decides whether to offer Confirm from this read. Before the order-scoped policy,
    // Stage 8A's rule showed a Sales Representative only the requests THEY raised, so a colleague
    // saw no pending discount, was offered an enabled button, and was refused after pressing it.
    const { data: seen, error } = await otherRep.read
      .from("approval_requests")
      .select("id, status, approval_type, entity_type")
      .eq("entity_id", orderId);

    expect(error, error?.message).toBeNull();
    expect(seen, "a colleague cannot see the decision this order is waiting on").toHaveLength(1);
    expect(seen![0].status).toBe("pending");

    // And the database is still the authority, whoever asks.
    const { data: refused } = await otherRep.api.rpc("staff_confirm_order", {
      p_order_id: orderId,
      p_idempotency_key: randomUUID(),
    });
    expect(refused?.ok).toBe(false);
    expect(refused.reason).toBe("discount_pending");
  });

  it("widens nothing else for a Sales Representative", async () => {
    // The policy is scoped by BOTH columns: `sales_rep`, order discounts only. A stock adjustment
    // is an approval record of a different kind on a different entity, and stays invisible.
    const { data: adjustment } = await manager.api.rpc("staff_enter_stock_adjustment", {
      p_product_id: productId,
      p_location_code: "store",
      p_quantity_delta: -1,
      p_reason: "integration scope check",
      p_idempotency_key: randomUUID(),
    });
    expect(adjustment?.ok, JSON.stringify(adjustment)).toBe(true);

    const { data: others } = await otherRep.read
      .from("approval_requests")
      .select("id")
      .neq("approval_type", "discount");
    expect(others, "a Sales Representative reached an approval that is not an order discount")
      .toHaveLength(0);

    // Decision HISTORY is untouched by the widening: it still admits a Cashier, a Manager and a
    // Director alone.
    const { data: decisions } = await otherRep.read.from("approval_decisions").select("id");
    expect(decisions, "a Sales Representative reached approval decision history").toHaveLength(0);
  });

  it("refuses confirmation while a discount is undecided", async () => {
    const orderId = await createOrder(salesRep, customerId, 3);

    await salesRep.api.rpc("staff_request_discount", {
      p_order_id: orderId,
      p_percent: 1,
      p_reason: "goodwill",
      p_idempotency_key: randomUUID(),
    });

    const { data } = await salesRep.api.rpc("staff_confirm_order", {
      p_order_id: orderId,
      p_idempotency_key: randomUUID(),
    });
    expect(data?.ok).toBe(false);
    expect(data.reason).toBe("discount_pending");
  });
});

describe("the Cash Customer path (product.md §12.4)", () => {
  it("creates no invoice, no balance and no reservation at confirmation", async () => {
    const before = await availability(productId);
    const orderId = await createOrder(salesRep, cashCustomerId, 4);

    const { data } = await salesRep.api.rpc("staff_confirm_order", {
      p_order_id: orderId,
      p_idempotency_key: randomUUID(),
    });

    expect(data?.ok, JSON.stringify(data)).toBe(true);
    expect(data.reason).toBe("confirmed_cash_sale");
    expect(data.invoice, "a walk-in confirmation produced an invoice").toBeNull();

    const { data: invoices } = await salesRep.read
      .from("invoices")
      .select("id")
      .eq("order_id", orderId);
    expect(invoices).toHaveLength(0);

    const { data: allocations } = await salesRep.read
      .from("stock_allocations")
      .select("id")
      .eq("order_id", orderId);
    expect(allocations, "a walk-in confirmation reserved stock").toHaveLength(0);

    // AC-87: availability is not reduced by one.
    const after = await availability(productId);
    expect(after.available).toBe(before.available);
  });
});

describe("cancelling", () => {
  it("withdraws a quotation nobody confirmed, leaving no invoice behind", async () => {
    const before = await availability(productId);
    const orderId = await createOrder(salesRep, customerId, 5);

    const { data } = await salesRep.api.rpc("staff_cancel_order", {
      p_order_id: orderId,
      p_reason: "quoted the wrong site",
      p_idempotency_key: randomUUID(),
    });
    expect(data?.ok, JSON.stringify(data)).toBe(true);
    expect(data?.reason).toBe("cancelled");

    const { data: order } = await salesRep.read
      .from("orders")
      .select("status, cancel_reason")
      .eq("id", orderId)
      .single();
    expect(order!.status).toBe("cancelled");
    expect(String(order!.cancel_reason)).toContain("wrong site");

    // A quotation is not a bill (§12.1 point 3), so there is nothing to keep and nothing to
    // release: no invoice was ever created and availability never moved.
    const { data: invoices } = await salesRep.read
      .from("invoices")
      .select("id")
      .eq("order_id", orderId);
    expect(invoices, "a quotation created an invoice").toHaveLength(0);

    const after = await availability(productId);
    expect(after.available).toBe(before.available);
    expect(after.physical).toBe(before.physical);
  });

  it("withdraws a pending discount AS A DECISION, with an actor and a reason and no approver", async () => {
    const orderId = await createOrder(salesRep, customerId, 6);

    await salesRep.api.rpc("staff_request_discount", {
      p_order_id: orderId,
      p_percent: 2,
      p_reason: "they came to the yard",
      p_idempotency_key: randomUUID(),
    });

    const { data: cancelled } = await salesRep.api.rpc("staff_cancel_order", {
      p_order_id: orderId,
      p_reason: "quoted the wrong site",
      p_idempotency_key: randomUUID(),
    });
    expect(cancelled?.ok, JSON.stringify(cancelled)).toBe(true);

    const { data: request } = await salesRep.read
      .from("approval_requests")
      .select("id, status, approved_by, approved_role, approved_at")
      .eq("entity_id", orderId)
      .single();

    expect(request!.status).toBe("cancelled");
    // §4.3, AC-84: a cancellation is a completed decision and NOT an approval.
    expect(request!.approved_by).toBeNull();
    expect(request!.approved_role).toBeNull();
    expect(request!.approved_at).toBeNull();

    // The projection moving is not the record. §4.3 requires the decision itself, in append-only
    // history, with who decided it, from which role, when, why, and what the outcome was.
    //
    // Read as a Director: `approval_decisions` admits a Cashier, a Manager and a Director, and a
    // Sales Representative reads the REQUEST they raised but not the decision history around it.
    const { data: decisions } = await director.read
      .from("approval_decisions")
      .select("outcome, decided_by, decided_role, note, decided_at")
      .eq("request_id", request!.id);

    expect(decisions, "the withdrawal wrote no decision at all").toHaveLength(1);
    expect(decisions![0].outcome).toBe("cancelled");
    expect(decisions![0].decided_by).toBe(salesRep.userId);
    expect(decisions![0].decided_role).toBe("sales_rep");
    expect(String(decisions![0].note)).toContain("wrong site");
    expect(decisions![0].decided_at).not.toBeNull();
  });

  it("records the status the order was ACTUALLY in, not one the command assumed", async () => {
    const quotation = await createOrder(salesRep, customerId, 2);
    await salesRep.api.rpc("staff_cancel_order", {
      p_order_id: quotation,
      p_reason: "customer changed their mind",
      p_idempotency_key: randomUUID(),
    });

    const confirmed = await createOrder(salesRep, customerId, 2);
    await salesRep.api.rpc("staff_confirm_order", {
      p_order_id: confirmed,
      p_idempotency_key: randomUUID(),
    });
    await salesRep.api.rpc("staff_cancel_order", {
      p_order_id: confirmed,
      p_reason: "customer changed their mind",
      p_idempotency_key: randomUUID(),
    });

    const { data: events } = await director.read
      .from("audit_events")
      .select("entity_id, before_state")
      .eq("action", "order_cancelled")
      .in("entity_id", [quotation, confirmed]);

    const byOrder = new Map(
      (events ?? []).map((row) => [
        row.entity_id as string,
        (row.before_state as { status?: string } | null)?.status,
      ]),
    );

    // It used to say 'confirmed' for both, which was a statement about the business that was
    // simply untrue for every quotation ever cancelled.
    expect(byOrder.get(quotation)).toBe("proforma");
    expect(byOrder.get(confirmed)).toBe("confirmed");
  });

  it("refuses a reason too short to mean anything", async () => {
    const orderId = await createOrder(salesRep, customerId, 1);

    const { data } = await salesRep.api.rpc("staff_cancel_order", {
      p_order_id: orderId,
      p_reason: "x",
      p_idempotency_key: randomUUID(),
    });
    expect(data?.ok).toBe(false);
    expect(data?.reason).toBe("reason_required");

    const { data: order } = await salesRep.read
      .from("orders")
      .select("status")
      .eq("id", orderId)
      .single();
    expect(order!.status, "a refused cancellation still cancelled the order").toBe("proforma");
  });

  it("releases the claim and keeps the invoice number", async () => {
    const orderId = await createOrder(salesRep, customerId, 7);
    await salesRep.api.rpc("staff_confirm_order", {
      p_order_id: orderId,
      p_idempotency_key: randomUUID(),
    });

    const reserved = await availability(productId);

    const { data } = await salesRep.api.rpc("staff_cancel_order", {
      p_order_id: orderId,
      p_reason: "customer changed their mind",
      p_idempotency_key: randomUUID(),
    });
    expect(data?.ok, JSON.stringify(data)).toBe(true);

    const after = await availability(productId);
    expect(after.available).toBe(reserved.available + 7);

    const { data: invoice } = await salesRep.read
      .from("invoices")
      .select("invoice_no, cancelled_at, cancel_reason")
      .eq("order_id", orderId)
      .single();

    // AC-11: it keeps its number and its history.
    expect(String(invoice!.invoice_no)).toMatch(/^FV-INV-/);
    expect(invoice!.cancelled_at).not.toBeNull();
    expect(String(invoice!.cancel_reason)).toContain("changed their mind");
  });
});

describe("who wrote this order", () => {
  const CREATOR = "Test sales_rep";

  it("names the creator to every live role that may read the order", async () => {
    const orderId = await createOrder(salesRep, customerId, 2);

    // A Cashier settles orders and a second Sales Representative may confirm this one (§12.6), so
    // both may read it — and both used to get "Created by  (Sales Representative)", because the
    // creator's `profiles` row is not theirs to read and the embedded join came back null.
    for (const [who, fixture] of [
      ["the second Sales Representative", otherRep],
      ["a Cashier", cashier],
      ["a Manager", manager],
      ["a Director", director],
    ] as const) {
      const { data, error } = await fixture.api.rpc("staff_order_creator_name", {
        p_order_id: orderId,
      });
      expect(error?.message, `${who} could not read the creator name`).toBeUndefined();
      expect(data, `${who} saw a blank creator`).toBe(CREATOR);
    }

    // And it is genuinely the OTHER person's name, not the reader's own row leaking through.
    expect(otherRep.userId).not.toBe(salesRep.userId);
  });

  it("gives them the name and nothing else about the person", async () => {
    for (const [who, fixture] of [
      ["the second Sales Representative", otherRep],
      ["a Cashier", cashier],
    ] as const) {
      // The profile itself stays closed. `profiles` holds the phone number an account signs in
      // with, the first-login gate and the active flag, and none of that is theirs.
      const { data: profiles } = await fixture.read
        .from("profiles")
        .select("id, full_name, phone_e164, is_active, must_change_password")
        .eq("id", salesRep.userId);
      expect(profiles, `${who} read the creator's profile row`).toHaveLength(0);

      // Nor the role assignment.
      const { data: roles } = await fixture.read
        .from("user_roles")
        .select("user_id, role")
        .eq("user_id", salesRep.userId);
      expect(roles, `${who} read the creator's role assignment`).toHaveLength(0);

      // Nor anybody else's row: their OWN profile is the only one they see, which is exactly what
      // Stage 8A's rule says and exactly what this change did not touch.
      const { data: everyone } = await fixture.read.from("profiles").select("id");
      expect(everyone?.map((row) => row.id)).toEqual([fixture.userId]);
    }
  });

  it("tells a Manager and a Director nothing they did not already have", async () => {
    // Their `profiles` access is unchanged: the whole table, as Stage 8A wrote it.
    for (const fixture of [manager, director]) {
      const { data } = await fixture.read.from("profiles").select("id, phone_e164");
      expect((data ?? []).length).toBeGreaterThan(1);
      expect(data!.every((row) => typeof row.phone_e164 === "string")).toBe(true);
    }
  });

  it("is unreachable with the SECRET key", async () => {
    const response = await fetch(
      `${process.env.SUPABASE_URL ?? "http://127.0.0.1:54321"}/rest/v1/rpc/staff_order_creator_name`,
      {
        method: "POST",
        headers: {
          apikey: SECRET_KEY,
          Authorization: `Bearer ${SECRET_KEY}`,
          "Content-Type": "application/json",
          "Content-Profile": "api",
          "Accept-Profile": "api",
        },
        body: JSON.stringify({ p_order_id: customerId }),
      },
    );
    // `staff_` means `authenticated` and nobody else: the prefix rule at the end of
    // 20260822000700 grants execute to that role alone, so the secret key is refused on privilege
    // before the function body — and before `private.authorize` would have refused it anyway.
    expect(response.status).toBe(403);
  });
});

describe("the sales tables, from outside the database", () => {
  it("is unreachable with the SECRET key on every table this stage added", async () => {
    for (const table of [
      "customers",
      "orders",
      "order_lines",
      "proformas",
      "proforma_lines",
      "invoices",
      "invoice_lines",
      "stock_allocations",
      "document_sequences",
    ]) {
      const response = await fetch(
        `${process.env.SUPABASE_URL ?? "http://127.0.0.1:54321"}/rest/v1/${table}?select=*`,
        { headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` } },
      );
      expect(response.status, `the secret key read ${table}`).toBe(403);
    }
  });

  it("hides the invoice-number counter from every signed-in user", async () => {
    // A client that could read it could predict the next invoice number; one that could write it
    // could hand two invoices the same one.
    const { data, error } = await manager.read.from("document_sequences").select("*");
    expect(error !== null || (data ?? []).length === 0).toBe(true);
  });

  it("resolves every embed the sales module asks PostgREST for", async () => {
    const orders = await salesRep.read.from("orders").select(`
      id, order_no, status, is_cash_sale, created_at,
      customers!inner(name)
    `);
    expect(orders.error, orders.error?.message).toBeNull();

    const detail = await salesRep.read.from("orders").select(`
      id, order_no, customer_id, status, is_cash_sale, discount_percent, discount_reason,
      created_role, created_at, cancel_reason,
      customers!inner(name),
      profiles!orders_created_by_fkey(full_name)
    `);
    expect(detail.error, detail.error?.message).toBeNull();

    const discounts = await salesRep.read
      .from("approval_requests")
      .select(`
        id, requested_percent, required_role, status, request_seq,
        requester:profiles!approval_requests_requested_by_fkey(full_name),
        approver:profiles!approval_requests_approved_by_fkey(full_name)
      `)
      .eq("entity_type", "order");
    expect(discounts.error, discounts.error?.message).toBeNull();
  });
});
