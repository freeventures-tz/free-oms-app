import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";

import { expectLandsOn, fixtures, openNavigation, signIn } from "./fixtures";

/**
 * Imprest funding through the screens (issue #48), on every device tier.
 *
 * The rules themselves are proved in pgTAP and over real HTTP. This spec proves a Manager and a
 * Director can actually carry a funding through the screens: request, approval, rejection, lower
 * provision, an approval increase, shortage and excess reporting, repeated mismatch, correction
 * and receipt, and that a failed read is a page-level failure rather than an empty history or a
 * total of zero.
 *
 * Each test seeds its own reason text, and every total is read as a delta, because the three
 * device tiers run one after another against one database.
 */

const SUFFIX = Math.random().toString(36).slice(2, 8).toUpperCase();

async function as(page: Page, who: "director" | "manager") {
  await page.context().clearCookies();
  const account = fixtures()[who];
  await signIn(page, account.phone, account.password);
  await expectLandsOn(page, "/dashboard");
}

async function postedTotal(page: Page): Promise<number> {
  await page.goto("/imprest");
  const text = await page.getByTestId("funding-total").locator(".fv-numeric").innerText();
  return Number(text.replace(/\D/g, ""));
}

async function openFunding(page: Page, reason: string) {
  await page.goto("/imprest");
  await page.getByRole("link", { name: new RegExp(reason) }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^FV-IMP-/);
}

async function submitForm(page: Page, testId: string, values: Record<string, string>) {
  const form = page.getByTestId(testId);
  for (const [label, value] of Object.entries(values)) {
    await form.getByLabel(label).fill(value);
  }
  await form.locator("button[type=submit]").click();
}

async function openAndSubmit(page: Page, toggle: RegExp, testId: string, values: Record<string, string>) {
  await page.getByRole("button", { name: toggle }).click();
  await submitForm(page, testId, values);
}

async function requestFunding(page: Page, amount: string, reason: string) {
  await page.goto("/imprest");
  await submitForm(page, "request-funding-form", {
    "Amount requested (TZS)": amount,
    "What the money is for": reason,
  });
  await expect(page.getByRole("status")).toHaveText("Funding request submitted.");
  await expect(page.getByRole("link", { name: new RegExp(reason) })).toBeVisible();
}

const figure = (page: Page, key: string) => page.getByTestId(`figure-${key}`).locator("dd");

test.describe("imprest funding", () => {
  test("a Manager and a Director reach the screen from navigation", async ({ page }, testInfo) => {
    for (const who of ["manager", "director"] as const) {
      await as(page, who);
      const nav = await openNavigation(page, testInfo);
      await nav.getByRole("link", { name: "Imprest funding" }).click();
      await expect(page).toHaveURL(/\/imprest$/);
      await expect(page.getByText("Posted imprest funding")).toBeVisible();
    }
  });

  test("request, lower approval, lower provision and receipt post only what was confirmed", async ({ page }) => {
    const reason = `Float ${SUFFIX} ${test.info().project.name}`;
    await as(page, "manager");
    const before = await postedTotal(page);
    await requestFunding(page, "100,000", reason);

    await as(page, "director");
    await openFunding(page, reason);
    await openAndSubmit(page, /^approve$/i, "approve-form", { "Amount to approve (TZS)": "80000" });
    await expect(page.getByRole("status")).toContainText("Funding approved");
    await openAndSubmit(page, /record imprest provided/i, "provide-form", {
      "Amount actually handed over (TZS)": "70000",
    });
    await expect(page.getByRole("status")).toContainText("Handover recorded");
    expect(await postedTotal(page)).toBe(before);

    await as(page, "manager");
    await openFunding(page, reason);
    await page.getByTestId("confirm-received").click();
    await expect(page.getByRole("status")).toHaveText("Cash receipt confirmed and posted.");
    await expect(figure(page, "requested")).toHaveText("TZS 100,000");
    await expect(figure(page, "approved")).toHaveText("TZS 80,000");
    await expect(figure(page, "provided")).toHaveText("TZS 70,000");
    await expect(figure(page, "received")).toHaveText("TZS 70,000");
    expect(await postedTotal(page)).toBe(before + 70000);
  });

  test("a Director rejects a request with a reason", async ({ page }) => {
    const reason = `Tea ${SUFFIX} ${test.info().project.name}`;
    await as(page, "manager");
    await requestFunding(page, "20000", reason);

    await as(page, "director");
    await openFunding(page, reason);
    await page.getByRole("button", { name: /^reject$/i }).click();
    await submitForm(page, "reject-form", { "Reason for rejecting": "" });
    await expect(page.getByText("Give a reason of at least 3 characters.")).toBeVisible();
    await submitForm(page, "reject-form", { "Reason for rejecting": "Not an operating cost" });
    await expect(page.getByRole("status")).toHaveText("Funding request rejected.");
    await expect(page.getByTestId("funding-history")).toContainText("Not an operating cost");
  });

  test("an increase comes before a larger handover, and repeated mismatches post nothing until confirmed", async ({
    page,
  }) => {
    const reason = `Diesel ${SUFFIX} ${test.info().project.name}`;
    await as(page, "manager");
    const before = await postedTotal(page);
    await requestFunding(page, "90000", reason);

    await as(page, "director");
    await openFunding(page, reason);
    await openAndSubmit(page, /^approve$/i, "approve-form", { "Amount to approve (TZS)": "80000" });
    await expect(page.getByRole("status")).toContainText("Funding approved");

    await openAndSubmit(page, /record imprest provided/i, "provide-form", {
      "Amount actually handed over (TZS)": "90000",
    });
    await expect(page.getByText(/more than the approved TZS 80,000/i)).toBeVisible();
    // The refused figure is still there for the Director to see.
    await expect(page.getByTestId("provide-form").getByLabel("Amount actually handed over (TZS)")).toHaveValue(
      "90000",
    );

    await openAndSubmit(page, /increase approval/i, "increase-form", {
      "New approved amount (TZS)": "90000",
      "Note (optional)": "Fuel price rose",
    });
    await expect(page.getByRole("status")).toHaveText("Approval increased.");
    await openAndSubmit(page, /record imprest provided/i, "provide-form", {
      "Amount actually handed over (TZS)": "90000",
    });
    await expect(page.getByRole("status")).toContainText("Handover recorded");

    // An excess.
    await as(page, "manager");
    await openFunding(page, reason);
    await openAndSubmit(page, /report mismatch/i, "mismatch-form", { "Amount you counted (TZS)": "95000" });
    await expect(page.getByRole("status")).toHaveText("Mismatch reported. Nothing was posted.");
    await expect(page.getByTestId("dispute-summary")).toContainText("TZS 95,000");

    await as(page, "director");
    await openFunding(page, reason);
    await openAndSubmit(page, /record corrected handover/i, "correct-form", {
      "Corrected amount handed over (TZS)": "90000",
      "Explanation of the correction": "Recounted: 90,000 was handed over",
    });
    await expect(page.getByRole("status")).toContainText("Corrected handover recorded");

    // A further mismatch: nothing arrived.
    await as(page, "manager");
    await openFunding(page, reason);
    await openAndSubmit(page, /report mismatch/i, "mismatch-form", {
      "Amount you counted (TZS)": "0",
      "Note (optional)": "The envelope never arrived",
    });
    await expect(page.getByRole("status")).toHaveText("Mismatch reported. Nothing was posted.");
    expect(await postedTotal(page)).toBe(before);

    await as(page, "director");
    await openFunding(page, reason);
    await openAndSubmit(page, /record corrected handover/i, "correct-form", {
      "Corrected amount handed over (TZS)": "85000",
      "Explanation of the correction": "Handed over in person at the gate",
    });
    await expect(page.getByRole("status")).toContainText("Corrected handover recorded");

    await as(page, "manager");
    await openFunding(page, reason);
    await expect(page.getByTestId("confirm-received")).toHaveText("Cash received: TZS 85,000");
    await page.getByTestId("confirm-received").click();
    await expect(page.getByRole("status")).toHaveText("Cash receipt confirmed and posted.");

    const history = page.getByTestId("funding-history");
    await expect(history).toContainText("Approved TZS 80,000");
    await expect(history).toContainText("Approval increased to TZS 90,000");
    await expect(history).toContainText("Excess reported: counted TZS 95,000 against TZS 90,000");
    await expect(history).toContainText("Shortage reported: counted TZS 0 against TZS 90,000");
    await expect(history).toContainText("Corrected handover TZS 85,000");
    await expect(history).toContainText("Receipt confirmed: TZS 85,000 posted");
    expect(await postedTotal(page)).toBe(before + 85000);
  });

  test("a failed read is a page failure, never an empty history or a zero total", async ({ page }) => {
    const reason = `Read ${SUFFIX} ${test.info().project.name}`;
    await as(page, "manager");
    await requestFunding(page, "15000", reason);
    await openFunding(page, reason);
    const detailUrl = page.url();

    // One Playwright worker runs the whole suite, so this grant is taken away from nobody else.
    try {
      psql("revoke select on public.imprest_funding_position from authenticated;");
      await page.goto("/imprest");
      await expect(page.getByText(/this page could not be loaded/i)).toBeVisible();
      await expect(page.getByText("Posted imprest funding")).toHaveCount(0);
    } finally {
      psql("grant select on public.imprest_funding_position to authenticated;");
    }

    try {
      psql("revoke select on public.imprest_funding_handovers from authenticated;");
      await page.goto(detailUrl);
      await expect(page.getByText(/this page could not be loaded/i)).toBeVisible();
      await expect(page.getByTestId("funding-history")).toHaveCount(0);
    } finally {
      psql("grant select on public.imprest_funding_handovers to authenticated;");
    }

    await page.goto(detailUrl);
    await expect(page.getByTestId("funding-history")).toContainText(`Requested TZS 15,000`);
  });
});

// ---------------------------------------------------------------------------------------------
// Review F1 on PR #49: the answer to a funding command is lost AFTER the server committed it.
//
// The action's POST really reaches the server and is really executed (`route.fetch`), then the
// browser is told the connection failed. The screen must not claim that nothing changed, and Try
// again must resend the same request so the database replays it rather than recording it twice.
// ---------------------------------------------------------------------------------------------

const LIST_ROUTE = /\/imprest(\?|$)/;
const detailRoute = (id: string) => new RegExp(`/imprest/${id}(\\?|$)`);

/** Lets the next POST to `pattern` reach the server and commit, then drops its answer. */
async function loseNextAnswer(page: Page, pattern: RegExp): Promise<() => boolean> {
  let lost = false;
  await page.route(pattern, async (route, request) => {
    if (request.method() !== "POST" || lost) return route.continue();
    await route.fetch();
    lost = true;
    await route.abort("connectionfailed");
  });
  return () => lost;
}

const UNCONFIRMED =
  "No answer came back, so this may or may not have been saved. Press Try again to find out: it resends the same request, which cannot be recorded twice.";

test.describe("imprest funding when an answer is lost", () => {
  test("a request that committed is reported as unconfirmed, and Try again does not create a second", async ({
    page,
  }) => {
    const reason = `Lost ${SUFFIX} ${test.info().project.name}`;
    await as(page, "manager");
    await page.goto("/imprest");
    const wasLost = await loseNextAnswer(page, LIST_ROUTE);

    await submitForm(page, "request-funding-form", {
      "Amount requested (TZS)": "12000",
      "What the money is for": reason,
    });

    await expect(page.getByText(UNCONFIRMED)).toBeVisible();
    expect(wasLost()).toBe(true);
    await expect(page.getByText(/nothing was changed/i)).toHaveCount(0);
    await expect(page.getByText("That did not work. Try again.")).toHaveCount(0);
    // What was typed is still there for the retry.
    await expect(page.getByTestId("request-funding-form").getByLabel("What the money is for")).toHaveValue(
      reason,
    );

    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("status")).toHaveText("Funding request submitted.");

    await page.unroute(LIST_ROUTE);
    await page.goto("/imprest");
    await expect(page.getByRole("link", { name: new RegExp(reason) })).toHaveCount(1);
  });

  test("a receipt that committed is reported as unconfirmed, and Try again posts it exactly once", async ({
    page,
  }) => {
    const reason = `Lost receipt ${SUFFIX} ${test.info().project.name}`;
    const id = await seedProvided(await sessionFor("manager"), await sessionFor("director"), reason);
    await as(page, "manager");
    const before = await postedTotal(page);

    await page.goto(`/imprest/${id}`);
    const wasLost = await loseNextAnswer(page, detailRoute(id));
    await page.getByTestId("confirm-received").click();

    await expect(page.getByText(UNCONFIRMED)).toBeVisible();
    expect(wasLost()).toBe(true);
    await page.unroute(detailRoute(id));

    // It DID post, read from a second tab, which is why "nothing was changed" would have been false.
    const second = await page.context().newPage();
    expect(await postedTotal(second)).toBe(before + 10000);
    await second.close();

    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("status")).toHaveText("Cash receipt confirmed and posted.");
    expect(await postedTotal(page)).toBe(before + 10000);
  });
});

// ---------------------------------------------------------------------------------------------
// Review F2 on PR #49: each loading boundary is shaped like the funding page it stands in for.
//
// The navigation is HELD, not delayed, as the production board's skeleton test learned to do:
// prefetches are let through and awaited, because the router can only show a boundary it already
// holds, and the one real navigation is parked until the skeleton has been measured. The page is
// then released and measured the same way, and the two are compared on this device tier.
// ---------------------------------------------------------------------------------------------

type Hold = { prefetched: () => boolean; holding: () => boolean; release: () => void };

async function holdNavigation(page: Page, pattern: RegExp): Promise<Hold> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let prefetched = false;
  let holding = false;
  await page.route(pattern, async (route, request) => {
    if ("next-router-prefetch" in request.headers()) {
      await route.continue();
      prefetched = true;
      return;
    }
    if (holding) return route.continue();
    holding = true;
    await released;
    await route.continue();
  });
  return { prefetched: () => prefetched, holding: () => holding, release: () => release() };
}

async function awaitPrefetch(page: Page, hold: Hold) {
  await expect
    .poll(hold.prefetched, { message: "the loading boundary was never prefetched", timeout: 15_000 })
    .toBe(true);
  // Prefetching has to have FINISHED, not merely started, or the click commits with no boundary.
  await page.waitForLoadState("networkidle");
}

async function awaitHeld(page: Page, hold: Hold) {
  await expect
    .poll(hold.holding, { message: "the navigation never reached the route handler", timeout: 15_000 })
    .toBe(true);
  const skeleton = page.getByRole("status");
  await expect(skeleton).toBeVisible();
  // Announced in words, not drawn only in grey (design.md §12.7 rule 6).
  await expect(skeleton).toContainText("Working…");
  return skeleton;
}

type Box = ReturnType<Page["getByTestId"]>;
const gridColumns = (box: Box) =>
  box.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
const flexDirection = (box: Box) => box.evaluate((el) => getComputedStyle(el).flexDirection);
const topOf = async (box: Box) => (await box.boundingBox())!.y;

/** How far the page may land from where its skeleton stood: a line of text, not a section. */
const LANDING_TOLERANCE_PX = 24;

test.describe("imprest funding while a page is still loading", () => {
  test("the list skeleton has the funding list's shape, not the production board's", async ({
    page,
  }, testInfo) => {
    const reason = `Shape ${SUFFIX} ${testInfo.project.name}`;
    await seedProvided(await sessionFor("manager"), await sessionFor("director"), reason);
    await as(page, "director");

    const hold = await holdNavigation(page, LIST_ROUTE);
    // Empties the client router cache, so every prefetch for the link happens under the handler.
    await page.reload();
    const nav = await openNavigation(page, testInfo);
    const link = nav.getByRole("link", { name: "Imprest funding" });
    await expect(link).toBeVisible();
    await awaitPrefetch(page, hold);
    await link.click({ noWaitAfter: true });

    const skeleton = await awaitHeld(page, hold);
    const total = skeleton.getByTestId("funding-total-skeleton");
    const list = skeleton.getByTestId("funding-list-skeleton");
    await expect(total).toBeVisible();
    await expect(list.locator("li")).toHaveCount(4);
    // The posted-funding card comes first, then the list, as on the page.
    expect(await topOf(total)).toBeLessThan(await topOf(list));
    // Nothing the size of the production board's materials table (`h-24`, 96px).
    const tallest = await skeleton
      .locator("[data-slot='skeleton']")
      .evaluateAll((els) => Math.max(...els.map((el) => el.getBoundingClientRect().height)));
    expect(tallest).toBeLessThan(48);
    const skeletonTotalTop = await topOf(total);
    const skeletonRowDirection = await flexDirection(list.locator("li").first());

    hold.release();
    await expect(page.getByTestId("funding-total")).toBeVisible({ timeout: 20_000 });
    await expect(skeleton).toHaveCount(0);
    await page.unroute(LIST_ROUTE);

    // The page lands where its skeleton stood, and its cards run the same way on this tier.
    expect(Math.abs((await topOf(page.getByTestId("funding-total"))) - skeletonTotalTop)).toBeLessThanOrEqual(
      LANDING_TOLERANCE_PX,
    );
    const card = page.getByRole("link", { name: new RegExp(reason) }).locator("> div");
    expect(await flexDirection(card)).toBe(skeletonRowDirection);
  });

  test("the detail skeleton has one funding's shape: figures, actions and history", async ({
    page,
  }, testInfo) => {
    const reason = `Detail shape ${SUFFIX} ${testInfo.project.name}`;
    const id = await seedProvided(await sessionFor("manager"), await sessionFor("director"), reason);
    await as(page, "director");

    const hold = await holdNavigation(page, detailRoute(id));
    await page.goto("/imprest");
    const link = page.getByRole("link", { name: new RegExp(reason) });
    await link.scrollIntoViewIfNeeded();
    await awaitPrefetch(page, hold);
    await link.click({ noWaitAfter: true });

    const skeleton = await awaitHeld(page, hold);
    const figures = skeleton.getByTestId("funding-figures-skeleton");
    await expect(figures.locator("> div")).toHaveCount(4);
    await expect(skeleton.getByTestId("funding-actions-skeleton")).toBeVisible();
    await expect(skeleton.getByTestId("funding-history-skeleton").locator("li")).toHaveCount(3);
    const skeletonColumns = await gridColumns(figures);
    expect(skeletonColumns).toBe(testInfo.project.name === "mobile" ? 2 : 4);
    const skeletonFiguresTop = await topOf(figures);

    hold.release();
    await expect(page.getByTestId("funding-figures")).toBeVisible({ timeout: 20_000 });
    await expect(skeleton).toHaveCount(0);
    await page.unroute(detailRoute(id));

    expect(await gridColumns(page.getByTestId("funding-figures"))).toBe(skeletonColumns);
    expect(
      Math.abs((await topOf(page.getByTestId("funding-figures"))) - skeletonFiguresTop),
    ).toBeLessThanOrEqual(LANDING_TOLERANCE_PX);
    await expect(page.getByTestId("funding-history")).toBeVisible();
  });
});

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

// ---------------------------------------------------------------------------------------------
// The mobile measurement, OFF BY DEFAULT like the stock benchmark:
//
//     FV_BENCHMARK=1 npx playwright test --project=mobile e2e/imprest-funding.spec.ts -g benchmark
//
// A real touch (`tap`) starts the clock inside the page. Acknowledgement is the first animation
// frame after the touched control reports `aria-busy`; completion is the server-confirmed success
// status. Seeding goes through the same commands with real sessions, unthrottled.
// ---------------------------------------------------------------------------------------------

const BENCHMARK = process.env.FV_BENCHMARK === "1";
const SAMPLES = 20;
const PROFILES = [
  { name: "Slow 4G", down: (1.6 * 1024 * 1024) / 8, up: (750 * 1024) / 8, latency: 562.5, cpu: 4 },
  { name: "Fast 4G", down: (9 * 1024 * 1024) / 8, up: (1.5 * 1024 * 1024) / 8, latency: 85, cpu: 4 },
] as const;

async function sessionFor(who: "director" | "manager"): Promise<SupabaseClient> {
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
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${body.access_token}` } },
  }).schema("api") as unknown as SupabaseClient;
}

async function seedProvided(
  manager: SupabaseClient,
  director: SupabaseClient,
  reason = `Benchmark ${SUFFIX}`,
): Promise<string> {
  const call = async (api: SupabaseClient, fn: string, args: Record<string, unknown>) => {
    const { data, error } = await api.rpc(fn, { ...args, p_idempotency_key: randomUUID() });
    if (error || !data.ok) throw new Error(`${fn}: ${error?.message ?? data.reason}`);
    return data.funding as { id: string; version: number };
  };
  const requested = await call(manager, "staff_request_imprest_funding", {
    p_amount_tzs: 10000,
    p_reason: reason,
  });
  const approved = await call(director, "admin_decide_imprest_funding", {
    p_funding_id: requested.id,
    p_expected_version: requested.version,
    p_approve: true,
    p_amount_tzs: 10000,
    p_reason: null,
  });
  await call(director, "admin_record_imprest_provided", {
    p_funding_id: approved.id,
    p_expected_version: approved.version,
    p_amount_tzs: 10000,
  });
  return requested.id;
}

function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
  return { n: sorted.length, p50: Math.round(rank(0.5)), p95: Math.round(rank(0.95)), worst: Math.round(sorted.at(-1)!) };
}

(BENCHMARK ? test.describe : test.describe.skip)("imprest funding mobile benchmark", () => {
  test.setTimeout(30 * 60_000);

  test("Cash received: acknowledgement and server-confirmed completion over 4G", async ({ page }, testInfo: TestInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the mobile profile only");
    const manager = await sessionFor("manager");
    const director = await sessionFor("director");
    await as(page, "manager");
    const cdp = await page.context().newCDPSession(page);

    for (const profile of PROFILES) {
      const ack: number[] = [];
      const done: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const id = await seedProvided(manager, director);
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          downloadThroughput: profile.down,
          uploadThroughput: profile.up,
          latency: profile.latency,
        });
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
        await page.goto(`/imprest/${id}`);
        const button = page.getByTestId("confirm-received");
        await button.waitFor();
        await button.evaluate((el) => {
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
            if (document.querySelector("[role=status]")?.textContent?.includes("confirmed")) {
              w.__fv.done = performance.now() - (w.__fv.t0 ?? performance.now());
              observer.disconnect();
            }
          }).observe(document.body, { subtree: true, childList: true, characterData: true });
        });
        await button.tap();
        await expect(page.getByRole("status")).toContainText("confirmed", { timeout: 30_000 });
        const sample = await page.evaluate(
          () => (window as unknown as { __fv: { ack?: number; done?: number } }).__fv,
        );
        ack.push(sample.ack ?? Number.POSITIVE_INFINITY);
        done.push(sample.done ?? Number.POSITIVE_INFINITY);
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0,
        });
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      }
      const a = summary(ack);
      const d = summary(done);
      console.log(`${profile.name} ack  n=${a.n} p50=${a.p50}ms p95=${a.p95}ms worst=${a.worst}ms`);
      console.log(`${profile.name} done n=${d.n} p50=${d.p50}ms p95=${d.p95}ms worst=${d.worst}ms`);
      expect(a.worst, `${profile.name} acknowledgement`).toBeLessThanOrEqual(100);
      expect(d.p95, `${profile.name} completion p95`).toBeLessThanOrEqual(2500);
    }
  });
});
