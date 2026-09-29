import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";

import { expectLandsOn, fixtures, signIn } from "./fixtures";

/**
 * Raised approvals through the screens (issue #70), on every device tier.
 *
 * The rules are proved in pgTAP and over real HTTP in the integration suite. This spec proves the
 * Cashier asks for more from the payment's page with an amount and a reason; that the request waits
 * on the Manager's list as "Waiting for a raised approval" with what was asked and how long; that
 * the Manager raises it with one tap and no figure to type, which sets the extra aside at once; that
 * the Cashier then records handing out the extra and is offered the settlement against the raised
 * approved amount; that a Director reads all of it and can act on none; and that a stale screen and
 * a failed read are said so.
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
    raise?: { id: string };
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
    p_reason: `Raise float ${SUFFIX}`,
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

/** Every payment a test seeded, so it can be closed out and leave the shared lists as it found them. */
const seeded: Row[] = [];

type Snapshot = {
  version: number;
  approved_tzs: number;
  imprest_approval_raises: { id: string; status: string }[];
};

async function snapshot(id: string): Promise<Snapshot> {
  const { data, error } = await (await sessionFor("manager")).client
    .from("imprest_disbursements")
    .select("version, approved_tzs:imprest_disbursement_approved_tzs, imprest_approval_raises(id, status)")
    .eq("id", id)
    .single();
  if (error) throw new Error(`snapshot: ${error.message}`);
  return data as unknown as Snapshot;
}

/**
 * Settles and verifies one seeded payment, deciding or handing out any raise first. These specs share
 * one database with the rest of the suite, and a payment left handed out would push other specs' rows
 * off the first page of the handed-out list.
 */
async function retire(row: Row) {
  for (let i = 0; i < 4; i += 1) {
    const d = await snapshot(row.id);
    const open = d.imprest_approval_raises.find((r) => r.status === "requested");
    const raised = d.imprest_approval_raises.find((r) => r.status === "raised");
    if (open) {
      await command("manager", "staff_decide_imprest_raise", {
        p_id: row.id, p_expected_version: d.version, p_raise_id: open.id, p_raise: false, p_reason: "Test clean-up",
      });
    } else if (raised) {
      await command("cashier", "staff_hand_out_imprest_raise", {
        p_id: row.id, p_expected_version: d.version, p_raise_id: raised.id, p_recipient: "Clean-up",
      });
    } else {
      break;
    }
  }
  const d = await snapshot(row.id);
  await command("cashier", "staff_settle_imprest_disbursement", {
    p_id: row.id,
    p_expected_version: d.version,
    p_lines: [
      { amount_tzs: Number(d.approved_tzs), purpose: "Clean-up", receipt_id: null, no_receipt_reason: "other", no_receipt_note: "Test clean-up" },
    ],
    p_returned_tzs: 0,
    p_explanation: null,
  });
  const after = await snapshot(row.id);
  const { data } = await (await sessionFor("manager")).client
    .from("imprest_settlements")
    .select("id")
    .eq("disbursement_id", row.id)
    .order("cycle", { ascending: false })
    .limit(1)
    .single();
  await command("manager", "staff_verify_imprest_disbursement", {
    p_id: row.id, p_expected_version: after.version, p_settlement_id: String(data!.id),
  });
}

/** Proposed, approved and handed out through the commands: 10,000 to Juma the driver. */
async function seedHandedOut(purpose: string, amount = 10000): Promise<Row> {
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
  const out = (
    await command("cashier", "staff_hand_out_imprest_disbursement", {
      p_id: approved.disbursement!.id,
      p_expected_version: approved.disbursement!.version,
      p_recipient: "Juma the driver",
    })
  ).disbursement!;
  seeded.push(out);
  return out;
}

async function askByCommand(row: Row, amount = 5000, reason = "The road toll rose") {
  return command("cashier", "staff_request_imprest_raise", {
    p_id: row.id,
    p_expected_version: row.version,
    p_amount_tzs: amount,
    p_reason: reason,
  });
}

async function as(page: Page, who: Who) {
  await page.context().clearCookies();
  const account = fixtures()[who];
  await signIn(page, account.phone, account.password);
  await expectLandsOn(page, who === "cashier" ? "/payments" : "/dashboard");
}

/** The waiting list is oldest first, so a request made just now is on the last page. */
const LAST_RAISE_PAGE = "/imprest?raise=9999";

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

test.describe("imprest raised approval", () => {
  test.beforeEach(async () => {
    await ensureFree(100000);
  });

  test.afterEach(async () => {
    for (const row of seeded.splice(0)) {
      try {
        await retire(row);
      } catch {
        // A test that failed part-way may leave a payment that cannot settle; its own failure is the news.
      }
    }
  });

  test("asked for, raised with one tap, handed out, and offered for settlement at the raised amount", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const purpose = `Kibaha raise ${SUFFIX} ${testInfo.project.name}`;
    const row = await seedHandedOut(purpose);
    const before = await position();

    // The Cashier asks from the payment's page: an amount and a reason, both checked first.
    await as(page, "cashier");
    await page.goto(`/imprest/disbursements/${row.id}`);
    await expect(page.getByTestId("settle-form")).toBeVisible();
    await page.getByTestId("ask-for-more-toggle").click();
    const ask = page.getByTestId("ask-for-more-form");
    await ask.getByRole("button", { name: "Send request" }).click();
    await expect(ask.getByText("Enter a whole number of shillings.")).toBeVisible();
    await expect(ask.getByText("Give a reason of 3 to 500 characters.")).toBeVisible();
    await ask.getByLabel("How much more (TZS)").fill("5000");
    await ask.getByLabel("Why more is needed").fill("The road toll rose at the border");
    await ask.getByRole("button", { name: "Send request" }).click();
    await expect(page.getByRole("status").first()).toContainText("Request sent.");
    expect(await position()).toEqual(before);

    // Settling waits: the form gives way to the request's state.
    await expect(page.getByTestId("raise-waiting")).toContainText("Waiting for the Manager to decide your request for TZS 5,000 more");
    await expect(page.getByTestId("settle-form")).toHaveCount(0);
    await page.goto("/imprest");
    const mine = page.getByTestId("disbursements-mine").getByRole("link", { name: new RegExp(purpose) });
    await expect(mine.getByTestId("next-step")).toHaveText("Waiting for the Manager to decide your request for more");

    // The Manager's list: what was asked, and how long it has waited.
    await as(page, "manager");
    await page.goto(LAST_RAISE_PAGE);
    await expect(page.getByTestId("disbursements-raise")).toContainText("Waiting for a raised approval (");
    const listed = page.getByTestId("disbursements-raise").getByRole("link", { name: new RegExp(purpose) });
    await expect(listed.getByTestId("raise-asked")).toContainText("Asked for TZS 5,000 more: The road toll rose at the border");
    await expect(listed.getByTestId("waiting-for")).toContainText("Waiting for");

    // One tap raises it. There is no figure to type.
    await listed.click();
    await expect(page.getByTestId("raise-request")).toContainText("TZS 5,000 more, taking the approval from TZS 10,000 to TZS 15,000");
    await expect(page.getByTestId("raise-request-reason")).toContainText("The road toll rose at the border");
    await expect(page.getByTestId("raise-approval-form").getByRole("spinbutton")).toHaveCount(0);
    await expect(page.getByTestId("raise-approval-form").getByRole("textbox")).toHaveCount(0);
    await page.getByTestId("raise-approval").click();
    await expect(page.getByRole("status")).toContainText("Approval raised.");
    const raised = await position();
    expect(raised.set_aside_tzs).toBe(before.set_aside_tzs + 5000);
    expect(raised.free_to_approve_tzs).toBe(before.free_to_approve_tzs - 5000);
    expect(raised.awaiting_verification_tzs).toBe(before.awaiting_verification_tzs);

    await page.reload();
    await expect(page.getByTestId("approval-first")).toContainText("TZS 10,000");
    await expect(page.getByTestId("raise-1")).toContainText("Raised, extra not yet handed out");
    await expect(page.getByTestId("raise-1")).toContainText("The road toll rose at the border");
    await expect(page.getByTestId("approval-total")).toContainText("TZS 15,000");
    await expect(page.getByTestId("raise-hand-out-note")).toBeVisible();
    await expect(page.getByTestId("disbursement-history")).toContainText("Approval raised and set aside");
    await expect(page.getByTestId("disbursements-raise")).toHaveCount(0);

    // The Cashier hands out the extra, and only then is offered the settlement, at TZS 15,000.
    await as(page, "cashier");
    await page.goto(`/imprest/disbursements/${row.id}`);
    await expect(page.getByTestId("settle-form")).toHaveCount(0);
    await page.goto("/imprest");
    await expect(
      page.getByTestId("disbursements-mine").getByRole("link", { name: new RegExp(purpose) }).getByTestId("next-step"),
    ).toHaveText("Next: hand out the extra");
    await page.getByTestId("disbursements-mine").getByRole("link", { name: new RegExp(purpose) }).click();
    const extra = page.getByTestId("hand-out-extra-form");
    await extra.getByRole("button", { name: "Record extra hand-out" }).click();
    await expect(extra.getByText("Name who received it, in 2 to 120 characters.")).toBeVisible();
    await extra.getByLabel("Who received it").fill("Juma the driver");
    await extra.getByRole("button", { name: "Record extra hand-out" }).click();
    await expect(page.getByRole("status").first()).toContainText("Extra hand-out recorded.");
    const out = await position();
    expect(out.awaiting_verification_tzs).toBe(before.awaiting_verification_tzs + 5000);

    await page.reload();
    const settle = page.getByTestId("settle-form");
    await expect(settle).toBeVisible();
    await expect(settle).toContainText("TZS 15,000");
    await expect(page.getByTestId("approval-total")).toContainText("TZS 15,000");
    await expect(page.getByTestId("raise-1")).toContainText("Raised and handed out");
    await expect(page.getByTestId("raise-1")).toContainText("Handed out to Juma the driver");
  });

  test("a Director reads the waiting list and the request, and can act on neither", async ({ page }, testInfo) => {
    const purpose = `Director raise ${SUFFIX} ${testInfo.project.name}`;
    const row = await seedHandedOut(purpose);
    await askByCommand(row, 4000, "Which booth took the fare?");

    await as(page, "director");
    await page.goto(LAST_RAISE_PAGE);
    await expect(page.getByTestId("disbursements-raise-note")).toContainText("the Manager decides");
    const listed = page.getByTestId("disbursements-raise").getByRole("link", { name: new RegExp(purpose) });
    await expect(listed.getByTestId("raise-asked")).toContainText("Which booth took the fare?");
    await listed.click();
    await expect(page.getByTestId("read-only")).toBeVisible();
    await expect(page.getByTestId("raise-request")).toBeVisible();
    await expect(page.getByTestId("raise-approval")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Refuse", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("ask-for-more")).toHaveCount(0);
    await expect(page.getByTestId("settle-form")).toHaveCount(0);
  });

  test("a refusal keeps its reason on the page and lets the Cashier ask again", async ({ page }, testInfo) => {
    const purpose = `Refused raise ${SUFFIX} ${testInfo.project.name}`;
    const row = await seedHandedOut(purpose);
    await askByCommand(row, 9000, "Buy a spare tyre");
    const before = await position();

    await as(page, "manager");
    await page.goto(`/imprest/disbursements/${row.id}`);
    await page.getByRole("button", { name: "Refuse", exact: true }).click();
    const form = page.getByTestId("refuse-raise-form");
    await form.getByRole("button", { name: "Refuse request" }).click();
    await expect(form.getByText("Give a reason of 3 to 500 characters.")).toBeVisible();
    await form.getByLabel("Why you are refusing").fill("A tyre is not part of this trip");
    await form.getByRole("button", { name: "Refuse request" }).click();
    await expect(page.getByRole("status")).toContainText("Request refused.");
    expect(await position()).toEqual(before);

    await page.reload();
    await expect(page.getByTestId("raise-1")).toContainText("Refused");
    await expect(page.getByTestId("raise-refusal")).toContainText("A tyre is not part of this trip");
    await expect(page.getByTestId("approval-total")).toContainText("TZS 10,000");

    await as(page, "cashier");
    await page.goto(`/imprest/disbursements/${row.id}`);
    await expect(page.getByTestId("settle-form")).toBeVisible();
    await expect(page.getByTestId("ask-for-more-toggle")).toBeVisible();
    await expect(page.getByTestId("raise-1")).toContainText("A tyre is not part of this trip");
  });

  test("a raise the fund cannot cover is refused with what is free, and sets nothing aside", async ({ page }, testInfo) => {
    const purpose = `Short raise ${SUFFIX} ${testInfo.project.name}`;
    const row = await seedHandedOut(purpose);
    const free = (await position()).free_to_approve_tzs;
    await askByCommand(row, free + 1, "Far more than the fund holds");
    const before = await position();

    await as(page, "manager");
    await page.goto(`/imprest/disbursements/${row.id}`);
    await page.getByTestId("raise-approval").click();
    await expect(page.getByText(/is free to approve, less than the .* proposed/)).toBeVisible();
    expect(await position()).toEqual(before);
    await expect(page.getByTestId("raise-approval")).toBeEnabled();
  });

  test("a screen left open while the request was decided is told so", async ({ page }, testInfo) => {
    const purpose = `Stale raise ${SUFFIX} ${testInfo.project.name}`;
    const row = await seedHandedOut(purpose);
    const asked = await askByCommand(row, 3000, "One more errand");

    await as(page, "manager");
    await page.goto(`/imprest/disbursements/${row.id}`);
    await command("manager", "staff_decide_imprest_raise", {
      p_id: row.id,
      p_expected_version: row.version + 1,
      p_raise_id: asked.raise!.id,
      p_raise: false,
      p_reason: "Not this time",
    });
    await page.getByTestId("raise-approval").click();
    await expect(page.getByText("This payment changed since you opened it. Reload to see where it stands.")).toBeVisible();
    const { data } = await (await sessionFor("manager")).client
      .from("imprest_approval_raises")
      .select("status")
      .eq("disbursement_id", row.id);
    expect(data).toEqual([{ status: "refused" }]);
  });

  test("a failed read is a page failure, never a missing raise", async ({ page }, testInfo) => {
    const purpose = `Raise read ${SUFFIX} ${testInfo.project.name}`;
    const row = await seedHandedOut(purpose);
    await askByCommand(row);
    await as(page, "manager");

    // One Playwright worker runs the whole suite, so this grant is taken away from nobody else.
    try {
      psql("revoke select on public.imprest_approval_raises from authenticated;");
      await page.goto(`/imprest/disbursements/${row.id}`);
      await expect(page.getByText(/this page could not be loaded/i)).toBeVisible();
      await expect(page.getByTestId("raise-request")).toHaveCount(0);
      await page.goto("/imprest");
      await expect(page.getByText(/this page could not be loaded/i)).toBeVisible();
    } finally {
      psql("grant select on public.imprest_approval_raises to authenticated;");
    }

    await page.goto(`/imprest/disbursements/${row.id}`);
    await expect(page.getByTestId("raise-request")).toContainText("The road toll rose");
  });
});

// ---------------------------------------------------------------------------------------------
// Mobile benchmark, opt-in, the method of the send-back and settlement benchmarks:
//
//     FV_BENCHMARK=1 npx playwright test --project=mobile e2e/imprest-raised-approval.spec.ts -g benchmark
//
// Asking for more and raising the approval: a real touch starts the clock inside the page,
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

(BENCHMARK ? test.describe : test.describe.skip)("imprest raised approval mobile benchmark", () => {
  test.setTimeout(60 * 60_000);

  // Every sample is settled and verified afterwards, so the benchmark leaves the lists as it found them.
  test.afterEach(async () => {
    for (const row of seeded.splice(0)) {
      try {
        await retire(row);
      } catch {
        // See the clean-up above.
      }
    }
  });

  test("Ask for more and Raise the approval: acknowledgement and server-confirmed completion over 4G", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the mobile profile only");
    await ensureFree(SAMPLES * PROFILES.length * 2 * 10000 + 1000);

    // Ask: the Cashier's form on the payment's own page, one handed-out payment per sample.
    const rows: Row[] = [];
    await as(page, "cashier");
    for (const profile of PROFILES) {
      const ack: number[] = [];
      const done: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const row = await seedHandedOut(`Bench raise ask ${SUFFIX} ${profile.name} ${i}`);
        rows.push(row);
        await page.goto(`/imprest/disbursements/${row.id}`);
        await page.getByTestId("ask-for-more-toggle").click();
        const form = page.getByTestId("ask-for-more-form");
        await form.getByLabel("How much more (TZS)").fill("2000");
        await form.getByLabel("Why more is needed").fill("A second toll on the way back");
        const sample = await measureTap(page, profile, "[data-testid=ask-for-more-form] button[type=submit]", "Request sent.");
        ack.push(sample.ack);
        done.push(sample.done);
      }
      report(`${profile.name} ask for more`, ack, done);
    }

    // Raise: the Manager's single tap on each of those requests.
    await as(page, "manager");
    let next = 0;
    for (const profile of PROFILES) {
      const ack: number[] = [];
      const done: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const row = rows[next++];
        await page.goto(`/imprest/disbursements/${row.id}`);
        await expect(page.getByTestId("raise-approval")).toBeVisible();
        const sample = await measureTap(page, profile, "[data-testid=raise-approval]", "Approval raised.");
        ack.push(sample.ack);
        done.push(sample.done);
      }
      report(`${profile.name} raise approval`, ack, done);
    }
  });
});
