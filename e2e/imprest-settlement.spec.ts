import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";

import { expectLandsOn, fixtures, signIn } from "./fixtures";

/**
 * Imprest hand-out and settlement through the screens (issue #62), on every device tier.
 *
 * The rules are proved in pgTAP, and storage access over the real Storage API in the integration
 * suite. This spec proves the Cashier can hand out and settle from a phone (photo or file, progress,
 * a failed upload kept and retried, the running total), that the Manager's two lists, the flags and
 * the breakdown show what happened, that a stored receipt opens decrypted for the Manager, that a
 * Director reads without controls, and that a failed read is a page failure.
 *
 * Every figure is read as a change, because the three tiers run one after another on one database.
 */

type Who = "director" | "manager" | "cashier";
type Row = { id: string; version: number };

const SUFFIX = Math.random().toString(36).slice(2, 8).toUpperCase();
const sessions = new Map<Who, SupabaseClient>();

// A real 1×1 PNG, so the thumbnail and the Manager's view have an image to draw.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

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

type Position = { free_to_approve_tzs: number; set_aside_tzs: number; awaiting_verification_tzs: number };
async function position(): Promise<Position> {
  const { data, error } = await (await sessionFor("manager")).rpc("staff_imprest_spending_position");
  if (error) throw new Error(`position: ${error.message}`);
  return (data as Position[])[0] ?? { free_to_approve_tzs: 0, set_aside_tzs: 0, awaiting_verification_tzs: 0 };
}

async function ensureFree(amount: number) {
  const free = (await position()).free_to_approve_tzs;
  if (free >= amount) return;
  const top = amount - free;
  const requested = await command("manager", "staff_request_imprest_funding", {
    p_amount_tzs: top,
    p_reason: `Settlement float ${SUFFIX}`,
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

/** Proposed by the Cashier and approved by the Manager, through the commands. */
async function seedApproved(amount: number, purpose: string): Promise<Row> {
  const proposed = await command("cashier", "staff_propose_imprest_disbursement", {
    p_amount_tzs: amount,
    p_category: "transport_and_delivery",
    p_purpose: purpose,
  });
  return (
    await command("manager", "staff_decide_imprest_disbursement", {
      p_id: proposed.disbursement!.id,
      p_expected_version: 1,
      p_approve: true,
      p_reason: null,
    })
  ).disbursement!;
}

async function seedHandedOut(amount: number, purpose: string): Promise<Row> {
  const approved = await seedApproved(amount, purpose);
  return (
    await command("cashier", "staff_hand_out_imprest_disbursement", {
      p_id: approved.id,
      p_expected_version: approved.version,
      p_recipient: "Juma the driver",
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

/** Adds a line and fills it. `evidence` is a file to upload, or a No-receipt reason and note. */
async function addLine(
  form: Locator,
  number: number,
  amount: string,
  purpose: string,
  evidence: { file: { name: string; mimeType: string; buffer: Buffer } } | { reason: string; note?: string },
) {
  await form.getByTestId("add-line").click();
  const line = form.getByTestId(`settle-line-${number}`);
  await line.getByLabel("Amount (TZS)").fill(amount);
  await line.getByLabel("What it was for").fill(purpose);
  if ("file" in evidence) {
    await line.getByTestId("choose-file").setInputFiles(evidence.file);
  } else {
    await line.getByText("No receipt", { exact: true }).click();
    await line.getByLabel("Why there is no receipt").selectOption({ label: evidence.reason });
    if (evidence.note) await line.getByLabel("Explain what happened").fill(evidence.note);
  }
  return line;
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

test.describe("imprest hand-out and settlement", () => {
  test.beforeEach(async () => {
    await ensureFree(300000);
  });

  test("the Cashier hands out the trip allowance, then settles three receipts and the change", async ({
    page,
  }, testInfo) => {
    const purpose = `Kibaha trip ${SUFFIX} ${testInfo.project.name}`;
    const row = await seedApproved(60000, purpose);
    const before = await position();

    await as(page, "cashier");
    await page.goto("/imprest");
    const mine = page.getByTestId("disbursements-mine").getByRole("link", { name: new RegExp(purpose) });
    await expect(mine.getByTestId("next-step")).toHaveText("Next: hand out the cash");
    await mine.click();

    // There is no amount to type: the approved amount goes out.
    const handOut = page.getByTestId("hand-out-form");
    await expect(handOut.getByRole("textbox")).toHaveCount(1);
    await handOut.getByLabel("Who received it").fill("Juma the driver");
    await handOut.getByRole("button", { name: "Record hand-out" }).click();
    await expect(page.getByRole("status")).toHaveText("Hand-out recorded. Settle it when the spending is done.");
    const afterHandOut = await position();
    expect(afterHandOut.set_aside_tzs).toBe(before.set_aside_tzs);
    expect(afterHandOut.awaiting_verification_tzs).toBe(before.awaiting_verification_tzs + 60000);

    await page.reload();
    await expect(page.getByTestId("recipient")).toContainText("Juma the driver");
    const form = page.getByTestId("settle-form");
    const petrol = await addLine(form, 1, "35,000", "Petrol, Dar to Kibaha", {
      file: { name: "petrol.png", mimeType: "image/png", buffer: PNG },
    });
    await expect(petrol.getByTestId("receipt-thumbnail")).toBeVisible();
    await expect(petrol.getByTestId("upload-status")).toHaveAttribute("data-status", "done");
    const parking = await addLine(form, 2, "2,000", "Parking", {
      file: { name: "parking.png", mimeType: "image/png", buffer: PNG },
    });
    await expect(parking.getByTestId("upload-status")).toHaveAttribute("data-status", "done");
    const fine = await addLine(form, 3, "10,000", "Traffic fine", {
      file: { name: "fine.pdf", mimeType: "application/pdf", buffer: PDF },
    });
    // A PDF shows its name, not a thumbnail.
    await expect(fine.getByTestId("receipt-name")).toHaveText("fine.pdf");
    await expect(fine.getByTestId("receipt-thumbnail")).toHaveCount(0);
    await expect(fine.getByTestId("upload-status")).toHaveAttribute("data-status", "done");

    // The running total while typing.
    await expect(form.getByTestId("total-used")).toHaveText(/47,000/);
    await expect(form.getByTestId("total-unexplained")).toHaveText(/13,000/);
    await form.getByLabel("Cash returned (TZS)").fill("13,000");
    await expect(form.getByTestId("total-unexplained")).toHaveText(/\b0\b/);
    await form.getByTestId("settle-submit").click();
    await expect(page.getByRole("status")).toHaveText(
      "Settled. It now waits for the Manager to verify it, and stays set aside until then.",
    );

    await page.reload();
    const breakdown = page.getByTestId("settlement-breakdown");
    await expect(breakdown.getByTestId("breakdown-used")).toContainText("47,000");
    await expect(breakdown.getByTestId("breakdown-returned")).toContainText("13,000");
    await expect(breakdown.getByTestId("breakdown-notAccounted")).toHaveCount(0);
    await expect(breakdown.getByTestId("settlement-lines").locator("li")).toHaveCount(3);
    const after = await position();
    expect(after.set_aside_tzs).toBe(before.set_aside_tzs);
    expect(after.free_to_approve_tzs).toBe(afterHandOut.free_to_approve_tzs);
    expect(after.awaiting_verification_tzs).toBe(afterHandOut.awaiting_verification_tzs - 13000);
    expect(row.id).toBeTruthy();
  });

  test("a remainder is recorded as Not accounted for, with its explanation and flag", async ({ page }, testInfo) => {
    const purpose = `Short change ${SUFFIX} ${testInfo.project.name}`;
    await seedHandedOut(60000, purpose);

    await as(page, "cashier");
    await page.goto("/imprest");
    const mine = page.getByTestId("disbursements-mine").getByRole("link", { name: new RegExp(purpose) });
    await expect(mine.getByTestId("next-step")).toHaveText("Next: settle it");
    await mine.click();

    const form = page.getByTestId("settle-form");
    await addLine(form, 1, "47,000", "Fuel and fees", { reason: "Vendor did not issue receipt" });
    await form.getByLabel("Cash returned (TZS)").fill("10,000");
    await expect(form.getByTestId("total-unexplained")).toHaveText(/3,000/);
    // The explanation is required before it will go.
    await form.getByTestId("settle-submit").click();
    await expect(form.getByText("Explain the amount not accounted for, in 3 to 500 characters.")).toBeVisible();
    await form.getByLabel("Why this is not accounted for").fill("Driver says the change was short");
    await form.getByTestId("settle-submit").click();
    await expect(page.getByRole("status")).toHaveText(/^Settled\./);

    await page.reload();
    await expect(page.getByTestId("breakdown-notAccounted")).toContainText("3,000");
    await expect(page.getByTestId("unaccounted-explanation")).toContainText("Driver says the change was short");
    await expect(page.getByTestId("flag-not-accounted")).toBeVisible();
    await expect(page.getByTestId("flag-no-receipt")).toBeVisible();
  });

  test("each No-receipt reason is accepted, and a lost receipt needs its explanation", async ({ page }, testInfo) => {
    const purpose = `Six reasons ${SUFFIX} ${testInfo.project.name}`;
    const row = await seedHandedOut(6000, purpose);

    await as(page, "cashier");
    await page.goto(`/imprest/disbursements/${row.id}`);
    const form = page.getByTestId("settle-form");
    const reasons = [
      "Vendor did not issue receipt",
      "Informal or casual labour",
      "Transport fare",
      "Emergency purchase",
      "Receipt lost or damaged",
      "Other",
    ];
    for (const [i, reason] of reasons.entries()) {
      await addLine(form, i + 1, "1,000", `Payment ${i + 1}`, { reason });
    }
    await form.getByLabel("Cash returned (TZS)").fill("0");
    await form.getByTestId("settle-submit").click();
    // The two that need an explanation say so, and nothing was sent.
    await expect(form.getByTestId("settle-line-5").getByText("Explain what happened, in 3 to 500 characters.")).toBeVisible();
    await expect(form.getByTestId("settle-line-6").getByText("Explain what happened, in 3 to 500 characters.")).toBeVisible();
    await form.getByTestId("settle-line-5").getByLabel("Explain what happened").fill("Fell in the mixer");
    await form.getByTestId("settle-line-6").getByLabel("Explain what happened").fill("Paid the night guard");
    await form.getByTestId("settle-submit").click();
    await expect(page.getByRole("status")).toHaveText(/^Settled\./);

    await page.reload();
    const lines = page.getByTestId("settlement-lines");
    for (const [i, reason] of reasons.entries()) {
      await expect(lines.getByTestId(`line-${i + 1}`).getByTestId("line-no-receipt")).toContainText(reason);
    }
    await expect(lines.getByTestId("line-5")).toContainText("Fell in the mixer");
  });

  test("a settlement above the approval is refused and nothing changes", async ({ page }, testInfo) => {
    const purpose = `Over ${SUFFIX} ${testInfo.project.name}`;
    const row = await seedHandedOut(60000, purpose);

    await as(page, "cashier");
    await page.goto(`/imprest/disbursements/${row.id}`);
    const form = page.getByTestId("settle-form");
    await addLine(form, 1, "55,000", "Fuel", { reason: "Transport fare" });
    await form.getByLabel("Cash returned (TZS)").fill("13,000");
    await expect(form.getByTestId("total-over")).toHaveText(/8,000/);
    await expect(form.getByTestId("over-approval")).toBeVisible();
    await form.getByTestId("settle-submit").click();
    await expect(form.getByText("Used plus returned is more than was approved.")).toBeVisible();
    // What was typed stays.
    await expect(form.getByTestId("settle-line-1").getByLabel("Amount (TZS)")).toHaveValue("55,000");

    await page.reload();
    await expect(page.getByTestId("settle-form")).toBeVisible();
    await expect(page.getByTestId("settlement-breakdown")).toHaveCount(0);
  });

  test("a failed upload keeps everything else and offers Try again for that file", async ({ page }, testInfo) => {
    const purpose = `Flaky upload ${SUFFIX} ${testInfo.project.name}`;
    const row = await seedHandedOut(20000, purpose);

    await as(page, "cashier");
    await page.goto(`/imprest/disbursements/${row.id}`);
    const form = page.getByTestId("settle-form");
    await form.getByLabel("Cash returned (TZS)").fill("5,000");

    let fail = true;
    await page.route("**/storage/v1/object/imprest-evidence/**", (route) =>
      fail ? route.abort("failed") : route.continue(),
    );
    const line = await addLine(form, 1, "15,000", "Cement offloading", {
      file: { name: "offload.png", mimeType: "image/png", buffer: PNG },
    });
    await expect(line.getByTestId("upload-status")).toHaveAttribute("data-status", "failed");
    await expect(line.getByText("The upload didn't finish. Everything else you entered is kept.")).toBeVisible();
    await expect(line.getByLabel("Amount (TZS)")).toHaveValue("15,000");
    await expect(form.getByLabel("Cash returned (TZS)")).toHaveValue("5,000");

    fail = false;
    await line.getByTestId("upload-retry").click();
    await expect(line.getByTestId("upload-status")).toHaveAttribute("data-status", "done");
    await form.getByTestId("settle-submit").click();
    await expect(page.getByRole("status")).toHaveText(/^Settled\./);
  });

  test("the Manager sees both lists, the flags, the fourth figure, and opens a receipt", async ({
    page,
  }, testInfo) => {
    const outPurpose = `Still out ${SUFFIX} ${testInfo.project.name}`;
    const settledPurpose = `Casual worker ${SUFFIX} ${testInfo.project.name}`;
    await seedHandedOut(4000, outPurpose);
    const settled = await seedHandedOut(20000, settledPurpose);

    // The Cashier settles with one receipt, uploaded through the screen so it is stored encrypted.
    await as(page, "cashier");
    await page.goto(`/imprest/disbursements/${settled.id}`);
    const form = page.getByTestId("settle-form");
    const line = await addLine(form, 1, "15,000", "Offloading", {
      file: { name: "worker.png", mimeType: "image/png", buffer: PNG },
    });
    await expect(line.getByTestId("upload-status")).toHaveAttribute("data-status", "done");
    await addLine(form, 2, "5,000", "Tea for the crew", { reason: "Informal or casual labour" });
    await form.getByLabel("Cash returned (TZS)").fill("0");
    await form.getByTestId("settle-submit").click();
    await expect(page.getByRole("status")).toHaveText(/^Settled\./);

    await as(page, "manager");
    await page.goto("/imprest");
    await expect(page.getByTestId("awaiting-verification")).toContainText(
      "Cash that has left the fund and hasn't been checked by the Manager yet.",
    );
    const out = page.getByTestId("disbursements-handed-out");
    await expect(out.getByRole("heading")).toHaveText(/^Handed out, not settled \(\d+\)$/);
    await expect(out.getByRole("link", { name: new RegExp(outPurpose) }).getByTestId("handed-out-to")).toContainText(
      "To Juma the driver · out for",
    );
    const waiting = page.getByTestId("disbursements-settled");
    await expect(waiting.getByRole("heading")).toHaveText(/^Settled, waiting for you \(\d+\)$/);
    await expect(page.getByTestId("disbursements-settled-note")).toContainText("isn't built yet");
    const row = waiting.getByRole("link", { name: new RegExp(settledPurpose) });
    await expect(row.getByTestId("settled-figures")).toContainText("Used TZS 20,000");
    await expect(row.getByTestId("flag-no-receipt")).toBeVisible();
    await expect(row.getByTestId("waiting-for")).toBeVisible();

    await row.click();
    await expect(page.getByTestId("verify-later")).toBeVisible();
    await expect(page.getByRole("button", { name: /cancel/i })).toHaveCount(0);
    const receipt = page.getByTestId("line-1").getByTestId("line-receipt");
    await receipt.getByTestId("view-receipt").click();
    const image = receipt.getByTestId("receipt-image");
    await expect(image).toBeVisible();
    // It decrypted into the very PNG that was uploaded.
    expect(await image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  });

  test("the Manager cannot cancel once the cash is handed out", async ({ page }, testInfo) => {
    const purpose = `No cancel ${SUFFIX} ${testInfo.project.name}`;
    const row = await seedHandedOut(3000, purpose);
    await as(page, "manager");
    await page.goto(`/imprest/disbursements/${row.id}`);
    await expect(page.getByTestId("handed-out-note")).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel approval" })).toHaveCount(0);
  });

  test("a Director reads the lists and the breakdown, with no control", async ({ page }, testInfo) => {
    const purpose = `Director reads ${SUFFIX} ${testInfo.project.name}`;
    const row = await seedHandedOut(2000, purpose);
    await command("cashier", "staff_settle_imprest_disbursement", {
      p_id: row.id,
      p_expected_version: row.version,
      p_lines: [],
      p_returned_tzs: 2000,
      p_explanation: null,
    });

    await as(page, "director");
    await page.goto("/imprest");
    await expect(page.getByTestId("awaiting-verification")).toBeVisible();
    const waiting = page.getByTestId("disbursements-settled");
    await expect(waiting.getByRole("heading")).toHaveText(/^Settled, waiting for the Manager \(\d+\)$/);
    await waiting.getByRole("link", { name: new RegExp(purpose) }).click();
    await expect(page.getByTestId("read-only")).toBeVisible();
    await expect(page.getByTestId("no-lines")).toBeVisible();
    await expect(page.getByTestId("breakdown-returned")).toContainText("2,000");
    await expect(page.getByTestId("settle-form")).toHaveCount(0);
    await expect(page.getByTestId("hand-out-form")).toHaveCount(0);
  });

  test("the Cashier sees Free to approve alone and their own flags", async ({ page }, testInfo) => {
    const purpose = `Cashier flags ${SUFFIX} ${testInfo.project.name}`;
    const row = await seedHandedOut(5000, purpose);
    await command("cashier", "staff_settle_imprest_disbursement", {
      p_id: row.id,
      p_expected_version: row.version,
      p_lines: [{ amount_tzs: 5000, purpose: "Bajaji", receipt_id: null, no_receipt_reason: "transport_fare", no_receipt_note: null }],
      p_returned_tzs: 0,
      p_explanation: null,
    });

    await as(page, "cashier");
    await page.goto("/imprest");
    await expect(page.getByTestId("free-to-approve")).toBeVisible();
    await expect(page.getByTestId("awaiting-verification")).toHaveCount(0);
    await expect(page.getByTestId("set-aside-total")).toHaveCount(0);
    const mine = page.getByTestId("disbursements-mine").getByRole("link", { name: new RegExp(purpose) });
    await expect(mine).toContainText("Settled, awaiting verification");
    await expect(mine.getByTestId("flag-no-receipt")).toBeVisible();
    await expect(mine.getByTestId("next-step")).toHaveCount(0);
  });

  test("a failed read is a page failure, never an empty list or a zero", async ({ page }, testInfo) => {
    const purpose = `Settle read ${SUFFIX} ${testInfo.project.name}`;
    await seedHandedOut(1000, purpose);
    await as(page, "manager");

    // One Playwright worker runs the whole suite, so this grant is taken away from nobody else.
    try {
      psql("revoke select on public.imprest_disbursement_handouts from authenticated;");
      await page.goto("/imprest");
      await expect(page.getByText(/this page could not be loaded/i)).toBeVisible();
      await expect(page.getByText("No cash is out waiting to be settled.")).toHaveCount(0);
      await expect(page.getByTestId("awaiting-verification")).toHaveCount(0);
    } finally {
      psql("grant select on public.imprest_disbursement_handouts to authenticated;");
    }

    await page.goto("/imprest");
    const out = page.getByTestId("disbursements-handed-out");
    const figure = await page.getByTestId("awaiting-verification").locator("dd.fv-numeric").innerText();
    expect(money(figure)).toBeGreaterThan(0);
    await expect(out).toBeVisible();
  });
});

// ---------------------------------------------------------------------------------------------
// Mobile benchmark, opt-in, the method of the funding and disbursement benchmarks:
//
//     FV_BENCHMARK=1 npx playwright test --project=mobile e2e/imprest-settlement.spec.ts -g benchmark
//
// Hand-out and Settle: a real touch starts the clock inside the page, acknowledgement is the first
// animation frame after the touched control reports `aria-busy`, and completion is the server's
// confirmation. The receipt upload is timed on its own, from choosing a 3 MB photo to the file
// being stored, because it is bound by the uplink rather than by the command.
// ---------------------------------------------------------------------------------------------

const BENCHMARK = process.env.FV_BENCHMARK === "1";
const SAMPLES = 20;
const UPLOAD_SAMPLES = 5;
const PHOTO_BYTES = 3 * 1024 * 1024;
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

/** Taps `control` under `profile` and returns the acknowledgement and completion times in ms. */
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

function report(label: string, ack: number[], done: number[]) {
  const a = summary(ack);
  const d = summary(done);
  console.log(`${label} ack  n=${a.n} p50=${a.p50}ms p95=${a.p95}ms worst=${a.worst}ms`);
  console.log(`${label} done n=${d.n} p50=${d.p50}ms p95=${d.p95}ms worst=${d.worst}ms`);
  expect(a.worst, `${label} acknowledgement`).toBeLessThanOrEqual(100);
  expect(d.p95, `${label} completion p95`).toBeLessThanOrEqual(2500);
}

(BENCHMARK ? test.describe : test.describe.skip)("imprest settlement mobile benchmark", () => {
  test.setTimeout(60 * 60_000);

  test("Hand out and Settle: acknowledgement and server-confirmed completion over 4G", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the mobile profile only");
    await ensureFree(SAMPLES * PROFILES.length * 2 * 1000 + 1000);
    await as(page, "cashier");

    for (const profile of PROFILES) {
      const ack: number[] = [];
      const done: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const row = await seedApproved(1000, `Bench hand-out ${SUFFIX} ${profile.name} ${i}`);
        await page.goto(`/imprest/disbursements/${row.id}`);
        await page.getByTestId("hand-out-form").getByLabel("Who received it").fill("Bench driver");
        const sample = await measureTap(page, profile, "[data-testid=hand-out-form] button[type=submit]", "Hand-out recorded.");
        ack.push(sample.ack);
        done.push(sample.done);
      }
      report(`${profile.name} hand-out`, ack, done);
    }

    for (const profile of PROFILES) {
      const ack: number[] = [];
      const done: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const row = await seedHandedOut(1000, `Bench settle ${SUFFIX} ${profile.name} ${i}`);
        await page.goto(`/imprest/disbursements/${row.id}`);
        const form = page.getByTestId("settle-form");
        await addLine(form, 1, "800", "Bajaji", { reason: "Transport fare" });
        await form.getByLabel("Cash returned (TZS)").fill("200");
        const sample = await measureTap(page, profile, "[data-testid=settle-submit]", "Settled.");
        ack.push(sample.ack);
        done.push(sample.done);
      }
      report(`${profile.name} settle`, ack, done);
    }
  });

  test("a 3 MB phone photo: from choosing it to stored, over 4G", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the mobile profile only");
    await ensureFree(UPLOAD_SAMPLES * PROFILES.length * 1000 + 1000);
    await as(page, "cashier");
    // Random bytes the size of a phone photo. Encryption makes every file look like this anyway.
    const photo = { name: "photo.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(PHOTO_BYTES, 7) };

    for (const profile of PROFILES) {
      const times: number[] = [];
      for (let i = 0; i < UPLOAD_SAMPLES; i += 1) {
        const row = await seedHandedOut(1000, `Bench upload ${SUFFIX} ${profile.name} ${i}`);
        await page.goto(`/imprest/disbursements/${row.id}`);
        const form = page.getByTestId("settle-form");
        await form.getByTestId("add-line").click();
        const line = form.getByTestId("settle-line-1");
        const elapsed = await throttled(page, profile, async () => {
          const start = Date.now();
          await line.getByTestId("choose-file").setInputFiles(photo);
          await expect(line.getByTestId("upload-status")).toHaveAttribute("data-status", "done", { timeout: 180_000 });
          return Date.now() - start;
        });
        times.push(elapsed);
      }
      const s = summary(times);
      console.log(`${profile.name} upload ${PHOTO_BYTES} bytes n=${s.n} p50=${s.p50}ms p95=${s.p95}ms worst=${s.worst}ms`);
    }
  });
});
