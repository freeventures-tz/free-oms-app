import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";

import { expectLandsOn, fixtures, openNavigation, signIn } from "./fixtures";

/**
 * Imprest disbursements through the screens (issue #55), on every device tier.
 *
 * The rules themselves are proved in pgTAP and over real HTTP. This spec proves the Cashier and the
 * Manager can carry a disbursement through the screens: propose, approve, a refused over-limit
 * approval, reject, withdraw and cancel; that the Cashier sees Free to approve alone; that a
 * Director reads without controls; and that a failed read is a page failure, not an empty list.
 *
 * Every figure is read as a delta, because the three tiers run one after another on one database.
 */

type Who = "director" | "manager" | "cashier";
type Row = { id: string; version: number };
type Position = { posted_funding_tzs: number | null; set_aside_tzs: number | null; free_to_approve_tzs: number };

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
  }).schema("api") as unknown as SupabaseClient;
  sessions.set(who, client);
  return client;
}

async function command(who: Who, fn: string, args: Record<string, unknown>) {
  const api = await sessionFor(who);
  const { data, error } = await api.rpc(fn, { ...args, p_idempotency_key: randomUUID() });
  if (error || !data.ok) throw new Error(`${fn}: ${error?.message ?? data.reason}`);
  return data as { reason: string; funding?: Row & { handover_id: string }; disbursement?: Row };
}

async function position(): Promise<Position> {
  const { data, error } = await (await sessionFor("manager")).rpc("staff_imprest_spending_position");
  if (error) throw new Error(`position: ${error.message}`);
  return (data as Position[])[0] ?? { posted_funding_tzs: 0, set_aside_tzs: 0, free_to_approve_tzs: 0 };
}

/** Posts received funding through the real funding workflow until at least `amount` is free. */
async function ensureFree(amount: number) {
  const free = (await position()).free_to_approve_tzs;
  if (free >= amount) return;
  const top = amount - free;
  const requested = await command("manager", "staff_request_imprest_funding", {
    p_amount_tzs: top,
    p_reason: `Spending float ${SUFFIX}`,
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

async function seedProposal(amount: number, purpose: string): Promise<Row> {
  return (
    await command("cashier", "staff_propose_imprest_disbursement", {
      p_amount_tzs: amount,
      p_category: "materials_and_supplies",
      p_purpose: purpose,
    })
  ).disbursement!;
}

async function as(page: Page, who: Who) {
  await page.context().clearCookies();
  const account = fixtures()[who];
  await signIn(page, account.phone, account.password);
  await expectLandsOn(page, who === "cashier" ? "/payments" : "/dashboard");
}

const money = (text: string) => Number(text.replace(/\D/g, ""));
const figure = async (page: Page, testId: string) =>
  money(await page.getByTestId(testId).locator("dd.fv-numeric").innerText());

async function figures(page: Page) {
  await page.goto("/imprest");
  return {
    posted: await figure(page, "funding-total"),
    setAside: await figure(page, "set-aside-total"),
    free: await figure(page, "free-to-approve"),
  };
}

async function openDisbursement(page: Page, purpose: string) {
  await page.goto("/imprest");
  await page.getByRole("link", { name: new RegExp(purpose) }).first().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^FV-DSB-/);
}

async function giveReason(page: Page, toggle: string, testId: string, label: string, reason: string) {
  await page.getByRole("button", { name: toggle, exact: true }).click();
  const form = page.getByTestId(testId);
  await form.getByLabel(label).fill(reason);
  await form.locator("button[type=submit]").click();
}

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

test.describe("imprest disbursements", () => {
  test.beforeEach(async () => {
    await ensureFree(200000);
  });

  test("the Cashier proposes from Free to approve alone, and the Manager's approval sets it aside", async ({
    page,
  }, testInfo) => {
    const purpose = `Diesel ${SUFFIX} ${testInfo.project.name}`;
    await as(page, "manager");
    const before = await figures(page);

    await as(page, "cashier");
    const nav = await openNavigation(page, testInfo);
    await nav.getByRole("link", { name: "Imprest", exact: true }).click();
    await expect(page).toHaveURL(/\/imprest$/);
    // The Cashier is sent Free to approve and nothing else: no posted funding, nothing set aside,
    // and no funding list.
    await expect(page.getByTestId("free-to-approve")).toBeVisible();
    await expect(page.getByTestId("funding-total")).toHaveCount(0);
    await expect(page.getByTestId("set-aside-total")).toHaveCount(0);
    await expect(page.getByText("Funding requests")).toHaveCount(0);

    const form = page.getByTestId("propose-disbursement-form");
    await form.getByText("Fuel and lubricants").click();
    await form.getByLabel("Amount (TZS)").fill("7,000");
    await form.getByLabel("Purpose").fill(purpose);
    await form.getByRole("button", { name: "Submit for approval" }).click();
    await expect(page.getByRole("status")).toHaveText(
      "Payment proposed. Wait for the Manager's approval before paying.",
    );
    // The form starts empty for the next one, and offers this purpose again.
    await expect(form.getByLabel("Purpose")).toHaveValue("");
    await page.reload();
    await expect(page.getByTestId("recent-purposes")).toContainText(purpose);
    const mine = page.getByTestId("disbursements-mine");
    await expect(mine.getByRole("link", { name: new RegExp(purpose) })).toContainText("Awaiting Manager approval");

    // A proposal moves no money and sets nothing aside (AC-96).
    await as(page, "manager");
    expect(await figures(page)).toEqual(before);
    const waiting = page.getByTestId("disbursements-waiting");
    await expect(waiting.getByRole("heading")).toHaveText(/^Waiting for a decision \(\d+\)$/);
    await expect(waiting.getByRole("link", { name: new RegExp(purpose) })).toBeVisible();

    await openDisbursement(page, purpose);
    // There is one figure to approve, the one proposed, and no field for another.
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await page.getByTestId("approve-disbursement").click();
    await expect(page.getByRole("status")).toHaveText(
      "Approved. The amount is set aside and can't be approved again.",
    );

    const after = await figures(page);
    expect(after).toEqual({ posted: before.posted, setAside: before.setAside + 7000, free: before.free - 7000 });
    const open = page.getByTestId("disbursements-open").getByRole("link", { name: new RegExp(purpose) });
    await expect(open).toContainText("Approved, not yet paid");
    await expect(open.getByTestId("open-for")).toHaveText(/^Open for /);
  });

  test("an approval above Free to approve is refused and changes nothing, then the Manager rejects it", async ({
    page,
  }, testInfo) => {
    const purpose = `Roof sheets ${SUFFIX} ${testInfo.project.name}`;
    const free = (await position()).free_to_approve_tzs;
    await seedProposal(free + 1000, purpose);

    await as(page, "manager");
    const before = await figures(page);
    await openDisbursement(page, purpose);
    await page.getByTestId("approve-disbursement").click();
    // Next's route announcer also carries role="alert", so match the refusal by its text.
    await expect(page.getByRole("alert").filter({ hasText: "free to approve" })).toContainText(
      `Only TZS ${free.toLocaleString("en-US")} is free to approve, less than the TZS ${(free + 1000).toLocaleString("en-US")} proposed. Nothing was changed.`,
    );
    expect(await figures(page)).toEqual(before);

    await openDisbursement(page, purpose);
    await giveReason(page, "Reject", "reject-form", "Reason for rejecting", "Too much for one payment");
    await expect(page.getByRole("status")).toHaveText("Proposal rejected.");
    await page.reload();
    const history = page.getByTestId("disbursement-history");
    await expect(history).toContainText("Rejected");
    await expect(history).toContainText("Too much for one payment");
    // A rejected disbursement names who decided it, and no approver (§4.3).
    await expect(history).not.toContainText("Approved");
    expect(await figures(page)).toEqual(before);

    // The Cashier may not read the Manager's profile, so their history names the role instead.
    await as(page, "cashier");
    await openDisbursement(page, purpose);
    await expect(page.getByTestId("disbursement-history").getByRole("listitem").last()).toContainText(
      /Rejected\s*Manager · /,
    );
    // Nothing is left for the Cashier to do, so there is no empty actions card.
    await expect(page.getByTestId("disbursement-actions")).toBeHidden();
  });

  test("the Cashier withdraws their own proposal before a decision", async ({ page }, testInfo) => {
    const purpose = `Casual loaders ${SUFFIX} ${testInfo.project.name}`;
    await seedProposal(3000, purpose);

    await as(page, "cashier");
    await openDisbursement(page, purpose);
    await expect(page.getByText("Waiting for the Manager to approve or reject it. Don't pay yet.")).toBeVisible();
    await giveReason(page, "Withdraw", "withdraw-form", "Reason for withdrawing", "Paid from another float");
    await expect(page.getByRole("status")).toHaveText("Proposal withdrawn.");
    await page.goto("/imprest");
    await expect(
      page.getByTestId("disbursements-mine").getByRole("link", { name: new RegExp(purpose) }),
    ).toContainText("Withdrawn");

    await as(page, "manager");
    await page.goto("/imprest");
    await expect(
      page.getByTestId("disbursements-waiting").getByRole("link", { name: new RegExp(purpose) }),
    ).toHaveCount(0);
  });

  test("the Manager cancels an approval, which frees the money and keeps both in the history", async ({
    page,
  }, testInfo) => {
    const purpose = `Welding ${SUFFIX} ${testInfo.project.name}`;
    const proposed = await seedProposal(9000, purpose);
    await command("manager", "staff_decide_imprest_disbursement", {
      p_id: proposed.id,
      p_expected_version: proposed.version,
      p_approve: true,
      p_reason: null,
    });

    await as(page, "manager");
    const before = await figures(page);
    await openDisbursement(page, purpose);
    await expect(page.getByTestId("open-for")).toHaveText(/^Open for /);
    await giveReason(page, "Cancel approval", "cancel-form", "Reason for cancelling", "Welder did not come");
    await expect(page.getByRole("status")).toHaveText(
      "Approval cancelled. The money set aside for it is free again.",
    );
    await page.reload();
    const history = page.getByTestId("disbursement-history");
    await expect(history).toContainText("Approved and set aside");
    await expect(history).toContainText("Approval cancelled and money freed");
    await expect(history).toContainText("Welder did not come");

    expect(await figures(page)).toEqual({
      posted: before.posted,
      setAside: before.setAside - 9000,
      free: before.free + 9000,
    });

    // A cancelled approval keeps its approval time, but it is no longer open.
    await as(page, "cashier");
    await page.goto("/imprest");
    const mine = page.getByTestId("disbursements-mine").getByRole("link", { name: new RegExp(purpose) });
    await expect(mine).toContainText("Cancelled");
    await expect(mine.getByTestId("open-for")).toHaveCount(0);
  });

  test("a Director reads the figures and the lists, and is offered no control", async ({ page }, testInfo) => {
    const purpose = `Director view ${SUFFIX} ${testInfo.project.name}`;
    await seedProposal(2000, purpose);

    await as(page, "director");
    await page.goto("/imprest");
    await expect(page.getByTestId("funding-total")).toBeVisible();
    await expect(page.getByTestId("set-aside-total")).toContainText("Approved but not yet paid.");
    await expect(page.getByTestId("free-to-approve")).toContainText("An approval above this is refused.");
    await openDisbursement(page, purpose);
    await expect(page.getByTestId("read-only")).toBeVisible();
    await expect(page.getByTestId("approve-disbursement")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reject", exact: true })).toHaveCount(0);
  });

  test("a failed read is a page failure, never an empty list or a zero", async ({ page }, testInfo) => {
    const purpose = `Read ${SUFFIX} ${testInfo.project.name}`;
    await seedProposal(1000, purpose);
    await as(page, "cashier");

    // One Playwright worker runs the whole suite, so this grant is taken away from nobody else.
    try {
      psql("revoke select on public.imprest_disbursements from authenticated;");
      await page.goto("/imprest");
      await expect(page.getByText(/this page could not be loaded/i)).toBeVisible();
      await expect(page.getByText("You haven't proposed any payments yet.")).toHaveCount(0);
      await expect(page.getByTestId("free-to-approve")).toHaveCount(0);
    } finally {
      psql("grant select on public.imprest_disbursements to authenticated;");
    }

    await page.goto("/imprest");
    await expect(page.getByTestId("disbursements-mine").getByRole("link", { name: new RegExp(purpose) })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------------------------
// Mobile benchmark, opt-in, the same method as the funding benchmark in imprest-funding.spec.ts:
//
//     FV_BENCHMARK=1 npx playwright test --project=mobile e2e/imprest-disbursements.spec.ts -g benchmark
//
// Two representative commands: the Cashier proposing, and the Manager approving. A real touch starts
// the clock inside the page. Acknowledgement is the first animation frame after the touched control
// reports `aria-busy`; completion is the server-confirmed success status. Seeding is unthrottled.
// ---------------------------------------------------------------------------------------------

const BENCHMARK = process.env.FV_BENCHMARK === "1";
const SAMPLES = 20;
const PROFILES = [
  { name: "Slow 4G", down: (1.6 * 1024 * 1024) / 8, up: (750 * 1024) / 8, latency: 562.5, cpu: 4 },
  { name: "Fast 4G", down: (9 * 1024 * 1024) / 8, up: (1.5 * 1024 * 1024) / 8, latency: 85, cpu: 4 },
] as const;

function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
  return { n: sorted.length, p50: Math.round(rank(0.5)), p95: Math.round(rank(0.95)), worst: Math.round(sorted.at(-1)!) };
}

/** Throttles, taps `control`, and returns the acknowledgement and completion times in ms. */
async function measureTap(page: Page, profile: (typeof PROFILES)[number], control: string, done: string) {
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
        if (document.querySelector("[role=status]")?.textContent?.includes(doneText)) {
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

(BENCHMARK ? test.describe : test.describe.skip)("imprest disbursements mobile benchmark", () => {
  test.setTimeout(30 * 60_000);

  test("Propose and Approve: acknowledgement and server-confirmed completion over 4G", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the mobile profile only");
    await ensureFree(SAMPLES * PROFILES.length * 1000 + 1000);

    await as(page, "cashier");
    for (const profile of PROFILES) {
      const ack: number[] = [];
      const done: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        await page.goto("/imprest");
        const form = page.getByTestId("propose-disbursement-form");
        await form.getByText("Fuel and lubricants").click();
        await form.getByLabel("Amount (TZS)").fill("1000");
        await form.getByLabel("Purpose").fill(`Bench ${SUFFIX} ${profile.name} ${i}`);
        const sample = await measureTap(
          page,
          profile,
          "[data-testid=propose-disbursement-form] button[type=submit]",
          "Payment proposed.",
        );
        ack.push(sample.ack);
        done.push(sample.done);
      }
      report(`${profile.name} propose`, ack, done);
    }

    await as(page, "manager");
    for (const profile of PROFILES) {
      const ack: number[] = [];
      const done: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const row = await seedProposal(1000, `Bench approve ${SUFFIX} ${profile.name} ${i}`);
        await page.goto(`/imprest/disbursements/${row.id}`);
        const sample = await measureTap(page, profile, "[data-testid=approve-disbursement]", "Approved.");
        ack.push(sample.ack);
        done.push(sample.done);
      }
      report(`${profile.name} approve`, ack, done);
    }
  });
});
