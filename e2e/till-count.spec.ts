import { execFileSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";
import { businessDate } from "@/lib/time/business-date";

import { expectLandsOn, fixtures, signIn } from "./fixtures";

/**
 * The daily till count through the screens (issue #83), on every device tier.
 *
 * The rules are proved in pgTAP and over real HTTP in the integration suite. This spec proves the
 * Cashier counts each payment method from `/till` without an expected figure in front of them; that
 * the Manager sees what is expected, sends the count back with a reason, and confirms a shortage with
 * a preset reason and note; that a Director reads it with no control; that a missed day reads Not
 * counted, never a zero, and is counted late; and that the grid scrolls inside its own container.
 *
 * A business day takes one confirmed till count, and the tiers run one after another on one
 * database. So each test starts a fresh day by moving every earlier till count far into the past, on
 * the local stack only, as the database's superuser with its triggers suspended for that statement.
 * The day's payments are written the same way, as an invoice paid by cash, Mixx by YAS and CRDB.
 */

type Who = "director" | "manager" | "cashier";
const sessions = new Map<Who, SupabaseClient>();
const URL_ = () => process.env.NEXT_PUBLIC_SUPABASE_URL!;
const KEY_ = () => process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const tzs = (value: number) => `TZS ${new Intl.NumberFormat("en-GB").format(value)}`;
const METHODS = ["cash", "mixx_by_yas", "halopesa", "mwanga_hakika_transfer", "crdb_transfer", "cheque"] as const;
type Method = (typeof METHODS)[number];
const LABELS: Record<Method, string> = {
  cash: "Cash",
  mixx_by_yas: "Mixx by YAS",
  halopesa: "Halopesa",
  mwanga_hakika_transfer: "Mwanga Hakika transfer",
  crdb_transfer: "CRDB transfer",
  cheque: "Cheque",
};

async function api(who: Who) {
  let client = sessions.get(who);
  if (!client) {
    const account = fixtures()[who];
    const response = await fetch(`${URL_()}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: KEY_(), "Content-Type": "application/json" },
      body: JSON.stringify({ email: derivedAuthIdentifier(account.phone), password: account.password }),
    });
    const body = await response.json();
    if (response.status !== 200) throw new Error(`${who} could not sign in: ${JSON.stringify(body)}`);
    client = createClient(URL_(), KEY_(), {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${body.access_token}` } },
    });
    sessions.set(who, client);
  }
  return client.schema("api");
}

/** What the till should hold today, per method, as the Manager reads it. */
async function expectedToday(): Promise<Record<Method, number>> {
  const { data, error } = await (await api("manager")).rpc("staff_till_expected", { p_business_date: businessDate() });
  if (error) throw new Error(`expected: ${error.message}`);
  return Object.fromEntries((data as { line: Method; expected_tzs: number }[]).map((r) => [r.line, Number(r.expected_tzs)])) as Record<
    Method,
    number
  >;
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

/** Ends the day for the till: every till count so far moves a thousand days back. */
function endDay() {
  superSql(`
    set session_replication_role = replica;
    update public.reconciliations set business_date = business_date - 100000;
    update public.reconciliations set business_date = business_date + 99000;
  `);
}

/** Lets the till be counted from `days` ago, so the days between read Not counted. */
function countingStartsDaysAgo(days: number) {
  superSql(`
    create or replace function private.till_counting_starts_on() returns date
    language sql immutable set search_path = ''
    as $b$ select ((now() at time zone 'Africa/Dar_es_Salaam')::date - ${days}) $b$;
  `);
}

/** Today's takings: one invoice paid by three methods, recorded by the E2E Cashier. */
function takePayments(amounts: Partial<Record<Method, number>>) {
  const tag = Math.random().toString(36).slice(2, 8).toUpperCase();
  const { cashier, salesRep } = fixtures();
  const values = Object.entries(amounts)
    .map(([method, amount]) => `(i, ${amount}, '${method}', cashier, 'cashier', d, gen_random_uuid())`)
    .join(", ");
  superSql(`
    do $$
    declare
      c uuid := gen_random_uuid(); o uuid := gen_random_uuid(); i uuid := gen_random_uuid();
      d date := (now() at time zone 'Africa/Dar_es_Salaam')::date;
      cashier uuid := (select id from public.profiles where phone_e164 = '${cashier.phone}');
      rep uuid := (select id from public.profiles where phone_e164 = '${salesRep.phone}');
    begin
      insert into public.customers (id, name) values (c, 'E2E Till Customer ${tag}');
      insert into public.orders (id, order_no, customer_id, status, is_cash_sale, created_by, created_role,
                                 created_at, confirmed_at)
      values (o, 'ORD-E2E-TILL-${tag}', c, 'confirmed', false, rep, 'sales_rep', now(), now());
      insert into public.invoices (id, invoice_no, order_id, customer_id, subtotal_tzs, discount_tzs,
                                   total_tzs, business_date, issued_at)
      values (i, 'INV-E2E-TILL-${tag}', o, c, 5000000, 0, 5000000, d, now());
      insert into public.payments (invoice_id, amount_tzs, method, received_by, received_role,
                                   business_date, correlation_id)
      values ${values};
    end $$;
  `);
}

async function as(page: Page, who: Who) {
  await page.context().clearCookies();
  const account = fixtures()[who];
  await signIn(page, account.phone, account.password);
  await expectLandsOn(page, who === "cashier" ? "/payments" : "/dashboard");
}

/** The control shown on this tier: a card on a phone, a grid row from tablet up. */
function lineOf(scope: Locator, method: Method): Locator {
  return scope.locator(`[data-testid=till-card-${method}]:visible, [data-testid=till-row-${method}]:visible`);
}

async function fillCount(form: Locator, figures: Record<Method, number>) {
  for (const m of METHODS) await form.getByLabel(LABELS[m], { exact: true }).fill(String(figures[m]));
}

test.describe("till count", () => {
  test.beforeEach(() => {
    endDay();
  });

  test("counted blind, sent back, counted again and confirmed as a shortage, then read by a Director", async ({ page }, testInfo) => {
    const shot = (name: string) =>
      page.screenshot({ path: testInfo.outputPath(`${name}-${testInfo.project.name}.png`), fullPage: true });
    takePayments({ cash: 150000, mixx_by_yas: 30000, crdb_transfer: 200000 });
    const expected = await expectedToday();

    // The Cashier sees today due, and a field per method with nothing expected to copy.
    await as(page, "cashier");
    await page.goto("/till");
    const today = page.getByTestId("till-today");
    await expect(today.getByTestId("till-state-due")).toBeVisible();
    await expect(today).not.toContainText("Expected");
    await expect(page.getByTestId("till-expected")).toHaveCount(0);
    await shot("till-1-cashier-due");
    const form = today.getByTestId("till-enter-form");
    await fillCount(form, { ...expected, cash: expected.cash - 1000 });
    await expect(form.getByTestId("till-running-total")).toContainText(
      tzs(Object.values(expected).reduce((a, b) => a + b, 0) - 1000),
    );
    await form.getByRole("button", { name: "Submit count" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Count submitted." })).toBeVisible();
    await expect(today.getByTestId("till-state-awaiting_confirmation")).toBeVisible();
    await expect(lineOf(today, "cash")).toContainText(`Short by ${tzs(1000)}`);
    await expect(lineOf(today, "cash")).toContainText(tzs(expected.cash));
    await expect(lineOf(today, "crdb_transfer")).toContainText("None");
    await shot("till-2-cashier-awaiting");

    // The Manager sees the same day, and sends it back with a reason.
    await as(page, "manager");
    await page.goto("/till");
    await expect(today.getByTestId("till-state-awaiting_confirmation")).toBeVisible();
    await expect(today.getByTestId("till-confirm")).toHaveText(`Confirm shortage of ${tzs(1000)}`);
    await today.getByTestId("till-open-send-back").click();
    await today.getByTestId("till-send-back-form").getByLabel("What the Cashier should check").fill("Count the coin bag too");
    await today.getByRole("button", { name: "Send back for a recount" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Count sent back." })).toBeVisible();
    await expect(today.getByTestId("till-state-sent_back")).toBeVisible();
    await expect(page.getByTestId("till-expected")).toBeVisible();

    // The Cashier reads the reason above the recount: cash still short, CRDB over by as much.
    await as(page, "cashier");
    await page.goto("/till");
    await expect(today.getByTestId("till-recount-reason")).toContainText("Count the coin bag too");
    await fillCount(today.getByTestId("till-enter-form"), {
      ...expected,
      cash: expected.cash - 1000,
      crdb_transfer: expected.crdb_transfer + 1000,
    });
    await today.getByRole("button", { name: "Submit the new count" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Count submitted." })).toBeVisible();
    await expect(today.getByTestId("till-short-and-over")).toContainText(
      `Short by ${tzs(1000)} and over by ${tzs(1000)}`,
    );

    // The Manager confirms: the net is zero, but the day is a shortage. Other needs a note.
    await as(page, "manager");
    await page.goto("/till");
    await expect(today.getByTestId("till-confirm")).toHaveText(`Confirm shortage of ${tzs(1000)}`);
    await today.getByText("Other", { exact: true }).click();
    await today.getByTestId("till-confirm").click();
    await expect(today.getByText("This reason needs a note of 3 to 500 characters.")).toBeVisible();
    await shot("till-3-manager-note-required");
    await today.getByLabel("Note (needed for this reason)").fill("CRDB slip filed under cash");
    await today.getByTestId("till-confirm").click();
    await expect(page.getByRole("status").filter({ hasText: "Count confirmed." })).toBeVisible();
    await expect(today.getByTestId("till-state-shortage")).toBeVisible();
    await expect(today.getByTestId("till-confirmation")).toContainText("Reason: Other.");
    await shot("till-4-manager-shortage");

    // A Director reads it, with no control, and the first count stays on the record.
    await as(page, "director");
    await page.goto("/till");
    await expect(today.getByTestId("till-state-shortage")).toBeVisible();
    await expect(page.getByTestId("till-confirm")).toHaveCount(0);
    await expect(page.getByTestId("till-enter-form")).toHaveCount(0);
    const history = page.getByTestId("till-history");
    await expect(history.getByTestId(`till-count-${businessDate()}-1`).getByTestId("till-state-sent_back")).toBeVisible();
    await expect(history.getByTestId(`till-count-${businessDate()}-1`)).toContainText("Count the coin bag too");
    await expect(history.getByTestId(`till-count-${businessDate()}-2`).getByTestId("till-state-shortage")).toBeVisible();
    await shot("till-5-director-read");

    // No tier scrolls sideways; on tablet and desktop the grid scrolls inside its own box.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (testInfo.project.name !== "mobile") {
      await expect(today.getByTestId("till-grid-scroll")).toHaveCSS("overflow-x", "auto");
    }
  });

  test("a missed day reads Not counted, never zero, and is counted late with a reason", async ({ page }, testInfo) => {
    const shot = (name: string) =>
      page.screenshot({ path: testInfo.outputPath(`${name}-${testInfo.project.name}.png`), fullPage: true });
    countingStartsDaysAgo(1);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const day = businessDate(yesterday);

    // The Manager sees yesterday open, as Not counted, with no figure that could pass for a zero.
    await as(page, "manager");
    await page.goto("/till");
    const open = page.getByTestId(`till-open-${day}`);
    await expect(open.getByTestId("till-state-not_counted")).toBeVisible();
    await expect(open).toContainText("Not counted since");
    await expect(open).not.toContainText("TZS 0");
    await shot("till-6-manager-not-counted");

    // The Cashier counts it late, and needs a reason.
    await as(page, "cashier");
    await page.goto("/till");
    await page.getByTestId(`till-open-late-${day}`).click();
    const late = page.getByTestId(`till-open-${day}`).getByTestId("till-late-form");
    await fillCount(late, { cash: 0, mixx_by_yas: 0, halopesa: 0, mwanga_hakika_transfer: 0, crdb_transfer: 0, cheque: 0 });
    await late.getByRole("button", { name: "Submit late count" }).click();
    await expect(late.getByText("Say why this day wasn't counted, in 3 to 500 characters.")).toBeVisible();
    await late.getByLabel("Why this day wasn't counted").fill("The Cashier was off sick");
    await late.getByRole("button", { name: "Submit late count" }).click();
    // The answer stays on screen after the day moves on to Awaiting Manager confirmation.
    await expect(page.getByRole("status").filter({ hasText: "Late count submitted." })).toBeVisible();
    await expect(open.getByTestId("till-state-awaiting_confirmation")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Late count submitted." })).toBeVisible();
    await shot("till-7-cashier-late");

    // The Manager confirms it from the card above the open days, and the day leaves the list.
    await as(page, "manager");
    await page.goto("/till");
    await expect(open.getByTestId("till-state-awaiting_confirmation")).toBeVisible();
    const decide = page.getByTestId(`till-past-${day}`);
    await expect(decide.getByTestId("till-late")).toContainText("The Cashier was off sick");
    await page.getByTestId("till-past-decision").getByRole("button", { name: "Confirm balanced" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Count confirmed." })).toBeVisible();
    await expect(page.getByTestId(`till-open-${day}`)).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Count confirmed." })).toBeVisible();
    await expect(
      page.getByTestId("till-history").getByTestId(`till-count-${day}-1`).getByTestId("till-state-balanced"),
    ).toBeVisible();
  });

  test("a Sales Representative is refused the till", async ({ page }) => {
    const { salesRep } = fixtures();
    await signIn(page, salesRep.phone, salesRep.password);
    await expectLandsOn(page, "/orders");
    await page.goto("/till");
    await expect(page.getByRole("heading", { name: /don't have access/i })).toBeVisible();
  });

  test("the till reads in Swahili", async ({ page }, testInfo) => {
    await as(page, "manager");
    await page.context().addCookies([{ name: "fv-locale", value: "sw", url: page.url() }]);
    await page.goto("/till");
    await expect(page.getByRole("heading", { name: "Hesabu ya droo ya kila siku" })).toBeVisible();
    await expect(page.getByTestId("till-today").getByTestId("till-state-due")).toHaveText("Hesabu ya leo inasubiriwa");
    await page.screenshot({ path: testInfo.outputPath(`till-8-manager-sw-${testInfo.project.name}.png`), fullPage: true });
  });
});

// ---------------------------------------------------------------------------------------------
// Mobile benchmark, opt-in, the method of the retirement, reversal and receipt link benchmarks:
//
//     FV_BENCHMARK=1 npx playwright test --project=mobile e2e/till-count.spec.ts -g benchmark
//
// The command is Submit count; the read is opening /till from the navigation and waiting for today's
// card. A real touch starts the clock inside the page. Acknowledgement is the first animation frame
// after the page shows it is working (the button's `aria-busy`, or the route's loading region or
// pending link); completion is the server's answer on screen.
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

async function measureTap(page: Page, profile: Profile, target: Locator, busy: string, done: string, doneText = "") {
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
        const self = busySelector === "self";
        const ack = new MutationObserver(() => {
          const isBusy = self ? el.getAttribute("aria-busy") === "true" : document.querySelector(busySelector);
          if (w.__fv.t0 !== undefined && isBusy) {
            requestAnimationFrame(() => (w.__fv.ack = performance.now() - w.__fv.t0!));
            ack.disconnect();
          }
        });
        if (self) ack.observe(el, { attributes: true });
        else ack.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        const finished = new MutationObserver(() => {
          const found = [...document.querySelectorAll(doneSelector)].some((node) => (node.textContent ?? "").includes(text));
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
    await cdp.send("Network.emulateNetworkConditions", { offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.detach();
  }
}

(BENCHMARK ? test.describe : test.describe.skip)("till count mobile benchmark", () => {
  test.setTimeout(60 * 60_000);

  test("Submit a till count, and open the till: acknowledgement and completion over 4G", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the mobile profile only");
    takePayments({ cash: 150000, mixx_by_yas: 30000, crdb_transfer: 200000 });
    const expected = await expectedToday();
    const verdicts: { label: string; value: number; limit: number }[] = [];
    const report = (label: string, ack: number[], done: number[]) => {
      const a = summary(ack);
      const d = summary(done);
      console.log(`${label} ack  n=${a.n} p50=${a.p50}ms p95=${a.p95}ms worst=${a.worst}ms`);
      console.log(`${label} done n=${d.n} p50=${d.p50}ms p95=${d.p95}ms worst=${d.worst}ms`);
      verdicts.push({ label: `${label} acknowledgement p95`, value: a.p95, limit: 100 });
      verdicts.push({ label: `${label} completion p95`, value: d.p95, limit: 2500 });
    };

    for (const profile of PROFILES) {
      const submitAck: number[] = [];
      const submitDone: number[] = [];
      const readAck: number[] = [];
      const readDone: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        endDay();
        await as(page, "cashier");
        await page.goto("/till");
        const form = page.getByTestId("till-enter-form");
        await fillCount(form, expected);
        const submit = await measureTap(page, profile, page.getByTestId("till-submit"), "self", "[role=status]", "Count submitted.");
        submitAck.push(submit.ack);
        submitDone.push(submit.done);

        await page.goto("/payments");
        await page.getByRole("button", { name: /^menu$/i }).click();
        const read = await measureTap(
          page,
          profile,
          page.locator("#fv-drawer").getByRole("link", { name: "Till count" }),
          "[data-pending-link], [role=status][aria-busy=true], [data-testid=till-today]",
          "[data-testid=till-today]",
          "Awaiting Manager confirmation",
        );
        readAck.push(read.ack);
        readDone.push(read.done);
      }
      report(`${profile.name} submit a till count`, submitAck, submitDone);
      report(`${profile.name} open the till`, readAck, readDone);
    }
    for (const verdict of verdicts) expect.soft(verdict.value, verdict.label).toBeLessThanOrEqual(verdict.limit);
  });
});
