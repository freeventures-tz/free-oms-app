import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";
import { encryptReceipt } from "@/lib/imprest/receipt-crypto";

import { expectLandsOn, fixtures, signIn } from "./fixtures";
import { receiptPhoto } from "./receipt-photo";

/**
 * Send back and settle again through the screens (issue #65), on every device tier.
 *
 * The rules are proved in pgTAP and over real HTTP in the integration suite. This spec proves the
 * Manager sends a settlement back from its page with a reason and no figure; that the Manager's and
 * Directors' lists show it waiting for the Cashier, with the reason and how long; that the Cashier
 * sees the reason above a Settle again form that starts from the returned cycle; that a receipt
 * from the first cycle is cited again beside a new phone photo, which is made smaller before it is
 * uploaded and still reads when the Manager opens it; that the Manager verifies the second cycle;
 * that the detail shows both cycles; and that a stale screen and a failed read are said so.
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
    receipt?: { id: string; object_path: string; key: string };
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
    p_reason: `Send-back float ${SUFFIX}`,
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

/** A small real JPEG, encrypted and uploaded the way the phone does it. */
async function uploadedReceipt(page: Page, d: Row, name: string) {
  const photo = await receiptPhoto(page, name, 120_000, { width: 1200, height: 900 });
  const registered = await command("cashier", "staff_register_imprest_receipt", {
    p_disbursement_id: d.id,
    p_file_name: name,
    p_content_type: "image/jpeg",
    p_byte_size: photo.buffer.length,
  });
  const receipt = registered.receipt!;
  const sealed = await encryptReceipt(photo.buffer.buffer.slice(photo.buffer.byteOffset, photo.buffer.byteOffset + photo.buffer.length) as ArrayBuffer, receipt.key);
  const response = await fetch(`${URL_()}/storage/v1/object/imprest-evidence/${receipt.object_path}`, {
    method: "POST",
    headers: {
      apikey: KEY_(),
      Authorization: `Bearer ${(await sessionFor("cashier")).token}`,
      "Content-Type": "application/octet-stream",
    },
    body: new Blob([sealed]),
  });
  if (response.status !== 200) throw new Error(`upload: ${response.status} ${await response.text()}`);
  return receipt;
}

/**
 * Proposed, approved, handed out and settled through the commands: 20,000 approved, a 12,000 fuel
 * line with a real receipt and a 5,000 fare with none, 3,000 returned.
 */
async function seedSettled(page: Page, purpose: string): Promise<Row> {
  const proposed = await command("cashier", "staff_propose_imprest_disbursement", {
    p_amount_tzs: 20000,
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
  const fuel = await uploadedReceipt(page, out.disbursement!, "fuel.jpg");
  return (
    await command("cashier", "staff_settle_imprest_disbursement", {
      p_id: out.disbursement!.id,
      p_expected_version: out.disbursement!.version,
      p_lines: [
        { amount_tzs: 12000, purpose: "Fuel", receipt_id: fuel.id, no_receipt_reason: null, no_receipt_note: null },
        { amount_tzs: 5000, purpose: "Tolls", receipt_id: null, no_receipt_reason: "transport_fare", no_receipt_note: null },
      ],
      p_returned_tzs: 3000,
      p_explanation: null,
    })
  ).disbursement!;
}

async function latestSettlement(id: string): Promise<string> {
  const { data, error } = await (await sessionFor("manager")).client
    .from("imprest_settlements")
    .select("id")
    .eq("disbursement_id", id)
    .order("cycle", { ascending: false })
    .limit(1)
    .single();
  if (error) throw new Error(`settlement: ${error.message}`);
  return String(data.id);
}

async function sendBackByCommand(row: Row, reason = "Add the receipt for the tolls") {
  return command("manager", "staff_send_back_imprest_settlement", {
    p_id: row.id,
    p_expected_version: row.version,
    p_settlement_id: await latestSettlement(row.id),
    p_reason: reason,
  });
}

async function as(page: Page, who: Who) {
  await page.context().clearCookies();
  const account = fixtures()[who];
  await signIn(page, account.phone, account.password);
  await expectLandsOn(page, who === "cashier" ? "/payments" : "/dashboard");
}

/** The sent-back list is oldest first, so one sent back just now is on the last page. */
const LAST_SENT_BACK_PAGE = "/imprest?back=9999";

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

test.describe("imprest send-back", () => {
  test.beforeEach(async () => {
    await ensureFree(100000);
  });

  test("sent back with a reason, settled again with a reused and a new receipt, and the second cycle verified", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const purpose = `Kibaha send-back ${SUFFIX} ${testInfo.project.name}`;
    const row = await seedSettled(page, purpose);
    const before = await position();

    // The Manager sends it back from its page: a reason, and no figure.
    await as(page, "manager");
    await page.goto(`/imprest/disbursements/${row.id}`);
    await page.getByRole("button", { name: "Send back", exact: true }).click();
    const form = page.getByTestId("send-back-form");
    await expect(form.getByRole("spinbutton")).toHaveCount(0);
    await expect(form.getByRole("textbox")).toHaveCount(1);
    await form.getByRole("button", { name: "Send back to the Cashier" }).click();
    await expect(form.getByText("Give a reason of 3 to 500 characters.")).toBeVisible();
    await form.getByLabel("What the Cashier needs to fix").fill("The tolls need a receipt, the fare was paid at a booth");
    await form.getByRole("button", { name: "Send back to the Cashier" }).click();
    await expect(page.getByRole("status")).toHaveText(
      "Sent back. The Cashier sees your reason and settles it again. It stays set aside until then.",
    );
    expect(await position()).toEqual(before);

    await page.reload();
    await expect(page.getByText("Sent back to the Cashier", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("sent-back-note")).toBeVisible();
    await expect(page.getByTestId("disbursement-history")).toContainText("Sent back");
    await expect(page.getByTestId("settlement-breakdown").getByTestId("cycle-returned")).toContainText(
      "The tolls need a receipt",
    );
    await expect(page.getByRole("button", { name: "Verify", exact: true })).toHaveCount(0);

    // The Manager's list: waiting for the Cashier, with the reason and how long.
    await page.goto(LAST_SENT_BACK_PAGE);
    await expect(page.getByTestId("disbursements-sent-back")).toContainText("Sent back, waiting for the Cashier (");
    const listed = page.getByTestId("disbursements-sent-back").getByRole("link", { name: new RegExp(purpose) });
    await expect(listed.getByTestId("sent-back-reason")).toContainText("Why: The tolls need a receipt");
    await expect(listed.getByTestId("waiting-for")).toContainText("Waiting for");

    // The Cashier: Settle again, the reason above the form, which starts from cycle 1.
    await as(page, "cashier");
    await page.goto("/imprest");
    const mine = page.getByTestId("disbursements-mine").getByRole("link", { name: new RegExp(purpose) });
    await expect(mine).toContainText("Sent back to the Cashier");
    await expect(mine.getByTestId("next-step")).toHaveText("Next: settle again");
    await mine.click();
    const step = page.getByTestId("cashier-step");
    await expect(step.getByRole("heading", { name: "Settle again" })).toBeVisible();
    await expect(step.getByTestId("sent-back-notice-reason")).toHaveText(
      "The tolls need a receipt, the fare was paid at a booth",
    );
    const settle = step.getByTestId("settle-form");
    await expect(settle.getByTestId("settle-lines").locator("> li")).toHaveCount(2);
    const fuelLine = settle.getByTestId("settle-line-1");
    await expect(fuelLine.getByLabel("Amount (TZS)")).toHaveValue("12000");
    await expect(fuelLine.getByTestId("earlier-receipt")).toHaveValue(/[0-9a-f-]{36}/);
    await expect(fuelLine.getByTestId("earlier-receipt").locator("option:checked")).toHaveText("fuel.jpg (settlement 1)");
    await expect(settle.getByLabel("Cash returned (TZS)")).toHaveValue("3000");

    // Tolls now has a receipt: a 3 MB phone photo, made smaller before it goes up.
    const tolls = settle.getByTestId("settle-line-2");
    await tolls.getByText("Receipt", { exact: true }).click();
    const photo = await receiptPhoto(page, "IMG_4211.jpg");
    expect(photo.buffer.length).toBeGreaterThan(2_500_000);
    await tolls.getByTestId("choose-file").setInputFiles(photo);
    const status = tolls.getByTestId("upload-status");
    await expect(status).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    await expect(status).toHaveAttribute("data-type", "image/jpeg");
    const uploaded = Number(await status.getAttribute("data-bytes"));
    expect(uploaded).toBeLessThan(700_000);
    expect(uploaded).toBeLessThan(photo.buffer.length / 4);
    console.log(`[${testInfo.project.name}] receipt photo ${photo.buffer.length} bytes uploaded as ${uploaded} bytes`);

    await settle.getByTestId("settle-submit").click();
    await expect(page.getByRole("status").first()).toContainText("Settled.");

    await page.reload();
    await expect(page.getByTestId("settlement-cycle-1")).toContainText("Settlement 1");
    await expect(page.getByTestId("settlement-cycle-1").getByTestId("cycle-returned")).toContainText(
      "Sent back by Manager on",
    );
    const latest = page.getByTestId("settlement-breakdown");
    await expect(latest).toContainText("Settlement 2");
    await expect(latest.getByTestId("line-2").getByTestId("line-receipt")).toContainText("IMG_4211.jpg");
    await expect(page.getByTestId("disbursement-history")).toContainText("Settled · Settlement 2");
    // The fare had no receipt in cycle 1; that stays on the disbursement for good.
    await expect(page.getByTestId("flag-no-receipt")).toBeVisible();

    // The Manager verifies cycle 2, and opens the new receipt: shrunk, and still readable.
    await as(page, "manager");
    await page.goto(`/imprest/disbursements/${row.id}`);
    const receiptLine = page.getByTestId("settlement-breakdown").getByTestId("line-2");
    await receiptLine.getByTestId("view-receipt").click();
    const image = receiptLine.getByTestId("receipt-image");
    await expect(image).toBeVisible();
    const natural = await image.evaluate((el: HTMLImageElement) => ({ w: el.naturalWidth, h: el.naturalHeight }));
    expect(Math.max(natural.w, natural.h)).toBe(2048);
    await image.screenshot({ path: testInfo.outputPath(`shrunk-receipt-${testInfo.project.name}.png`) });
    // The receipt's own pixels, one for one, where the till print is: what the Manager sees zoomed in.
    const crop = await image.evaluate((el: HTMLImageElement) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1000;
      canvas.height = 1030;
      canvas.getContext("2d")!.drawImage(el, 540, 150, 1000, 1030, 0, 0, 1000, 1030);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    writeFileSync(testInfo.outputPath(`shrunk-receipt-actual-pixels-${testInfo.project.name}.png`), Buffer.from(crop, "base64"));

    await page.getByRole("button", { name: "Verify", exact: true }).click();
    await expect(page.getByTestId("verify-expense")).toHaveText("TZS 17,000 posts as imprest expense");
    await page.getByTestId("confirm-verify").click();
    await expect(page.getByRole("status")).toHaveText("Verified. It is posted and no longer set aside.");
    const after = await position();
    expect(after.posted_balance_tzs).toBe(before.posted_balance_tzs - 17000);
    expect(after.free_to_approve_tzs).toBe(before.free_to_approve_tzs + 3000);
  });

  test("a Director reads the sent-back list and page, with no control", async ({ page }, testInfo) => {
    const purpose = `Director send-back ${SUFFIX} ${testInfo.project.name}`;
    const row = await seedSettled(page, purpose);
    await sendBackByCommand(row, "Which booth took the fare?");

    await as(page, "director");
    await page.goto(LAST_SENT_BACK_PAGE);
    await expect(page.getByTestId("disbursements-sent-back-note")).toContainText("then the Manager checks it");
    const listed = page.getByTestId("disbursements-sent-back").getByRole("link", { name: new RegExp(purpose) });
    await expect(listed.getByTestId("sent-back-reason")).toContainText("Which booth took the fare?");
    await listed.click();
    await expect(page.getByTestId("read-only")).toBeVisible();
    await expect(page.getByTestId("cycle-returned")).toContainText("Sent back by E2E Manager on");
    await expect(page.getByRole("button", { name: "Send back", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Verify", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("settle-form")).toHaveCount(0);
  });

  test("a screen left open while the settlement was sent back is told so", async ({ page }, testInfo) => {
    const purpose = `Stale send-back ${SUFFIX} ${testInfo.project.name}`;
    const row = await seedSettled(page, purpose);

    await as(page, "manager");
    await page.goto(`/imprest/disbursements/${row.id}`);
    await page.getByRole("button", { name: "Send back", exact: true }).click();
    await sendBackByCommand(row);
    const form = page.getByTestId("send-back-form");
    await form.getByLabel("What the Cashier needs to fix").fill("A second reason");
    await form.getByRole("button", { name: "Send back to the Cashier" }).click();
    await expect(page.getByText("This payment changed since you opened it. Reload to see where it stands.")).toBeVisible();
    const { data } = await (await sessionFor("manager")).client
      .from("imprest_settlement_returns")
      .select("reason")
      .eq("disbursement_id", row.id);
    expect(data).toEqual([{ reason: "Add the receipt for the tolls" }]);
  });

  test("a failed read is a page failure, never a missing reason", async ({ page }, testInfo) => {
    const purpose = `Send-back read ${SUFFIX} ${testInfo.project.name}`;
    const row = await seedSettled(page, purpose);
    await sendBackByCommand(row);
    await as(page, "manager");

    // One Playwright worker runs the whole suite, so this grant is taken away from nobody else.
    try {
      psql("revoke select on public.imprest_settlement_returns from authenticated;");
      await page.goto(`/imprest/disbursements/${row.id}`);
      await expect(page.getByText(/this page could not be loaded/i)).toBeVisible();
      await expect(page.getByTestId("cycle-returned")).toHaveCount(0);
      await page.goto("/imprest");
      await expect(page.getByText(/this page could not be loaded/i)).toBeVisible();
    } finally {
      psql("grant select on public.imprest_settlement_returns to authenticated;");
    }

    await page.goto(`/imprest/disbursements/${row.id}`);
    await expect(page.getByTestId("cycle-returned")).toContainText("Add the receipt for the tolls");
  });
});

// ---------------------------------------------------------------------------------------------
// Mobile benchmark, opt-in, the method of the settlement and verification benchmarks:
//
//     FV_BENCHMARK=1 npx playwright test --project=mobile e2e/imprest-send-back.spec.ts -g benchmark
//
// Send back and Settle again: a real touch starts the clock inside the page, acknowledgement is the
// first animation frame after the touched control reports `aria-busy`, and completion is the
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

function report(label: string, ack: number[], done: number[]) {
  const a = summary(ack);
  const d = summary(done);
  console.log(`${label} ack  n=${a.n} p50=${a.p50}ms p95=${a.p95}ms worst=${a.worst}ms`);
  console.log(`${label} done n=${d.n} p50=${d.p50}ms p95=${d.p95}ms worst=${d.worst}ms`);
  expect(a.worst, `${label} acknowledgement`).toBeLessThanOrEqual(100);
  expect(d.p95, `${label} completion p95`).toBeLessThanOrEqual(2500);
}

(BENCHMARK ? test.describe : test.describe.skip)("imprest send-back mobile benchmark", () => {
  test.setTimeout(60 * 60_000);

  test("Send back and Settle again: acknowledgement and server-confirmed completion over 4G", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the mobile profile only");
    await ensureFree(SAMPLES * PROFILES.length * 2 * 20000 + 1000);

    const rows: Row[] = [];
    await as(page, "manager");
    for (const profile of PROFILES) {
      const ack: number[] = [];
      const done: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const row = await seedSettled(page, `Bench send-back ${SUFFIX} ${profile.name} ${i}`);
        rows.push(row);
        await page.goto(`/imprest/disbursements/${row.id}`);
        await page.getByRole("button", { name: "Send back", exact: true }).click();
        await page.getByTestId("send-back-form").getByLabel("What the Cashier needs to fix").fill("Add the tolls receipt");
        const sample = await measureTap(page, profile, "[data-testid=send-back-form] button[type=submit]", "Sent back.");
        ack.push(sample.ack);
        done.push(sample.done);
      }
      report(`${profile.name} send back`, ack, done);
    }

    await as(page, "cashier");
    let next = 0;
    for (const profile of PROFILES) {
      const ack: number[] = [];
      const done: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const row = rows[next++];
        await page.goto(`/imprest/disbursements/${row.id}`);
        // The form starts from cycle 1: the fuel receipt cited again, the fare as it was.
        await expect(page.getByTestId("settle-line-1").getByTestId("earlier-receipt")).toHaveValue(/[0-9a-f-]{36}/);
        const sample = await measureTap(page, profile, "[data-testid=settle-submit]", "Settled.");
        ack.push(sample.ack);
        done.push(sample.done);
      }
      report(`${profile.name} settle again`, ack, done);
    }
  });
});
