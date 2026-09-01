import { expect, test, type Locator, type Page } from "@playwright/test";

import { expectLandsOn, fixtures, openNavigation, signIn } from "./fixtures";

/**
 * Taking money and letting goods go, on every device tier.
 *
 * What is proved here that no other layer can prove:
 *
 *   · That CREDIT IS PRESENTED APART FROM THE SIX TENDERS and says in words that it records no
 *     money (product.md §12.5, design.md §7.7). Only a browser can show a control sitting apart.
 *   · That the balance due is the figure the screen leads with (§7.7 hierarchy).
 *   · That Confirm Release is DISABLED, with its reason shown, until a dispatch-note number exists
 *     (design.md §6.3, §4.4) — and that the OMS never offers to print the note (AC-37).
 *   · That a walk-in sale is ONE action with ONE confirmation, not four saves (§7A.3).
 *   · That a Manager beyond the TZS 500,000 credit limit is refused and told which limit (AC-17).
 *
 * Each journey is ONE test made of steps, not a serial block sharing variables between tests. A
 * journey is one thing happening, and writing it as one test makes the shared state real rather
 * than hoped for.
 */

const PAYMENTS_HREF = "/payments";
const DISPATCH_HREF = "/dispatch";
const ORDERS_HREF = "/orders";

/**
 * The fixtures this file owns, named at MODULE LOAD.
 *
 * Created rather than borrowed: the three device projects share one database and other specs price
 * the seeded catalogue, so every figure asserted below is arithmetic on a price this file set.
 */
const SUFFIX = Math.random().toString(36).slice(2, 8).toUpperCase();
const PRODUCT = `E2E Settle Item ${SUFFIX}`;
const STOREKEEPER = `E2E Keeper ${SUFFIX}`;
// A REGISTERED customer, not the walk-in one. `loadCustomers` sorts Cash Customer first so it is
// one tap away (design.md §7.5), which means picking the select by index lands on the walk-in path
// and confirms into no invoice at all (§12.4) — a difference this file tests deliberately.
const CUSTOMER = `E2E Settle Customer ${SUFFIX}`;
const UNIT_PRICE_TZS = 100_000;

async function signInAs(page: Page, who: "director" | "manager" | "cashier" | "salesRep") {
  const account = fixtures()[who];
  await signIn(page, account.phone, account.password);
  await expectLandsOn(
    page,
    who === "cashier" ? "/payments" : who === "salesRep" ? "/orders" : "/dashboard",
  );
}

/** Ends the current session so one test can walk through several people. */
async function switchTo(page: Page, who: "director" | "manager" | "cashier" | "salesRep") {
  await page.context().clearCookies();
  await signInAs(page, who);
}

function unique(prefix: string): string {
  return `${prefix} ${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

/**
 * Selects an option by the text it starts with.
 *
 * The storekeeper picker reads "Name (SK-0001)" — the server composes the label from two facts and
 * the code is generated, so a test cannot know it in advance. Matching the prefix and selecting by
 * VALUE keeps the assertion about the person rather than about the shape of the label.
 */
async function selectByPrefix(select: Locator, prefix: string): Promise<void> {
  const value = await select
    .locator("option")
    .filter({ hasText: prefix })
    .first()
    .getAttribute("value");
  if (!value) throw new Error(`no option starting with "${prefix}"`);
  await select.selectOption(value);
}

/**
 * Move to the next step of the phone flow, if there is one.
 *
 * Create New Order is one mounted layout with a CSS decision on top: below `md` only the active
 * step is shown, and from `md` up all three are visible at once. The stepper bar is `md:hidden`, so
 * this is a no-op on tablet and desktop and the same helper drives all three tiers.
 */
async function nextStep(page: Page) {
  const next = page.locator("#stepNext");
  if (await next.isVisible()) await next.click();
}

/** The customer is FOUND and picked from the results, never scrolled to (design.md §7.5). */
async function chooseCustomer(page: Page, name: string) {
  await page.getByLabel(/choose a customer/i).fill(name);
  await page.getByTestId("customer-results").getByRole("button", { name }).click();
}

/** The product likewise, from a selectable result card that carries its price (§7.4, §10.1). */
async function addProductLine(page: Page, product: string, quantity: string) {
  await page.getByLabel(/^product$/i).fill(product);
  await page.getByTestId("order-product-results").getByRole("button", { name: product }).click();
  await page.getByLabel(/^quantity/i).fill(quantity);
}

/**
 * Confirms the order through the two-step sheet v0.0.3 introduced (design.md §7A.2, §10.8).
 *
 * The first press only opens the confirmation; the second is the deliberate one. Waiting on the
 * durable state afterwards rather than on the control that started it, for the reason recorded in
 * the Stage 12 plan: a pending `Button` hides its label and exposes "Working…", so a role-and-name
 * locator stops matching the instant the click lands and long before the server answers.
 */
async function confirmOrder(page: Page, consequence: RegExp) {
  await page.locator("#confirmOrder").click();
  const sheet = page.getByRole("alertdialog");
  await expect(sheet).toContainText(consequence);
  await sheet.locator("#confirmOrderYes").click();
}

/**
 * Opens a confirmation, checks it NAMES THE CONSEQUENCE, and takes the second, separate press.
 *
 * design.md §11.8 lists the three actions on these screens that require one: approving credit,
 * completing a walk-in sale, and confirming a signed release. §10.8 adds that the dialog must name
 * the specific consequence rather than asking "are you sure?", which is what the `consequence`
 * argument asserts.
 */
async function confirmThrough(
  page: Page,
  open: Locator,
  consequence: RegExp,
  confirmLabel: RegExp,
) {
  await open.click();
  const sheet = page.getByRole("alertdialog");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(consequence);

  // It does not dismiss itself: an irreversible confirmation requires an explicit choice (§10.8).
  await page.keyboard.press("Escape");
  await expect(sheet).toBeVisible();

  await sheet.getByRole("button", { name: confirmLabel }).click();
}

/**
 * The balance-due figure on an invoice card.
 *
 * Scoped to the element that carries it, because the same amount also appears in "of TZS 600,000"
 * and in the not-yet-settled explanation. Matching loose text would pass on any of the three and
 * would keep passing if the prominent figure disappeared — which is the one thing design.md §7.7
 * asks this card to get right.
 */
function balanceOn(card: Locator): Locator {
  return card.locator('[data-testid^="balance-"]');
}

/**
 * What the stock screen says is in the store right now, read in its OWN Director session.
 *
 * It cannot borrow the caller's page: this journey walks through four people, and "Inventory &
 * stock" belongs to a Manager and a Director (design.md §4.2). A Cashier asking the same question
 * is sent to /no-access — correctly — so the reading is done by somebody entitled to it rather
 * than by whoever happens to be signed in mid-journey.
 */
async function stockInStore(page: Page): Promise<number> {
  const context = await page.context().browser()!.newContext();
  const reader = await context.newPage();
  try {
    await signInAs(reader, "director");
    await reader.goto("/inventory");
    await reader.getByTestId("location-tab-store").click();
    const card = reader.getByRole("article", { name: PRODUCT, exact: true });
    return Number(await card.getByTestId("stock-quantity").getAttribute("data-quantity"));
  } finally {
    await context.close();
  }
}

/**
 * Everything this file sells and dispatches, created once through the real screens.
 *
 * Nothing reaches into the database: a fixture that cheats proves nothing about the system, and
 * this exercises the catalogue, stock, storekeeper and customer screens on the way past.
 */
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await signInAs(page, "director");

    await page.goto("/settings/products");
    await page.locator("#productName").fill(PRODUCT);
    await page.locator("#productUnit").selectOption({ label: "piece" });
    await page.locator("#addProduct").click();
    await expect(page.getByText(new RegExp(`${PRODUCT} added`, "i"))).toBeVisible();

    const card = page.getByRole("article", { name: PRODUCT, exact: true });
    await card.getByRole("button", { name: /set price/i }).click();
    await card.getByLabel(/price in tzs/i).fill(String(UNIT_PRICE_TZS));
    await card.getByLabel(/why is it changing/i).fill("e2e fixture");
    await card.getByRole("button", { name: /save price/i }).click();
    await expect(card.getByText(/price saved/i)).toBeVisible();

    await page.goto("/inventory");
    await page.getByTestId("location-tab-store").click();
    await page.getByRole("button", { name: /record opening stock/i }).click();
    await page.getByLabel(/^product$/i).selectOption({ label: PRODUCT });
    await page.getByLabel(/^quantity/i).fill("500");
    await page.locator("#saveOpeningStock").click();
    await expect(page.getByText(/opening stock recorded/i)).toBeVisible();

    await page.goto("/settings/storekeepers");
    await page.getByLabel(/full name/i).fill(STOREKEEPER);
    await page.getByLabel(/started on/i).fill(new Date().toISOString().slice(0, 10));
    await page.locator("#addStorekeeper").click();
    await expect(page.getByText(/storekeeper registered/i)).toBeVisible();

    await page.goto("/orders/new");
    await page.locator("#addCustomer").click();
    await page.getByLabel(/customer name/i).fill(CUSTOMER);
    await page.locator("#saveCustomer").click();
    await expect(page.getByText(/customer added/i)).toBeVisible();
  } finally {
    await page.close();
  }
});

/** A confirmed order with an invoice, ready for the Cashier. Returns the invoice number. */
async function sellTo(page: Page, customer: string, quantity: number): Promise<string> {
  await page.goto("/orders/new");

  await chooseCustomer(page, customer);
  await nextStep(page);
  await addProductLine(page, PRODUCT, String(quantity));
  await nextStep(page);
  await page.locator("#submitOrder").click();

  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
  await confirmOrder(page, /confirming holds the stock and creates the invoice/i);

  // The DURABLE state, not the transient success line. Confirming revalidates the route and the
  // action panel that carried the message is gone — correctly, since there is nothing left to
  // confirm. Asserting the message is a race; asserting the invoice is not.
  await expect(page.getByRole("heading", { name: /^invoice$/i })).toBeVisible();

  return page.getByText(/^FV-INV-\d{8}-\d{4}$/).first().innerText();
}

// ---------------------------------------------------------------------------
test("an invoice is settled and the goods leave", async ({ page }) => {
  let invoiceNo = "";
  let before = 0;

  await test.step("a Sales Representative sells six", async () => {
    await signInAs(page, "salesRep");
    invoiceNo = await sellTo(page, CUSTOMER, 6);
    expect(invoiceNo).toMatch(/^FV-INV-\d{8}-\d{4}$/);
  });

  await test.step("the Cashier leads with the balance, and credit sits apart", async () => {
    await switchTo(page, "cashier");
    await page.goto(PAYMENTS_HREF);

    const card = page.getByRole("article", { name: invoiceNo, exact: true });
    await expect(card).toBeVisible();
    await expect(card.getByText(/balance due/i)).toBeVisible();
    await expect(balanceOn(card)).toHaveText("TZS 600,000");
    // §12.3: the status is calculated from money received, and none has been.
    await expect(card.getByText(/^unpaid$/i)).toBeVisible();

    // §12.5: two different kinds of thing, offered as two separate controls.
    await expect(card.getByRole("button", { name: /take payment/i })).toBeVisible();
    await expect(card.getByRole("button", { name: /carry as credit/i })).toBeVisible();
  });

  await test.step("a part payment leaves it partly paid", async () => {
    const card = page.getByRole("article", { name: invoiceNo, exact: true });
    await card.getByRole("button", { name: /take payment/i }).click();

    // Preset buttons, not a dropdown (product.md §5.1, design.md §10.1).
    await card.getByTestId("method-cash").click();
    await card.getByLabel(/amount received/i).fill("200000");
    await card.getByRole("button", { name: /^record payment$/i }).click();
    await expect(card.getByText(/payment recorded/i)).toBeVisible();

    await page.goto(PAYMENTS_HREF);
    const updated = page.getByRole("article", { name: invoiceNo, exact: true });
    await expect(updated.getByText(/partly paid/i)).toBeVisible();
    await expect(balanceOn(updated)).toHaveText("TZS 400,000");
  });

  await test.step("carrying the rest as credit records no money", async () => {
    const card = page.getByRole("article", { name: invoiceNo, exact: true });
    await card.getByRole("button", { name: /carry as credit/i }).click();

    // The panel changes its language, because the decision is a different kind of thing (§12.5).
    await expect(card.getByText(/credit is not a payment/i)).toBeVisible();

    await card.getByLabel(/amount to carry as credit/i).fill("400000");
    await card.getByLabel(/^why\?$/i).fill("regular customer, pays monthly");
    await card.getByRole("button", { name: /send for approval/i }).click();

    // 400 000 is inside a Manager's TZS 500 000 limit (§4).
    await expect(card.getByText(/sent to the manager for approval/i)).toBeVisible();
  });

  await test.step("a Manager approves it, and the money received does not move", async () => {
    await switchTo(page, "manager");
    await page.goto(PAYMENTS_HREF);

    const card = page.getByRole("article", { name: invoiceNo, exact: true });
    await expect(card.getByText(/waiting for the manager/i)).toBeVisible();

    await confirmThrough(
      page,
      card.getByRole("button", { name: /^approve credit$/i }),
      /records no money, and the invoice stays unpaid until money arrives/i,
      /yes, approve the credit/i,
    );

    // The DURABLE outcome, in place. Approving revalidates the route and the decision panel — with
    // its success line — is gone, correctly, because there is nothing left to decide. Waiting for
    // that line is a race; waiting for the state it produced is not.
    //
    // AC-93: the balance is recorded as APPROVED CREDIT and the money received has not moved, so
    // the invoice is still Partly paid.
    await expect(card.getByText(/400,000 approved as credit/i)).toBeVisible();
    await expect(card.getByText(/partly paid/i)).toBeVisible();
  });

  await test.step("the Cashier marks it settled", async () => {
    await switchTo(page, "cashier");
    await page.goto(PAYMENTS_HREF);

    const card = page.getByRole("article", { name: invoiceNo, exact: true });
    await card.getByRole("button", { name: /mark as settled/i }).click();

    // Wait for the DURABLE state, not for the button to go. A pending Button hides its label and
    // exposes "Working…" instead, so `toHaveCount(0)` on the old name passes the instant the click
    // registers — and the navigation that followed it abandoned the server action mid-flight. That
    // is what made this step fail on a random tier about one run in three.
    await expect(card.getByText(/ready to dispatch/i)).toBeVisible();

    await page.goto(PAYMENTS_HREF);
    await expect(
      page.getByRole("article", { name: invoiceNo, exact: true }).getByText(/ready to dispatch/i),
    ).toBeVisible();
  });

  await test.step("the Cashier assigns a storekeeper, and nothing moves", async () => {
    before = await stockInStore(page);

    await page.goto(DISPATCH_HREF);
    const card = page.getByRole("article", { name: invoiceNo, exact: true });
    await expect(card.getByText(/assigning does not move any stock/i)).toBeVisible();

    await selectByPrefix(card.getByLabel(/^storekeeper$/i), STOREKEEPER);
    await card.getByLabel(/collect from/i).selectOption("store");
    await card.getByRole("button", { name: /assign storekeeper/i }).click();
    // The ASSIGNMENT is the durable signal, not the control going. A pending Button hides its label
    // and exposes "Working…", so a role-and-name locator stops matching the moment the click lands
    // and long before the server answers — which makes the navigation below a race.
    //
    // Asserted on the RELABELLED card: once a storekeeper is on it the card is named for the
    // invoice AND the keeper, so the invoice-only locator above stops matching by design.
    await expect(
      page.getByRole("article", { name: new RegExp(`${invoiceNo}.*${STOREKEEPER}`) }).first(),
    ).toBeVisible();

    await page.goto(DISPATCH_HREF);
    await expect(page.getByText(/storekeeper assigned/i).first()).toBeVisible();
    expect(await stockInStore(page)).toBe(before);
  });

  await test.step("Confirm Release is disabled until the note number exists", async () => {
    await switchTo(page, "manager");
    await page.goto(DISPATCH_HREF);

    const card = page
      .getByRole("article", { name: new RegExp(`${invoiceNo}.*${STOREKEEPER}`) })
      .first();

    // design.md §6.3 and §4.4: a temporary state the Manager can resolve, so it is disabled rather
    // than hidden — and a disabled control with no explanation is a defect.
    await expect(card.getByRole("button", { name: /confirm the customer signed/i })).toBeDisabled();
    await expect(card.getByText(/save the dispatch note number first/i)).toBeVisible();

    // AC-37: the OMS does not produce the note, and the screen says where the number comes from.
    await expect(card.getByText(/the system does not print dispatch notes/i)).toBeVisible();
  });

  await test.step("recording the note moves nothing", async () => {
    const card = page
      .getByRole("article", { name: new RegExp(`${invoiceNo}.*${STOREKEEPER}`) })
      .first();

    await card.getByLabel(/dispatch note number/i).fill(unique("DN").replace(" ", "-"));
    await card.getByRole("button", { name: /save note number/i }).click();
    // The durable state, for the reason given above: a pending button's name is "Working…", so the
    // old name disappearing proves only that the click landed, never that the server answered.
    await expect(card.getByText(/waiting for signature/i)).toBeVisible();

    await page.goto(DISPATCH_HREF);
    await expect(page.getByText(/waiting for signature/i).first()).toBeVisible();
    expect(await stockInStore(page)).toBe(before);
  });

  await test.step("confirming the signature is what makes the stock leave", async () => {
    await page.goto(DISPATCH_HREF);
    const card = page
      .getByRole("article", { name: new RegExp(`${invoiceNo}.*${STOREKEEPER}`) })
      .first();

    // The exact consequence, before it happens (design.md §10.8, §11.8) — and now behind an
    // explicit confirmation, because this is the one action that takes stock out of the yard.
    await expect(card.getByText(/the stock leaves the yard now/i)).toBeVisible();
    await confirmThrough(
      page,
      card.getByRole("button", { name: /confirm the customer signed/i }),
      /releases 6 units to .* from /i,
      /yes, the customer signed/i,
    );
    // Likewise: the release is what makes the stock leave, so wait for the release.
    await expect(card.getByText(/^collected$/i)).toBeVisible();

    await page.goto(DISPATCH_HREF);
    await expect(page.getByText(/^collected$/i).first()).toBeVisible();
    expect(await stockInStore(page)).toBe(before - 6);
  });
});

// ---------------------------------------------------------------------------
test("a credit balance beyond a Manager's limit needs a Director", async ({ page }) => {
  await signInAs(page, "salesRep");
  const invoiceNo = await sellTo(page, CUSTOMER, 8); // 800 000

  await test.step("the Cashier asks to carry the whole balance", async () => {
    await switchTo(page, "cashier");
    await page.goto(PAYMENTS_HREF);

    const card = page.getByRole("article", { name: invoiceNo, exact: true });
    await card.getByRole("button", { name: /carry as credit/i }).click();
    await card.getByLabel(/amount to carry as credit/i).fill("800000");
    await card.getByLabel(/^why\?$/i).fill("large customer, agreed terms");
    await card.getByRole("button", { name: /send for approval/i }).click();

    // §4: above TZS 500,000 on one invoice is a Director's decision.
    await expect(card.getByText(/sent to a director for approval/i)).toBeVisible();
  });

  await test.step("a Manager who tries anyway is refused, and told which limit", async () => {
    await switchTo(page, "manager");
    await page.goto(PAYMENTS_HREF);

    const card = page.getByRole("article", { name: invoiceNo, exact: true });
    // design.md §7.8: the limit is SHOWN, not merely enforced.
    await expect(card.getByText(/waiting for a director/i)).toBeVisible();

    // Third in that hierarchy: what this customer ALREADY owes on approved credit, which the
    // per-invoice limit of product.md §4 cannot see. The earlier journey in this file left them
    // carrying an approved, unpaid balance, so the figure here is real money and not zero.
    //
    // The AMOUNT is not asserted, and deliberately: it is a running total across every invoice the
    // customer holds, so it depends on what ran before it. `credit-exposure.test.ts` proves the
    // arithmetic exhaustively; this proves the figure reaches the screen §7.8 puts it on.
    const exposure = card.getByTestId(/^credit-exposure-/);
    await expect(exposure).toContainText(CUSTOMER);
    await expect(exposure).toContainText(/TZS [\d,]+/);
    await expect(exposure).not.toContainText(/TZS 0\b/);

    // The control is UNAVAILABLE with its reason stated (design.md §4.4), rather than enabled and
    // then refused by the database. §4.3 makes a rejection a completed decision too, so a Manager
    // is offered neither: being able to refuse it would be deciding it either way.
    await expect(card.getByRole("button", { name: /^approve credit$/i })).toBeDisabled();
    await expect(card.getByRole("button", { name: /^reject$/i })).toBeDisabled();
    await expect(card.getByTestId(/^credit-blocked-/)).toContainText(
      /beyond a manager's limit, so only a director can approve or reject it/i,
    );

    // And nothing was submitted: the invoice is untouched and still waiting for its Director.
    await expect(card.getByText(/waiting for a director/i)).toBeVisible();
  });

  await test.step("a Director approves it, and no money is recorded", async () => {
    await switchTo(page, "director");
    await page.goto(PAYMENTS_HREF);

    const card = page.getByRole("article", { name: invoiceNo, exact: true });
    await confirmThrough(
      page,
      card.getByRole("button", { name: /^approve credit$/i }),
      /approves TZS 800,000 for .* to pay later/i,
      /yes, approve the credit/i,
    );

    // AC-93: the approved balance is recorded, and the invoice is still Unpaid, because approving
    // credit records no money.
    await expect(card.getByText(/800,000 approved as credit/i)).toBeVisible();
    await expect(card.getByText(/^unpaid$/i)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
test("a walk-in sale is completed in one action at the till", async ({ page }) => {
  let orderNo = "";
  let orderId = "";

  await test.step("a Sales Representative writes and confirms it", async () => {
    await signInAs(page, "salesRep");
    await page.goto("/orders/new");

    // A single prominent preset, not an item lost in a list (design.md §7.5).
    await page.locator("#cashCustomer").click();
    await nextStep(page);
    await addProductLine(page, PRODUCT, "3");
    await nextStep(page);
    await page.locator("#submitOrder").click();

    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
    orderId = new URL(page.url()).pathname.split("/").pop()!;
    orderNo = (await page.getByRole("heading", { level: 1 }).innerText()).replace(/^Order\s+/i, "");

    // The walk-in confirmation names its own consequence, and it is the opposite of the registered
    // one: nothing is owed and nothing is held until the money arrives (§12.4).
    await confirmOrder(page, /confirming creates no invoice and holds no stock/i);

    // §12.4 and AC-86: confirming a walk-in order creates NO invoice. The durable proof is the
    // order reading Confirmed with no invoice anywhere on the page.
    await expect(page.getByText(/^confirmed$/i)).toBeVisible();

    await page.reload();
    await expect(page.getByText(/^confirmed$/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: /^invoice$/i })).toHaveCount(0);
    await expect(page.getByText(/units held for this order/i)).toHaveCount(0);
  });

  await test.step("the Cashier completes it in one action", async () => {
    await switchTo(page, "cashier");
    await page.goto(PAYMENTS_HREF);

    const card = page.getByRole("article", { name: orderNo, exact: true });
    await expect(card).toBeVisible();
    await expect(card.getByText("TZS 300,000").first()).toBeVisible();

    // §7A.3: one action with one confirmation, never four sequential saves — and the screen names
    // the consequence where nothing at all is recorded.
    await expect(card.getByText(/if the stock has gone, nothing at all is recorded/i)).toBeVisible();

    await card.getByTestId("cash-method-cash").click();
    await confirmThrough(
      page,
      card.getByRole("button", { name: /take payment and complete the sale/i }),
      /creates the invoice and holds the goods for collection — all at once/i,
      /yes, complete the sale/i,
    );

    // The DURABLE outcome, not the transient success line. §12.4 and AC-16: taking the money is
    // what creates the invoice, so the walk-in card leaves the queue the moment the route
    // revalidates — taking the success message with it. Asserting that message races the
    // revalidation that removes the card carrying it; asserting the invoice does not.
    await expect(card).toHaveCount(0);

    await page.reload();

    // The same order, now an invoice card in the same queue. Found by its link rather than by an
    // invoice number the test never saw, because the number is issued by the payment itself.
    const invoiced = page
      .getByRole("article")
      .filter({ has: page.locator(`a[href="/orders/${orderId}"]`) });

    await expect(invoiced.getByText(/^FV-INV-\d{8}-\d{4}$/)).toBeVisible();
    // §12.3: the status is calculated from money received, and all of it has been.
    await expect(invoiced.getByText(/^paid$/i)).toBeVisible();
    await expect(balanceOn(invoiced)).toHaveText("TZS 0");
    // AC-16 is a FULL settlement: the walk-in path exists for nothing else.
    await expect(page.getByRole("article", { name: orderNo, exact: true })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
test("two invoices are settled one after another, without reloading the page", async ({ page }) => {
  let first = "";
  let second = "";

  await test.step("a Sales Representative sells twice", async () => {
    await signInAs(page, "salesRep");
    first = await sellTo(page, CUSTOMER, 1);
    second = await sellTo(page, CUSTOMER, 2);
  });

  await test.step("the Cashier clears both without a reload between them", async () => {
    await switchTo(page, "cashier");
    await page.goto(PAYMENTS_HREF);

    // EVERY CARD OWNS ITS IDEMPOTENCY KEY, and this is the test that says so. One key handed to
    // the whole page is claimed by whichever card acts first; the second card then sends a key the
    // database has already recorded against a different command and request, and is refused with
    // `idempotency_key_conflict` — which reads, at the till, as the system breaking for no reason.
    //
    // There is deliberately NO navigation in this step. A reload would mint fresh keys and hide
    // exactly the defect being tested.
    for (const [invoiceNo, amount] of [[first, "100000"], [second, "200000"]] as const) {
      const card = page.getByRole("article", { name: invoiceNo, exact: true });

      await card.getByRole("button", { name: /take payment/i }).click();
      await card.getByTestId("method-cash").click();
      await card.getByLabel(/amount received/i).fill(amount);
      await card.getByRole("button", { name: /^record payment$/i }).click();
      await expect(card.getByText(/payment recorded/i)).toBeVisible();

      await card.getByRole("button", { name: /mark as settled/i }).click();
      await expect(card.getByText(/ready to dispatch/i)).toBeVisible();
    }

    // The refusal this test exists to prevent, named so a failure says why it failed.
    await expect(page.getByText(/reload the page and try again/i)).toHaveCount(0);
  });

  await test.step("and both are settled when the page is asked again", async () => {
    await page.goto(PAYMENTS_HREF);
    for (const invoiceNo of [first, second]) {
      await expect(
        page.getByRole("article", { name: invoiceNo, exact: true }).getByText(/ready to dispatch/i),
      ).toBeVisible();
    }
  });
});

// ---------------------------------------------------------------------------
test("a partial release leaves the rest assignable, and the rest goes out too", async ({ page }) => {
  let invoiceNo = "";
  let before = 0;

  await test.step("a Sales Representative sells ten, and the Cashier settles it", async () => {
    await signInAs(page, "salesRep");
    invoiceNo = await sellTo(page, CUSTOMER, 10);

    await switchTo(page, "cashier");
    await page.goto(PAYMENTS_HREF);

    const card = page.getByRole("article", { name: invoiceNo, exact: true });
    await card.getByRole("button", { name: /take payment/i }).click();
    await card.getByTestId("method-cash").click();
    await card.getByRole("button", { name: /^record payment$/i }).click();
    await expect(card.getByText(/payment recorded/i)).toBeVisible();

    await card.getByRole("button", { name: /mark as settled/i }).click();
    await expect(card.getByText(/ready to dispatch/i)).toBeVisible();
  });

  await test.step("the Cashier assigns four of the ten", async () => {
    before = await stockInStore(page);

    await page.goto(DISPATCH_HREF);
    const card = page.getByRole("article", { name: invoiceNo, exact: true });
    await expect(card.getByText(/10 still owed/i)).toBeVisible();

    await selectByPrefix(card.getByLabel(/^storekeeper$/i), STOREKEEPER);
    await card.getByLabel(/collect from/i).selectOption("store");
    await card.getByLabel(new RegExp(PRODUCT, "i")).fill("4");
    await card.getByRole("button", { name: /assign storekeeper/i }).click();

    await expect(
      page.getByRole("article", { name: new RegExp(`${invoiceNo}.*${STOREKEEPER}`) }).first(),
    ).toBeVisible();
  });

  await test.step("six remain assignable while the four are in progress", async () => {
    await page.goto(DISPATCH_HREF);
    // The assign card is still here — this is the control the review found missing — and it now
    // offers SIX, because four are spoken for by a dispatch that has not gone out yet.
    const card = page.getByRole("article", { name: invoiceNo, exact: true });
    await expect(card).toBeVisible();
    await expect(card.getByText(/6 still owed/i)).toBeVisible();
  });

  await test.step("a Manager notes the number and releases the four", async () => {
    await switchTo(page, "manager");
    await page.goto(DISPATCH_HREF);

    const card = page
      .getByRole("article", { name: new RegExp(`${invoiceNo}.*${STOREKEEPER}`) })
      .first();

    await card.getByLabel(/dispatch note number/i).fill(unique("DN").replace(" ", "-"));
    await card.getByRole("button", { name: /save note number/i }).click();
    await expect(card.getByText(/waiting for signature/i)).toBeVisible();

    await confirmThrough(
      page,
      card.getByRole("button", { name: /confirm the customer signed/i }),
      /releases 4 units/i,
      /yes, the customer signed/i,
    );
    await expect(card.getByText(/^collected$/i)).toBeVisible();

    expect(await stockInStore(page)).toBe(before - 4);
  });

  await test.step("the remaining six are still assignable, and go out on a second dispatch", async () => {
    await switchTo(page, "cashier");
    await page.goto(DISPATCH_HREF);

    // AFTER a partial release. Before this correction the invoice vanished from the assignment
    // list the moment it had any dispatch at all, so the other six could never be handed over.
    const card = page.getByRole("article", { name: invoiceNo, exact: true });
    await expect(card).toBeVisible();
    await expect(card.getByText(/6 still owed/i)).toBeVisible();

    await selectByPrefix(card.getByLabel(/^storekeeper$/i), STOREKEEPER);
    await card.getByLabel(/collect from/i).selectOption("store");
    await card.getByRole("button", { name: /assign storekeeper/i }).click();

    await switchTo(page, "manager");
    await page.goto(DISPATCH_HREF);

    // Two dispatches now carry this invoice and this storekeeper, so the card is found by the one
    // thing that tells them apart: the note number about to go on it. Filtering by the save
    // control would stop matching the instant that control is used, which is what a first attempt
    // at this test did.
    const noteNo = unique("DN").replace(" ", "-");
    const assigned = page
      .getByRole("article", { name: new RegExp(`${invoiceNo}.*${STOREKEEPER}`) })
      .filter({ has: page.getByRole("button", { name: /save note number/i }) })
      .first();

    await assigned.getByLabel(/dispatch note number/i).fill(noteNo);
    await assigned.getByRole("button", { name: /save note number/i }).click();

    const second = page
      .getByRole("article", { name: new RegExp(`${invoiceNo}.*${STOREKEEPER}`) })
      .filter({ hasText: noteNo })
      .first();
    await expect(second.getByText(/waiting for signature/i)).toBeVisible();

    await confirmThrough(
      page,
      second.getByRole("button", { name: /confirm the customer signed/i }),
      /releases 6 units/i,
      /yes, the customer signed/i,
    );

    // All ten have now left the yard, in two dispatches against one invoice.
    await expect(second.getByText(/^collected$/i)).toBeVisible();
    expect(await stockInStore(page)).toBe(before - 10);

    // And nothing is left to assign on it.
    await switchTo(page, "cashier");
    await page.goto(DISPATCH_HREF);
    await expect(page.getByRole("article", { name: invoiceNo, exact: true })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
test.describe("what the settlement screens offer", () => {
  test("a Manager reads payments and is offered no way to take money", async ({ page }) => {
    await signInAs(page, "manager");
    await page.goto(PAYMENTS_HREF);

    // §12.6 step 6 gives settlement to the Cashier. Absent, not greyed (design.md §4.3, §4.4).
    await expect(page.getByRole("button", { name: /take payment/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /mark as settled/i })).toHaveCount(0);
  });

  test("a Cashier is offered no way to confirm a release", async ({ page }) => {
    await signInAs(page, "cashier");
    await page.goto(DISPATCH_HREF);

    // §12.6 step 13 gives the signed release to the Manager.
    await expect(page.getByRole("button", { name: /confirm the customer signed/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /save note number/i })).toHaveCount(0);
  });

  test("a Sales Representative cannot reach dispatch at all", async ({ page }) => {
    await signInAs(page, "salesRep");
    await page.goto(DISPATCH_HREF);
    await expect(page).toHaveURL(/\/no-access/);
  });

  test("a Manager reads storekeepers and is offered no way to register one", async ({ page }) => {
    await signInAs(page, "manager");
    await page.goto("/settings/storekeepers");

    await expect(page.getByRole("heading", { level: 1, name: /storekeepers/i })).toBeVisible();
    await expect(page.locator("#addStorekeeper")).toHaveCount(0);
  });

  test("the navigation offers dispatch to the roles that work it", async ({ page }, testInfo) => {
    await signInAs(page, "cashier");
    const navigation = await openNavigation(page, testInfo);
    await expect(navigation.getByRole("link", { name: /^dispatch$/i })).toBeVisible();
    // §3.2 registration is a Director's, so the destination is not offered at all.
    await expect(navigation.getByRole("link", { name: /^storekeepers$/i })).toHaveCount(0);
  });

  test("every queue says how much of it is off the page", async ({ page }) => {
    await signInAs(page, "cashier");

    // A queue that shows the first twenty-five and says nothing is a queue that loses the oldest
    // unsettled invoice in the business. The count is always stated (design.md §12.3 in spirit:
    // an empty result and a truncated one are different answers).
    await page.goto(PAYMENTS_HREF);
    await expect(page.getByTestId("pager-count-awaiting")).toBeVisible();
    await expect(page.getByTestId("pager-count-settled")).toBeVisible();

    await page.goto(DISPATCH_HREF);
    await expect(page.getByTestId("pager-count-unreleased")).toBeVisible();
    await expect(page.getByTestId("pager-count-released")).toBeVisible();
  });

  test("neither payments nor dispatch scrolls the page sideways", async ({ page }) => {
    await signInAs(page, "cashier");

    for (const href of [PAYMENTS_HREF, DISPATCH_HREF, ORDERS_HREF]) {
      await page.goto(href);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${href} scrolls horizontally`).toBeLessThanOrEqual(1);
    }
  });
});
