import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";

import { expectLandsOn, fixtures, signIn } from "./fixtures";

/**
 * The Manager verifies a settled payment through the screens (issue #64), on every device tier.
 *
 * The rules are proved in pgTAP and over real HTTP in the integration suite. This spec proves the
 * Manager verifies from the "Settled, waiting for you" queue with one confirmation and no field,
 * that the posted balance, the queue, the breakdown and the history show what happened, that a
 * Director reads without a control, that the Cashier sees their payment as verified, that a stale
 * screen is told so, and that a failed read is a page failure.
 *
 * Every figure is read as a change, because the three tiers run one after another on one database.
 */

type Who = "director" | "manager" | "cashier";
type Row = { id: string; version: number };

const SUFFIX = Math.random().toString(36).slice(2, 8).toUpperCase();
const sessions = new Map<Who, SupabaseClient>();

async function sessionFor(who: Who): Promise<SupabaseClient> {
  const cached = sessions.get(who);
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const account = fixtures()[who];
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: derivedAuthIdentifier(account.phone), password: account.password }),
  });
  const body = await response.json();
  if (response.status !== 200) throw new Error(`${who} could not sign in: ${JSON.stringify(body)}`);
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${body.access_token}` } },
  });
  sessions.set(who, client);
  return client;
}

async function command(who: Who, fn: string, args: Record<string, unknown>) {
  const api = (await sessionFor(who)).schema("api");
  const { data, error } = await api.rpc(fn, { ...args, p_idempotency_key: randomUUID() });
  if (error || !data.ok) throw new Error(`${fn}: ${error?.message ?? data.reason}`);
  return data as { reason: string; funding?: Row & { handover_id: string }; disbursement?: Row };
}

type Position = {
  posted_balance_tzs: number;
  set_aside_tzs: number;
  free_to_approve_tzs: number;
  awaiting_verification_tzs: number;
};
async function position(): Promise<Position> {
  const { data, error } = await (await sessionFor("manager")).schema("api").rpc("staff_imprest_spending_position");
  if (error) throw new Error(`position: ${error.message}`);
  return (data as Position[])[0];
}

async function ensureFree(amount: number) {
  const free = (await position())?.free_to_approve_tzs ?? 0;
  if (free >= amount) return;
  const top = amount - free;
  const requested = await command("manager", "staff_request_imprest_funding", {
    p_amount_tzs: top,
    p_reason: `Verification float ${SUFFIX}`,
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

const noReceipt = (amount: number, purpose: string, reason = "vendor_did_not_issue") => ({
  amount_tzs: amount,
  purpose,
  receipt_id: null,
  no_receipt_reason: reason,
  no_receipt_note: null,
});

/**
 * Proposed, approved, handed out and settled through the commands: the worked example's shape by
 * default, Used 47,000 in two lines, Returned 10,000 and 3,000 Not accounted for.
 */
async function seedSettled(
  purpose: string,
  settlement: { amount: number; lines: ReturnType<typeof noReceipt>[]; returned: number; explanation: string | null } = {
    amount: 60000,
    lines: [noReceipt(40000, "Fuel"), noReceipt(7000, "Tolls", "transport_fare")],
    returned: 10000,
    explanation: "Driver cannot say where three thousand went",
  },
): Promise<Row> {
  const proposed = await command("cashier", "staff_propose_imprest_disbursement", {
    p_amount_tzs: settlement.amount,
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
  return (
    await command("cashier", "staff_settle_imprest_disbursement", {
      p_id: out.disbursement!.id,
      p_expected_version: out.disbursement!.version,
      p_lines: settlement.lines,
      p_returned_tzs: settlement.returned,
      p_explanation: settlement.explanation,
    })
  ).disbursement!;
}

async function latestSettlement(id: string): Promise<string> {
  const { data, error } = await (await sessionFor("manager"))
    .from("imprest_settlements")
    .select("id")
    .eq("disbursement_id", id)
    .order("cycle", { ascending: false })
    .limit(1)
    .single();
  if (error) throw new Error(`settlement: ${error.message}`);
  return String(data.id);
}

async function verifyByCommand(row: Row) {
  return command("manager", "staff_verify_imprest_disbursement", {
    p_id: row.id,
    p_expected_version: row.version,
    p_settlement_id: await latestSettlement(row.id),
  });
}

async function as(page: Page, who: Who) {
  await page.context().clearCookies();
  const account = fixtures()[who];
  await signIn(page, account.phone, account.password);
  await expectLandsOn(page, who === "cashier" ? "/payments" : "/dashboard");
}

const money = (text: string) => Number(text.replace(/\D/g, ""));

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

test.describe("imprest verification", () => {
  test.beforeEach(async () => {
    await ensureFree(200000);
  });

  test("the Manager verifies the worked example from the queue with one confirmation", async ({ page }, testInfo) => {
    const purpose = `Kibaha verify ${SUFFIX} ${testInfo.project.name}`;
    await seedSettled(purpose);
    const before = await position();

    await as(page, "manager");
    await page.goto("/imprest");
    await expect(page.getByTestId("funding-total").locator("dt")).toHaveText("Posted balance");
    await expect(page.getByTestId("funding-total")).toContainText(
      "Confirmed funding minus verified spending and losses.",
    );
    expect(money(await page.getByTestId("funding-total").locator(".fv-numeric").innerText())).toBe(
      before.posted_balance_tzs,
    );
    await expect(page.getByTestId("disbursements-settled-note")).toContainText("then verify it");
    const queue = page.getByTestId("disbursements-settled");
    const row = queue.getByRole("link", { name: new RegExp(purpose) });
    await expect(row.getByTestId("settled-figures")).toContainText("Used TZS 47,000");
    await row.click();

    // What is being verified: the four figures and each line, as the Cashier settled them.
    const breakdown = page.getByTestId("settlement-breakdown");
    await expect(breakdown.getByTestId("breakdown-approved")).toContainText("60,000");
    await expect(breakdown.getByTestId("breakdown-used")).toContainText("47,000");
    await expect(breakdown.getByTestId("breakdown-returned")).toContainText("10,000");
    await expect(breakdown.getByTestId("breakdown-notAccounted")).toContainText("3,000");
    await expect(breakdown.getByTestId("settlement-lines").locator("li")).toHaveCount(2);

    await page.getByRole("button", { name: "Verify", exact: true }).click();
    const form = page.getByTestId("verify-form");
    // No field for another figure: one confirmation.
    await expect(form.getByRole("textbox")).toHaveCount(0);
    await expect(form.getByRole("spinbutton")).toHaveCount(0);
    await expect(form.getByTestId("verify-expense")).toHaveText("TZS 47,000 posts as imprest expense");
    await expect(form.getByTestId("verify-loss")).toHaveText(
      "TZS 3,000 posts as an unexplained loss for a Director to decide on",
    );
    await expect(form.getByTestId("verify-released")).toHaveText(
      "TZS 10,000 came back and is free to approve again",
    );
    await expect(form).toContainText("Only this step lowers the posted balance. It can't be undone.");
    await form.getByTestId("confirm-verify").click();
    await expect(page.getByRole("status")).toHaveText("Verified. It is posted and no longer set aside.");

    const after = await position();
    expect(after.posted_balance_tzs).toBe(before.posted_balance_tzs - 50000);
    expect(after.set_aside_tzs).toBe(before.set_aside_tzs - 60000);
    expect(after.free_to_approve_tzs).toBe(before.free_to_approve_tzs + 10000);
    expect(after.awaiting_verification_tzs).toBe(before.awaiting_verification_tzs - 50000);

    await page.reload();
    await expect(page.getByText("Verified", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("posting-expense")).toContainText("47,000");
    await expect(page.getByTestId("posting-loss")).toContainText("3,000");
    await expect(page.getByTestId("posting-loss")).toContainText("Awaiting a Director's decision");
    await expect(page.getByTestId("verified-by")).toContainText("Verified by E2E Manager on");
    await expect(page.getByTestId("disbursement-history")).toContainText("Verified and posted");
    await expect(page.getByTestId("flag-not-accounted")).toBeVisible();
    await expect(page.getByTestId("flag-no-receipt")).toBeVisible();
    await expect(page.getByRole("button", { name: "Verify", exact: true })).toHaveCount(0);

    await page.goto("/imprest");
    await expect(page.getByTestId("disbursements-settled").getByRole("link", { name: new RegExp(purpose) })).toHaveCount(0);
    expect(money(await page.getByTestId("funding-total").locator(".fv-numeric").innerText())).toBe(
      after.posted_balance_tzs,
    );
  });

  test("a settlement with nothing left over posts the expense alone", async ({ page }, testInfo) => {
    const purpose = `Exact verify ${SUFFIX} ${testInfo.project.name}`;
    const row = await seedSettled(purpose, {
      amount: 20000,
      lines: [noReceipt(20000, "Diesel")],
      returned: 0,
      explanation: null,
    });

    await as(page, "manager");
    await page.goto(`/imprest/disbursements/${row.id}`);
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    const form = page.getByTestId("verify-form");
    await expect(form.getByTestId("verify-loss")).toHaveCount(0);
    await expect(form.getByTestId("confirm-verify")).toHaveText("Verify and post TZS 20,000");
    await form.getByTestId("confirm-verify").click();
    await expect(page.getByRole("status")).toHaveText(/^Verified\./);
    await page.reload();
    await expect(page.getByTestId("posting-expense")).toContainText("20,000");
    await expect(page.getByTestId("posting-loss")).toHaveCount(0);
  });

  test("a screen left open while another Manager verified is told so, and posts nothing twice", async ({
    page,
  }, testInfo) => {
    const purpose = `Stale verify ${SUFFIX} ${testInfo.project.name}`;
    const row = await seedSettled(purpose);

    await as(page, "manager");
    await page.goto(`/imprest/disbursements/${row.id}`);
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    await verifyByCommand(row);
    const before = await position();

    await page.getByTestId("confirm-verify").click();
    await expect(page.getByText("This payment changed since you opened it. Reload to see where it stands.")).toBeVisible();
    expect(await position()).toEqual(before);
  });

  test("a Director reads the queue and a verified payment, with no control", async ({ page }, testInfo) => {
    const waitingPurpose = `Director waiting ${SUFFIX} ${testInfo.project.name}`;
    const donePurpose = `Director verified ${SUFFIX} ${testInfo.project.name}`;
    const waiting = await seedSettled(waitingPurpose);
    const done = await seedSettled(donePurpose);
    await verifyByCommand(done);

    await as(page, "director");
    await page.goto("/imprest");
    await expect(page.getByTestId("funding-total").locator("dt")).toHaveText("Posted balance");
    await expect(page.getByTestId("disbursements-settled-note")).toContainText("The Manager checks each one");
    await page.getByTestId("disbursements-settled").getByRole("link", { name: new RegExp(waitingPurpose) }).click();
    await expect(page.getByTestId("verify-by-manager")).toBeVisible();
    await expect(page.getByRole("button", { name: "Verify", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("verify-form")).toHaveCount(0);

    await page.goto(`/imprest/disbursements/${done.id}`);
    await expect(page.getByTestId("read-only")).toBeVisible();
    await expect(page.getByTestId("posting-expense")).toContainText("47,000");
    await expect(page.getByTestId("posting-loss")).toContainText("3,000");
    await expect(page.getByTestId("verified-by")).toContainText("E2E Manager");
    await expect(page.getByRole("button", { name: "Verify", exact: true })).toHaveCount(0);
    expect(waiting.id).toBeTruthy();
  });

  test("the Cashier sees their payment as verified, and Free to approve alone", async ({ page }, testInfo) => {
    const purpose = `Cashier verified ${SUFFIX} ${testInfo.project.name}`;
    const row = await seedSettled(purpose);
    await verifyByCommand(row);

    await as(page, "cashier");
    await page.goto("/imprest");
    await expect(page.getByTestId("free-to-approve")).toBeVisible();
    await expect(page.getByTestId("funding-total")).toHaveCount(0);
    await expect(page.getByTestId("set-aside-total")).toHaveCount(0);
    await expect(page.getByTestId("awaiting-verification")).toHaveCount(0);
    const mine = page.getByTestId("disbursements-mine").getByRole("link", { name: new RegExp(purpose) });
    await expect(mine).toContainText("Verified");
    await expect(mine.getByTestId("flag-not-accounted")).toBeVisible();
    await expect(mine.getByTestId("next-step")).toHaveCount(0);

    await mine.click();
    await expect(page.getByTestId("verified-note")).toHaveText("Verified. It is posted and can't be changed.");
    await expect(page.getByTestId("posting-expense")).toContainText("47,000");
    // A Cashier may not read the Manager's profile, so the role stands in for the name.
    await expect(page.getByTestId("verified-by")).toContainText("Verified by Manager on");
    await expect(page.getByTestId("disbursement-history")).toContainText("Verified and posted");
    await expect(page.getByTestId("settle-form")).toHaveCount(0);
  });

  test("a failed read is a page failure, never a missing posting", async ({ page }, testInfo) => {
    const purpose = `Verify read ${SUFFIX} ${testInfo.project.name}`;
    const row = await seedSettled(purpose);
    await verifyByCommand(row);
    await as(page, "manager");

    // One Playwright worker runs the whole suite, so this grant is taken away from nobody else.
    try {
      psql("revoke select on public.imprest_postings from authenticated;");
      await page.goto(`/imprest/disbursements/${row.id}`);
      await expect(page.getByText(/this page could not be loaded/i)).toBeVisible();
      await expect(page.getByTestId("posting-expense")).toHaveCount(0);
      await page.goto("/imprest");
      await expect(page.getByText(/this page could not be loaded/i)).toBeVisible();
      await expect(page.getByTestId("funding-total")).toHaveCount(0);
    } finally {
      psql("grant select on public.imprest_postings to authenticated;");
    }

    await page.goto(`/imprest/disbursements/${row.id}`);
    await expect(page.getByTestId("posting-expense")).toContainText("47,000");
  });
});

// ---------------------------------------------------------------------------------------------
// Mobile benchmark, opt-in, the method of the funding, disbursement and settlement benchmarks:
//
//     FV_BENCHMARK=1 npx playwright test --project=mobile e2e/imprest-verification.spec.ts -g benchmark
//
// Verify: a real touch on the confirmation starts the clock inside the page, acknowledgement is the
// first animation frame after the button reports `aria-busy`, and completion is the server's
// confirmation appearing.
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

(BENCHMARK ? test.describe : test.describe.skip)("imprest verification mobile benchmark", () => {
  test.setTimeout(60 * 60_000);

  test("Verify: acknowledgement and server-confirmed completion over 4G", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the mobile profile only");
    await ensureFree(SAMPLES * PROFILES.length * 1000 + 1000);
    await as(page, "manager");

    for (const profile of PROFILES) {
      const ack: number[] = [];
      const done: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const row = await seedSettled(`Bench verify ${SUFFIX} ${profile.name} ${i}`, {
          amount: 1000,
          lines: [noReceipt(800, "Bajaji", "transport_fare")],
          returned: 200,
          explanation: null,
        });
        await page.goto(`/imprest/disbursements/${row.id}`);
        await page.getByRole("button", { name: "Verify", exact: true }).click();
        const sample = await measureTap(page, profile, "[data-testid=confirm-verify]", "Verified.");
        ack.push(sample.ack);
        done.push(sample.done);
      }
      const a = summary(ack);
      const d = summary(done);
      console.log(`${profile.name} verify ack  n=${a.n} p50=${a.p50}ms p95=${a.p95}ms worst=${a.worst}ms`);
      console.log(`${profile.name} verify done n=${d.n} p50=${d.p50}ms p95=${d.p95}ms worst=${d.worst}ms`);
      expect(a.worst, `${profile.name} verify acknowledgement`).toBeLessThanOrEqual(100);
      expect(d.p95, `${profile.name} verify completion p95`).toBeLessThanOrEqual(2500);
    }
  });
});
