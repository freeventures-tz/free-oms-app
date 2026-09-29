import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";

import { expectLandsOn, fixtures, signIn } from "./fixtures";

/**
 * Reversals through the screens (issue #71), on every device tier.
 *
 * The rules are proved in pgTAP and over real HTTP in the integration suite. This spec proves the
 * Cashier asks for a reversal of a verified expense from the payment's page with a correct amount and
 * a reason; that it waits on the Directors' list as "Reversals waiting for approval"; that a Director
 * approves it with no figure to type, told where the posted balance lands; that the page then reads
 * the original, the request, the decision, the reversal and the replacement in order; that the
 * Manager asks and reads but cannot decide, and a rejection keeps its reason; that an approval the
 * fund cannot carry is refused and said so; and that a failed read is said so.
 *
 * Every figure is read as a change, because the three tiers run one after another on one database.
 */

type Who = "director" | "manager" | "cashier";
type Row = { id: string; version: number };

const SUFFIX = Math.random().toString(36).slice(2, 8).toUpperCase();
const sessions = new Map<Who, { client: SupabaseClient; token: string }>();
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
  const session = { client, token: String(body.access_token) };
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
    reversal?: { id: string; version: number };
  };
}

type Position = { set_aside_tzs: number; free_to_approve_tzs: number; awaiting_verification_tzs: number; posted_balance_tzs: number };
async function position(): Promise<Position> {
  const { data, error } = await (await sessionFor("manager")).client.schema("api").rpc("staff_imprest_spending_position");
  if (error) throw new Error(`position: ${error.message}`);
  return (data as Position[])[0];
}

async function ensureFree(amount: number) {
  const free = (await position())?.free_to_approve_tzs ?? 0;
  if (free >= amount) return;
  const top = amount - free;
  const requested = await command("manager", "staff_request_imprest_funding", {
    p_amount_tzs: top,
    p_reason: `Reversal float ${SUFFIX}`,
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

/** Every request a test opened, so it can be closed and leave the Directors' list as it found it. */
const opened: string[] = [];

/** Every payment a test approved and left open, so it can be cancelled and free its money again. */
const held: Row[] = [];

/**
 * Proposed, approved, handed out, settled as Used 8,000 and Returned 1,500 (so 500 is not
 * accounted for) and verified: an expense of 8,000 and a loss of 500 are posted.
 */
async function seedVerified(purpose: string): Promise<{ row: Row; expense: string; loss: string }> {
  const proposed = await command("cashier", "staff_propose_imprest_disbursement", {
    p_amount_tzs: 10000,
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
  const settled = await command("cashier", "staff_settle_imprest_disbursement", {
    p_id: out.disbursement!.id,
    p_expected_version: out.disbursement!.version,
    p_lines: [
      { amount_tzs: 8000, purpose: "Fare", receipt_id: null, no_receipt_reason: "transport_fare", no_receipt_note: null },
    ],
    p_returned_tzs: 1500,
    p_explanation: "Change lost on the road",
  });
  const client = (await sessionFor("manager")).client;
  const { data: s } = await client.from("imprest_settlements").select("id").eq("disbursement_id", out.disbursement!.id).single();
  const verified = await command("manager", "staff_verify_imprest_disbursement", {
    p_id: out.disbursement!.id,
    p_expected_version: settled.disbursement!.version,
    p_settlement_id: String(s!.id),
  });
  const { data: postings } = await client
    .from("imprest_postings")
    .select("id, kind")
    .eq("disbursement_id", out.disbursement!.id)
    .eq("entry", "original");
  const id = (kind: string) => String(postings!.find((p) => p.kind === kind)!.id);
  return { row: verified.disbursement!, expense: id("expense"), loss: id("unexplained_loss") };
}

async function requestByCommand(who: Who, postingId: string, correct: number, reason = "Receipt shows less") {
  const asked = await command(who, "staff_request_imprest_reversal", {
    p_posting_id: postingId,
    p_correct_tzs: correct,
    p_reason: reason,
  });
  opened.push(asked.reversal!.id);
  return asked.reversal!;
}

async function as(page: Page, who: Who) {
  await page.context().clearCookies();
  const account = fixtures()[who];
  await signIn(page, account.phone, account.password);
  await expectLandsOn(page, who === "cashier" ? "/payments" : "/dashboard");
}

/** The waiting list is oldest first, so a request made just now is on the last page. */
const LAST_REVERSAL_PAGE = "/imprest?reversal=9999";

function psql(sql: string) {
  const url = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  try {
    execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], { stdio: "pipe" });
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
    execFileSync(
      "docker",
      [
        "exec", "-i", process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_free-oms-app",
        "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-c", sql,
      ],
      { stdio: "pipe" },
    );
  }
}

async function cleanUp() {
  const client = (await sessionFor("director")).client;
  for (const id of opened.splice(0)) {
    const { data } = await client.from("imprest_posting_reversals").select("status, version").eq("id", id).single();
    if (data?.status !== "requested") continue;
    try {
      await command("director", "admin_decide_imprest_reversal", {
        p_reversal_id: id, p_expected_version: data.version, p_approve: false, p_reason: "Test clean-up",
      });
    } catch {
      // A test that failed part-way may leave a request another step already decided.
    }
  }
  for (const row of held.splice(0)) {
    try {
      await command("manager", "staff_cancel_imprest_disbursement", {
        p_id: row.id, p_expected_version: row.version, p_reason: "Test clean-up",
      });
    } catch {
      // See above.
    }
  }
}

test.describe("imprest reversal", () => {
  test.beforeEach(async () => {
    await ensureFree(100000);
  });

  test.afterEach(cleanUp);

  test("asked for by the Cashier, approved by a Director, and read in order", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const purpose = `Reversal trip ${SUFFIX} ${testInfo.project.name}`;
    const { row } = await seedVerified(purpose);
    const before = await position();

    // The Cashier asks from the payment's page: a correct amount and a reason, both checked first.
    await as(page, "cashier");
    await page.goto(`/imprest/disbursements/${row.id}`);
    const expense = page.getByTestId("standing-expense");
    await expect(expense).toContainText("TZS 8,000");
    await expense.getByTestId("request-reversal-toggle").click();
    const form = expense.getByTestId("request-reversal-form");
    await form.getByRole("button", { name: "Send to a Director" }).click();
    await expect(form.getByText("Enter a whole number of shillings, 0 or more.")).toBeVisible();
    await expect(form.getByText("Give a reason of 3 to 500 characters.")).toBeVisible();
    await form.getByLabel("Correct amount (TZS)").fill("7500");
    await form.getByLabel("Why it needs correcting").fill("The receipt shows 7,500");
    await form.getByRole("button", { name: "Send to a Director" }).click();
    await expect(expense.getByRole("status")).toContainText("Request sent.");
    await expect(expense.getByTestId("reversal-waiting")).toBeVisible();
    expect(await position()).toEqual(before);
    const { data: made } = await (await sessionFor("cashier")).client
      .from("imprest_posting_reversals")
      .select("id")
      .eq("disbursement_id", row.id);
    opened.push(String(made![0].id));

    // The Directors' list, and one tap to approve with nothing to type.
    await as(page, "director");
    await page.goto(LAST_REVERSAL_PAGE);
    await expect(page.getByTestId("disbursements-reversal")).toContainText("Reversals waiting for approval (");
    await page.getByTestId("disbursements-reversal").getByRole("link", { name: new RegExp(purpose) }).click();
    const request = page.getByTestId("reversal-1");
    await expect(request).toContainText("Imprest expense: TZS 8,000 to TZS 7,500");
    await expect(request).toContainText("The receipt shows 7,500");
    await expect(request.getByTestId("reversal-status")).toHaveText("Waiting for a Director");
    const approve = request.getByTestId("approve-reversal-form");
    await expect(approve).toContainText("a replacement of TZS 7,500");
    await expect(approve).toContainText(
      `goes from TZS ${before.posted_balance_tzs.toLocaleString("en-GB")} to TZS ${(before.posted_balance_tzs + 500).toLocaleString("en-GB")}`,
    );
    await expect(approve.getByRole("textbox")).toHaveCount(0);
    await request.getByTestId("approve-reversal").click();
    await expect(request.getByRole("status")).toContainText("Approved. The reversal and the replacement are posted.");
    const after = await position();
    expect(after.posted_balance_tzs).toBe(before.posted_balance_tzs + 500);
    expect(after.free_to_approve_tzs).toBe(before.free_to_approve_tzs + 500);

    // The page reads the original, the request, the decision, the reversal and the replacement.
    await page.reload();
    await expect(page.getByTestId("reversal-1").getByTestId("reversal-status")).toHaveText("Approved and posted");
    const ledger = page.getByTestId("posting-ledger").getByTestId("ledger-row");
    await expect(ledger.nth(0)).toContainText("Posted at verification · Imprest expense · Reversed");
    await expect(ledger.nth(2)).toContainText("Reversal · Imprest expense");
    await expect(ledger.nth(2)).toContainText("TZS -8,000");
    await expect(ledger.nth(3)).toContainText("Replacement · Imprest expense");
    await expect(ledger.nth(3)).toContainText("TZS 7,500");
    const history = page.getByTestId("disbursement-history");
    await expect(history).toContainText(
      /Verified and posted[\s\S]*Reversal asked for[\s\S]*Reversal approved[\s\S]*Reversal posted[\s\S]*Replacement posted/,
    );
    await expect(page.getByTestId("disbursements-reversal")).toHaveCount(0);

    // The Cashier sees the outcome, and the replacement is the one open to correction now.
    await as(page, "cashier");
    await page.goto(`/imprest/disbursements/${row.id}`);
    await expect(page.getByTestId("reversal-1").getByTestId("reversal-status")).toHaveText("Approved and posted");
    await expect(page.getByTestId("standing-expense")).toHaveAttribute("data-entry", "replacement");
    await expect(page.getByTestId("standing-expense")).toContainText("TZS 7,500");
  });

  test("the Manager asks and reads but cannot decide; a Director rejects, and the reason stays", async ({
    page,
  }, testInfo) => {
    const purpose = `Reversal loss ${SUFFIX} ${testInfo.project.name}`;
    const { row } = await seedVerified(purpose);
    const before = await position();

    await as(page, "manager");
    await page.goto(`/imprest/disbursements/${row.id}`);
    const loss = page.getByTestId("standing-unexplained_loss");
    await loss.getByTestId("request-reversal-toggle").click();
    await loss.getByLabel("Correct amount (TZS)").fill("0");
    await loss.getByLabel("Why it needs correcting").fill("The 500 was found in the van");
    await loss.getByRole("button", { name: "Send to a Director" }).click();
    await expect(loss.getByRole("status")).toContainText("Request sent.");
    const { data: made } = await (await sessionFor("manager")).client
      .from("imprest_posting_reversals")
      .select("id")
      .eq("disbursement_id", row.id);
    opened.push(String(made![0].id));

    // The Manager reads the list and the request, and has nothing to decide it with.
    await page.goto(LAST_REVERSAL_PAGE);
    await expect(page.getByTestId("disbursements-reversal-note")).toContainText("A Director approves or rejects each one");
    await page.getByTestId("disbursements-reversal").getByRole("link", { name: new RegExp(purpose) }).click();
    await expect(page.getByTestId("reversal-1")).toContainText("Unexplained loss: TZS 500 to TZS 0");
    await expect(page.getByTestId("approve-reversal")).toHaveCount(0);
    await expect(page.getByTestId("reject-reversal-toggle")).toHaveCount(0);

    // A Director rejects it, with a reason; nothing is posted.
    await as(page, "director");
    await page.goto(`/imprest/disbursements/${row.id}`);
    await expect(page.getByTestId("request-reversal-toggle")).toHaveCount(0);
    await page.getByTestId("reject-reversal-toggle").click();
    const reject = page.getByTestId("reject-reversal-form");
    await reject.getByRole("button", { name: "Reject request" }).click();
    await expect(reject.getByText("Give a reason of 3 to 500 characters.")).toBeVisible();
    await reject.getByLabel("Why you are rejecting it").fill("The van was searched twice");
    await reject.getByRole("button", { name: "Reject request" }).click();
    await expect(page.getByRole("status").first()).toContainText("Request rejected.");
    expect(await position()).toEqual(before);

    // The Director's view once decided is read-only.
    await page.reload();
    await expect(page.getByTestId("reversal-1").getByTestId("reversal-status")).toHaveText("Rejected");
    await expect(page.getByTestId("reversal-rejection")).toContainText("The van was searched twice");
    await expect(page.getByTestId("approve-reversal")).toHaveCount(0);
    await expect(page.getByTestId("read-only")).toBeVisible();

    // The Cashier reads the outcome and why.
    await as(page, "cashier");
    await page.goto(`/imprest/disbursements/${row.id}`);
    await expect(page.getByTestId("reversal-rejection")).toContainText("The van was searched twice");
    await expect(page.getByTestId("disbursement-history")).toContainText("Reversal rejected");
  });

  test("an approval the fund cannot carry is refused with what is free, and posts nothing", async ({
    page,
  }, testInfo) => {
    const { row, expense } = await seedVerified(`Reversal short ${SUFFIX} ${testInfo.project.name}`);
    const free = (await position()).free_to_approve_tzs;
    await requestByCommand("cashier", expense, 8000 + free, "A second receipt was found");

    // A payment approved after the request takes one shilling of what was free.
    const proposed = await command("cashier", "staff_propose_imprest_disbursement", {
      p_amount_tzs: 1,
      p_category: "transport_and_delivery",
      p_purpose: `One shilling ${SUFFIX}`,
    });
    const approved = await command("manager", "staff_decide_imprest_disbursement", {
      p_id: proposed.disbursement!.id, p_expected_version: 1, p_approve: true, p_reason: null,
    });
    held.push(approved.disbursement!);
    const before = await position();

    await as(page, "director");
    await page.goto(`/imprest/disbursements/${row.id}`);
    await page.getByTestId("approve-reversal").click();
    await expect(page.getByText(/This would take the posted balance below what is set aside/)).toBeVisible();
    expect(await position()).toEqual(before);
    await expect(page.getByTestId("approve-reversal")).toBeEnabled();
  });

  test("a failed read is a page failure, never a missing request", async ({ page }, testInfo) => {
    const { row, expense } = await seedVerified(`Reversal read ${SUFFIX} ${testInfo.project.name}`);
    await requestByCommand("cashier", expense, 7000, "The receipt shows 7,000");
    await as(page, "director");

    // One Playwright worker runs the whole suite, so this grant is taken away from nobody else.
    try {
      psql("revoke select on public.imprest_posting_reversals from authenticated;");
      await page.goto(`/imprest/disbursements/${row.id}`);
      await expect(page.getByText(/this page could not be loaded/i)).toBeVisible();
      await expect(page.getByTestId("reversal-1")).toHaveCount(0);
      await page.goto("/imprest");
      await expect(page.getByText(/this page could not be loaded/i)).toBeVisible();
    } finally {
      psql("grant select on public.imprest_posting_reversals to authenticated;");
    }

    await page.goto(`/imprest/disbursements/${row.id}`);
    await expect(page.getByTestId("reversal-1")).toContainText("The receipt shows 7,000");
  });
});

// ---------------------------------------------------------------------------------------------
// Mobile benchmark, opt-in, the method of the raised-approval and send-back benchmarks:
//
//     FV_BENCHMARK=1 npx playwright test --project=mobile e2e/imprest-reversal.spec.ts -g benchmark
//
// Asking for a reversal and approving it: a real touch starts the clock inside the page,
// acknowledgement is the first animation frame after the touched control reports `aria-busy`, and
// completion is the server's confirmation appearing.
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

async function measureTap(page: Page, profile: Profile, control: string, done: string) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    downloadThroughput: profile.down,
    uploadThroughput: profile.up,
    latency: profile.latency,
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
  try {
    const button = page.locator(control);
    await button.evaluate((el, doneText) => {
      const w = window as unknown as { __fv: { t0?: number; ack?: number; done?: number } };
      w.__fv = {};
      el.addEventListener("pointerdown", () => (w.__fv.t0 = performance.now()), { once: true });
      new MutationObserver((_, observer) => {
        if (el.getAttribute("aria-busy") === "true" && w.__fv.t0 !== undefined) {
          requestAnimationFrame(() => (w.__fv.ack = performance.now() - w.__fv.t0!));
          observer.disconnect();
        }
      }).observe(el, { attributes: true });
      new MutationObserver((_, observer) => {
        if ([...document.querySelectorAll("[role=status]")].some((s) => s.textContent?.includes(doneText))) {
          w.__fv.done = performance.now() - (w.__fv.t0 ?? performance.now());
          observer.disconnect();
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    }, done);
    await button.tap();
    await expect(page.getByRole("status").filter({ hasText: done })).toBeVisible({ timeout: 30_000 });
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

function report(label: string, ack: number[], done: number[]) {
  const a = summary(ack);
  const d = summary(done);
  console.log(`${label} ack  n=${a.n} p50=${a.p50}ms p95=${a.p95}ms worst=${a.worst}ms`);
  console.log(`${label} done n=${d.n} p50=${d.p50}ms p95=${d.p95}ms worst=${d.worst}ms`);
  expect(a.worst, `${label} acknowledgement`).toBeLessThanOrEqual(100);
  expect(d.p95, `${label} completion p95`).toBeLessThanOrEqual(2500);
}

(BENCHMARK ? test.describe : test.describe.skip)("imprest reversal mobile benchmark", () => {
  test.setTimeout(60 * 60_000);
  test.afterEach(cleanUp);

  test("Ask for a reversal and Approve it: acknowledgement and server-confirmed completion over 4G", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the mobile profile only");
    await ensureFree(SAMPLES * PROFILES.length * 10000 + 1000);

    // Ask: the Cashier's form on the payment's own page, one verified payment per sample.
    const rows: Row[] = [];
    await as(page, "cashier");
    for (const profile of PROFILES) {
      const ack: number[] = [];
      const done: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const { row } = await seedVerified(`Bench reversal ${SUFFIX} ${profile.name} ${i}`);
        rows.push(row);
        await page.goto(`/imprest/disbursements/${row.id}`);
        const expense = page.getByTestId("standing-expense");
        await expense.getByTestId("request-reversal-toggle").click();
        await expense.getByLabel("Correct amount (TZS)").fill("7500");
        await expense.getByLabel("Why it needs correcting").fill("The receipt shows 7,500");
        const sample = await measureTap(
          page,
          profile,
          "[data-testid=standing-expense] [data-testid=request-reversal-form] button[type=submit]",
          "Request sent.",
        );
        ack.push(sample.ack);
        done.push(sample.done);
      }
      report(`${profile.name} ask for a reversal`, ack, done);
    }

    // Approve: a Director's single tap on each of those requests.
    await as(page, "director");
    let next = 0;
    for (const profile of PROFILES) {
      const ack: number[] = [];
      const done: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const row = rows[next++];
        await page.goto(`/imprest/disbursements/${row.id}`);
        await expect(page.getByTestId("approve-reversal")).toBeVisible();
        const sample = await measureTap(page, profile, "[data-testid=approve-reversal]", "Approved.");
        ack.push(sample.ack);
        done.push(sample.done);
      }
      report(`${profile.name} approve a reversal`, ack, done);
    }
  });
});
