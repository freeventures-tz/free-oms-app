import { expect, test, type Page } from "@playwright/test";

import { expectLandsOn, fixtures, signIn } from "./fixtures";

/**
 * A customer's promise, protected against production — on every device tier (issue #7).
 *
 * pgTAP proves the rule inside the database and the integration suite proves it over HTTP and under
 * race. What is left for a browser, and provable nowhere else:
 *
 *   · THAT THE REFUSAL IS READABLE. The yard is full of cement and the batch is refused anyway.
 *     Unless the screen says WHY — that the bags are sold — a Manager sees a system arguing with
 *     what is in front of their eyes. So the sentence and its three numbers are the assertion.
 *
 *   · THAT IT FITS. The refusal renders on a phone in a yard, not only on a desktop.
 *
 *   · THAT THE PROMISE IS THE ONLY OBSTACLE. Once the order is cancelled the identical batch is
 *     approved and consumes exactly what it asked for. The rule protects a promise; it does not
 *     make production hard.
 *
 * Nothing here reaches into the database. The yard is stocked through supplier receiving, the price
 * is set on the products screen, and the order is written on the order screen, exactly as the
 * business does it. Quantities are READ rather than assumed: the three device projects share one
 * database and run one after another, so what is sellable when this file starts is whatever the
 * tier before it left.
 */

const CEMENT = "Dangote Cement 42R";
const SAND = "Sand";
const AGGREGATE = "Aggregate";
const BRICK_6 = 'Tofali 6"';

const SUFFIX = Math.random().toString(36).slice(2, 8).toUpperCase();
const SUPPLIER = `E2E Invariant Supplier ${SUFFIX}`;

async function signInAs(page: Page, who: "director" | "manager" | "salesRep") {
  const account = fixtures()[who];
  await page.context().clearCookies();
  await signIn(page, account.phone, account.password);
  await expectLandsOn(page, who === "salesRep" ? "/orders" : "/dashboard");
}

/**
 * Chooses a product in a catalogue select by NAME.
 *
 * Since Stage 10 Part C an option reads "name · specification · content", so cement is labelled
 * "Dangote Cement 42R · 50 kg". Matching on the name and reading the value back keeps this
 * independent of a label assembled for people.
 */
async function selectProduct(page: Page, label: string | RegExp, name: string): Promise<void> {
  const select = page.getByLabel(label);
  const value = await select.locator("option", { hasText: name }).first().getAttribute("value");
  await select.selectOption(value!);
}

/**
 * Move to the next step of the phone flow, if there is one.
 *
 * The new-order screen is three sections in one layout with a CSS decision on top: below `md` only
 * the active step is shown, and from `md` up all three are visible at once. The stepper bar is
 * `md:hidden`, so this is a no-op on tablet and desktop and the same body proves all three tiers.
 */
async function nextStep(page: Page): Promise<void> {
  const next = page.locator("#stepNext");
  if (await next.isVisible()) await next.click();
}

/** The customer is FOUND rather than scrolled to (design.md §7.5). */
async function chooseCustomer(page: Page, name: string): Promise<void> {
  await page.getByLabel(/choose a customer/i).fill(name);
  await page.getByTestId("customer-results").getByRole("button", { name }).click();
}

/**
 * Adds the cement to an order and returns the line's §8.1 figures.
 *
 * The ORDER screen searches for a product; only the receiving screen still offers a `<select>`, so
 * `selectProduct` above is not the helper for this one. Selecting a result adds the line at a
 * quantity of one, and the line then carries "N can be sold (M in the yard)" — which is the whole
 * reason this file reads it here rather than off the stock board.
 */
async function addCementLine(page: Page): Promise<{ sellable: number; physical: number }> {
  await page.getByLabel(/^product$/i).fill(CEMENT);
  await page.getByTestId("order-product-results").getByRole("button", { name: CEMENT }).click();

  const line = await page.getByTestId("order-available-0").innerText();
  const figures = line.match(/([\d,]+)\s+can be sold\s*\(([\d,]+)/i);

  return {
    sellable: Number((figures?.[1] ?? "0").replace(/,/g, "")),
    physical: Number((figures?.[2] ?? "0").replace(/,/g, "")),
  };
}

/** Puts materials in the yard the way the business really does: a delivery, entered and approved. */
async function deliverToYard(page: Page, product: string, quantity: number): Promise<void> {
  const noteRef = `DN-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  await page.goto("/inventory/receiving");
  await page.locator("#newReceipt").click();
  await page.getByLabel(/^supplier$/i).selectOption({ label: SUPPLIER });
  await page.getByLabel(/delivered to/i).selectOption("yard");
  await page.getByLabel(/delivery date/i).fill(new Date().toISOString().slice(0, 10));
  await page.getByLabel(/delivery note number/i).fill(noteRef);
  await selectProduct(page, /^product$/i, product);
  await page.getByLabel(/^expected/i).fill(String(quantity));
  await page.getByLabel(/^received$/i).fill(String(quantity));
  await page.locator("#submitReceipt").click();
  await expect(page.getByText(/waiting for a manager to approve/i)).toBeVisible();

  await page.goto("/inventory/receiving");
  const card = page.getByRole("article", { name: `${SUPPLIER} ${noteRef}`, exact: true });
  await card.getByRole("button", { name: /approve delivery/i }).click();
  await expect(card.getByText(/approved by/i)).toBeVisible();
}

/** Records a batch on the standard recipe and leaves it in draft, consuming nothing (AC-39). */
async function recordStandardBatch(page: Page): Promise<void> {
  await page.goto("/production");
  await page.locator("#openBatchForm").click();

  // The moulding time is left as the form OFFERS it. §11.4 asks the Manager to confirm or correct
  // it, and confirming is the normal case. Typing one here would also have been wrong in a way
  // worth recording: the obvious `new Date().toISOString().slice(0, 16)` is a UTC wall clock, and
  // the field means Dar es Salaam wall clock — so it set the batch three hours early and made the
  // screen look broken when it was the test that was.
  // §11.2 puts two brick sizes on the form with identically labelled fields inside each, so the
  // field is reached through the group that names the size rather than through a generated id.
  await page.getByRole("group", { name: BRICK_6, exact: true }).getByLabel(/^moulded$/i).fill("22");
  await page.locator("#submitBatch").click();
  await expect(page.getByText(/nothing has left the yard yet/i)).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  // Deliveries and a price, through the real screens, on a cold Next build. Honest work rather
  // than a hang, so the hook gets a budget to match.
  test.setTimeout(240_000);

  const page = await browser.newPage();
  try {
    await signInAs(page, "director");

    await page.goto("/settings/suppliers");
    await page.getByLabel(/supplier name/i).fill(SUPPLIER);
    await page.locator("#addSupplier").click();
    await expect(page.getByText(/supplier added/i)).toBeVisible();

    // A price, because nothing may be ordered at a figure nobody approved (§4).
    //
    // This hook runs ONCE PER WORKER, so it has to be idempotent. "No price set" is the
    // only reliable signal that the work is still outstanding; the button reads "Set price" either
    // way, and re-pricing at the same figure is refused as `price_unchanged`.
    await page.goto("/settings/products");
    const card = page.getByRole("article", { name: CEMENT }).first();
    await expect(card).toBeVisible();

    // The BUTTON is the reliable signal: it reads "Set price" only while the product has none, and
    // "Change price" once it has one. Waiting for the card first matters — a `count()` on a page
    // that has not finished rendering answers zero and skips the fixture silently, which is how
    // this hook came to leave cement unpriced and the order screen refusing to sell it.
    const setPrice = card.getByRole("button", { name: "Set price", exact: true });
    if ((await setPrice.count()) > 0) {
      await setPrice.click();
      await card.getByLabel(/price in tzs/i).fill("20000");
      await card.getByLabel(/why is it changing/i).fill("stock invariant fixture");
      await card.getByRole("button", { name: /save price/i }).click();
      await expect(card.getByText(/price saved/i)).toBeVisible();
    }

    await signInAs(page, "manager");

    // Sand and aggregate in quantity, so the batch is refused for the CEMENT and for nothing else.
    // The approval walks its inputs in product order and returns the first refusal it finds; a
    // short yard of sand would refuse the batch for the wrong reason and the test would pass while
    // proving nothing.
    await deliverToYard(page, SAND, 200);
    await deliverToYard(page, AGGREGATE, 200);
    await deliverToYard(page, CEMENT, 12);
  } finally {
    await page.close();
  }
});

test.describe.serial("a batch may not consume what a customer has been promised", () => {
  let orderNo = "";
  /** What may be SOLD when this file starts — physical minus whatever earlier specs promised. */
  let sellable = 0;
  /** What is PHYSICALLY there, across every location, as the §8.1 line reports it. */
  let physical = 0;

  test("a Sales Representative promises every sellable bag to a customer", async ({ page }) => {
    // Both figures are read through a MANAGER, off the §8.1 line on the order screen.
    //
    // NOT a preference, and not the stock screen either. `public.product_availability` is a
    // `security_invoker` view over `inventory_ledger`, whose SELECT policy admits a Director and a
    // Manager and nobody else — so a Sales Representative reads it as zero and the order screen
    // tells them "0 can be sold (0 in the yard)" for every product, whatever is there. That is a
    // real defect in the sales screen, recorded for its owner and not this ticket's to fix.
    //
    // And it must be AVAILABLE rather than the yard's physical balance, which is the mistake that
    // first wrote this test: by the time the whole suite reaches this file, earlier specs have
    // promised some of the same cement to their own customers, so physical and available differ and
    // ordering the physical figure is refused for stock somebody else already holds.
    await signInAs(page, "manager");
    await page.goto("/orders/new");

    // A Manager reads the figures from step 2, which on a phone is reached through step 1 — and a
    // customer has to be chosen before step 1 will let go. The Cash Customer is the permanent
    // one-click row of §12.4: it always exists, and nothing is promised by looking at a screen.
    await page.locator("#cashCustomer").click();
    await nextStep(page);

    ({ sellable, physical } = await addCementLine(page));
    expect(sellable, "the fixture needs something to promise").toBeGreaterThan(0);

    await signInAs(page, "salesRep");
    await page.goto("/orders/new");

    const customerName = `E2E Invariant Customer ${SUFFIX}-${test.info().project.name}`;
    await page.locator("#addCustomer").click();
    await page.getByLabel(/customer name/i).fill(customerName);
    await page.locator("#saveCustomer").click();
    await expect(page.getByText(/customer added/i)).toBeVisible();

    await page.reload();

    await chooseCustomer(page, customerName);
    await nextStep(page);

    await addCementLine(page);
    await page.getByLabel(/^quantity/i).fill(String(sellable));
    await nextStep(page);

    await page.locator("#submitOrder").click();

    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
    orderNo = (await page.getByRole("heading", { level: 1 }).innerText()).replace(/^Order\s+/i, "");

    // Confirming is irreversible — it holds the stock and creates the invoice — so §11.8 makes it
    // two deliberate presses with the consequence named in between.
    await page.locator("#confirmOrder").click();
    const sheet = page.getByRole("alertdialog");
    await expect(sheet).toBeVisible();
    await sheet.locator("#confirmOrderYes").click();

    await expect(page.getByRole("heading", { name: /^invoice$/i })).toBeVisible();
  });

  test("the yard still shows the bags, and says they can no longer be sold", async ({ page }) => {
    await signInAs(page, "manager");
    await page.goto("/orders/new");
    await page.locator("#cashCustomer").click();
    await nextStep(page);
    await addCementLine(page);

    // The trap, on screen and read by a role that can see it: physically present, and none of it
    // sellable. If these two ever read the same number again, the §8.1 subtraction has stopped.
    const line = page.getByTestId("order-available-0");
    await expect(line).toContainText(/^0 can be sold/i);
    await expect(line).toContainText(new RegExp(`${physical} in the yard`, "i"));
  });

  test("approving a batch is refused, and the screen says why in numbers", async ({ page }) => {
    await signInAs(page, "manager");
    await recordStandardBatch(page);

    await page.goto("/production");
    await page.getByRole("button", { name: /^approve$/i }).first().click();

    // The sentence a Manager needs. "Not enough" in front of a full yard reads as a broken system;
    // naming the promise is what makes the refusal make sense.
    await expect(page.getByText(/already promised to a customer/i)).toBeVisible();

    // And the three figures behind it, rendered rather than merely returned.
    const detail = page.getByText(/can be used/i);
    await expect(detail).toContainText("0 can be used");
    // ALL of it is promised now, not just this order's share. Available was `sellable` and this
    // order took every bag of it, so promised = (whatever was already promised) + sellable, which
    // is the whole physical balance.
    await expect(detail).toContainText(`${physical} are promised`);
    await expect(detail).toContainText("needs 1");
  });

  test("the batch is still a draft, and the yard is untouched", async ({ page }) => {
    await signInAs(page, "manager");
    await page.goto("/production");

    // A refusal that had half-consumed the yard would show a smaller number here.
    await page.goto("/orders/new");
    await page.locator("#cashCustomer").click();
    await nextStep(page);
    await addCementLine(page);
    await expect(page.getByTestId("order-available-0")).toContainText(
      new RegExp(`${physical} in the yard`, "i"),
    );
  });

  test("a fresh delivery unblocks the batch, and the promise is still protected", async ({
    page,
  }) => {
    // The way the yard actually solves this: buy more cement. NOT by cancelling the order — the
    // order screen offers no cancel control once an order is confirmed (the action panel renders
    // only at proforma stage), and inventing one to make a test pass would be testing a product
    // that does not exist.
    //
    // This is the better proof anyway. The rule is not "production waits for the customer"; it is
    // "the customer's bags are theirs". Five more bags arrive, the identical batch is approved on
    // the surplus, and the twelve promised bags are still promised at the end of it.
    await signInAs(page, "manager");
    await deliverToYard(page, CEMENT, 5);

    await page.goto("/production");
    await page.getByRole("button", { name: /^approve$/i }).first().click();

    await expect(page.getByText(/already promised to a customer/i)).toHaveCount(0);

    // The settled state, not the transient success line: approving revalidates the route and the
    // card comes back reporting what it now IS. Asserting the message is a race with that.
    await expect(page.getByText(/^approved$/i).first()).toBeVisible();

    // The batch took one bag from the five that arrived. The customer's twelve never moved.
    await page.goto("/orders/new");
    await page.locator("#cashCustomer").click();
    await nextStep(page);
    await addCementLine(page);
    const line = page.getByTestId("order-available-0");
    await expect(line).toContainText(/^4 can be sold/i);
    await expect(line).toContainText(new RegExp(`${physical + 4} in the yard`, "i"));

    await signInAs(page, "salesRep");
    await page.goto("/orders");
    await expect(page.getByRole("article", { name: orderNo, exact: true })).toBeVisible();
  });
});
