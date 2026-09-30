import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";
import { businessDate } from "@/lib/time/business-date";

import { expectLandsOn, fixtures, signIn } from "./fixtures";

/**
 * Retirement through the screens (issue #72), on every device tier.
 *
 * The rules are proved in pgTAP and over real HTTP in the integration suite. This spec proves the
 * Manager sees what is unresolved first and submits the fund's retirement with a reason; that a
 * Director approves it after a second step that says it cannot be undone; that the carried balance
 * then shows on the imprest screen and today's count is not asked for again; that the retired fund's
 * record reads whole and read-only, with its deficit and Not counted days; that blockers are named
 * with a link and leave the Manager no submit; that a rejection keeps its reason; and that a failed
 * read is said so.
 *
 * A retirement needs a fund with nothing open and today counted after the last posting, and the specs
 * share one database. So each test starts on a fund of its own, opened below the triggers as the
 * local stack's superuser, and the spec leaves a plain fund behind for the specs after it.
 */

type Who = "director" | "manager" | "cashier";
type Row = { id: string; version: number };

const SUFFIX = Math.random().toString(36).slice(2, 8).toUpperCase();
const sessions = new Map<Who, { client: SupabaseClient; token: string; userId: string }>();
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
  const session = { client, token: String(body.access_token), userId: String(body.user.id) };
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
    disbursement?: Row & { disbursement_no: string };
    count?: Row;
    retirement?: Row;
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

/** Closes whatever fund is active and opens an empty one, below the triggers. */
async function freshFund(): Promise<void> {
  const manager = await sessionFor("manager");
  superSql(`
    set session_replication_role = replica;
    update public.imprest_funds set is_active = false, retired_at = now() where is_active;
    insert into public.imprest_funds (opened_by) values ('${manager.userId}');
  `);
}

async function postFunding(amount: number) {
  const requested = await command("manager", "staff_request_imprest_funding", {
    p_amount_tzs: amount,
    p_reason: `Retirement float ${SUFFIX}`,
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

/** 10,000 handed out, settled as Used 8,000 and Returned 1,500, verified: a loss of 500 waits. */
async function verifiedWithLoss(purpose: string): Promise<Row & { disbursement_no: string }> {
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
    p_lines: [{ amount_tzs: 8000, purpose: "Fare", receipt_id: null, no_receipt_reason: "transport_fare", no_receipt_note: null }],
    p_returned_tzs: 1500,
    p_explanation: "Change lost on the road",
  });
  const client = (await sessionFor("manager")).client;
  const { data: s } = await client.from("imprest_settlements").select("id").eq("disbursement_id", out.disbursement!.id).single();
  await command("manager", "staff_verify_imprest_disbursement", {
    p_id: out.disbursement!.id,
    p_expected_version: settled.disbursement!.version,
    p_settlement_id: String(s!.id),
  });
  return proposed.disbursement!;
}

/** Today's count of `counted`, confirmed. A shortage takes a counting error as its reason. */
async function confirmedCount(counted: number, short: boolean): Promise<string> {
  const entered = await command("cashier", "staff_enter_imprest_count", {
    p_business_date: businessDate(),
    p_previous_count_id: null,
    p_counted_tzs: counted,
    p_note: null,
    p_late_reason: null,
  });
  await command("manager", "staff_confirm_imprest_count", {
    p_id: entered.count!.id,
    p_expected_version: entered.count!.version,
    p_explanation: short ? "counting_error" : null,
    p_note: null,
  });
  return entered.count!.id;
}

async function as(page: Page, who: Who) {
  await page.context().clearCookies();
  const account = fixtures()[who];
  await signIn(page, account.phone, account.password);
  await expectLandsOn(page, who === "cashier" ? "/payments" : "/dashboard");
}

test.describe("imprest retirement", () => {
  // The next specs expect a fund they can count today; leave them a plain one.
  test.afterAll(freshFund);

  test("submitted by the Manager, approved by a Director, and its balance carried", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await freshFund();
    await postFunding(60000);
    const trip = await verifiedWithLoss(`Retire trip ${SUFFIX} ${testInfo.project.name}`);
    // 60,000 received, 8,000 spent and 500 lost: 51,500 expected, and 1,000 short when counted.
    await confirmedCount(50500, true);

    // The Manager: what is unresolved comes first, then the submit.
    await as(page, "manager");
    await page.goto("/imprest");
    const section = page.getByTestId("retirement");
    const unresolved = section.getByTestId("retirement-unresolved");
    await expect(unresolved).toContainText("Retirement does not resolve these.");
    await expect(unresolved.getByTestId("retirement-unresolved-deficit")).toHaveText(`Deficit: ${tzs(1500)}`);
    await expect(unresolved.getByTestId("retirement-unresolved-losses")).toContainText(trip.disbursement_no);
    await expect(section.getByTestId("retirement-count")).toContainText(tzs(50500));
    const form = section.getByTestId("submit-retirement-form");
    await form.getByRole("button", { name: "Submit retirement" }).click();
    await expect(form.getByText("Give a reason of 3 to 500 characters.")).toBeVisible();
    await form.getByLabel("Why the fund is being retired").fill("Month end");
    await form.getByRole("button", { name: "Submit retirement" }).click();
    await expect(section.getByRole("status")).toContainText("Retirement submitted.");
    // The screen refreshes into the waiting state, and the confirmation stays beside it.
    await expect(page.getByTestId("retirement-status")).toHaveText("Waiting for a Director");
    await expect(section.getByRole("status")).toContainText("Retirement submitted.");
    await page.reload();
    await expect(page.getByTestId("retirement-status")).toHaveText("Waiting for a Director");
    await expect(page.getByTestId("retirement-closing")).toContainText(tzs(50500));
    await expect(page.getByTestId("approve-retirement")).toHaveCount(0);

    // A Director: approve, then say yes once more.
    await as(page, "director");
    await page.goto("/imprest");
    await expect(page.getByTestId("retirement-reason")).toContainText("Month end");
    await page.getByTestId("approve-retirement").click();
    await expect(page.getByTestId("confirm-retirement-form")).toContainText("It can't be undone.");
    await page.getByTestId("confirm-retirement").click();
    await expect(page.getByTestId("retirement").getByRole("status")).toContainText("The fund is retired.");
    // The screen refreshes into the next fund, and the confirmation stays.
    await expect(page.getByTestId("carried-balance")).toBeVisible();
    await expect(page.getByTestId("retirement").getByRole("status")).toContainText("The fund is retired.");

    // The next fund carries the balance, and today is not due again.
    await page.reload();
    await expect(page.getByTestId("carried-balance")).toContainText(tzs(50500));
    await expect(page.getByTestId("funding-total")).toContainText(tzs(50500));
    await expect(page.getByTestId("count-not-yet")).toContainText("Counting starts again on");
    await as(page, "cashier");
    await page.goto("/imprest");
    await expect(page.getByTestId("carried-balance")).toHaveCount(0);
    await expect(page.getByTestId("count-not-yet")).toBeVisible();
    await expect(page.getByTestId("free-to-approve")).toContainText(tzs(50500));

    // The retired fund's record, read-only, the unresolved first.
    await as(page, "director");
    await page.goto("/imprest?retired=1");
    const retired = page.getByTestId("retired-funds").getByRole("link").first();
    await expect(retired).toContainText(`Closing balance ${tzs(50500)}`);
    await expect(retired).toContainText(`Deficit ${tzs(1500)}`);
    await retired.click();
    await expect(page.getByTestId("fund-status")).toHaveText("Retired");
    await expect(page.getByTestId("fund-unresolved-deficit")).toHaveText(`Deficit: ${tzs(1500)}`);
    await expect(page.getByTestId("fund-figure-closing")).toContainText(tzs(50500));
    await expect(page.getByTestId("fund-carried-into")).toContainText(tzs(50500));
    await expect(page.getByTestId("fund-retirement-approved")).toContainText("Month end");
    await expect(page.getByTestId("fund-postings")).toContainText(trip.disbursement_no);
    await expect(page.locator("main form")).toHaveCount(0);
    await expect(page.locator("main button")).toHaveCount(0);

    // A payment of the retired fund can no longer be corrected, and its page says why.
    await as(page, "manager");
    await page.goto(`/imprest/disbursements/${trip.id}`);
    await expect(page.getByTestId("reversal-fund-retired")).toContainText("retired");
    await expect(page.getByTestId("request-reversal-toggle")).toHaveCount(0);
  });

  test("blockers are named with a link and leave no submit; a rejection keeps its reason", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await freshFund();
    await postFunding(20000);
    const open = await command("cashier", "staff_propose_imprest_disbursement", {
      p_amount_tzs: 1000,
      p_category: "other",
      p_purpose: `Retire padlock ${SUFFIX} ${testInfo.project.name}`,
    });

    await as(page, "manager");
    await page.goto("/imprest");
    const blockers = page.getByTestId("retirement-blockers");
    await expect(blockers).toContainText("Still open (1)");
    await expect(blockers.getByRole("link", { name: open.disbursement!.disbursement_no })).toHaveAttribute(
      "href",
      `/imprest/disbursements/${open.disbursement!.id}`,
    );
    await expect(page.getByTestId("submit-retirement-form")).toHaveCount(0);

    await command("cashier", "staff_withdraw_imprest_disbursement", {
      p_id: open.disbursement!.id,
      p_expected_version: 1,
      p_reason: "Not needed",
    });
    const countId = await confirmedCount(20000, false);
    await command("manager", "staff_submit_imprest_retirement", { p_count_id: countId, p_reason: "Month end" });

    await as(page, "director");
    await page.goto("/imprest");
    await page.getByTestId("reject-retirement-toggle").click();
    const reject = page.getByTestId("reject-retirement-form");
    await reject.getByRole("button", { name: "Reject retirement" }).click();
    await expect(reject.getByText("Give a reason of 3 to 500 characters.")).toBeVisible();
    await reject.getByLabel("Why you are rejecting it").fill("Count again with me there");
    await reject.getByRole("button", { name: "Reject retirement" }).click();
    await expect(page.getByTestId("retirement").getByRole("status")).toContainText("Retirement rejected.");

    await as(page, "manager");
    await page.goto("/imprest");
    await expect(page.getByTestId("retirement-rejected")).toContainText("Count again with me there");
    // The day's count still closes the fund, so the Manager may submit again.
    await expect(page.getByTestId("submit-retirement-form")).toBeVisible();
  });

  test("a failed read is a page failure, never a fund with nothing unresolved", async ({ page }) => {
    await as(page, "manager");
    // One Playwright worker runs the whole suite, so this grant is taken away from nobody else.
    try {
      superSql("revoke execute on function api.staff_imprest_fund_state() from authenticated;");
      await page.goto("/imprest");
      await expect(page.getByText(/this page could not be loaded/i)).toBeVisible();
      await expect(page.getByTestId("retirement")).toHaveCount(0);
    } finally {
      superSql("grant execute on function api.staff_imprest_fund_state() to authenticated;");
    }
    await page.goto("/imprest");
    await expect(page.getByTestId("retirement")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------------------------
// Mobile benchmark, opt-in, the method of the reversal and raised-approval benchmarks:
//
//     FV_BENCHMARK=1 npx playwright test --project=mobile e2e/imprest-retirement.spec.ts -g benchmark
//
// Submitting a retirement and approving it: a real touch starts the clock inside the page,
// acknowledgement is the first animation frame after the touched control reports `aria-busy`, and
// completion is the server's confirmation appearing. Each sample retires a fund of its own.
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

(BENCHMARK ? test.describe : test.describe.skip)("imprest retirement mobile benchmark", () => {
  test.setTimeout(60 * 60_000);
  test.afterAll(freshFund);

  test("Submit a retirement and Approve it: acknowledgement and server-confirmed completion over 4G", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the mobile profile only");

    // Submit: the Manager's form on the imprest screen, a fund of its own per sample.
    await as(page, "manager");
    for (const profile of PROFILES) {
      const ack: number[] = [];
      const done: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        await freshFund();
        await postFunding(10000);
        await confirmedCount(10000, false);
        await page.goto("/imprest");
        await page.getByTestId("submit-retirement-form").getByLabel("Why the fund is being retired").fill("Month end");
        const sample = await measureTap(
          page,
          profile,
          "[data-testid=submit-retirement-form] button[type=submit]",
          "Retirement submitted.",
        );
        ack.push(sample.ack);
        done.push(sample.done);
      }
      report(`${profile.name} submit a retirement`, ack, done);
    }

    // Approve: a Director's confirming tap, a submitted fund of its own per sample.
    await as(page, "director");
    for (const profile of PROFILES) {
      const ack: number[] = [];
      const done: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        await freshFund();
        await postFunding(10000);
        const countId = await confirmedCount(10000, false);
        await command("manager", "staff_submit_imprest_retirement", { p_count_id: countId, p_reason: "Month end" });
        await page.goto("/imprest");
        await page.getByTestId("approve-retirement").click();
        const sample = await measureTap(page, profile, "[data-testid=confirm-retirement]", "The fund is retired.");
        ack.push(sample.ack);
        done.push(sample.done);
      }
      report(`${profile.name} approve a retirement`, ack, done);
    }
  });
});
