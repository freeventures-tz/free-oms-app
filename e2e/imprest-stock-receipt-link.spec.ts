import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";

import { expectLandsOn, fixtures, signIn } from "./fixtures";

/**
 * A supplier delivery paid from imprest, through the screens (issue #73), on every device tier.
 *
 * The rules are proved in pgTAP and over real HTTP in the integration suite. This spec proves the
 * Cashier who paid for a delivery marks it Paid from imprest on the receiving form and picks the
 * payment, typing nothing about it; that the receipt then names its payment and links to it, and the
 * payment lists the delivery; that no imprest figure moves, and stock rises only when the Manager
 * approves; that a Director reads both sides and is offered no control; that a Sales Representative
 * is not offered Paid from imprest; and that a failed read is said so.
 *
 * Every figure is read as a change, because the three tiers run one after another on one database.
 */

type Who = "director" | "manager" | "cashier" | "salesRep";
type Row = { id: string; version: number; disbursement_no?: string };

const SUFFIX = Math.random().toString(36).slice(2, 8).toUpperCase();
const sessions = new Map<Who, { client: SupabaseClient; userId: string }>();
const URL_ = () => process.env.NEXT_PUBLIC_SUPABASE_URL!;
const KEY_ = () => process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

async function sessionFor(who: Who) {
  const cached = sessions.get(who);
  if (cached) return cached;
  const account = fixtures()[who];
  const response = await fetch(`${URL_()}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: KEY_(), "Content-Type": "application/json" },
    body: JSON.stringify({ email: derivedAuthIdentifier(account.phone), password: account.password }),
  });
  const body = await response.json();
  if (response.status !== 200) throw new Error(`${who} could not sign in: ${JSON.stringify(body)}`);
  const client = createClient(URL_(), KEY_(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${body.access_token}` } },
  });
  const session = { client, userId: String(body.user.id) };
  sessions.set(who, session);
  return session;
}

async function command(who: Who, fn: string, args: Record<string, unknown>) {
  const api = (await sessionFor(who)).client.schema("api");
  const { data, error } = await api.rpc(fn, { ...args, p_idempotency_key: randomUUID() });
  if (error || !data.ok) throw new Error(`${fn}: ${error?.message ?? data.reason}`);
  return data as {
    reason: string;
    funding?: Row & { handover_id: string };
    disbursement?: Row;
    supplier?: { id: string };
    product?: { id: string };
    receipt?: { id: string };
  };
}

type Position = { set_aside_tzs: number; free_to_approve_tzs: number; awaiting_verification_tzs: number; posted_balance_tzs: number };
async function position(): Promise<Position> {
  const { data, error } = await (await sessionFor("manager")).client.schema("api").rpc("staff_imprest_spending_position");
  if (error) throw new Error(`position: ${error.message}`);
  return (data as Position[])[0];
}

async function stockOf(productId: string): Promise<number> {
  const { data, error } = await (await sessionFor("manager")).client
    .from("current_stock")
    .select("quantity")
    .eq("product_id", productId)
    .eq("location_code", "store")
    .eq("stock_state", "available");
  if (error) throw new Error(`stock: ${error.message}`);
  return (data ?? []).reduce((sum, row) => sum + Number(row.quantity), 0);
}

async function ensureFree(amount: number) {
  const free = (await position())?.free_to_approve_tzs ?? 0;
  if (free >= amount) return;
  const top = amount - free;
  const requested = await command("manager", "staff_request_imprest_funding", {
    p_amount_tzs: top,
    p_reason: `Delivery float ${SUFFIX}`,
  });
  const approved = await command("director", "admin_decide_imprest_funding", {
    p_funding_id: requested.funding!.id,
    p_expected_version: requested.funding!.version,
    p_approve: true,
    p_amount_tzs: top,
    p_reason: null,
  });
  const provided = await command("director", "admin_record_imprest_provided", {
    p_funding_id: approved.funding!.id,
    p_expected_version: approved.funding!.version,
    p_amount_tzs: top,
  });
  await command("manager", "staff_confirm_imprest_received", {
    p_funding_id: provided.funding!.id,
    p_expected_version: provided.funding!.version,
    p_handover_id: provided.funding!.handover_id,
  });
}

/** The Cashier's payment for a delivery: proposed, approved and handed out to the supplier. */
async function paidOut(recipient: string, amount = 25000): Promise<Row & { disbursement_no: string }> {
  const proposed = await command("cashier", "staff_propose_imprest_disbursement", {
    p_amount_tzs: amount,
    p_category: "materials_and_supplies",
    p_purpose: `Sand for the yard ${SUFFIX}`,
  });
  const approved = await command("manager", "staff_decide_imprest_disbursement", {
    p_id: proposed.disbursement!.id,
    p_expected_version: 1,
    p_approve: true,
    p_reason: null,
  });
  const out = await command("cashier", "staff_hand_out_imprest_disbursement", {
    p_id: approved.disbursement!.id,
    p_expected_version: approved.disbursement!.version,
    p_recipient: recipient,
  });
  const { data } = await (await sessionFor("manager")).client
    .from("imprest_disbursements")
    .select("disbursement_no")
    .eq("id", out.disbursement!.id)
    .single();
  return { ...out.disbursement!, disbursement_no: String(data!.disbursement_no) };
}

let supplier: { id: string; name: string };
let product: { id: string; name: string };

async function catalogue() {
  if (supplier && product) return;
  const supplierName = `Simba Sand ${SUFFIX}`;
  const productName = `River sand ${SUFFIX}`;
  const s = await command("director", "admin_add_supplier", { p_name: supplierName });
  const p = await command("director", "admin_add_product", {
    p_name: productName,
    p_specification: null,
    p_unit_code: "piece",
    p_unit_content: null,
  });
  supplier = { id: s.supplier!.id, name: supplierName };
  product = { id: p.product!.id, name: productName };
}

const LANDING: Record<Who, string> = {
  director: "/dashboard",
  manager: "/dashboard",
  cashier: "/payments",
  salesRep: "/orders",
};

async function as(page: Page, who: Who) {
  await page.context().clearCookies();
  const account = fixtures()[who];
  await signIn(page, account.phone, account.password);
  await expectLandsOn(page, LANDING[who]);
}

/** Fills the receiving form down to, but not including, Paid from imprest. */
async function fillDelivery(page: Page, noteRef: string, quantity = 30) {
  await page.getByRole("button", { name: "Record a delivery" }).click();
  await page.getByLabel("Supplier", { exact: true }).selectOption(supplier.id);
  await page.getByLabel("Delivery note number").fill(noteRef);
  await page.getByLabel("Product", { exact: true }).selectOption(product.id);
  await page.getByLabel(/^Expected/).fill(String(quantity));
  await page.getByLabel("Received", { exact: true }).fill(String(quantity));
}

function receiptCard(page: Page, noteRef: string) {
  return page.getByRole("article", { name: `${supplier.name} ${noteRef}` });
}

/** SQL as the local stack's superuser. Never pointed at a hosted database. */
function superSql(sql: string) {
  const url =
    process.env.SUPABASE_SUPERUSER_DB_URL ?? "postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres";
  if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("superSql runs against the local stack only");
  try {
    execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], { stdio: "pipe" });
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
    execFileSync(
      "docker",
      [
        "exec", "-i", "-e", "PGPASSWORD=postgres", process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_free-oms-app",
        "psql", "-h", "127.0.0.1", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-c", sql,
      ],
      { stdio: "pipe" },
    );
  }
}

test.describe("a delivery paid from imprest", () => {
  test.beforeEach(async () => {
    await catalogue();
    await ensureFree(60000);
  });

  test("the Cashier marks it paid from their payment, and both records point at each other", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const payment = await paidOut(`Simba Yard ${testInfo.project.name}`);
    const noteRef = `DN-${SUFFIX}-${testInfo.project.name.slice(0, 3).toUpperCase()}`;
    const figures = await position();
    const stock = await stockOf(product.id);

    await as(page, "cashier");
    await page.goto("/inventory/receiving");
    await fillDelivery(page, noteRef);

    // Marked, but nothing picked: the form asks before anything is sent.
    await page.getByRole("checkbox", { name: "Paid from imprest" }).check();
    await page.getByRole("button", { name: "Save delivery" }).click();
    await expect(page.getByText("Choose the payment that paid for this delivery.")).toBeVisible();

    // The payment is picked by its number, payee, category and approved amount; nothing is typed.
    const picker = page.getByLabel("Which payment paid for it");
    await expect(picker.locator("option", { hasText: payment.disbursement_no })).toHaveText(
      `${payment.disbursement_no} · Simba Yard ${testInfo.project.name} · Materials and supplies · TZS 25,000`,
    );
    await picker.selectOption(payment.id);
    await page.getByRole("button", { name: "Save delivery" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Delivery recorded." })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Paid from imprest" })).not.toBeChecked();

    // Nothing moved: no imprest figure and no stock.
    expect(await position()).toEqual(figures);
    expect(await stockOf(product.id)).toBe(stock);

    // The receipt names its payment and links to it; the payment lists the delivery, waiting.
    const card = receiptCard(page, noteRef);
    await expect(card).toContainText(`Paid from imprest: ${payment.disbursement_no}`);
    await expect(card).toContainText(`Simba Yard ${testInfo.project.name} · Materials and supplies · TZS 25,000`);
    await card.getByRole("link", { name: payment.disbursement_no }).click();
    await expect(page).toHaveURL(new RegExp(`/imprest/disbursements/${payment.id}$`));
    const list = page.getByTestId("disbursement-stock-receipts");
    await expect(list).toContainText("Deliveries paid from this payment");
    await expect(list).toContainText(`${supplier.name} · ${noteRef}`);
    await expect(list).toContainText("Entered by E2E Cashier (Cashier)");
    await expect(list).toContainText("Waiting for approval");

    // Only the Manager's approval raises stock, by what was accepted.
    await as(page, "manager");
    await page.goto("/inventory/receiving");
    const pending = receiptCard(page, noteRef);
    await expect(pending).toContainText(`Paid from imprest: ${payment.disbursement_no}`);
    await pending.getByRole("button", { name: "Approve delivery" }).click();
    await expect.poll(() => stockOf(product.id)).toBe(stock + 30);
    await page.reload();
    const decided = receiptCard(page, noteRef);
    await expect(decided.locator("[data-outcome=approved]")).toBeVisible();
    await expect(decided).toContainText(`Paid from imprest: ${payment.disbursement_no}`);
    expect(await position()).toEqual(figures);
    await page.goto(`/imprest/disbursements/${payment.id}`);
    await expect(page.getByTestId("disbursement-stock-receipts")).toContainText("Approved");
  });

  test("a Director reads both sides and is offered no control; a Sales Representative is not offered Paid from imprest", async ({ page }, testInfo) => {
    const payment = await paidOut(`Director view ${testInfo.project.name}`);
    const noteRef = `DN-${SUFFIX}-D${testInfo.project.name.slice(0, 2).toUpperCase()}`;
    const { data: entered, error } = await (await sessionFor("manager")).client.schema("api").rpc("staff_enter_stock_receipt", {
      p_supplier_id: supplier.id,
      p_location_code: "store",
      p_delivery_date: new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Dar_es_Salaam" }),
      p_delivery_note_ref: noteRef,
      p_lines: [{ product_id: product.id, expected_quantity: 5, received_quantity: 5 }],
      p_disbursement_id: payment.id,
      p_idempotency_key: randomUUID(),
    });
    expect(error, JSON.stringify(entered)).toBeNull();

    await as(page, "director");
    await page.goto("/inventory/receiving");
    await expect(page.getByRole("button", { name: "Record a delivery" })).toHaveCount(0);
    const card = receiptCard(page, noteRef);
    await expect(card).toContainText(`Paid from imprest: ${payment.disbursement_no}`);
    await expect(card.getByRole("button")).toHaveCount(0);
    await card.getByRole("link", { name: payment.disbursement_no }).click();
    const list = page.getByTestId("disbursement-stock-receipts");
    await expect(list).toContainText(`${supplier.name} · ${noteRef}`);
    await expect(list).toContainText("Entered by E2E Manager (Manager)");
    await expect(list.getByRole("button")).toHaveCount(0);

    await as(page, "salesRep");
    await page.goto("/inventory/receiving");
    await page.getByRole("button", { name: "Record a delivery" }).click();
    await expect(page.getByLabel("Delivery note number")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Paid from imprest" })).toHaveCount(0);
  });

  test("a failed read is a page failure, never a delivery with nothing to pick or a payment that paid for nothing", async ({ page }) => {
    const payment = await paidOut("Failed read");
    await as(page, "manager");
    // One Playwright worker runs the whole suite, so these grants are taken away from nobody else.
    try {
      superSql("revoke execute on function api.staff_imprest_receipt_payment_options() from authenticated;");
      await page.goto("/inventory/receiving");
      await expect(page.getByText(/this page could not be loaded/i)).toBeVisible();
      await expect(page.getByRole("button", { name: "Record a delivery" })).toHaveCount(0);
    } finally {
      superSql("grant execute on function api.staff_imprest_receipt_payment_options() to authenticated;");
    }
    try {
      superSql("revoke execute on function api.staff_imprest_disbursement_stock_receipts(uuid) from authenticated;");
      await page.goto(`/imprest/disbursements/${payment.id}`);
      await expect(page.getByText(/this page could not be loaded/i)).toBeVisible();
      await expect(page.getByTestId("disbursement-stock-receipts")).toHaveCount(0);
    } finally {
      superSql("grant execute on function api.staff_imprest_disbursement_stock_receipts(uuid) to authenticated;");
    }
    await page.goto(`/imprest/disbursements/${payment.id}`);
    await expect(page.getByTestId("disbursement-stock-receipts")).toContainText(
      "No stock receipt is marked as paid from this payment.",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Mobile benchmark, opt-in, the method of the retirement and reversal benchmarks:
//
//     FV_BENCHMARK=1 npx playwright test --project=mobile e2e/imprest-stock-receipt-link.spec.ts -g benchmark
//
// The command is Save delivery with Paid from imprest picked; the read is tapping the receipt's
// payment and waiting for the payment's page to list the delivery. A real touch starts the clock
// inside the page. Acknowledgement is the first animation frame after the page shows it is working
// (the button's `aria-busy`, or the route's loading region); completion is the server's answer on
// screen (the success status, or the payment's list of deliveries).
// ---------------------------------------------------------------------------------------------

const BENCHMARK = process.env.FV_BENCHMARK === "1";
const SAMPLES = 20;
const PROFILES = [
  { name: "Slow 4G", down: (1.6 * 1024 * 1024) / 8, up: (750 * 1024) / 8, latency: 562.5, cpu: 4 },
  { name: "Fast 4G", down: (9 * 1024 * 1024) / 8, up: (1.5 * 1024 * 1024) / 8, latency: 85, cpu: 4 },
] as const;
type Profile = (typeof PROFILES)[number];

function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
  return { n: sorted.length, p50: Math.round(rank(0.5)), p95: Math.round(rank(0.95)), worst: Math.round(sorted.at(-1)!) };
}

/**
 * One touch on `target`, timed: `busy` is a selector that appears when the page acknowledges it,
 * and `done` a selector, holding `doneText` when given, that appears when the server has answered.
 */
async function measureTap(
  page: Page,
  profile: Profile,
  target: Locator,
  busy: string,
  done: string,
  doneText = "",
) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    downloadThroughput: profile.down,
    uploadThroughput: profile.up,
    latency: profile.latency,
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
  try {
    await target.evaluate(
      (el, [busySelector, doneSelector, text]) => {
        const w = window as unknown as { __fv: { t0?: number; ack?: number; done?: number } };
        w.__fv = {};
        el.addEventListener("pointerdown", () => (w.__fv.t0 = performance.now()), { once: true });
        // "self": the touched control reports `aria-busy`, watched on the control alone, the method
        // of the retirement and reversal benchmarks. Otherwise a selector anywhere on the page.
        const self = busySelector === "self";
        const ack = new MutationObserver(() => {
          const busy = self ? el.getAttribute("aria-busy") === "true" : document.querySelector(busySelector);
          if (w.__fv.t0 !== undefined && busy) {
            requestAnimationFrame(() => (w.__fv.ack = performance.now() - w.__fv.t0!));
            ack.disconnect();
          }
        });
        if (self) ack.observe(el, { attributes: true });
        else ack.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        const finished = new MutationObserver(() => {
          const found = [...document.querySelectorAll(doneSelector)].some((node) =>
            (node.textContent ?? "").includes(text),
          );
          if (w.__fv.t0 !== undefined && found) {
            w.__fv.done = performance.now() - w.__fv.t0;
            finished.disconnect();
          }
        });
        finished.observe(document.body, { subtree: true, childList: true, characterData: true });
      },
      [busy, done, doneText] as const,
    );
    await target.tap();
    await expect(page.locator(done).filter({ hasText: doneText }).first()).toBeVisible({ timeout: 30_000 });
    const sample = await page.evaluate(() => (window as unknown as { __fv: { ack?: number; done?: number } }).__fv);
    return { ack: sample.ack ?? Number.POSITIVE_INFINITY, done: sample.done ?? Number.POSITIVE_INFINITY };
  } finally {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.detach();
  }
}

/** Every row is printed first and judged afterwards, so one row over its target never hides the rest. */
const verdicts: { label: string; value: number; limit: number }[] = [];

function report(label: string, ack: number[], done: number[]) {
  const a = summary(ack);
  const d = summary(done);
  console.log(`${label} ack  n=${a.n} p50=${a.p50}ms p95=${a.p95}ms worst=${a.worst}ms`);
  console.log(`${label} done n=${d.n} p50=${d.p50}ms p95=${d.p95}ms worst=${d.worst}ms`);
  verdicts.push({ label: `${label} acknowledgement`, value: a.worst, limit: 100 });
  verdicts.push({ label: `${label} completion p95`, value: d.p95, limit: 2500 });
}

function judge() {
  for (const verdict of verdicts.splice(0)) {
    expect.soft(verdict.value, verdict.label).toBeLessThanOrEqual(verdict.limit);
  }
}

(BENCHMARK ? test.describe : test.describe.skip)("delivery paid from imprest mobile benchmark", () => {
  test.setTimeout(60 * 60_000);

  test("Save a delivery paid from imprest, and open its payment: acknowledgement and completion over 4G", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the mobile profile only");
    await catalogue();
    await ensureFree(SAMPLES * PROFILES.length * 1000 + 1000);
    const payment = await paidOut("Benchmark sands", SAMPLES * PROFILES.length * 1000);
    await as(page, "cashier");

    for (const profile of PROFILES) {
      const saveAck: number[] = [];
      const saveDone: number[] = [];
      const readAck: number[] = [];
      const readDone: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const noteRef = `BM-${SUFFIX}-${profile.name.slice(0, 1)}${i}`;
        await page.goto("/inventory/receiving");
        await fillDelivery(page, noteRef, 1);
        await page.getByRole("checkbox", { name: "Paid from imprest" }).check();
        await page.getByLabel("Which payment paid for it").selectOption(payment.id);
        const save = await measureTap(
          page,
          profile,
          page.locator("#submitReceipt"),
          "self",
          "[role=status]",
          "Delivery recorded.",
        );
        saveAck.push(save.ack);
        saveDone.push(save.done);

        await expect(receiptCard(page, noteRef)).toBeVisible();
        const read = await measureTap(
          page,
          profile,
          receiptCard(page, noteRef).locator("[data-testid^=paid-from-] a"),
          "[data-pending-link], [role=status][aria-busy=true], [data-testid=disbursement-stock-receipts]",
          "[data-testid=disbursement-stock-receipts]",
          noteRef,
        );
        readAck.push(read.ack);
        readDone.push(read.done);
      }
      report(`${profile.name} save a delivery paid from imprest`, saveAck, saveDone);
      report(`${profile.name} open its payment`, readAck, readDone);
    }
    judge();
  });
});
