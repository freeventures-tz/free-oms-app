import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";
import { businessDate } from "@/lib/time/business-date";

import { expectLandsOn, fixtures, signIn } from "./fixtures";

/**
 * Days nobody counted (issue #69), through the screens, on every device tier.
 *
 * The rules are proved in pgTAP and over real HTTP in the integration suite. This spec proves that
 * the Manager's dashboard raises the missed days, oldest first, with how long each has waited; that
 * the Cashier counts one late from the imprest screen with a required reason; that the Manager
 * confirms it the way any count is confirmed, after which the day leaves the open list and its
 * alert stays in the history; that a Director reads all of it with no control; that many missed
 * days are paged rather than hidden; and that a failed read is said so, never shown as no alerts.
 *
 * Each test opens fresh missed days: every earlier count moves thirty days into the past, and the
 * day counting started moves to three days ago, on the local stack only, as the database's
 * superuser with the count tables' triggers suspended for that one statement.
 */

type Who = "director" | "manager" | "cashier";
type Count = { id: string; version: number; variance_tzs: number; status: string };

const sessions = new Map<Who, { client: SupabaseClient; token: string }>();
const URL_ = () => process.env.NEXT_PUBLIC_SUPABASE_URL!;
const KEY_ = () => process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

/** `YYYY-MM-DD`, `n` days before today's business date. */
function daysBefore(n: number): string {
  const d = new Date(`${businessDate()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

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

type Position = { posted_balance_tzs: number; awaiting_verification_tzs: number };
async function position(): Promise<Position | undefined> {
  const { data, error } = await (await sessionFor("manager")).client.schema("api").rpc("staff_imprest_spending_position");
  if (error) throw new Error(`position: ${error.message}`);
  return (data as Position[])[0];
}

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

function startCountingOn(day: string) {
  superSql(`
    create or replace function private.imprest_counting_starts_on() returns date
    language sql immutable set search_path = '' as $b$ select '${day}'::date $b$;
  `);
}

/**
 * Fresh missed days: an earlier test's waiting count is confirmed, every count moves thirty days
 * into the past (in two steps, so no row lands on a day another has not left), and counting starts
 * `missed` days ago, so each of those days is Not counted and today is due.
 */
async function openMissedDays(missed: number) {
  const { data } = await (await sessionFor("manager")).client
    .schema("api")
    .rpc("staff_imprest_counts", { p_limit: 1, p_offset: 0 });
  const latest = (data as Count[] | null)?.[0];
  if (latest?.status === "awaiting_confirmation") {
    await command("manager", "staff_confirm_imprest_count", {
      p_id: latest.id,
      p_expected_version: latest.version,
      p_explanation: latest.variance_tzs === 0 ? null : "counting_error",
      p_note: null,
    });
  }
  superSql(`
    set session_replication_role = replica;
    update public.imprest_counts set business_date = business_date - 100000;
    update public.imprest_counts set business_date = business_date + 99970;
    update public.imprest_count_flags set business_date = business_date - 30;
    update public.imprest_funds set opened_at = least(opened_at, now() - interval '400 days') where is_active;
  `);
  startCountingOn(daysBefore(missed));
}

async function as(page: Page, who: Who) {
  await page.context().clearCookies();
  const account = fixtures()[who];
  await signIn(page, account.phone, account.password);
  await expectLandsOn(page, who === "cashier" ? "/payments" : "/dashboard");
}

test.describe("imprest days nobody counted", () => {
  test.beforeEach(async () => {
    await ensureFund(500_000);
    await openMissedDays(3);
  });

  test.afterAll(() => {
    startCountingOn(businessDate());
  });

  test("the Manager is alerted, the Cashier counts a missed day late, and the alert moves to the history", async ({
    page,
  }, testInfo) => {
    const shot = (name: string) =>
      page.screenshot({ path: testInfo.outputPath(`${name}-${testInfo.project.name}.png`), fullPage: true });
    const [oldest, middle, newest] = [daysBefore(3), daysBefore(2), daysBefore(1)];

    // The Manager's dashboard raises the three days, oldest first, with how long each has waited.
    await as(page, "manager");
    const alerts = page.getByTestId("count-alerts");
    await expect(alerts).toBeVisible();
    await expect(alerts.getByRole("heading")).toContainText("3 imprest days have no confirmed count");
    await expect(alerts.locator("li")).toHaveCount(3);
    await expect(alerts.locator("li").first()).toHaveAttribute("data-testid", `count-alert-${oldest}`);
    await expect(alerts.getByTestId(`count-alert-${oldest}`)).toContainText("Not counted");
    await expect(alerts.getByTestId(`count-alert-${oldest}`)).toContainText(/Waiting \d+ (hour|day)s?/);
    await shot("missed-1-manager-dashboard");

    // The Cashier sees today due, not Not counted, and the three missed days to count late.
    await as(page, "cashier");
    await page.goto("/imprest");
    await expect(page.getByTestId("count-today").getByTestId("count-state-due")).toBeVisible();
    const open = page.getByTestId("count-open-days");
    await expect(open.getByRole("heading", { name: "3 days not closed" })).toBeVisible();
    for (const day of [oldest, middle, newest]) {
      await expect(open.getByTestId(`open-day-${day}`).getByTestId("count-state-not_counted")).toBeVisible();
    }
    await shot("missed-2-cashier-open-days");

    // A reason is required, and nothing typed is lost when it is missing.
    const row = open.getByTestId(`open-day-${oldest}`);
    await row.getByTestId(`open-late-count-${oldest}`).click();
    const form = row.getByTestId("late-count-form");
    const expected = await expectedCash();
    await form.getByLabel("Cash in the tin").fill(String(expected));
    await form.getByRole("button", { name: "Enter late count" }).click();
    await expect(form.getByText("Say why this day wasn't counted, in 3 to 500 characters.")).toBeVisible();
    await expect(form.getByLabel("Cash in the tin")).toHaveValue(String(expected));
    await form.getByLabel("Why this day wasn't counted").fill("Cashier was off sick");
    await shot("missed-3-cashier-late-count");
    await form.getByRole("button", { name: "Enter late count" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Late count entered." })).toBeVisible();
    await expect(row.getByTestId("count-state-awaiting_confirmation")).toBeVisible();
    // The fund holds one waiting count, so the other missed days wait for it.
    await expect(open.getByTestId(`open-late-count-${middle}`)).toHaveCount(0);
    await expect(open.getByTestId(`open-day-${middle}`)).toContainText("A count is waiting for the Manager");

    // The Manager confirms it from the imprest screen, as any count.
    await as(page, "manager");
    await page.goto("/imprest");
    const earlier = page.getByTestId("count-today").getByTestId("count-earlier");
    await expect(earlier).toBeVisible();
    await expect(earlier.getByTestId("count-late")).toContainText("Counted late: Cashier was off sick");
    await page.getByTestId("count-today").getByRole("button", { name: "Confirm balanced" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Count confirmed." })).toBeVisible();
    await expect(page.getByTestId(`open-day-${oldest}`)).toHaveCount(0);
    await expect(page.getByTestId("count-open-days").getByRole("heading", { name: "2 days not closed" })).toBeVisible();
    const history = page.getByTestId("count-alert-history");
    await expect(history.getByTestId(`alert-history-not_counted-${oldest}`)).toContainText(
      "when a late count was confirmed",
    );
    await expect(history.getByTestId(`alert-history-awaiting_confirmation-${oldest}-1`)).toContainText(
      "when the Manager confirmed it",
    );
    await shot("missed-4-manager-confirmed");

    await page.goto("/dashboard");
    await expect(page.getByTestId("count-alerts").locator("li")).toHaveCount(2);
    await expect(page.getByTestId(`count-alert-${oldest}`)).toHaveCount(0);
  });

  test("a Director reads the alerts, the open days and the history, with no control", async ({ page }, testInfo) => {
    await as(page, "director");
    await expect(page.getByTestId("count-alerts")).toContainText("3 imprest days have no confirmed count");
    await page.goto("/imprest");
    const open = page.getByTestId("count-open-days");
    await expect(open.getByTestId(`open-day-${daysBefore(3)}`)).toBeVisible();
    await expect(open.getByRole("button")).toHaveCount(0);
    await expect(page.getByTestId("late-count-form")).toHaveCount(0);
    await expect(page.getByTestId("count-alert-history")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`missed-5-director-${testInfo.project.name}.png`), fullPage: true });
  });

  test("many missed days are paged and counted, never hidden", async ({ page }) => {
    startCountingOn(daysBefore(25));
    await as(page, "manager");
    const alerts = page.getByTestId("count-alerts");
    await expect(alerts.getByRole("heading")).toContainText("25 imprest days have no confirmed count");
    await expect(alerts.getByRole("link", { name: "See all 25 on the imprest screen" })).toBeVisible();

    await page.goto("/imprest");
    await expect(page.getByTestId("pager-count-missed")).toHaveText("Showing 1–10 of 25");
    await page.getByTestId("pager-next-missed").click();
    await expect(page.getByTestId("pager-count-missed")).toHaveText("Showing 11–20 of 25");
    await expect(page.getByTestId(`open-day-${daysBefore(15)}`)).toBeVisible();
  });

  test("a failed read is a page failure, never an empty alert list", async ({ page }) => {
    await as(page, "manager");
    try {
      superSql("revoke execute on function api.staff_imprest_open_count_days(integer, integer) from authenticated;");
      await page.goto("/dashboard");
      await expect(page.getByText(/this page could not be loaded/i)).toBeVisible();
      await expect(page.getByTestId("count-alerts")).toHaveCount(0);
    } finally {
      superSql("grant execute on function api.staff_imprest_open_count_days(integer, integer) to authenticated;");
    }
    await page.goto("/dashboard");
    await expect(page.getByTestId("count-alerts")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------------------------
// Mobile benchmark, opt-in, the method of the daily count benchmark:
//
//     FV_BENCHMARK=1 npx playwright test --project=mobile e2e/imprest-not-counted.spec.ts -g benchmark
//
// Enter a late count: a real touch starts the clock inside the page, acknowledgement is the first
// animation frame after the touched control reports `aria-busy`, and completion is the server's
// confirmation appearing. The open days read is timed from the page, over the same emulated 4G,
// against 25 open days.
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

async function throttled<T>(page: Page, profile: Profile, run: () => Promise<T>): Promise<T> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    downloadThroughput: profile.down,
    uploadThroughput: profile.up,
    latency: profile.latency,
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
  try {
    return await run();
  } finally {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.detach();
  }
}

async function measureTap(page: Page, profile: Profile, control: string, done: string) {
  return throttled(page, profile, async () => {
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
  });
}

/** One open days read from the page, over the emulated network, with the viewer's own token. */
async function measureRead(page: Page, profile: Profile, token: string) {
  return throttled(page, profile, () =>
    page.evaluate(
      async ({ url, key, bearer }) => {
        const t0 = performance.now();
        const response = await fetch(`${url}/rest/v1/rpc/staff_imprest_open_count_days`, {
          method: "POST",
          headers: {
            apikey: key,
            Authorization: `Bearer ${bearer}`,
            "Content-Type": "application/json",
            "Content-Profile": "api",
          },
          body: JSON.stringify({ p_limit: 10, p_offset: 0 }),
        });
        const rows = (await response.json()) as { total: number }[];
        if (!response.ok || rows.length !== 10 || Number(rows[0].total) !== 25) throw new Error("bad read");
        return performance.now() - t0;
      },
      { url: URL_(), key: KEY_(), bearer: token },
    ),
  );
}

function report(label: string, ack: number[] | null, done: number[]) {
  const d = summary(done);
  if (ack) {
    const a = summary(ack);
    console.log(`${label} ack  n=${a.n} p50=${a.p50}ms p95=${a.p95}ms worst=${a.worst}ms`);
    expect(a.worst, `${label} acknowledgement`).toBeLessThanOrEqual(100);
  }
  console.log(`${label} done n=${d.n} p50=${d.p50}ms p95=${d.p95}ms worst=${d.worst}ms`);
  expect(d.p95, `${label} completion p95`).toBeLessThanOrEqual(2500);
}

(BENCHMARK ? test.describe : test.describe.skip)("imprest days nobody counted mobile benchmark", () => {
  test.setTimeout(60 * 60_000);

  test("Enter late count and the open days read: acknowledgement and completion over 4G", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the mobile profile only");
    await ensureFund(500_000);

    await as(page, "cashier");
    for (const profile of PROFILES) {
      const ack: number[] = [];
      const done: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        await openMissedDays(3);
        await page.goto("/imprest");
        const row = page.getByTestId(`open-day-${daysBefore(3)}`);
        await row.getByTestId(`open-late-count-${daysBefore(3)}`).click();
        await row.getByLabel("Why this day wasn't counted").fill("Cashier was off sick");
        await row.getByLabel("Cash in the tin").fill(String(100_000 + i));
        // The tap is measured on a settled page, as a person taps it, not mid-hydration.
        await page.waitForLoadState("networkidle");
        const sample = await measureTap(page, profile, "[data-testid=submit-late-count]", "Late count entered.");
        ack.push(sample.ack);
        done.push(sample.done);
      }
      report(`${profile.name} enter late count`, ack, done);
    }

    await openMissedDays(25);
    const { token } = await sessionFor("manager");
    await page.goto("/imprest");
    for (const profile of PROFILES) {
      const done: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) done.push(await measureRead(page, profile, token));
      report(`${profile.name} open days read (25 open)`, null, done);
    }
  });
});
