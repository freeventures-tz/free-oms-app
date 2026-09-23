import { expect, test, type Page } from "@playwright/test";

import { expectLandsOn, fixtures, openNavigation, signIn } from "./fixtures";

/**
 * Orders, quotations and invoices, on every device tier.
 *
 * What is proved here that no other layer can prove:
 *
 *   · That a Sales Representative writes an order WITHOUT TYPING A TOTAL. product.md §5.2 forbids
 *     asking for one, and only a browser can show that no such field exists (AC-2).
 *   · That the product and the customer are FOUND BY SEARCHING and chosen from results, not hunted
 *     through a dropdown (design.md §7.4, §7.5, §10.1).
 *   · That a phone gets Customer → Items → Review and LOSES NOTHING going back a step (§7.4).
 *   · That the screen never implies a bill before there is one. design.md §7.6: order number and
 *     proforma number together, and no invoice until the customer confirms.
 *   · That confirmation is TWO STEPS and names its consequence before it happens (§7A.2, §10.8).
 *   · That a quotation can actually be revised from the screen, keeping the earlier version (§12.1).
 *   · That a Manager beyond their discount limit is OFFERED NOTHING and refused by the database
 *     either way — approving and rejecting alike (§4, §4.3, design.md §4.4).
 *   · That a walk-in sale says plainly it creates no invoice and holds no stock (§12.4).
 */

const ORDERS_HREF = "/orders";
const NEW_ORDER_HREF = "/orders/new";

type Who = "director" | "manager" | "cashier" | "salesRep" | "salesRepTwo";

async function signInAs(page: Page, who: Who) {
  const account = fixtures()[who];
  await signIn(page, account.phone, account.password);
  await expectLandsOn(
    page,
    who === "cashier"
      ? "/payments"
      : who === "salesRep" || who === "salesRepTwo"
        ? "/orders"
        : "/dashboard",
  );
}

/**
 * The product this file sells, created by the first test below.
 *
 * Module-level and shared by all the describe blocks on purpose: they run in declaration order in
 * one worker, and one fixture product beats several cluttering the catalogue. If the first block
 * fails to create it, the later ones fail loudly — which is the right direction to fail in.
 */
let PRODUCT = "";
/**
 * The registered (non-cash) customer this file sells to, created by the first block and shared for
 * the same reason. Cash Customer is a separate preset and answers a different question.
 */
let CUSTOMER = "";
const UNIT_PRICE_TZS = 25_000;

function unique(prefix: string): string {
  return `${prefix} ${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

/**
 * Move to the next step of the phone flow, if there is one.
 *
 * The three sections are one layout with a CSS decision on top: below `md` only the active step is
 * shown, and from `md` up all three are visible at once. The stepper bar is `md:hidden`, so this is
 * a no-op on tablet and desktop and the same test body proves both shapes.
 */
async function nextStep(page: Page) {
  const next = page.locator("#stepNext");
  if (await next.isVisible()) await next.click();
}

/**
 * Put the signed-in person into one language and wait for it to take.
 *
 * The shell carries a switcher in the phone header AND in the tablet-and-up bar; both are in the
 * DOM on every tier and exactly one is on screen, so the visible one is the one to press. The
 * English option is labelled in whichever language is current — "English" or "Kiingereza" — which
 * is why this matches either.
 */
async function useLanguage(page: Page, language: "en" | "sw") {
  const option = page
    .getByRole("button", { name: language === "en" ? /^(English|Kiingereza)$/ : /^Kiswahili$/ })
    .filter({ visible: true });

  await option.click();
  await expect(option).toHaveAttribute("aria-pressed", "true");
}

async function chooseCustomer(page: Page, name: string) {
  await page.getByLabel(/choose a customer/i).fill(name);
  await page.getByTestId("customer-results").getByRole("button", { name }).click();
}

async function addProductLine(page: Page, product: string, quantity: string) {
  await page.getByLabel(/^product$/i).fill(product);
  await page.getByTestId("order-product-results").getByRole("button", { name: product }).click();
  await page.getByLabel(/^quantity/i).fill(quantity);
}

/**
 * Creates a product nothing else in the suite touches, prices it, and stocks it — all through the
 * real screens as a Director.
 *
 * It creates its OWN product rather than reusing a seeded one, and that is not caution for its own
 * sake: the three device projects share one database, and `catalogue.spec.ts` sets a price of
 * 33 000 on Marine 12 mm before this file runs. A test that assumed the seeded price passed alone
 * and failed in the suite, which is exactly the kind of shared-fixture coupling that makes a suite
 * untrustworthy. Every figure asserted below is arithmetic on a price this function set.
 *
 * Nothing here reaches into the database. A fixture that cheats proves nothing about the system,
 * and this exercises the three Stage 10 screens on the way past.
 */
async function createPricedProduct(
  page: Page,
  name: string,
  price: string,
  quantity: string,
): Promise<void> {
  await signInAs(page, "director");

  await page.goto("/settings/products");
  await page.locator("#productName").fill(name);
  await page.locator("#productUnit").selectOption({ label: "piece" });
  await page.locator("#addProduct").click();
  await expect(page.getByText(new RegExp(`${name} added`, "i"))).toBeVisible();

  const card = page.getByRole("article", { name, exact: true });
  await card.getByRole("button", { name: /set price/i }).click();
  await card.getByLabel(/price in tzs/i).fill(price);
  await card.getByLabel(/why is it changing/i).fill("e2e fixture");
  await card.getByRole("button", { name: /save price/i }).click();
  await expect(card.getByText(/price saved/i)).toBeVisible();

  await page.goto("/inventory");
  await page.getByTestId("location-tab-store").click();
  await page.getByRole("button", { name: /record opening stock/i }).click();
  await page.getByLabel(/^product$/i).selectOption({ label: name });
  await page.getByLabel(/^quantity/i).fill(quantity);
  await page.locator("#saveOpeningStock").click();
  await expect(page.getByText(/opening stock recorded/i)).toBeVisible();
}

// ---------------------------------------------------------------------------
// The journey: an order becomes a quotation, and a quotation becomes an invoice
// ---------------------------------------------------------------------------
test.describe.serial("an order becomes an invoice", () => {
  let orderNo: string;

  test("a Director prices and stocks what will be sold", async ({ page }) => {
    PRODUCT = unique("E2E Sale Item");
    await createPricedProduct(page, PRODUCT, String(UNIT_PRICE_TZS), "400");
  });

  test("a Sales Representative writes an order without typing a single total", async ({ page }) => {
    CUSTOMER = unique("E2E Customer");

    await signInAs(page, "salesRep");
    await page.goto(NEW_ORDER_HREF);

    await page.locator("#addCustomer").click();
    await page.getByLabel(/customer name/i).fill(CUSTOMER);
    await page.locator("#saveCustomer").click();
    await expect(page.getByText(/customer added/i)).toBeVisible();

    await page.reload();

    // Step 1 — the customer is FOUND, not scrolled to (design.md §7.5).
    await chooseCustomer(page, CUSTOMER);
    await nextStep(page);

    // Step 2 — the product likewise, and the result carries its price and what is left to sell
    // before the choice is made (§7.4, §10.1).
    await page.getByLabel(/^product$/i).fill(PRODUCT);
    const result = page.getByTestId("order-product-results").getByRole("button", { name: PRODUCT });
    await expect(result).toContainText(/can be sold/i);
    await result.click();

    // Selecting adds the line at one, and the stepper takes it from there.
    await expect(page.getByLabel(/^quantity/i)).toHaveValue("1");
    await page.locator("#orderIncrease0").click();
    await expect(page.getByLabel(/^quantity/i)).toHaveValue("2");
    await page.locator("#orderDecrease0").click();
    await expect(page.getByLabel(/^quantity/i)).toHaveValue("1");

    await page.getByLabel(/^quantity/i).fill("8");

    // Every total on the page is calculated. product.md §5.2 says a user must never be asked to
    // type a line total or a subtotal, and the absence is the assertion.
    await expect(page.getByTestId("order-line-total-0")).toContainText("200,000");
    await expect(page.getByLabel(/line total/i)).toHaveCount(0);
    await expect(page.getByLabel(/subtotal/i)).toHaveCount(0);
    await expect(page.getByLabel(/price each/i)).toHaveCount(0);

    // §14.1: quantity shortcut chips are configured by a Director per product, and none is
    // configured. The interface must not invent a row of them.
    await expect(page.getByRole("button", { name: /^(10|20|50|100)$/ })).toHaveCount(0);

    await nextStep(page);

    // Step 3 — review, and the subtotal lives here on every tier.
    await expect(page.getByTestId("review-customer")).toContainText(CUSTOMER);
    await expect(page.getByTestId("order-subtotal")).toContainText("200,000");

    await page.locator("#submitOrder").click();

    // Straight to the order, where the proforma number is.
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
    orderNo = (await page.getByRole("heading", { level: 1 }).innerText()).replace(/^Order\s+/i, "");
    expect(orderNo).toMatch(/^FV-ORD-\d{8}-\d{4}$/);
  });

  test("the order shows a quotation and says plainly it is not a bill", async ({ page }) => {
    await signInAs(page, "salesRep");
    await page.goto(ORDERS_HREF);
    await page.getByRole("article", { name: orderNo, exact: true }).click();

    await expect(page.getByText(/quotation, version 1/i)).toBeVisible();
    await expect(page.getByText(/FV-PRO-/)).toBeVisible();

    // design.md §7.6 and §7A.1: the whole risk of this screen is a reader treating a quotation as
    // an invoice, so the page says so and shows no invoice at all.
    await expect(page.getByText(/this is a quotation, not a bill/i)).toBeVisible();
    await expect(page.getByText(/FV-INV-/)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /^invoice$/i })).toHaveCount(0);
  });

  test("the customer asks for more, and the quotation is revised from the screen", async ({
    page,
  }) => {
    await signInAs(page, "salesRep");
    await page.goto(ORDERS_HREF);
    await page.getByRole("article", { name: orderNo, exact: true }).click();

    // §12.1 point 4. The command has always existed; until this release no screen called it, so the
    // most ordinary request a customer makes could not be answered without starting again.
    await page.locator("#reviseOrder").click();

    // The draft opens on what the order already says, so changing a quantity is two taps.
    await expect(page.getByLabel(/^quantity/i)).toHaveValue("8");
    await page.getByLabel(/^quantity/i).fill("12");
    await expect(page.getByTestId("revise-subtotal")).toContainText("300,000");

    await page.locator("#submitRevision").click();

    // The DURABLE state: a new version, not the message that announced it.
    await expect(page.getByText(/quotation, version 2/i)).toBeVisible();

    await page.reload();
    await expect(page.getByText(/quotation, version 2/i)).toBeVisible();
    // Nothing is overwritten: the version the customer already holds is still readable.
    await expect(page.getByText(/earlier versions \(1\)/i)).toBeVisible();
  });

  test("confirming is two steps, and produces exactly one invoice while holding the stock", async ({
    page,
  }) => {
    await signInAs(page, "salesRep");
    await page.goto(ORDERS_HREF);
    await page.getByRole("article", { name: orderNo, exact: true }).click();

    // STEP ONE opens the confirmation and commits to nothing.
    await page.locator("#confirmOrder").click();

    // §10.8 and §11.8: it names the specific consequence before it happens.
    const sheet = page.getByRole("alertdialog");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText(/confirming holds the stock and creates the invoice/i);

    // And it does not dismiss itself — an irreversible confirmation requires an explicit choice.
    await page.keyboard.press("Escape");
    await expect(sheet).toBeVisible();

    // STEP TWO is a separate, deliberate press.
    await sheet.locator("#confirmOrderYes").click();

    // The DURABLE state, not the transient success line. Confirming revalidates the route, the
    // order comes back confirmed, and the panel that carried the message is gone — correctly, since
    // there is nothing left to confirm. Asserting the message is a race; asserting the invoice is
    // not.
    await expect(page.getByRole("heading", { name: /^invoice$/i })).toBeVisible();

    await page.reload();
    await expect(page.getByText(/FV-INV-/)).toBeVisible();
    // §12.3 derives the status from money received, and this role may not read what was received
    // (design.md §4.2). So the card says the status is not shown — which is true — rather than
    // Unpaid, which it would have no way of knowing. It said Unpaid for years, to everybody, on
    // every invoice; that is the defect this assertion used to encode.
    await expect(page.getByText(/payment status not shown/i)).toBeVisible();
    await expect(page.getByText(/^unpaid$/i)).toHaveCount(0);
    await expect(page.getByText(/units held for this order/i)).toBeVisible();

    // Exactly one — the invoice heading appears once on the page.
    await expect(page.getByRole("heading", { name: /^invoice$/i })).toHaveCount(1);
  });

  test("a confirmed order cannot be quietly re-quoted", async ({ page }) => {
    await signInAs(page, "salesRep");
    await page.goto(ORDERS_HREF);
    await page.getByRole("article", { name: orderNo, exact: true }).click();

    // Confirming, revising and re-quoting are all gone: the order is no longer at the quotation
    // stage, and an invoice is immutable (AC-12).
    await expect(page.locator("#confirmOrder")).toHaveCount(0);
    await expect(page.locator("#requestDiscount")).toHaveCount(0);
    await expect(page.locator("#reviseOrder")).toHaveCount(0);
    await expect(page.getByText(/an invoice cannot be changed/i)).toBeVisible();

    // And the one decision §4.3 still allows is offered, with its consequence stated before it
    // happens (design.md §10.8).
    await expect(page.locator("#cancelOrder")).toBeVisible();
    await expect(page.getByText(/cancelling releases the stock held for this order/i)).toBeVisible();
  });

  test("cancelling it releases the stock and keeps the invoice number", async ({ page }) => {
    await signInAs(page, "salesRep");
    await page.goto(ORDERS_HREF);
    await page.getByRole("article", { name: orderNo, exact: true }).click();

    // Wait for the DETAIL page before reading anything off it. The orders list renders
    // "Invoice FV-INV-…" on the card that was just clicked, so a bare read races the navigation and
    // resolves against the list.
    await expect(page.getByRole("heading", { name: /^invoice$/i })).toBeVisible();
    const invoiceNo = (await page.getByText(/^FV-INV-\d{8}-\d{4}$/).innerText()).trim();

    await page.locator("#cancelOrder").click();
    await page.getByLabel(/why is it being cancelled/i).fill("customer changed their mind");
    await page.locator("#confirmCancel").click();

    await expect(page.getByText(/^cancelled$/i).first()).toBeVisible();

    await page.reload();
    // AC-11: the invoice is kept, with the SAME number, and reads Cancelled rather than Unpaid.
    await expect(page.getByText(invoiceNo)).toBeVisible();
    await expect(page.getByText(/^unpaid$/i)).toHaveCount(0);
    await expect(page.getByText(/cancelled: customer changed their mind/i).first()).toBeVisible();
    // Cancellation outranks the settlement boundary: nobody owes a cancelled invoice, so there is
    // no status being withheld and the card stops saying one is.
    await expect(page.getByText(/payment status not shown/i)).toHaveCount(0);

    // The reservation is released, so the card that reported it is gone (§4.3).
    await expect(page.getByText(/units held for this order/i)).toHaveCount(0);

    // A cancelled order is decided. Nothing on it can be acted on again.
    await expect(page.locator("#cancelOrder")).toHaveCount(0);
    await expect(page.locator("#confirmOrder")).toHaveCount(0);
    await expect(page.locator("#reviseOrder")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Cancellation at the quotation stage, where there is no invoice to keep
// ---------------------------------------------------------------------------
test.describe.serial("a quotation is cancelled before anyone confirms it", () => {
  let orderNo: string;

  test("a Sales Representative writes one", async ({ page }) => {
    await signInAs(page, "salesRep");
    await page.goto(NEW_ORDER_HREF);

    await chooseCustomer(page, CUSTOMER);
    await nextStep(page);
    await addProductLine(page, PRODUCT, "3");
    await nextStep(page);
    await page.locator("#submitOrder").click();

    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
    orderNo = (await page.getByRole("heading", { level: 1 }).innerText()).replace(/^Order\s+/i, "");
    expect(orderNo).toMatch(/^FV-ORD-\d{8}-\d{4}$/);
  });

  test("cancelling it leaves no invoice behind", async ({ page }) => {
    await signInAs(page, "salesRep");
    await page.goto(ORDERS_HREF);
    await page.getByRole("article", { name: orderNo, exact: true }).click();

    await page.locator("#cancelOrder").click();

    // A reason is required, and the value survives the refusal (design.md §12.7).
    await page.getByLabel(/why is it being cancelled/i).fill("x");
    await page.locator("#confirmCancel").click();
    await expect(page.getByText(/say why, in a few words/i)).toBeVisible();
    await expect(page.getByLabel(/why is it being cancelled/i)).toHaveValue("x");

    await page.getByLabel(/why is it being cancelled/i).fill("quoted the wrong site");
    await page.locator("#confirmCancel").click();

    await expect(page.getByText(/^cancelled$/i).first()).toBeVisible();

    await page.reload();
    await expect(page.getByText(/cancelled: quoted the wrong site/i).first()).toBeVisible();
    // Nothing was ever owed, so nothing is kept: a quotation that was never accepted leaves no
    // invoice and no reservation (§12.1 point 3).
    await expect(page.getByText(/FV-INV-/)).toHaveCount(0);
    await expect(page.getByText(/units held for this order/i)).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// The discount limits, shown as well as enforced
// ---------------------------------------------------------------------------
test.describe.serial("a discount beyond a Manager's limit", () => {
  let orderNo: string;

  test("a Sales Representative asks for one on a small order", async ({ page }) => {
    await signInAs(page, "salesRep");
    await page.goto(NEW_ORDER_HREF);

    await chooseCustomer(page, CUSTOMER);
    await nextStep(page);
    await addProductLine(page, PRODUCT, "4");
    await nextStep(page);
    await page.locator("#submitOrder").click();

    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
    orderNo = (await page.getByRole("heading", { level: 1 }).innerText()).replace(/^Order\s+/i, "");

    await page.locator("#requestDiscount").click();
    await page.getByLabel(/discount percentage/i).fill("2");
    await page.getByLabel(/^why\?$/i).fill("regular customer");
    await page.locator("#submitDiscount").click();

    // 4 × 25 000 = 100 000, at or below TZS 1 000 000, so ANY discount is a Director's (AC-18).
    await expect(page.getByText(/sent to a director for approval/i)).toBeVisible();
  });

  test("a Manager is told whose decision it is and offered neither half of it", async ({ page }) => {
    await signInAs(page, "manager");
    await page.goto(ORDERS_HREF);
    await page.getByRole("article", { name: orderNo, exact: true }).click();

    // design.md §7.8: limit enforcement is SHOWN, not just enforced.
    await expect(page.getByText(/waiting for a director/i)).toBeVisible();

    // design.md §4.4 puts this under HIDDEN: it is not a block the Manager can clear. And it is
    // BOTH controls — §4.3 makes a rejection a completed decision, so a Manager able to refuse it
    // would be settling it without a Director ever seeing it.
    await expect(page.locator("#approveDiscount")).toHaveCount(0);
    await expect(page.locator("#rejectDiscount")).toHaveCount(0);
    await expect(page.locator("#discountBeyondManagerLimit")).toBeVisible();
  });

  test("confirmation is disabled while the discount is undecided, and says why", async ({
    page,
  }) => {
    await signInAs(page, "salesRep");
    await page.goto(ORDERS_HREF);
    await page.getByRole("article", { name: orderNo, exact: true }).click();

    await expect(page.locator("#confirmOrder")).toBeDisabled();
    await expect(page.getByText(/a discount is waiting for a decision/i).first()).toBeVisible();
  });

  test("a Director approves it, and the customer is re-quoted", async ({ page }) => {
    await signInAs(page, "director");
    await page.goto(ORDERS_HREF);
    await page.getByRole("article", { name: orderNo, exact: true }).click();

    await page.locator("#approveDiscount").click();

    // §12.1 point 4 again: approving changes what the customer is quoted, so they are quoted again.
    await expect(page.getByText(/quotation, version 2/i)).toBeVisible();
    await expect(page.getByText(/approved by/i)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// The walk-in path says what it does
// ---------------------------------------------------------------------------
test.describe.serial("a Cash Customer sale", () => {
  let orderNo: string;

  test("the screen warns that nothing is owed and nothing is held", async ({ page }) => {
    // ITS OWN PRODUCT IF IT HAS TO. `PRODUCT` is module state created by the first block, and
    // Playwright discards the worker after ANY failure — so one unrelated failure earlier in this
    // file re-imports the module, resets `PRODUCT` to an empty string, and every test below then
    // fails looking for an option labelled "". The fixture is rebuilt here so a failure stays one
    // failure. (Ported from the reviewed issue #19 source at `a34704a` by issue #51, because main
    // still has the same module-state dependency.)
    if (!PRODUCT) {
      PRODUCT = unique("E2E Sale Item");
      await createPricedProduct(page, PRODUCT, String(UNIT_PRICE_TZS), "400");
      await page.context().clearCookies();
    }

    await signInAs(page, "salesRep");
    await page.goto(NEW_ORDER_HREF);

    // A single prominent preset, not an item lost in a list (design.md §7.5).
    await page.locator("#cashCustomer").click();
    await expect(page.getByText(/a walk-in sale\. nothing is owed/i)).toBeVisible();

    await nextStep(page);
    await addProductLine(page, PRODUCT, "2");
    await nextStep(page);
    await page.locator("#submitOrder").click();

    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
    orderNo = (await page.getByRole("heading", { level: 1 }).innerText()).replace(/^Order\s+/i, "");
  });

  test("confirming it creates no invoice and holds no stock", async ({ page }) => {
    await signInAs(page, "salesRep");
    await page.goto(ORDERS_HREF);
    await page.getByRole("article", { name: orderNo, exact: true }).click();

    await page.locator("#confirmOrder").click();
    const sheet = page.getByRole("alertdialog");
    await expect(sheet).toContainText(/confirming creates no invoice and holds no stock/i);
    await sheet.locator("#confirmOrderYes").click();

    await expect(page.getByText(/^confirmed$/i)).toBeVisible();

    await page.reload();
    // AC-86 and AC-87, in the browser: no invoice, no reservation.
    await expect(page.getByText(/FV-INV-/)).toHaveCount(0);
    await expect(page.getByText(/units held for this order/i)).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// A refusal the person is inside a sheet to hear
// ---------------------------------------------------------------------------
test.describe.serial("a confirmation the server refuses", () => {
  let orderNo: string;
  let scarce: string;

  test("a Director stocks two of something", async ({ page }) => {
    scarce = unique("E2E Scarce Item");
    await createPricedProduct(page, scarce, "25000", "2");
  });

  test("a Sales Representative quotes five of it", async ({ page }) => {
    // A separate test, and therefore a separate browser context: `signIn` starts at `/sign-in`, and
    // a page that still holds the Director's session is sent to their landing page instead.
    await signInAs(page, "salesRep");
    await page.goto(NEW_ORDER_HREF);
    await chooseCustomer(page, CUSTOMER);
    await nextStep(page);
    await addProductLine(page, scarce, "5");
    await nextStep(page);
    await page.locator("#submitOrder").click();

    // A quotation reserves nothing, so quoting more than the yard holds is legal (§12.1 point 3).
    // The refusal arrives at confirmation, which is the moment stock is actually claimed.
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
    orderNo = (await page.getByRole("heading", { level: 1 }).innerText()).replace(/^Order\s+/i, "");
  });

  test("says so inside the sheet, with the figures and a retry", async ({ page }) => {
    await signInAs(page, "salesRep");
    await page.goto(ORDERS_HREF);
    await page.getByRole("article", { name: orderNo, exact: true }).click();

    await page.locator("#confirmOrder").click();
    const sheet = page.getByRole("alertdialog");
    await sheet.locator("#confirmOrderYes").click();

    // INSIDE the sheet. `AlertDialog` traps focus, so a refusal rendered on the card behind it is
    // a message nobody can reach without dismissing the thing that produced it.
    const refusal = sheet.getByRole("alert");
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText(/there is not enough stock/i);
    await expect(refusal).toContainText(/2 can be sold, 5 asked for/i);

    // The sheet stays open, and the way forward is in it.
    await expect(sheet).toBeVisible();
    await expect(sheet.locator("#retryConfirmOrder")).toBeVisible();

    await sheet.locator("#retryConfirmOrder").click();
    await expect(sheet.getByRole("alert")).toContainText(/there is not enough stock/i);

    // Nothing was created by either attempt.
    await sheet.getByRole("button", { name: /go back/i }).click();
    await page.reload();
    await expect(page.getByText(/FV-INV-/)).toHaveCount(0);
    await expect(page.getByText(/units held for this order/i)).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// One representative's order, another representative's screen
// ---------------------------------------------------------------------------
test.describe.serial("a discount somebody else asked for", () => {
  let orderNo: string;

  test("a Sales Representative raises one on their own order", async ({ page }) => {
    await signInAs(page, "salesRep");
    await page.goto(NEW_ORDER_HREF);

    await chooseCustomer(page, CUSTOMER);
    await nextStep(page);
    await addProductLine(page, PRODUCT, "5");
    await nextStep(page);
    await page.locator("#submitOrder").click();

    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
    orderNo = (await page.getByRole("heading", { level: 1 }).innerText()).replace(/^Order\s+/i, "");

    await page.locator("#requestDiscount").click();
    await page.getByLabel(/discount percentage/i).fill("3");
    await page.getByLabel(/^why\?$/i).fill("site visit");
    await page.locator("#submitDiscount").click();
    await expect(page.getByText(/sent to a director for approval/i)).toBeVisible();
  });

  test("a DIFFERENT representative sees it and is not offered a confirmation", async ({ page }) => {
    await signInAs(page, "salesRepTwo");
    await page.goto(ORDERS_HREF);
    await page.getByRole("article", { name: orderNo, exact: true }).click();

    // §12.6 lets any of the three order roles confirm any order, so the pending decision has to be
    // visible to all of them. It was not: Stage 8A showed a Sales Representative only the requests
    // they raised themselves, so a colleague saw nothing, was offered an enabled Confirm, and was
    // refused by the database after pressing it.
    await expect(page.getByText(/waiting for a director/i)).toBeVisible();
    await expect(page.locator("#confirmOrder")).toBeDisabled();
    await expect(page.getByText(/a discount is waiting for a decision/i).first()).toBeVisible();

    // The widening is the pending STATE, not the authority: deciding it is still nobody's here.
    await expect(page.locator("#approveDiscount")).toHaveCount(0);
    await expect(page.locator("#rejectDiscount")).toHaveCount(0);

    // And the order names the person who wrote it. `profiles` admits a Manager and a Director
    // alone, so this used to read "Created by  (Sales Representative)" — a sentence with a hole
    // where a person should be.
    await expect(page.getByText(/created by e2e sales rep \(sales representative\)/i)).toBeVisible();
  });

  test("a Cashier is told who wrote it too, in both languages", async ({ page }) => {
    await signInAs(page, "cashier");
    await page.goto(ORDERS_HREF);
    await page.getByRole("article", { name: orderNo, exact: true }).click();

    // A language choice follows the person, not the device (design.md §8.1), so this test both
    // starts from a known one and puts it back — otherwise the tier that runs first decides what
    // language every later Cashier test is written in.
    await useLanguage(page, "en");
    await expect(
      page.getByText(/created by e2e sales rep \(sales representative\)/i),
    ).toBeVisible();
    // No sentence may say "by" and then name nobody.
    await expect(page.getByText(/created by\s{2,}\(/i)).toHaveCount(0);

    await useLanguage(page, "sw");
    await expect(page.getByText(/imetengenezwa na e2e sales rep \(muuzaji\)/i)).toBeVisible();
    await expect(page.getByText(/imetengenezwa na\s{2,}\(/i)).toHaveCount(0);

    await useLanguage(page, "en");
  });
});

// ---------------------------------------------------------------------------
// The phone flow, which is a different shape rather than a narrower one
// ---------------------------------------------------------------------------
test.describe("the three-step order on a phone", () => {
  test("keeps everything entered when the person goes back a step", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the stepper exists below the md breakpoint");

    await signInAs(page, "salesRep");
    await page.goto(NEW_ORDER_HREF);

    await expect(page.getByTestId("step-indicator")).toContainText(/step 1 of 3/i);
    await chooseCustomer(page, CUSTOMER);

    await page.locator("#stepNext").click();
    await expect(page.getByTestId("step-indicator")).toContainText(/step 2 of 3/i);
    await addProductLine(page, PRODUCT, "7");

    // The persistent bar carries the count and the running total the whole way (design.md §7.4).
    await expect(page.getByTestId("running-total")).toContainText("175,000");

    await page.locator("#stepNext").click();
    await expect(page.getByTestId("step-indicator")).toContainText(/step 3 of 3/i);
    await expect(page.getByTestId("review-customer")).toContainText(CUSTOMER);

    // BACK, twice, and nothing is lost. The three sections are one mounted layout with a CSS
    // decision on top, so there is no draft to restore and nothing to forget to restore.
    await page.locator("#stepBack").click();
    await expect(page.getByLabel(/^quantity/i)).toHaveValue("7");

    await page.locator("#stepBack").click();
    await expect(page.getByTestId("step-indicator")).toContainText(/step 1 of 3/i);
    await expect(
      page.getByTestId("customer-results").getByRole("button", { name: CUSTOMER }),
    ).toHaveAttribute("aria-pressed", "true");

    // Forward again, and the order is still exactly what it was.
    await page.locator("#stepNext").click();
    await page.locator("#stepNext").click();
    await expect(page.getByTestId("review-customer")).toContainText(CUSTOMER);
    await expect(page.getByTestId("order-subtotal")).toContainText("175,000");
  });

  test("brings a refused submission back to the first thing that is wrong", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the hidden steps only exist below md");

    await signInAs(page, "salesRep");
    await page.goto(NEW_ORDER_HREF);

    // Straight to Review with nothing entered, and submit. Every field this can fail on lives on an
    // earlier step — which on a phone is a step that is not on screen.
    await page.locator("#stepNext").click();
    await page.locator("#stepNext").click();
    await page.locator("#submitOrder").click();

    const problems = page.getByTestId("order-problems");
    await expect(problems).toBeVisible();
    await expect(problems).toContainText(/that customer is not available/i);
    await expect(problems).toContainText(/add at least one item/i);

    // Announced AND focused: a person who cannot see the screen is told, and a person who can is
    // taken there rather than left pressing a button that appears to do nothing.
    await expect(problems).toHaveAttribute("role", "alert");
    await expect(problems).toBeFocused();

    // Moved to the FIRST invalid step, which is the customer.
    await expect(page.getByTestId("step-indicator")).toContainText(/step 1 of 3/i);
    await chooseCustomer(page, CUSTOMER);

    // And the summary offers the way to the other one.
    await page.locator("#goTo-items").click();
    await expect(page.getByTestId("step-indicator")).toContainText(/step 2 of 3/i);

    await page.getByLabel(/^product$/i).fill(PRODUCT);
    await page.getByTestId("order-product-results").getByRole("button", { name: PRODUCT }).click();
    await page.getByLabel(/^quantity/i).fill("0");

    await page.locator("#stepNext").click();
    await page.locator("#submitOrder").click();

    // An invalid quantity is an items problem, so it lands there.
    await expect(page.getByTestId("order-problems")).toContainText(
      /enter a whole number of units/i,
    );
    await expect(page.getByTestId("step-indicator")).toContainText(/step 2 of 3/i);

    // NOTHING was lost by either refusal: the quantity the person typed and the customer they
    // chose are both still there.
    await expect(page.getByLabel(/^quantity/i)).toHaveValue("0");
    await page.locator("#stepBack").click();
    await expect(
      page.getByTestId("customer-results").getByRole("button", { name: CUSTOMER }),
    ).toHaveAttribute("aria-pressed", "true");

    // Corrected, it goes through.
    await page.locator("#stepNext").click();
    await page.getByLabel(/^quantity/i).fill("2");
    await page.locator("#stepNext").click();
    await page.locator("#submitOrder").click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
  });

  test("shows one step at a time on a phone and all three at once above it", async ({
    page,
  }, testInfo) => {
    await signInAs(page, "salesRep");
    await page.goto(NEW_ORDER_HREF);

    const productSearch = page.getByLabel(/^product$/i);

    if (testInfo.project.name === "mobile") {
      // Step 1 only: the item picker belongs to step 2 and is not on screen yet.
      await expect(productSearch).toBeHidden();
      await expect(page.locator("#stepBack")).toBeDisabled();
      await page.locator("#stepNext").click();
      await expect(productSearch).toBeVisible();
    } else {
      // Tablet and desktop: customer, items and the sticky summary are all present at once (§7.4).
      await expect(page.getByLabel(/choose a customer/i)).toBeVisible();
      await expect(productSearch).toBeVisible();
      await expect(page.getByTestId("order-subtotal")).toBeVisible();
      await expect(page.locator("#stepNext")).toBeHidden();
    }
  });
});

// ---------------------------------------------------------------------------
// Roles, and what each is offered
// ---------------------------------------------------------------------------
test.describe("what the orders screens offer", () => {
  test("a Cashier reads orders and is offered no way to start one", async ({ page }, testInfo) => {
    await signInAs(page, "cashier");

    const navigation = await openNavigation(page, testInfo);
    await navigation.getByRole("link", { name: /^orders$/i }).click();

    await expect(page.getByRole("heading", { level: 1, name: /orders/i })).toBeVisible();
    // Absent, not greyed (design.md §4.3, §4.4).
    await expect(page.getByRole("link", { name: /create new order/i })).toHaveCount(0);
  });

  test("a Sales Representative is offered no way to decide a discount", async ({ page }) => {
    await signInAs(page, "salesRep");
    await page.goto(ORDERS_HREF);

    const first = page.getByRole("article").first();
    await first.click();

    await expect(page.locator("#approveDiscount")).toHaveCount(0);
    await expect(page.locator("#rejectDiscount")).toHaveCount(0);
  });

  test("the orders list never scrolls the page sideways", async ({ page }) => {
    await signInAs(page, "salesRep");
    await page.goto(ORDERS_HREF);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "the page body scrolls horizontally").toBeLessThanOrEqual(1);
  });

  test("an order's line table scrolls inside its own container on a phone", async ({ page }) => {
    await signInAs(page, "salesRep");
    await page.goto(ORDERS_HREF);
    await page.getByRole("article").first().click();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "the page body scrolls horizontally").toBeLessThanOrEqual(1);
  });

  test("the new-order screen never scrolls the page sideways either", async ({ page }) => {
    await signInAs(page, "salesRep");
    await page.goto(NEW_ORDER_HREF);
    await expect(page.getByLabel(/choose a customer/i)).toBeVisible();

    // The phone's fixed step bar and the two-column layout above `lg` are the two things most
    // likely to push the body wide, so this is asserted on the screen that has both.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "the page body scrolls horizontally").toBeLessThanOrEqual(1);
  });
});
