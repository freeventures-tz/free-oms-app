import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";
import { businessDate } from "@/lib/time/business-date";
import { generateReportFor, resetScheduledReportDay } from "@/tests/support/scheduled-report";

import { expectLandsOn, fixtures, signIn } from "./fixtures";

/**
 * The daily report's imprest section, read on every device tier (issue #82).
 *
 * The rules are proved in pgTAP and over real HTTP in the integration suite. This spec proves what a
 * Director and the Manager actually see: a day with a verified expense that was reversed and posted
 * again, a payment still out, and a count the Manager confirmed short. The report states the
 * expenses, the posted balance, expected cash and the count's real outcome, the same figures the
 * imprest screen shows, and never the old "not in the system yet" sentence.
 *
 * The scheduler only ever reports yesterday, so today's report is written by the generator's own
 * attempt from the operator's prompt (`generateReportFor`) and cleared again afterwards. Each tier
 * starts on a fund of its own, opened below the triggers as the local stack's superuser, and leaves
 * a plain fund behind for the specs after it, as `imprest-retirement.spec.ts` does.
 */

type Who = "director" | "manager" | "cashier";
type Row = { id: string; version: number };

const SUFFIX = Math.random().toString(36).slice(2, 8).toUpperCase();
const sessions = new Map<Who, { client: SupabaseClient; userId: string }>();
const URL_ = () => process.env.NEXT_PUBLIC_SUPABASE_URL!;
const KEY_ = () => process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const tzs = (value: number) => `TZS ${new Intl.NumberFormat("en-GB").format(value)}`;

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
    count?: Row;
    reversal?: Row;
  };
}

/** SQL as the local stack's superuser, which may suspend triggers. Never pointed at a hosted database. */
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

/**
 * Closes whatever fund is active and opens an empty one, below the triggers.
 *
 * A report reads the fund whose business days include its date, and a fund retired TODAY by a real
 * approval (as `imprest-retirement.spec.ts` leaves several) still owns today: its closing count is
 * today's. Those retirements are moved to yesterday here, so today belongs to this spec's fund alone.
 */
async function freshFund(): Promise<void> {
  const manager = await sessionFor("manager");
  superSql(`
    set session_replication_role = replica;
    update public.imprest_retirements set business_date = business_date - 1
     where status = 'approved' and business_date >= private.imprest_business_date();
    update public.imprest_funds set retired_at = retired_at - interval '1 day'
     where private.imprest_business_date_of(retired_at) >= private.imprest_business_date();
    update public.imprest_funds set is_active = false, retired_at = now() - interval '1 day' where is_active;
    -- The day's funding and expense lines read every fund, so what earlier tests did today moves
    -- to yesterday with the funds that did it.
    update public.imprest_postings set posted_at = posted_at - interval '1 day'
     where private.imprest_business_date_of(posted_at) >= private.imprest_business_date();
    update public.imprest_fundings set requested_at = requested_at - interval '1 day'
     where private.imprest_business_date_of(requested_at) >= private.imprest_business_date();
    update public.imprest_fundings set received_at = received_at - interval '1 day'
     where private.imprest_business_date_of(received_at) >= private.imprest_business_date();
    insert into public.imprest_funds (opened_by) values ('${manager.userId}');
  `);
}

async function postFunding(amount: number) {
  const requested = await command("manager", "staff_request_imprest_funding", {
    p_amount_tzs: amount,
    p_reason: `Report float ${SUFFIX}`,
  });
  const approved = await command("director", "admin_decide_imprest_funding", {
    p_funding_id: requested.funding!.id,
    p_expected_version: requested.funding!.version,
    p_approve: true,
    p_amount_tzs: amount,
    p_reason: null,
  });
  const provided = await command("director", "admin_record_imprest_provided", {
    p_funding_id: approved.funding!.id,
    p_expected_version: approved.funding!.version,
    p_amount_tzs: amount,
  });
  await command("manager", "staff_confirm_imprest_received", {
    p_funding_id: provided.funding!.id,
    p_expected_version: provided.funding!.version,
    p_handover_id: provided.funding!.handover_id,
  });
}

async function handedOut(amount: number, purpose: string): Promise<Row> {
  const proposed = await command("cashier", "staff_propose_imprest_disbursement", {
    p_amount_tzs: amount,
    p_category: "transport_and_delivery",
    p_purpose: purpose,
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
    p_recipient: "Juma the driver",
  });
  return out.disbursement!;
}

/** 10,000 handed out, settled as Used 8,000 and Returned 1,500, verified: an expense and a loss of 500. */
async function verifiedWithLoss(purpose: string): Promise<string> {
  const out = await handedOut(10000, purpose);
  const settled = await command("cashier", "staff_settle_imprest_disbursement", {
    p_id: out.id,
    p_expected_version: out.version,
    p_lines: [{ amount_tzs: 8000, purpose: "Fare", receipt_id: null, no_receipt_reason: "transport_fare", no_receipt_note: null }],
    p_returned_tzs: 1500,
    p_explanation: "Change lost on the road",
  });
  const client = (await sessionFor("manager")).client;
  const { data: s } = await client.from("imprest_settlements").select("id").eq("disbursement_id", out.id).single();
  await command("manager", "staff_verify_imprest_disbursement", {
    p_id: out.id,
    p_expected_version: settled.disbursement!.version,
    p_settlement_id: String(s!.id),
  });
  return out.id;
}

/** The expense posting corrected from 8,000 to 6,000: a Cashier asks, a Director approves. */
async function reverseExpense(disbursementId: string) {
  const client = (await sessionFor("manager")).client;
  const { data: posting } = await client
    .from("imprest_postings")
    .select("id")
    .eq("disbursement_id", disbursementId)
    .eq("kind", "expense")
    .eq("entry", "original")
    .single();
  const asked = await command("cashier", "staff_request_imprest_reversal", {
    p_posting_id: String(posting!.id),
    p_correct_tzs: 6000,
    p_reason: "The receipt says 6,000",
  });
  await command("director", "admin_decide_imprest_reversal", {
    p_reversal_id: asked.reversal!.id,
    p_expected_version: asked.reversal!.version,
    p_approve: true,
    p_reason: null,
  });
}

/** Today's count, 300 under expected cash, confirmed by the Manager as a counting error. */
async function confirmedShort(expected: number) {
  const entered = await command("cashier", "staff_enter_imprest_count", {
    p_business_date: businessDate(),
    p_previous_count_id: null,
    p_counted_tzs: expected - 300,
    p_note: null,
    p_late_reason: null,
  });
  await command("manager", "staff_confirm_imprest_count", {
    p_id: entered.count!.id,
    p_expected_version: entered.count!.version,
    p_explanation: "counting_error",
    p_note: null,
  });
}

async function as(page: Page, who: Who) {
  await page.context().clearCookies();
  const account = fixtures()[who];
  await signIn(page, account.phone, account.password);
  await expectLandsOn(page, who === "cashier" ? "/payments" : "/dashboard");
}

/**
 * Opens a section if this tier shows it shut. Asked of the body's visibility rather than of
 * `aria-expanded`, which reads "false" on a tablet until hydration corrects it: a click in that
 * window would shut a section CSS already shows open.
 */
async function openSection(page: Page, key: string) {
  const body = page.locator(`#report-section-${key}`);
  await body.waitFor({ state: "attached" });
  // Retried, because a press that lands before hydration does nothing; one that lands after opens it.
  await expect(async () => {
    if (!(await body.isVisible())) await page.getByTestId(`report-toggle-${key}`).click();
    await expect(body).toBeVisible({ timeout: 1000 });
  }).toPass();
}

const row = (page: Page, section: string, key: string) =>
  page.getByTestId(`report-row-${section}-${key}`);

test.describe("the imprest section of a report", () => {
  let runId = "";
  const today = businessDate();

  test.beforeAll(async () => {
    await freshFund();
    await postFunding(100000);
    const spent = await verifiedWithLoss(`Report trip ${SUFFIX}`);
    await reverseExpense(spent);
    await handedOut(5000, `Report errand ${SUFFIX}`);
    // Posted 100,000 - 6,000 - 500 = 93,500, and 5,000 is out: expected cash is 88,500.
    await confirmedShort(88500);

    resetScheduledReportDay(today);
    const written = generateReportFor(today);
    if (!written.ok || !written.run_id) throw new Error(`no report: ${JSON.stringify(written)}`);
    runId = written.run_id;
  });

  test.afterAll(async () => {
    resetScheduledReportDay(today);
    await freshFund();
  });

  test("a Director reads the expenses, the balance and the confirmed count", async ({ page }, testInfo) => {
    await as(page, "director");
    await page.goto(`/reports/${runId}`);
    await expect(page.getByRole("heading", { name: /report for /i })).toBeVisible();
    for (const key of ["imprestExpenses", "imprestPosition", "imprestReconciliation"]) {
      await openSection(page, key);
    }
    // Taken before any assertion, so the same capture records the screen before and after the change.
    await page.screenshot({ path: testInfo.outputPath(`report-imprest-${testInfo.project.name}.png`), fullPage: true });

    // The chip is on the heading, so the outcome reads before the section is opened.
    await expect(page.getByTestId("report-state-imprestReconciliation")).toHaveText(/^shortage$/i);
    // The till is never counted yet, so it is still listed; the imprest count no longer is.
    await expect(page.getByTestId("report-unresolved")).not.toContainText(/imprest cash count/i);

    await openSection(page, "imprestReconciliation");
    await expect(row(page, "imprestReconciliation", "countedTzs")).toContainText(tzs(88200));
    await expect(row(page, "imprestReconciliation", "expectedTzs")).toContainText(tzs(88500));
    await expect(row(page, "imprestReconciliation", "varianceTzs")).toContainText(tzs(300));
    await expect(row(page, "imprestReconciliation", "varianceTzs").getByRole("img", { name: /shortfall/i })).toBeVisible();
    await expect(row(page, "imprestReconciliation", "varianceReason")).toContainText(/counting error/i);

    await openSection(page, "imprestPosition");
    // 93,500 less the confirmed shortage of 300.
    await expect(row(page, "imprestPosition", "postedBalanceTzs")).toContainText(tzs(93200));
    await expect(row(page, "imprestPosition", "setAsideTzs")).toContainText(tzs(5000));
    await expect(row(page, "imprestPosition", "freeToApproveTzs")).toContainText(tzs(88200));
    await expect(row(page, "imprestPosition", "awaitingVerificationTzs")).toContainText(tzs(5000));
    await expect(row(page, "imprestPosition", "expectedCashTzs")).toContainText(tzs(88200));
    await expect(page.getByRole("region", { name: /imprest balance/i })).toContainText(/end of this business day/i);

    await openSection(page, "imprestExpenses");
    await expect(row(page, "imprestExpenses", "verifiedExpenseCount")).toContainText("1");
    await expect(row(page, "imprestExpenses", "verifiedExpenseTzs")).toContainText(tzs(8000));
    await expect(row(page, "imprestExpenses", "reversedExpenseTzs")).toContainText(tzs(8000));
    await expect(row(page, "imprestExpenses", "replacementExpenseTzs")).toContainText(tzs(6000));
    await expect(row(page, "imprestExpenses", "netExpenseTzs")).toContainText(tzs(6000));
    await expect(row(page, "imprestExpenses", "unexplainedLossTzs")).toContainText(tzs(500));

    await expect(page.getByText(/not in the system yet/i)).toHaveCount(0);

    // Nothing on the page is wider than the phone it is read on.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

  });

  test("the Manager reads the same figures, in Swahili too", async ({ page }, testInfo) => {
    await as(page, "manager");
    await page.goto(`/reports/${runId}`);
    await expect(page.getByTestId("report-state-imprestReconciliation")).toHaveText(/^shortage$/i);
    await openSection(page, "imprestPosition");
    await expect(row(page, "imprestPosition", "expectedCashTzs")).toContainText(tzs(88200));

    await page.context().addCookies([{ name: "fv-locale", value: "sw", url: new URL(page.url()).origin }]);
    await page.reload();
    await expect(page.getByTestId("report-state-imprestReconciliation")).toHaveText(/^upungufu$/i);
    await openSection(page, "imprestPosition");
    await expect(page.getByRole("region", { name: /salio la mfuko/i })).toContainText(/fedha zinazotarajiwa/i);
    await page.screenshot({ path: testInfo.outputPath(`report-imprest-sw-${testInfo.project.name}.png`), fullPage: true });
  });

  test("a Cashier is refused the report's address", async ({ page }) => {
    await as(page, "cashier");
    await page.goto(`/reports/${runId}`);
    await expect(page).toHaveURL(/\/no-access/);
    await expect(page.getByTestId("report-state-imprestReconciliation")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Mobile benchmark, opt-in, the method of the retirement and reversal benchmarks:
//
//     FV_BENCHMARK=1 npx playwright test --project=mobile e2e/report-imprest.spec.ts -g benchmark
//
// Opening a report from the archive, the read a Director makes on a phone: a real touch on the card
// starts the clock inside the page, acknowledgement is the first animation frame showing the card's
// "Opening" state, the report's loading region or the report itself, and completion is the report's imprest count chip
// rendered from the server's answer. Each sample opens the same report of today.
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

async function measureOpen(page: Page, profile: Profile, card: string) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    downloadThroughput: profile.down,
    uploadThroughput: profile.up,
    latency: profile.latency,
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
  try {
    await page.locator(card).evaluate((el) => {
      const w = window as unknown as { __fv: { t0?: number; ack?: number; done?: number } };
      w.__fv = {};
      el.addEventListener("pointerdown", () => (w.__fv.t0 = performance.now()), { once: true });
      new MutationObserver((_, observer) => {
        if (w.__fv.t0 === undefined) return;
        const loading = document.querySelector("[data-pending-link], [role=status][aria-busy=true]");
        const chip = document.querySelector("[data-testid=report-state-imprestReconciliation]");
        if (w.__fv.ack === undefined && (loading || chip)) {
          const t0 = w.__fv.t0;
          w.__fv.ack = -1;
          requestAnimationFrame(() => (w.__fv.ack = performance.now() - t0));
        }
        if (chip) {
          w.__fv.done = performance.now() - w.__fv.t0;
          observer.disconnect();
        }
      }).observe(document.body, { subtree: true, childList: true, attributes: true });
    });
    await page.locator(card).tap();
    await expect(page.getByTestId("report-state-imprestReconciliation")).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    const sample = await page.evaluate(() => (window as unknown as { __fv: { ack?: number; done?: number } }).__fv);
    return {
      ack: sample.ack !== undefined && sample.ack >= 0 ? sample.ack : Number.POSITIVE_INFINITY,
      done: sample.done ?? Number.POSITIVE_INFINITY,
    };
  } finally {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.detach();
  }
}

(BENCHMARK ? test.describe : test.describe.skip)("report imprest section mobile benchmark", () => {
  test.setTimeout(30 * 60_000);
  const today = businessDate();

  test.beforeAll(async () => {
    await freshFund();
    await postFunding(100000);
    const spent = await verifiedWithLoss(`Report bench ${SUFFIX}`);
    await reverseExpense(spent);
    await handedOut(5000, `Report bench errand ${SUFFIX}`);
    await confirmedShort(88500);
    resetScheduledReportDay(today);
    const written = generateReportFor(today);
    if (!written.ok) throw new Error(`no report: ${JSON.stringify(written)}`);
  });

  test.afterAll(async () => {
    resetScheduledReportDay(today);
    await freshFund();
  });

  test("Open a report from the archive: acknowledgement and completion over 4G", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the mobile profile only");

    await as(page, "director");
    for (const profile of PROFILES) {
      const ack: number[] = [];
      const done: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        await page.goto("/reports");
        await expect(page.getByTestId(`report-${today}`)).toBeVisible();
        const sample = await measureOpen(page, profile, `[data-testid="report-${today}"]`);
        ack.push(sample.ack);
        done.push(sample.done);
      }
      const a = summary(ack);
      const d = summary(done);
      console.log(`${profile.name} open a report ack  n=${a.n} p50=${a.p50}ms p95=${a.p95}ms worst=${a.worst}ms`);
      console.log(`${profile.name} open a report done n=${d.n} p50=${d.p50}ms p95=${d.p95}ms worst=${d.worst}ms`);
      expect(a.p95, `${profile.name} acknowledgement p95`).toBeLessThanOrEqual(100);
      expect(d.p95, `${profile.name} completion p95`).toBeLessThanOrEqual(2500);
    }
  });
});
