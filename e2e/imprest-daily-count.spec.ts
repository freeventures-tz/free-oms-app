import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";
import { businessDate } from "@/lib/time/business-date";

import { expectLandsOn, fixtures, signIn } from "./fixtures";

/**
 * The daily count through the screens (issue #68), on every device tier.
 *
 * The rules are proved in pgTAP and over real HTTP in the integration suite. This spec proves the
 * Cashier counts from the imprest screen with one field and no expected figure in front of them; that
 * the Manager sends the count back with a reason and the Cashier sees it above a recount; that the
 * Manager confirms a shortage with a preset reason, which posts it and lowers the posted balance;
 * that a Director reads the flag and the day with no control; and that a stale screen and a failed
 * read are said so.
 *
 * A business day takes one confirmed count, and the tiers run one after another on one database. So
 * each test starts a fresh day by moving every earlier count a day into the past, on the local stack
 * only, as the database's superuser with its triggers suspended for that one statement.
 */

type Who = "director" | "manager" | "cashier";
type Count = { id: string; version: number; expected_tzs: number };

const sessions = new Map<Who, { client: SupabaseClient; token: string }>();
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
  const session = { client, token: String(body.access_token) };
  sessions.set(who, session);
  return session;
}

async function command(who: Who, fn: string, args: Record<string, unknown>) {
  const api = (await sessionFor(who)).client.schema("api");
  const { data, error } = await api.rpc(fn, { ...args, p_idempotency_key: randomUUID() });
  if (error || !data.ok) throw new Error(`${fn}: ${error?.message ?? data.reason}`);
  return data as { reason: string; count?: Count; funding?: { id: string; version: number; handover_id: string } };
}

type Position = { posted_balance_tzs: number; awaiting_verification_tzs: number; free_to_approve_tzs: number };
async function position(): Promise<Position | undefined> {
  const { data, error } = await (await sessionFor("manager")).client.schema("api").rpc("staff_imprest_spending_position");
  if (error) throw new Error(`position: ${error.message}`);
  return (data as Position[])[0];
}

/** Expected cash as it stands: posted balance minus awaiting verification. */
async function expectedCash(): Promise<number> {
  const p = (await position())!;
  return Number(p.posted_balance_tzs) - Number(p.awaiting_verification_tzs);
}

/** A fund with cash in it, so there is something to count. */
async function ensureFund(amount: number) {
  if (((await position())?.posted_balance_tzs ?? 0) >= amount) return;
  const requested = await command("manager", "staff_request_imprest_funding", {
    p_amount_tzs: amount,
    p_reason: "Daily count float",
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
 * Ends the day: every count and flag so far moves one day into the past, so today is uncounted. In
 * two steps, because one `- 1` moves a row onto a day another row has not left yet.
 */
function endDay() {
  superSql(`
    set session_replication_role = replica;
    update public.imprest_counts set business_date = business_date - 100000;
    update public.imprest_counts set business_date = business_date + 99999;
    update public.imprest_count_flags set business_date = business_date - 1;
  `);
}

async function as(page: Page, who: Who) {
  await page.context().clearCookies();
  const account = fixtures()[who];
  await signIn(page, account.phone, account.password);
  await expectLandsOn(page, who === "cashier" ? "/payments" : "/dashboard");
}

async function enteredByCommand(counted: number): Promise<Count> {
  return (
    await command("cashier", "staff_enter_imprest_count", {
      p_business_date: businessDate(),
      p_previous_count_id: null,
      p_counted_tzs: counted,
      p_note: null,
    })
  ).count!;
}

test.describe("imprest daily count", () => {
  test.beforeEach(async () => {
    await ensureFund(500_000);
    endDay();
  });

  test("counted, sent back, counted again and confirmed as a shortage that posts", async ({ page }, testInfo) => {
    const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}-${testInfo.project.name}.png`), fullPage: true });
    const expected = await expectedCash();
    const posted = Number((await position())!.posted_balance_tzs);

    // The Cashier sees today uncounted, and one field: no expected figure to copy.
    await as(page, "cashier");
    await page.goto("/imprest");
    const today = page.getByTestId("count-today");
    await expect(today.getByTestId("count-state-due")).toBeVisible();
    await expect(today).not.toContainText("Expected cash");
    await shot("count-1-cashier-not-counted");
    await today.getByLabel("Cash in the tin").fill(String(expected - 2000));
    await today.getByRole("button", { name: "Enter count" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Count entered." })).toBeVisible();
    await expect(today.getByTestId("count-state-awaiting_confirmation")).toBeVisible();
    await expect(today.getByTestId("count-variance")).toContainText(`Short by ${tzs(2000)}`);
    await expect(today.getByTestId("count-expected")).toContainText(tzs(expected));
    await shot("count-2-cashier-awaiting");

    // The Manager sends it back with a reason.
    await as(page, "manager");
    await page.goto("/imprest");
    await expect(today.getByTestId("count-state-awaiting_confirmation")).toBeVisible();
    await expect(today.getByTestId("count-basis")).toBeVisible();
    await today.getByTestId("open-send-back-count").click();
    await today.getByTestId("send-back-count-form").getByLabel("What the Cashier should check").fill("Count the coin bag too");
    await today.getByRole("button", { name: "Send back for a recount" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Count sent back." })).toBeVisible();
    await expect(today.getByTestId("count-state-sent_back")).toBeVisible();
    await shot("count-3-manager-sent-back");

    // The Cashier reads the reason above the recount.
    await as(page, "cashier");
    await page.goto("/imprest");
    await expect(today.getByTestId("recount-reason")).toContainText("Count the coin bag too");
    await today.getByLabel("Cash in the tin").fill(`${expected - 1000}`);
    await today.getByRole("button", { name: "Enter the new count" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Count entered." })).toBeVisible();
    await expect(today.getByTestId("count-variance")).toContainText(`Short by ${tzs(1000)}`);

    // The Manager confirms: Other needs a note, then the shortage posts.
    await as(page, "manager");
    await page.goto("/imprest");
    const form = today.getByTestId("confirm-count-form");
    await expect(form.getByTestId("confirm-posts")).toContainText(`count shortage of ${tzs(1000)}`);
    await form.getByText("Other", { exact: true }).click();
    await form.getByRole("button", { name: `Confirm shortage of ${tzs(1000)}` }).click();
    await expect(form.getByText("This reason needs a note of 3 to 500 characters.")).toBeVisible();
    await form.getByLabel("Note (required for this reason)").fill("Coin bag was short on arrival");
    await shot("count-4-manager-confirming");
    await form.getByRole("button", { name: `Confirm shortage of ${tzs(1000)}` }).click();
    await expect(page.getByRole("status").filter({ hasText: "Count confirmed." })).toBeVisible();
    await expect(today.getByTestId("count-state-shortage")).toBeVisible();
    await expect(today.getByTestId("count-posted")).toContainText(`count shortage of ${tzs(1000)}, waiting for a Director`);
    await expect(page.getByTestId("funding-total")).toContainText(tzs(posted - 1000));
    // Both counts stay on the record.
    const history = page.getByTestId("count-history");
    await expect(history.getByTestId(`count-${businessDate()}-1`).getByTestId("count-state-sent_back")).toBeVisible();
    await expect(history.getByTestId(`count-${businessDate()}-2`).getByTestId("count-state-shortage")).toBeVisible();
    await shot("count-5-manager-confirmed");
  });

  test("a Director reads the flag and the day, with no control", async ({ page }, testInfo) => {
    const expected = await expectedCash();
    const count = await enteredByCommand(expected + 700);
    await command("manager", "staff_confirm_imprest_count", {
      p_id: count.id,
      p_expected_version: count.version,
      p_explanation: "change_not_returned",
      p_note: null,
    });

    await as(page, "director");
    await expect(page.getByTestId("count-flags")).toContainText(`Excess of ${tzs(700)}`);
    await page.goto("/imprest");
    await expect(page.getByTestId("count-flags")).toContainText(`Excess of ${tzs(700)}`);
    const today = page.getByTestId("count-today");
    await expect(today.getByTestId("count-state-excess")).toBeVisible();
    await expect(today.getByTestId("count-confirmation")).toContainText("Change not returned");
    await expect(page.getByTestId("enter-count-form")).toHaveCount(0);
    await expect(page.getByTestId("confirm-count-form")).toHaveCount(0);
    await expect(page.getByTestId("open-send-back-count")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`count-6-director-${testInfo.project.name}.png`), fullPage: true });
  });

  test("yesterday's count still waiting holds today's until the Manager decides it", async ({ page }) => {
    await enteredByCommand((await expectedCash()) - 400);
    endDay();

    await as(page, "cashier");
    await page.goto("/imprest");
    const today = page.getByTestId("count-today");
    await expect(today.getByTestId("count-earlier")).toBeVisible();
    await expect(today).toContainText("still waits for the Manager");
    await expect(page.getByTestId("enter-count-form")).toHaveCount(0);

    await as(page, "manager");
    await page.goto("/imprest");
    await expect(today.getByTestId("count-earlier").getByTestId("count-variance")).toContainText(`Short by ${tzs(400)}`);
    const form = today.getByTestId("confirm-count-form");
    await form.getByText("Counting error", { exact: true }).click();
    await form.getByRole("button", { name: `Confirm shortage of ${tzs(400)}` }).click();
    await expect(page.getByRole("status").filter({ hasText: "Count confirmed." })).toBeVisible();
    await expect(today.getByTestId("count-earlier")).toHaveCount(0);

    await as(page, "cashier");
    await page.goto("/imprest");
    await expect(page.getByTestId("enter-count-form")).toBeVisible();
  });

  test("a screen left open while the count was sent back is told so", async ({ page }) => {
    const count = await enteredByCommand((await expectedCash()) - 300);
    await as(page, "manager");
    await page.goto("/imprest");
    const form = page.getByTestId("count-today").getByTestId("confirm-count-form");
    await expect(form).toBeVisible();

    await command("manager", "staff_send_back_imprest_count", {
      p_id: count.id,
      p_expected_version: count.version,
      p_reason: "Sent back from another screen",
    });
    await form.getByText("Counting error", { exact: true }).click();
    await form.getByRole("button", { name: `Confirm shortage of ${tzs(300)}` }).click();
    await expect(page.getByText(/changed since you opened this page|no longer waiting for you/)).toBeVisible();
    // Nothing typed was lost, and nothing was confirmed.
    await expect(form.getByRole("radio", { name: "Counting error" })).toBeChecked();
    const { data } = await (await sessionFor("manager")).client
      .from("imprest_count_confirmations")
      .select("id")
      .eq("count_id", count.id);
    expect(data).toEqual([]);
  });

  test("a failed read is a page failure, never Not counted or no flags", async ({ page }) => {
    await as(page, "director");
    try {
      superSql("revoke select on public.imprest_count_flags from authenticated;");
      await page.goto("/imprest");
      await expect(page.getByText(/this page could not be loaded/i)).toBeVisible();
      await expect(page.getByTestId("count-flags")).toHaveCount(0);
    } finally {
      superSql("grant select on public.imprest_count_flags to authenticated;");
    }

    await as(page, "cashier");
    try {
      superSql("revoke execute on function api.staff_imprest_counts(integer, integer, date) from authenticated;");
      await page.goto("/imprest");
      await expect(page.getByText(/this page could not be loaded/i)).toBeVisible();
      await expect(page.getByTestId("count-today")).toHaveCount(0);
    } finally {
      superSql("grant execute on function api.staff_imprest_counts(integer, integer, date) to authenticated;");
    }
    await page.goto("/imprest");
    await expect(page.getByTestId("count-today").getByTestId("count-state-due")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------------------------
// Mobile benchmark, opt-in, the method of the settlement, verification and send-back benchmarks:
//
//     FV_BENCHMARK=1 npx playwright test --project=mobile e2e/imprest-daily-count.spec.ts -g benchmark
//
// Enter a count and confirm one: a real touch starts the clock inside the page, acknowledgement is
// the first animation frame after the touched control reports `aria-busy`, and completion is the
// server's confirmation appearing.
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

/**
 * Confirms the latest count if it still waits for the Manager. A waiting earlier count blocks today's
 * count (one waiting count per fund), so every sample starts from here, outside the timed tap.
 */
async function confirmWaitingCount() {
  const { data, error } = await (await sessionFor("manager")).client
    .schema("api")
    .rpc("staff_imprest_counts", { p_limit: 1, p_offset: 0 });
  if (error) throw new Error(`staff_imprest_counts: ${error.message}`);
  const latest = (data as { id: string; version: number; variance_tzs: number; status: string }[] | null)?.[0];
  if (latest?.status !== "awaiting_confirmation") return;
  await command("manager", "staff_confirm_imprest_count", {
    p_id: latest.id,
    p_expected_version: latest.version,
    p_explanation: latest.variance_tzs === 0 ? null : "counting_error",
    p_note: null,
  });
}

function report(label: string, ack: number[], done: number[]) {
  const a = summary(ack);
  const d = summary(done);
  console.log(`${label} ack  n=${a.n} p50=${a.p50}ms p95=${a.p95}ms worst=${a.worst}ms`);
  console.log(`${label} done n=${d.n} p50=${d.p50}ms p95=${d.p95}ms worst=${d.worst}ms`);
  expect(a.worst, `${label} acknowledgement`).toBeLessThanOrEqual(100);
  expect(d.p95, `${label} completion p95`).toBeLessThanOrEqual(2500);
}

(BENCHMARK ? test.describe : test.describe.skip)("imprest daily count mobile benchmark", () => {
  test.setTimeout(60 * 60_000);

  test("Enter count and Confirm: acknowledgement and server-confirmed completion over 4G", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the mobile profile only");
    await ensureFund(500_000);

    await as(page, "cashier");
    for (const profile of PROFILES) {
      const ack: number[] = [];
      const done: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        await confirmWaitingCount();
        endDay();
        await page.goto("/imprest");
        await page.getByTestId("count-today").getByLabel("Cash in the tin").fill(String(100_000 + i));
        const sample = await measureTap(page, profile, "[data-testid=submit-count]", "Count entered.");
        ack.push(sample.ack);
        done.push(sample.done);
      }
      report(`${profile.name} enter count`, ack, done);
    }

    await as(page, "manager");
    for (const profile of PROFILES) {
      const ack: number[] = [];
      const done: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        await confirmWaitingCount();
        endDay();
        await enteredByCommand((await expectedCash()) - 100);
        await page.goto("/imprest");
        await page.getByTestId("confirm-count-form").getByText("Counting error", { exact: true }).click();
        const sample = await measureTap(page, profile, "[data-testid=confirm-count]", "Count confirmed.");
        ack.push(sample.ack);
        done.push(sample.done);
      }
      report(`${profile.name} confirm count`, ack, done);
    }
  });
});
