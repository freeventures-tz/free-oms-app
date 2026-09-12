import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";

import { expectLandsOn, fixtures, openNavigation, signIn } from "./fixtures";

/**
 * Brick production, on every device tier.
 *
 * What is proved here that no other layer can prove:
 *
 *   · That the batch form ARRIVES FILLED IN with the standard recipe, so a Manager who used exactly
 *     it types nothing (product.md §11.1, design.md §7.16). Only a browser can show a pre-fill.
 *   · That the variance appears BESIDE the figure as it is typed, and that there is no field to
 *     type a variance into (§5.2).
 *   · That recording a batch moves nothing on the stock screen, and that approving is what does
 *     (§11.1, AC-38, AC-39).
 *   · That a lot still inside its 72 hours offers a DISABLED inspection with its reason shown, and
 *     that reaching the end of curing says READY FOR INSPECTION and not "ready to sell" (AC-44).
 *   · That only the accepted quantity becomes sellable (AC-45), proved by a SERVER-CONFIRMED
 *     inspection record and the resulting balances rather than by a card disappearing.
 *   · That a draft and an uninspected lot stay reachable behind more than fifty decided batches.
 *   · That the moulding time is the yard's time even on a device set to another zone (§15.3).
 *   · That a Director is offered no control on the board at all — §4.1 gives every production step
 *     to the Manager, and design.md §4.3 wants the control absent rather than greyed.
 *
 * HOW A LOT BECOMES INSPECTABLE INSIDE A TEST RUN: by being moulded four days ago. §11.4 says
 * curing starts at the actual moulding-completion time and the form asks for it, refusing only a
 * time in the FUTURE — so a Manager recording Monday's batch on Thursday is an ordinary use of the
 * product, not a way around the countdown. The countdown itself is proved by the batch moulded
 * moments earlier, which stays shut.
 *
 * Production runs on the SEEDED catalogue: §11.1 fixes the recipe and §11.2 fixes the two brick
 * sizes, so this file cannot invent a product the way the sales specs do. The yard is therefore
 * stocked through SUPPLIER RECEIVING rather than opening stock — a receipt may be recorded any
 * number of times, and the three device projects share one database.
 */

const PRODUCTION_HREF = "/production";
const STOCK_HREF = "/inventory";

const CEMENT = "Dangote Cement 42R";
const SAND = "Sand";
const AGGREGATE = "Aggregate";
const BRICK_6 = 'Tofali 6"';

const SUFFIX = Math.random().toString(36).slice(2, 8).toUpperCase();
const SUPPLIER = `E2E Yard Supplier ${SUFFIX}`;

/** How many decided batches the reachability fixture puts in front of the old work. */
const HISTORY_DEPTH = 55;

async function signInAs(page: Page, who: "director" | "manager" | "cashier" | "salesRep") {
  const account = fixtures()[who];
  await signIn(page, account.phone, account.password);
  await expectLandsOn(
    page,
    who === "cashier" ? "/payments" : who === "salesRep" ? "/orders" : "/dashboard",
  );
}

/**
 * What the stock screen says is at a location right now, read from the attribute, not the words.
 *
 * The card is matched on the START of its name rather than exactly. Since Stage 10 Part C a stock
 * card is labelled "name specification content", so cement reads "Dangote Cement 42R 50 kg" — and
 * the content is a property of the unit, not something this test should have to restate. Anchoring
 * at the front still separates the two brick sizes, which is the only ambiguity that matters here.
 */
async function stockAt(page: Page, location: string, product: string): Promise<number> {
  await page.goto(STOCK_HREF);
  await page.getByTestId(`location-tab-${location}`).click();
  const escaped = product.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const card = page.getByRole("article", { name: new RegExp(`^${escaped}`) });
  const value = await card.getByTestId("stock-quantity").getAttribute("data-quantity");
  return Number(value);
}

/**
 * The six-inch block of the batch form.
 *
 * §11.2 puts two sizes on the form and every field inside them is labelled identically, so the
 * fields are reached through the group that names the size rather than through an id the seed
 * generates per environment.
 */
function sixInch(page: Page) {
  return page.getByRole("group", { name: BRICK_6, exact: true });
}

/**
 * A wall-clock string for the YARD, as `<input type="datetime-local">` writes it.
 *
 * Deliberately not derived from the test runner's zone: the form pre-fills and parses in
 * `Africa/Dar_es_Salaam` (§15.3), and a helper reading the local zone would disagree with it on the
 * one test that runs with the browser set to New York.
 */
function yardTime(daysAgo: number): string {
  const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Dar_es_Salaam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(when);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`;
}

/**
 * Chooses a product in a catalogue select.
 *
 * NOT by exact label: since Stage 10 Part C an option reads "name · specification · content", and
 * the content is what one counted unit holds — "Dangote Cement 42R · 50 kg". Matching the option by
 * its product name and reading back its value keeps this test independent of a label that is
 * assembled for people rather than for tests.
 */
async function selectProduct(page: Page, name: string): Promise<void> {
  const select = page.getByLabel(/^product$/i);
  const value = await select.locator("option", { hasText: name }).first().getAttribute("value");
  await select.selectOption(value!);
}

/** Puts materials in the yard the way the business really does: a delivery, entered and approved. */
async function deliverToYard(page: Page, product: string, quantity: number): Promise<void> {
  const noteRef = `DN-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  await page.goto("/inventory/receiving");
  await page.locator("#newReceipt").click();
  await page.getByLabel(/^supplier$/i).selectOption({ label: SUPPLIER });
  await page.getByLabel(/delivered to/i).selectOption("yard");
  await page.getByLabel(/delivery note number/i).fill(noteRef);
  await selectProduct(page, product);
  await page.getByLabel(/^expected/i).fill(String(quantity));
  await page.getByLabel(/^received$/i).fill(String(quantity));
  await page.locator("#submitReceipt").click();
  // Wait for the receipt to exist before navigating: a `goto` fired during the server action
  // abandons it, and the card this function approves would never appear.
  await expect(page.getByText(/waiting for a manager to approve/i)).toBeVisible();

  await page.goto("/inventory/receiving");
  const card = page.getByRole("article", { name: `${SUPPLIER} ${noteRef}`, exact: true });
  await card.getByRole("button", { name: /approve delivery/i }).click();
  await expect(card.getByText(/approved by/i)).toBeVisible();
}

/**
 * A Manager's own API session, for the one fixture the interface cannot build in reasonable time.
 *
 * Fifty-five decided batches through the screens would take longer than the whole suite. These go
 * through the SAME commands the screens call, with the same session and the same authority — a
 * Manager's token, no secret key — so what is seeded is what the product produces.
 */
async function managerSession(): Promise<{ api: SupabaseClient; read: SupabaseClient }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const { manager } = fixtures();

  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: derivedAuthIdentifier(manager.phone),
      password: manager.password,
    }),
  });

  const body = await response.json();
  if (response.status !== 200) {
    throw new Error(`the manager could not sign in: ${JSON.stringify(body)}`);
  }

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${body.access_token}` } },
  });

  return { api: client.schema("api") as unknown as SupabaseClient, read: client };
}

async function productId(read: SupabaseClient, name: string): Promise<string> {
  const { data, error } = await read.from("products").select("id").eq("name", name).single();
  if (error) throw new Error(`looking up ${name}: ${error.message}`);
  return (data as { id: string }).id;
}

test.beforeAll(async ({ browser }) => {
  // Three deliveries, each entered and approved through the real screens, on a cold Next build.
  // The default hook budget is one minute and this is honest work rather than a hang.
  test.setTimeout(300_000);

  const page = await browser.newPage();
  try {
    await signInAs(page, "director");
    await page.goto("/settings/suppliers");
    await page.getByLabel(/supplier name/i).fill(SUPPLIER);
    await page.locator("#addSupplier").click();
    await expect(page.getByText(/supplier added/i)).toBeVisible();

    await page.context().clearCookies();
    await signInAs(page, "manager");

    // Enough for every batch below, on all three tiers, with room to spare.
    await deliverToYard(page, CEMENT, 40);
    await deliverToYard(page, SAND, 200);
    await deliverToYard(page, AGGREGATE, 200);
  } finally {
    await page.close();
  }
});

// ---------------------------------------------------------------------------
test("a batch is recorded, approved, and only then consumes the yard", async ({ page }) => {
  let sandBefore = 0;
  let cementBefore = 0;
  let batchNo = "";

  await test.step("the form arrives already filled in with the standard recipe", async () => {
    await signInAs(page, "manager");

    sandBefore = await stockAt(page, "yard", SAND);
    cementBefore = await stockAt(page, "yard", CEMENT);

    await page.goto(PRODUCTION_HREF);
    await page.locator("#openBatchForm").click();

    // §11.1 and design.md §7.16: confirming the recipe is the normal case, so the actual quantities
    // START at the standard. A form that opened empty would make the exception the default.
    await expect(page.getByLabel(new RegExp(`actually used, ${CEMENT}`, "i"))).toHaveValue("1");
    await expect(page.getByLabel(new RegExp(`actually used, ${SAND}`, "i"))).toHaveValue("5");
    await expect(page.getByLabel(new RegExp(`actually used, ${AGGREGATE}`, "i"))).toHaveValue("5");
  });

  await test.step("changing a figure shows the variance without asking anyone to type it", async () => {
    await page.getByLabel(new RegExp(`actually used, ${SAND}`, "i")).fill("6");

    // The difference appears beside the figure, ON THE SAND ROW OF THIS FORM. Scoped rather than
    // page-wide: the three device projects share one database, so a batch another tier already
    // recorded is sitting further down the page carrying a variance of its own.
    // §5.2: calculated, never typed — and there is no control anywhere that would accept one.
    const materials = page.locator("form:has(#submitBatch)");
    await expect(materials.getByRole("row").filter({ hasText: SAND }).getByText("+1")).toBeVisible();
    await expect(page.getByLabel(/^difference$/i)).toHaveCount(0);
  });

  await test.step("recording it moves nothing", async () => {
    await sixInch(page).getByLabel(/^moulded$/i).fill("22");
    await page.locator("#submitBatch").click();

    await expect(page.getByText(/nothing has left the yard yet/i)).toBeVisible();

    // §11.1, AC-39. The yard is untouched by a record of what happened in it.
    expect(await stockAt(page, "yard", SAND)).toBe(sandBefore);
    expect(await stockAt(page, "yard", CEMENT)).toBe(cementBefore);
  });

  await test.step("approving deducts the ACTUAL, not the recipe", async () => {
    await page.goto(PRODUCTION_HREF);

    const card = page.getByRole("article").filter({ hasText: /waiting for approval/i }).first();
    batchNo = (await card.locator(".fv-identifier").first().innerText()).trim();

    // What approving will do, said before it happens (design.md §10.8).
    await expect(card.getByText(/takes the materials out of the yard/i)).toBeVisible();

    await card.getByRole("button", { name: /^approve$/i }).click();
    // The settled state rather than the transient success line: approving revalidates the route and
    // the card comes back reporting what it now IS.
    await expect(
      page.getByRole("article", { name: batchNo, exact: true }).getByText(/^approved$/i),
    ).toBeVisible();

    // SIX, the confirmed actual — not the five the recipe expects (§11.1, AC-38).
    expect(await stockAt(page, "yard", SAND)).toBe(sandBefore - 6);
    expect(await stockAt(page, "yard", CEMENT)).toBe(cementBefore - 1);
  });

  await test.step("the bricks are curing, and curing is not sellable", async () => {
    const brickBefore = await stockAt(page, "yard", BRICK_6);
    await page.goto(PRODUCTION_HREF);

    const lot = page.getByRole("article", { name: `${batchNo} ${BRICK_6}`, exact: true });
    await expect(lot).toBeVisible();
    await expect(lot.getByText(/still curing/i)).toBeVisible();

    // AC-44: the control is DISABLED and its reason is shown, rather than offered and then refused
    // after a round trip.
    const inspect = lot.getByRole("button", { name: /record the inspection/i });
    await expect(inspect).toBeDisabled();
    await expect(lot.getByText(/the 72 hours are not up yet/i)).toBeVisible();
    // …and it says how long is left, rather than only that it is not time yet.
    await expect(lot.getByText(/left$/)).toBeVisible();

    // Twenty-two moulded, and not one of them for sale.
    expect(brickBefore).toBe(await stockAt(page, "yard", BRICK_6));

    // …and yet they ARE in the yard. The Stock screen says it shows what is physically at each
    // location, so §8's Curing state is shown there as its own figure — never added to the
    // sellable one, and never left out and made the page's own sentence false.
    await page.goto(STOCK_HREF);
    await page.getByTestId("location-tab-yard").click();
    const brickCard = page.getByRole("article", { name: new RegExp(`^${BRICK_6}`) });
    await expect(brickCard.getByTestId("stock-curing")).toBeVisible();
    await expect(brickCard.getByText(/not yet for sale/i)).toBeVisible();

    // The two figures are separate numbers, and the curing one is not inside the sellable one.
    const sellable = Number(
      await brickCard.getByTestId("stock-quantity").getAttribute("data-quantity"),
    );
    const curing = Number(await brickCard.getByTestId("stock-curing").getAttribute("data-quantity"));
    expect(curing).toBeGreaterThan(0);
    expect(sellable).toBe(brickBefore);
  });
});

// ---------------------------------------------------------------------------
test("only the bricks a Manager accepts become sellable", async ({ page }) => {
  let brickBefore = 0;
  let batchNo = "";

  await test.step("a batch moulded four days ago is ready for inspection", async () => {
    await signInAs(page, "manager");
    brickBefore = await stockAt(page, "yard", BRICK_6);

    await page.goto(PRODUCTION_HREF);
    await page.locator("#openBatchForm").click();

    // §11.4: curing counts from when moulding finished, which the Manager states. Only a FUTURE
    // time is refused, so recording Monday's batch on Thursday is ordinary use.
    await page.locator("#mouldedAt").fill(yardTime(4));
    await sixInch(page).getByLabel(/^moulded$/i).fill("22");
    await page.locator("#submitBatch").click();
    await expect(page.getByText(/nothing has left the yard yet/i)).toBeVisible();

    await page.goto(PRODUCTION_HREF);
    const card = page.getByRole("article").filter({ hasText: /waiting for approval/i }).first();
    batchNo = (await card.locator(".fv-identifier").first().innerText()).trim();
    await card.getByRole("button", { name: /^approve$/i }).click();
    await expect(
      page.getByRole("article", { name: batchNo, exact: true }).getByText(/^approved$/i),
    ).toBeVisible();
  });

  await test.step("the words say ready for INSPECTION, never ready to sell", async () => {
    await page.goto(PRODUCTION_HREF);
    const lot = page.getByRole("article", { name: `${batchNo} ${BRICK_6}`, exact: true });

    // The STATUS, exactly — not the "Ready for inspection {time}" line beside it, which says when
    // rather than what. AC-44 turns on the word the chip uses.
    await expect(lot.getByText("Ready for inspection", { exact: true })).toBeVisible();
    await expect(lot.getByText(/still curing/i)).toHaveCount(0);
    // AC-44: reaching the end of curing grants nothing. The screen must not imply otherwise.
    expect(await stockAt(page, "yard", BRICK_6)).toBe(brickBefore);
  });

  await test.step("the inspection has to account for every brick that cured", async () => {
    await page.goto(PRODUCTION_HREF);
    const lot = page.getByRole("article", { name: `${batchNo} ${BRICK_6}`, exact: true });

    await lot.getByLabel(/^accepted$/i).fill("18");
    await lot.getByLabel(/^rejected$/i).fill("0");
    await expect(lot.getByText(/the two must match/i)).toBeVisible();
  });

  await test.step("a reject count is explained from the four preset reasons, never typed", async () => {
    const lot = page.getByRole("article", { name: `${batchNo} ${BRICK_6}`, exact: true });

    await lot.getByLabel(/^rejected$/i).fill("4");
    // §11.5, AC-3: four buttons, and no text field to type a fifth reason into.
    await expect(lot.getByRole("button", { name: /^broken$/i })).toBeVisible();
    await expect(lot.getByRole("button", { name: /^cracked$/i })).toBeVisible();
    await expect(lot.getByRole("button", { name: /^undersized$/i })).toBeVisible();
    await expect(lot.getByRole("button", { name: /^weak$/i })).toBeVisible();
    // The absence is the assertion: the reason is a set of buttons, and NOTHING here would accept
    // a typed one (§11.5, AC-3). The group itself is labelled "Why", so this asks for a textbox.
    await expect(lot.getByRole("textbox", { name: /^why$/i })).toHaveCount(0);

    await lot.getByRole("button", { name: /^cracked$/i }).click();
    await expect(lot.getByRole("button", { name: /^cracked$/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  await test.step("the inspection is proved by its record, not by a card disappearing", async () => {
    const lot = page.getByRole("article", { name: `${batchNo} ${BRICK_6}`, exact: true });

    await lot.getByRole("button", { name: /record the inspection/i }).click();

    // THE SERVER-CONFIRMED RESULT. A control that vanished proves only that something removed a
    // card: it could have been a failed read, a stale render, or a lot somebody else inspected.
    // The batch keeps the outcome, so this is the record a Manager would find tomorrow.
    await page.goto(PRODUCTION_HREF);
    const batch = page.getByRole("article", { name: batchNo, exact: true });
    const outcome = batch.locator('[data-testid^="lot-inspection-"]').first();

    await expect(outcome).toBeVisible();
    await expect(outcome).toHaveAttribute("data-accepted", "18");
    await expect(outcome).toHaveAttribute("data-rejected", "4");
    await expect(outcome).toContainText(/cracked/i);

    // And the lot has left the queue, which is the consequence rather than the proof.
    await expect(
      page.getByRole("article", { name: `${batchNo} ${BRICK_6}`, exact: true }),
    ).toHaveCount(0);

    // EIGHTEEN, not twenty-two: four were cracked at inspection (§11.4, AC-45), and §8 makes a
    // reject unsellable rather than stock kept somewhere else.
    expect(await stockAt(page, "yard", BRICK_6)).toBe(brickBefore + 18);
  });
});

// ---------------------------------------------------------------------------
test.describe("work that is not on the first page", () => {
  test("an old draft and an old curing lot stay reachable behind more than fifty decided batches", async ({
    page,
  }) => {
    test.setTimeout(300_000);

    const { api, read } = await managerSession();
    const [cement, sand, aggregate, brick] = await Promise.all([
      productId(read, CEMENT),
      productId(read, SAND),
      productId(read, AGGREGATE),
      productId(read, BRICK_6),
    ]);

    const recipe = [
      { product_id: cement, actual_quantity: 1 },
      { product_id: sand, actual_quantity: 5 },
      { product_id: aggregate, actual_quantity: 5 },
    ];

    async function enter(mouldedAt: string) {
      const { data, error } = await api.rpc("staff_enter_production_batch", {
        p_location_code: "yard",
        p_moulded_at: mouldedAt,
        p_inputs: recipe,
        p_outputs: [{ product_id: brick, quantity_moulded: 22 }],
        p_yield_note: null,
        p_idempotency_key: randomUUID(),
      });
      if (error) throw new Error(`entering a batch: ${error.message}`);
      const result = data as { ok: boolean; reason: string; batch: { id: string; batch_no: string } };
      expect(result.reason, JSON.stringify(result)).toBe("entered");
      return result.batch;
    }

    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();

    // THE OLD WORK, entered first so everything else is newer than it.
    const oldDraft = await enter(fourDaysAgo);
    const oldApproved = await enter(fourDaysAgo);

    const { data: approved } = await api.rpc("staff_approve_production_batch", {
      p_batch_id: oldApproved.id,
      p_idempotency_key: randomUUID(),
    });
    expect((approved as { reason: string }).reason).toBe("approved");

    // …and the history that buries it. Each one is entered and then REJECTED, which is a completed
    // decision that consumes nothing (§4.3) — so fifty-five of them cost the yard nothing at all.
    for (let batch = 0; batch < HISTORY_DEPTH; batch += 5) {
      await Promise.all(
        Array.from({ length: Math.min(5, HISTORY_DEPTH - batch) }, async () => {
          const entered = await enter(new Date().toISOString());
          const { data } = await api.rpc("staff_reject_production_batch", {
            p_batch_id: entered.id,
            p_reason: "seeded history for the reachability check",
            p_idempotency_key: randomUUID(),
          });
          expect((data as { reason: string }).reason).toBe("rejected");
        }),
      );
    }

    await signInAs(page, "manager");
    await page.goto(PRODUCTION_HREF);

    // THE UNINSPECTED LOT. The inspection queue is its own read, oldest first, so the lot from four
    // days ago is at the front of it however much history exists.
    await expect(
      page.getByRole("article", { name: `${oldApproved.batch_no} ${BRICK_6}`, exact: true }),
    ).toBeVisible();

    // THE OLD DRAFT. Newest first, so it is at the BACK of the drafts queue — which is exactly the
    // record the old "latest fifty batches" read lost. Walking the pager is the proof that it is
    // reachable rather than merely counted.
    const draftCard = page.getByRole("article", { name: oldDraft.batch_no, exact: true });
    for (let hop = 0; hop < 10 && (await draftCard.count()) === 0; hop += 1) {
      const next = page.getByTestId("pager-next-drafts");
      if ((await next.count()) === 0) break;
      await next.click();
      await expect(page.getByTestId("pager-count-drafts")).toBeVisible();
    }
    await expect(draftCard).toBeVisible();

    // The count is stated whether or not there is a second page, so nobody has to guess.
    await expect(page.getByTestId("pager-count-history")).toContainText(/of \d+/);
  });
});

// ---------------------------------------------------------------------------
test.describe("the yard's clock, on a device set somewhere else", () => {
  test.use({ timezoneId: "America/New_York" });

  test("pre-fills the moulding time in Dar es Salaam, not in the browser's zone", async ({
    page,
  }) => {
    await signInAs(page, "manager");
    await page.goto(PRODUCTION_HREF);
    await page.locator("#openBatchForm").click();

    const shown = await page.locator("#mouldedAt").inputValue();

    // Read back as a time in Dar es Salaam — UTC+3, no daylight saving — it is the present moment.
    // Compared as an instant rather than as a string, so a minute ticking over between the two
    // clocks is not a failure while an hour being wrong still is.
    const asBusinessInstant = Date.parse(`${shown}:00Z`) - 3 * 60 * 60 * 1000;
    expect(Math.abs(Date.now() - asBusinessInstant)).toBeLessThan(5 * 60 * 1000);

    // And it is NOT the device's own clock. New York is seven or eight hours behind Dar es Salaam,
    // so a form filled from the browser would be a different hour always and a different DAY for
    // most of the afternoon — and the curing clock would start there, permanently.
    const deviceHour = await page.evaluate(() => new Date().getHours());
    expect(Number(shown.slice(11, 13)), "the form offered the device's hour").not.toBe(deviceHour);
  });
});

// ---------------------------------------------------------------------------
test.describe("what the production screen offers", () => {
  test("a Director reads the board and is offered no control on it", async ({ page }) => {
    await signInAs(page, "director");
    await page.goto(PRODUCTION_HREF);

    await expect(page.getByRole("heading", { name: /brick production/i })).toBeVisible();

    // Absent, not disabled (design.md §4.3, §4.4). §4.1 gives a Director no part in production.
    await expect(page.locator("#openBatchForm")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^approve$/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /record the inspection/i })).toHaveCount(0);
  });

  test("a Cashier cannot reach production at all", async ({ page }) => {
    await signInAs(page, "cashier");
    await page.goto(PRODUCTION_HREF);
    await expect(page).toHaveURL(/\/no-access/);
  });

  test("a Sales Representative cannot reach it either", async ({ page }) => {
    await signInAs(page, "salesRep");
    await page.goto(PRODUCTION_HREF);
    await expect(page).toHaveURL(/\/no-access/);
  });

  test("navigation offers production to the two roles that use it", async ({ page }, testInfo) => {
    await signInAs(page, "manager");
    const managerNav = await openNavigation(page, testInfo);
    await expect(managerNav.getByRole("link", { name: /brick production/i })).toBeVisible();

    await page.context().clearCookies();
    await signInAs(page, "cashier");
    const cashierNav = await openNavigation(page, testInfo);
    await expect(cashierNav.getByRole("link", { name: /brick production/i })).toHaveCount(0);
  });

  test("the board never scrolls the page sideways", async ({ page }) => {
    await signInAs(page, "manager");
    await page.goto(PRODUCTION_HREF);

    // design.md §3.5: a wide table scrolls inside its own container, never the body.
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows).toBe(false);
  });

  test("every control a thumb reaches is at least 44 pixels tall on a touch tier", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name === "desktop",
      "design.md §9.9 sets the 44px floor for touch tiers; a desktop pointer is measured at 40px " +
        "and 32px by design",
    );

    await signInAs(page, "manager");
    await page.goto(PRODUCTION_HREF);
    await page.locator("#openBatchForm").click();

    const controls = page.locator(
      "form:has(#submitBatch) button, form:has(#submitBatch) input, form:has(#submitBatch) select",
    );

    const count = await controls.count();
    expect(count).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      if (!(await control.isVisible())) continue;
      const box = await control.boundingBox();
      expect(box, `control ${index} has no box`).not.toBeNull();
      expect(Math.round(box!.height), `control ${index} is too short`).toBeGreaterThanOrEqual(44);
    }
  });
});

// ---------------------------------------------------------------------------
test.describe("the feedback contract, under deliberate delay", () => {
  /** Long enough that nothing here can pass by being quick. */
  const SERVER_DELAY_MS = 3000;

  /** The contract's own budget, in BROWSER time: acknowledge within ~100 ms (design.md §12.7). */
  const TAP_TO_PENDING_BUDGET_MS = 100;

  /**
   * Clicks `clicks` times inside one in-page evaluation and returns how long the button took to say
   * so.
   *
   * Browser time only: nothing here includes Playwright's round trip, so the threshold can be the
   * contract itself rather than the contract plus automation overhead. The burst is dispatched
   * natively in a single tick, bypassing every actionability check — which is the point: a real
   * thumb does not wait to be told the control is ready.
   *
   * It also resolves the element ONCE and then watches that node. A pending Button hides its label
   * with `invisible` and announces "Working…" instead, so its ACCESSIBLE NAME changes the moment it
   * starts working — and a locator that found it by the word "Approve" stops matching it exactly
   * when the thing being measured happens.
   */
  async function measureTapToPending(button: Locator, clicks = 6): Promise<number> {
    return button.evaluate(
      (node: HTMLButtonElement, clickCount) =>
        new Promise<number>((resolve, reject) => {
          let settled = false;

          function check() {
            if (settled) return;
            // THIS node, not "any busy button on the page": a page-wide query would report a
            // stranger's pending state as this button's acknowledgement.
            if (node.getAttribute("aria-busy") !== "true") return;
            settled = true;
            observer.disconnect();
            resolve(performance.now() - t0);
          }

          const observer = new MutationObserver(check);
          observer.observe(node.parentElement ?? document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["aria-busy"],
          });

          const t0 = performance.now();
          for (let i = 0; i < clickCount; i++) node.click();
          check();

          setTimeout(() => {
            if (settled) return;
            settled = true;
            observer.disconnect();
            reject(new Error("the button pressed never entered a pending state within 5s"));
          }, 5000);
        }),
      clicks,
    );
  }

  /** Every server action that actually left the browser, by its `Next-Action` header. */
  function recordServerActions(page: Page): string[] {
    const payloads: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.headers()["next-action"]) {
        payloads.push(request.postData() ?? "");
      }
    });
    return payloads;
  }

  test("acknowledges an approval at once, refuses a burst, and never doubles the deduction", async ({
    page,
  }) => {
    await signInAs(page, "manager");
    const sandBefore = await stockAt(page, "yard", SAND);

    // The server held for three seconds. Without a delay the request answers before a second tap is
    // physically possible, and the test would pass whether or not the guard exists.
    await page.route("**/production**", async (route) => {
      if (route.request().method() === "POST") {
        await new Promise((resolve) => setTimeout(resolve, SERVER_DELAY_MS));
      }
      await route.continue();
    });

    await page.goto(PRODUCTION_HREF);
    await page.locator("#openBatchForm").click();
    await sixInch(page).getByLabel(/^moulded$/i).fill("22");
    await page.locator("#submitBatch").click();
    await expect(page.getByText(/nothing has left the yard yet/i)).toBeVisible({ timeout: 30_000 });

    const payloads = recordServerActions(page);
    await page.goto(PRODUCTION_HREF);

    const newest = page.getByRole("article").filter({ hasText: /waiting for approval/i }).first();
    const batchNo = (await newest.locator(".fv-identifier").first().innerText()).trim();

    // NAMED, and reached by test id rather than by its label. Two things move under this test: the
    // card leaves the drafts queue once it is approved, and the button's accessible name becomes
    // "Working…" while it works.
    const card = page.getByRole("article", { name: batchNo, exact: true });
    const approve = card.locator('[data-testid^="approve-batch-"]');
    const before = await approve.boundingBox();

    const elapsed = await measureTapToPending(approve, 6);
    expect(elapsed, `the tap was acknowledged after ${Math.round(elapsed)} ms`).toBeLessThan(
      TAP_TO_PENDING_BUDGET_MS,
    );

    // Working, saying so in words rather than by colour alone, and the same size as before
    // (§12.7 rules 4 and 6, §11.5).
    await expect(approve).toHaveAttribute("aria-busy", "true");
    await expect(approve).toContainText(/working/i);
    const during = await approve.boundingBox();
    expect(Math.abs((during?.width ?? 0) - (before?.width ?? 0))).toBeLessThanOrEqual(1);

    // Its sibling closes with it, so a burst across both cannot send two decisions about one batch.
    await expect(card.getByRole("button", { name: /^reject$/i })).toBeDisabled();

    // The settled state, not the transient success line: the card comes back reporting what it IS.
    await expect(card.getByText(/^approved$/i)).toBeVisible({ timeout: 30_000 });
    await page.unroute("**/production**");

    // Six activations, one request. The guard is a ref written synchronously inside the handler,
    // before any await — `disabled` alone closes the control only once React has committed.
    expect(payloads, "more than one approval reached the server").toHaveLength(1);

    // And, decisively, one helping of materials rather than six.
    expect(await stockAt(page, "yard", SAND)).toBe(sandBefore - 5);
  });

  test("shows a skeleton shaped like the board while the route is still loading", async ({
    page,
  }, testInfo) => {
    await signInAs(page, "manager");

    // THE REQUEST IS HELD, NOT DELAYED, and that is the whole difference.
    //
    // This test used to count requests and add a fixed delay to every one after the first, on the
    // reasoning that request one is Next's prefetch of the static loading boundary and request two
    // is the page's own data. The count is not stable across viewports. `openNavigation` returns
    // the always-visible `aside` on tablet and desktop, but on mobile it opens the drawer first, so
    // the link only enters the viewport -- and is only prefetched -- part-way through the test,
    // after this handler is installed. The delay then landed on a different request than intended,
    // the route committed with no skeleton at all, and the test failed on a real screen that was
    // behaving perfectly.
    //
    // So the intended request is IDENTIFIED rather than counted, in two parts.
    //
    // THE PREFETCH MUST HAPPEN, AND THE TEST MUST KNOW IT DID. A router can only show a loading
    // boundary it already holds: Next's partial prefetch is what delivers `loading.tsx`, and
    // without it a click leaves the OLD page on screen until the data arrives, with no skeleton at
    // all. Prefetches carry `Next-Router-Prefetch` and are let through, and the reload below empties
    // the client router cache so every prefetch for this page happens under the handler, where the
    // test can WAIT for it rather than assume it.
    //
    // THE NAVIGATION IS THEN HELD, NOT DELAYED. The first request that is not a prefetch is the one
    // this test is about; it is parked, unanswered, until the assertions have finished with it. The
    // skeleton is therefore on screen for exactly as long as the assertions take, on every
    // viewport, instead of for a fixed number of milliseconds.
    let releaseNavigation: (() => void) | undefined;

    const released = new Promise<void>((resolve) => {
      releaseNavigation = resolve;
    });

    let prefetched = false;
    let holding = false;

    await page.route(/\/production/, async (route, request) => {
      if ("next-router-prefetch" in request.headers()) {
        await route.continue();
        prefetched = true;
        return;
      }

      // Anything after the hold is released, including the board's own later reads.
      if (holding) {
        await route.continue();
        return;
      }

      holding = true;
      await released;
      await route.continue();
    });

    await page.reload();

    const navigation = await openNavigation(page, testInfo);
    const link = navigation.getByRole("link", { name: /brick production/i });
    await expect(link).toBeVisible();

    // On a phone the link lives in the drawer and is only prefetched once the drawer opens, which
    // is why this waits here rather than earlier. This is the step whose timing the old counting
    // gate got wrong.
    await expect
      .poll(() => prefetched, {
        message: "the loading boundary for /production was never prefetched",
        timeout: 15_000,
      })
      .toBe(true);

    // AND PREFETCHING HAS TO HAVE FINISHED, not merely started. Next issues more than one prefetch
    // for this link, and clicking after the first one leaves the router still filling its cache:
    // the navigation then commits with no boundary to show and the skeleton never appears. This is
    // the one place the test waits on the network rather than on a fact, and it is a settle
    // condition rather than a guess -- everything asserted below is held open, not timed.
    await page.waitForLoadState("networkidle");

    await link.click({ noWaitAfter: true });

    // The navigation is now parked in the handler above, so the route CANNOT commit and the
    // assertions below cannot lose a race they are not running. Waiting on the flag rather than on
    // a promise gives this a failure somebody can read if the navigation never arrives at all.
    await expect
      .poll(() => holding, {
        message: "the navigation to /production never reached the route handler",
        timeout: 15_000,
      })
      .toBe(true);

    const skeleton = page.getByRole("status");
    await expect(skeleton).toBeVisible();
    // Announced in words, not drawn only in grey — §12.7 rule 6.
    await expect(skeleton).toContainText(/working/i);
    // Shaped like the board it stands in for — a header, then queue cards — rather than a centred
    // spinner (§12.7 rule 3). A skeleton of the wrong shape is a second layout shift.
    //
    // Polled rather than read once: the request is held open, so the count settles and STAYS, and
    // a single read taken mid-paint is the one remaining way this could report a partial boundary.
    // The assertion itself is unchanged.
    await expect
      .poll(async () => skeleton.locator("[data-slot='skeleton']").count())
      .toBeGreaterThan(5);

    releaseNavigation!();

    await expect(page.getByRole("heading", { name: /brick production/i })).toBeVisible({
      timeout: 20_000,
    });
    await expect(skeleton).toHaveCount(0);

    await page.unroute(/\/production/);
  });

  test("keeps what was typed when a request never reaches a verdict, and retries the same one", async ({
    page,
  }) => {
    await signInAs(page, "manager");
    await page.goto(PRODUCTION_HREF);
    await page.locator("#openBatchForm").click();

    await page.getByLabel(new RegExp(`actually used, ${SAND}`, "i")).fill("6");
    await sixInch(page).getByLabel(/^moulded$/i).fill("22");

    // One aborted attempt: the request leaves and never comes back, which is the yard's connection
    // rather than a refusal the server gave.
    let aborted = false;
    await page.route(/\/production/, async (route, request) => {
      if (request.method() !== "POST" || aborted) return route.continue();
      aborted = true;
      await route.abort("connectionfailed");
    });

    await page.locator("#submitBatch").click();

    // §12.5: the failure is reported rather than swallowed, and NOTHING typed is thrown away.
    await expect(page.getByRole("button", { name: /^try again$/i })).toBeVisible();
    await expect(page.getByLabel(new RegExp(`actually used, ${SAND}`, "i"))).toHaveValue("6");
    await expect(sixInch(page).getByLabel(/^moulded$/i)).toHaveValue("22");

    // The retry carries the SAME request, which is what makes it safe to press.
    await page.getByRole("button", { name: /^try again$/i }).click();
    await expect(page.getByText(/nothing has left the yard yet/i)).toBeVisible();

    await page.unroute(/\/production/);
  });

  test("keeps its feedback legible with motion turned off", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });

    await signInAs(page, "manager");
    await page.goto(PRODUCTION_HREF);
    await page.locator("#openBatchForm").click();
    await sixInch(page).getByLabel(/^moulded$/i).fill("22");

    await page.route(/\/production/, async (route, request) => {
      if (request.method() !== "POST") return route.continue();
      await new Promise((resolve) => setTimeout(resolve, SERVER_DELAY_MS));
      await route.continue();
    });

    const submit = page.locator("#submitBatch");
    await submit.click();

    // §12.7 rule 6: the state is carried by `aria-busy` and a word, not by something moving — so it
    // is exactly as readable under stopped animation.
    await expect(submit).toHaveAttribute("aria-busy", "true");
    await expect(submit).toBeDisabled();
    const spinner = submit.locator("svg");
    if ((await spinner.count()) > 0) {
      await expect(spinner.first()).toHaveClass(/motion-reduce:animate-none/);
    }

    await expect(page.getByText(/nothing has left the yard yet/i)).toBeVisible({ timeout: 30_000 });
    await page.unroute(/\/production/);
  });
});

// ---------------------------------------------------------------------------
test.describe("a refusal a Manager can read, and a correction the database accepts", () => {
  /**
   * Records a batch moulded four days ago and approves it, so its lot is out of curing and the
   * inspection controls on it are live. Returns the batch number, which is how every card below is
   * addressed: the three device projects share one database, and "the first card" is not a lot.
   */
  async function readyLot(page: Page): Promise<string> {
    await page.goto(PRODUCTION_HREF);
    await page.locator("#openBatchForm").click();
    await page.locator("#mouldedAt").fill(yardTime(4));
    await sixInch(page).getByLabel(/^moulded$/i).fill("22");
    await page.locator("#submitBatch").click();
    await expect(page.getByText(/nothing has left the yard yet/i)).toBeVisible();

    await page.goto(PRODUCTION_HREF);
    const card = page.getByRole("article").filter({ hasText: /waiting for approval/i }).first();
    const batchNo = (await card.locator(".fv-identifier").first().innerText()).trim();
    await card.getByRole("button", { name: /^approve$/i }).click();
    await expect(
      page.getByRole("article", { name: batchNo, exact: true }).getByText(/^approved$/i),
    ).toBeVisible();

    return batchNo;
  }

  /**
   * A refusal the schema produces, which is the one shape the board used to drop.
   *
   * `inspectLotAction` and `rejectBatchAction` answer a failed schema with FIELD ERRORS AND NOTHING
   * ELSE. Both cards rendered `result.error` alone, so submitting an inspection with the accepted
   * count blank finished in silence: the control stopped working and the screen never said why.
   * Only a browser proves this end to end — the action, the wire, and what the card does with it.
   */
  test("names the field, announces it, and keeps everything already entered", async ({ page }) => {
    await signInAs(page, "manager");
    const batchNo = await readyLot(page);

    await page.goto(PRODUCTION_HREF);
    const lot = page.getByRole("article", { name: `${batchNo} ${BRICK_6}`, exact: true });

    // Everything except the accepted count, which is what the refusal is about.
    await lot.getByLabel(/^rejected$/i).fill("2");
    await lot.getByRole("button", { name: /^cracked$/i }).click();
    await lot.getByLabel(/^accepted$/i).fill("");
    await lot.getByRole("button", { name: /record the inspection/i }).click();

    // ANNOUNCED, in the yard's language rather than as a key, and reachable by focus.
    const refusal = lot.locator('[data-testid^="inspect-problems-"]');
    await expect(refusal).toBeVisible();
    await expect(refusal).toHaveAttribute("role", "alert");
    await expect(refusal).toContainText(/enter a whole number/i);
    await expect(refusal).toBeFocused();

    // ASSOCIATED with the control it is about, so arriving at the field still carries the reason.
    const accepted = lot.getByLabel(/^accepted$/i);
    await expect(accepted).toHaveAttribute("aria-invalid", "true");
    const describedBy = await accepted.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`#${describedBy}`)).toContainText(/enter a whole number/i);

    // AND NOTHING IS THROWN AWAY (design.md §12.7): the count and the chosen reason are still here.
    await expect(lot.getByLabel(/^rejected$/i)).toHaveValue("2");
    await expect(lot.getByRole("button", { name: /^cracked$/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // The lot is still in the queue, because nothing was recorded.
    await page.goto(PRODUCTION_HREF);
    await expect(
      page.getByRole("article", { name: `${batchNo} ${BRICK_6}`, exact: true }),
    ).toBeVisible();
  });

  /**
   * The counterexample for the value whose control has gone.
   *
   * Both corrections here are ones the DATABASE used to refuse: an explanation for a batch that
   * turned out to be ordinary (`yield_within_range`), and a reason for rejects that turned out to
   * be none (`reject_reason_without_rejects`). The screen showed neither field at the moment the
   * command was sent, so the refusal named something nobody could see. Accepting the batch and the
   * inspection is the proof — a mocked action could not make this claim.
   */
  test("accepts a batch and an inspection after the figures are corrected", async ({ page }) => {
    await signInAs(page, "manager");

    await test.step("an explanation and a reject reason, both corrected away", async () => {
      await page.goto(PRODUCTION_HREF);
      await page.locator("#openBatchForm").click();
      await page.locator("#mouldedAt").fill(yardTime(4));

      // 18 is below §11.2's approved minimum, so the explanation is asked for and given.
      await sixInch(page).getByLabel(/^moulded$/i).fill("18");
      const note = page.locator("#yieldNote");
      await expect(note).toBeVisible();
      await note.fill("the mixer stopped");

      // Two rejects at the mould, explained from the four presets.
      await sixInch(page).getByLabel(/thrown away at the mould/i).fill("2");
      await sixInch(page).getByRole("button", { name: /^cracked$/i }).click();

      // Recounted: an ordinary batch with nothing thrown away. Both controls disappear.
      await sixInch(page).getByLabel(/^moulded$/i).fill("22");
      await sixInch(page).getByLabel(/thrown away at the mould/i).fill("0");
      await expect(page.locator("#yieldNote")).toHaveCount(0);
      await expect(sixInch(page).getByRole("button", { name: /^cracked$/i })).toHaveCount(0);

      // ACCEPTED. Before this correction the database refused it twice over, about two fields the
      // form was no longer showing.
      await page.locator("#submitBatch").click();
      await expect(page.getByText(/nothing has left the yard yet/i)).toBeVisible();
    });

    await test.step("and the inspection, corrected the same way", async () => {
      await page.goto(PRODUCTION_HREF);
      const card = page.getByRole("article").filter({ hasText: /waiting for approval/i }).first();
      const batchNo = (await card.locator(".fv-identifier").first().innerText()).trim();
      await card.getByRole("button", { name: /^approve$/i }).click();
      await expect(
        page.getByRole("article", { name: batchNo, exact: true }).getByText(/^approved$/i),
      ).toBeVisible();

      await page.goto(PRODUCTION_HREF);
      const lot = page.getByRole("article", { name: `${batchNo} ${BRICK_6}`, exact: true });

      await lot.getByLabel(/^accepted$/i).fill("18");
      await lot.getByLabel(/^rejected$/i).fill("4");
      await lot.getByRole("button", { name: /^cracked$/i }).click();

      // Recounted: every brick is good.
      await lot.getByLabel(/^accepted$/i).fill("22");
      await lot.getByLabel(/^rejected$/i).fill("0");
      await expect(lot.getByRole("button", { name: /^cracked$/i })).toHaveCount(0);

      await lot.getByRole("button", { name: /record the inspection/i }).click();

      // WAIT FOR THE RECORD BEFORE NAVIGATING, because navigating cancels what is still in flight.
      //
      // Measured with a four-second delay injected on the action: navigating straight after the
      // click aborts the request and the inspection never reaches the database at all — the lot
      // keeps `inspected_at` null and the board has nothing to show. Waiting for its record first,
      // under the same delay, lets the command finish, and it then survives the reload below. The
      // two steps above this one already wait for a server-confirmed outcome; this one did not.
      await expect(
        page
          .getByRole("article", { name: batchNo, exact: true })
          .locator('[data-testid^="lot-inspection-"]')
          .first(),
      ).toBeVisible();

      // The SERVER-CONFIRMED record, kept on the batch: twenty-two accepted, none rejected, and no
      // reason attached to a rejection that never happened.
      await page.goto(PRODUCTION_HREF);
      const outcome = page
        .getByRole("article", { name: batchNo, exact: true })
        .locator('[data-testid^="lot-inspection-"]')
        .first();

      await expect(outcome).toBeVisible();
      await expect(outcome).toHaveAttribute("data-accepted", "22");
      await expect(outcome).toHaveAttribute("data-rejected", "0");
      await expect(outcome).not.toContainText(/cracked/i);
    });
  });
});
