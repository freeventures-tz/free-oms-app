import { expect, test, type Locator, type Page } from "@playwright/test";

import { businessDate } from "@/lib/time/business-date";

import { expectLandsOn, fixtures, openNavigation, signIn } from "./fixtures";

/**
 * Suppliers, receiving, transfers and corrections, on every device tier.
 *
 * What is proved here that no other layer can prove:
 *
 *   · That a delivery ENTERED changes nothing on screen, and that approving it is what moves the
 *     number a Manager reads. pgTAP proves the database does this; this proves the person sees it.
 *   · That a DIRECTOR is offered no control on the receiving board. product.md §4.1 names three
 *     enterers and one approver and a Director is none of them, and design.md §4.3 says the control
 *     is absent rather than greyed. Only a browser can show the absence.
 *   · That short and excess appear without anyone typing them, and that there is no field to type
 *     them into (§5.2, AC-27).
 *   · That the Stage 10 Part A interaction contract holds on screens that did not exist when it was
 *     written, including that a burst on Approve produces exactly ONE decision.
 *
 * The Part A matrix is not repeated per control. It was proved once against the account screens for
 * the primitives every screen now shares; what is proved here is that these screens use them.
 */

const TAP_TO_PENDING_BUDGET_MS = 100;
const SERVER_DELAY_MS = 3000;

const RECEIVING_HREF = "/inventory/receiving";
const STOCK_HREF = "/inventory";
const TRANSFERS_HREF = "/inventory/transfers";
const SUPPLIERS_HREF = "/settings/suppliers";

/** A seeded product with a name no other product shares, counted in sheets and holding nothing. */
const PRODUCT = "Marine 18 mm";

async function signInAs(page: Page, who: "director" | "manager" | "cashier" | "salesRep") {
  const account = fixtures()[who];
  await signIn(page, account.phone, account.password);
  await expectLandsOn(page, who === "cashier" ? "/payments" : who === "salesRep" ? "/orders" : "/dashboard");
}

/**
 * What the stock screen says is at a location right now.
 *
 * Read from a data attribute rather than parsed out of the sentence, because the sentence is a
 * translated template and its word order differs between English and Swahili by design (§8.5).
 */
async function stockAt(page: Page, location: string, product: string): Promise<number> {
  await page.goto(STOCK_HREF);
  await page.getByTestId(`location-tab-${location}`).click();
  const card = page.getByRole("article", { name: product, exact: true });
  const value = await card.getByTestId("stock-quantity").getAttribute("data-quantity");
  return Number(value);
}

/**
 * Clicks `clicks` times inside one in-page evaluation and returns how long the button took to say
 * so. Browser time only: nothing here includes Playwright's round trip, so the threshold can be the
 * contract itself (design.md §12.7 rule 1) rather than the contract plus automation overhead.
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
          reject(new Error("the button pressed never entered a pending state within 5s of the tap"));
        }, 5000);
      }),
    clicks,
  );
}

/** Every server-action request the page makes, in order, with the body it sent. */
function recordServerActions(page: Page): string[] {
  const payloads: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.headers()["next-action"]) {
      payloads.push(request.postData() ?? "");
    }
  });
  return payloads;
}

function unique(prefix: string): string {
  return `${prefix} ${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// The journey: register a supplier, record a delivery, approve it, see the stock
// ---------------------------------------------------------------------------
test.describe.serial("a delivery becomes stock", () => {
  let supplierName: string;
  let noteRef: string;
  let stockBefore: number;

  test("a Director registers a supplier", async ({ page }, testInfo) => {
    supplierName = unique("E2E Supplier");
    noteRef = unique("DN").replace(" ", "-");

    await signInAs(page, "director");

    const navigation = await openNavigation(page, testInfo);
    await navigation.getByRole("link", { name: /suppliers/i }).click();
    await expect(page.getByRole("heading", { level: 1, name: /suppliers/i })).toBeVisible();

    await page.getByLabel(/supplier name/i).fill(supplierName);
    await page.locator("#addSupplier").click();

    await expect(page.getByText(/supplier added/i)).toBeVisible();
    await expect(page.getByRole("article", { name: supplierName, exact: true })).toBeVisible();
  });

  test("a Manager notes what the store holds before anything arrives", async ({ page }) => {
    await signInAs(page, "manager");
    stockBefore = await stockAt(page, "store", PRODUCT);
    expect(Number.isFinite(stockBefore)).toBe(true);
  });

  test("a Cashier records the delivery, and the calculations appear without being typed", async ({
    page,
  }) => {
    await signInAs(page, "cashier");
    await page.goto(RECEIVING_HREF);

    await page.locator("#newReceipt").click();

    await page.getByLabel(/^supplier$/i).selectOption({ label: supplierName });
    await page.getByLabel(/delivered to/i).selectOption("store");
    await page.getByLabel(/delivery date/i).fill(new Date().toISOString().slice(0, 10));
    await page.getByLabel(/delivery note number/i).fill(noteRef);

    await page.getByLabel(/^product$/i).selectOption({ label: PRODUCT });
    await page.getByLabel(/^expected/i).fill("50");
    await page.getByLabel(/^received$/i).fill("48");
    await page.getByLabel(/^damaged$/i).fill("3");

    // Short, excess and accepted, worked out while the person types — and there is no field for
    // any of them (product.md §5.2, AC-27, AC-28). 50 expected, 48 arrived, 3 broken.
    const derived = page.getByTestId("line-derived-0");
    await expect(derived).toContainText("2");
    await expect(derived).toContainText("45");

    // The absence is the assertion: no input anywhere offers to take these numbers.
    await expect(page.getByLabel(/^short$/i)).toHaveCount(0);
    await expect(page.getByLabel(/^excess$/i)).toHaveCount(0);
    await expect(page.getByLabel(/^accepted$/i)).toHaveCount(0);

    await page.locator("#submitReceipt").click();
    await expect(page.getByText(/waiting for a manager to approve/i)).toBeVisible();
  });

  test("recording it changed no stock at all", async ({ page }) => {
    await signInAs(page, "manager");
    expect(await stockAt(page, "store", PRODUCT)).toBe(stockBefore);
  });

  test("a Director sees the delivery and is offered no way to decide it", async ({ page }) => {
    await signInAs(page, "director");
    await page.goto(RECEIVING_HREF);

    const card = page.getByRole("article", { name: `${supplierName} ${noteRef}`, exact: true });
    await expect(card).toBeVisible();
    await expect(card.getByText(/waiting for approval/i)).toBeVisible();

    // Absent, not disabled (design.md §4.3, §4.4). A greyed Approve with a tooltip would leak the
    // authority structure, and §4.1 gives a Director no part in this decision at all.
    await expect(card.getByRole("button", { name: /approve/i })).toHaveCount(0);
    await expect(card.getByRole("button", { name: /reject/i })).toHaveCount(0);
  });

  test("a Manager approves it, and the store rises by the ACCEPTED quantity", async ({ page }) => {
    await signInAs(page, "manager");
    await page.goto(RECEIVING_HREF);

    const card = page.getByRole("article", { name: `${supplierName} ${noteRef}`, exact: true });

    // What approving will do, said before it happens (design.md §10.8).
    await expect(card.getByText(/adds the accepted quantity to stock/i)).toBeVisible();

    await card.getByRole("button", { name: /approve delivery/i }).click();
    // The settled state rather than the transient success line: approving revalidates the route and
    // the card comes back reporting what it now IS, which is the confirmation that survives a
    // refresh.
    await expect(card.getByText(/approved by/i)).toBeVisible();

    // 48 arrived and 3 were broken. Damaged goods are unsellable (§8) and never reach a balance,
    // so the store rises by 45 and not by 48.
    expect(await stockAt(page, "store", PRODUCT)).toBe(stockBefore + 45);
  });

  test("the shortage is still on the record after approval", async ({ page }) => {
    await signInAs(page, "manager");
    await page.goto(RECEIVING_HREF);

    const card = page.getByRole("article", { name: `${supplierName} ${noteRef}`, exact: true });
    // §9.1: every shortage stays documented, however small. Approving a delivery does not forgive
    // the two sheets that never arrived.
    await expect(card.getByText(/2 short, recorded permanently/i)).toBeVisible();
    await expect(card.getByText(/approved by/i)).toBeVisible();
  });

  test("the card says who entered it and who approved it, each with a role and a moment", async ({
    page,
  }) => {
    await signInAs(page, "manager");
    await page.goto(RECEIVING_HREF);

    const card = page.getByRole("article", { name: `${supplierName} ${noteRef}`, exact: true });

    // ENTRY: the Cashier who recorded it, the role they held while doing so, and when. §4.2 makes
    // this a fact in its own right — it is not evidence that anything was approved.
    const entry = card.locator("[data-testid^='entry-record-']");
    await expect(entry).toContainText("E2E Cashier");
    await expect(entry).toContainText("Cashier");
    await expect(entry.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);

    // DECISION: a different person, in a different role, at a different moment. A Cashier may enter
    // a delivery and may never approve one, so a card that showed only "approved" would hide the
    // half of the record that says who is answerable for the stock rising.
    const decision = card.locator("[data-testid^='decision-record-']");
    await expect(decision).toHaveAttribute("data-outcome", "approved");
    await expect(decision).toHaveAttribute("data-decided-role", "manager");
    await expect(decision).toHaveAttribute("data-decided-at", /^\d{4}-\d{2}-\d{2}T/);
    await expect(decision).toContainText("Approved by E2E Manager (Manager)");
    await expect(decision).toContainText(/decided/i);

    // The two attributions are separate elements, not one sentence doing both jobs.
    await expect(entry).not.toContainText(/approved by/i);
  });
});

// ---------------------------------------------------------------------------
// Rejection is a decision, and it is not an approval
// ---------------------------------------------------------------------------
test.describe.serial("a delivery is rejected", () => {
  let supplierName: string;
  let noteRef: string;

  test("a Sales Representative records it", async ({ page }) => {
    supplierName = unique("E2E Reject");
    noteRef = unique("DNR").replace(" ", "-");

    await signInAs(page, "director");
    await page.goto(SUPPLIERS_HREF);
    await page.getByLabel(/supplier name/i).fill(supplierName);
    await page.locator("#addSupplier").click();
    await expect(page.getByText(/supplier added/i)).toBeVisible();

    await page.context().clearCookies();
    await signInAs(page, "salesRep");
    await page.goto(RECEIVING_HREF);

    await page.locator("#newReceipt").click();
    await page.getByLabel(/^supplier$/i).selectOption({ label: supplierName });
    await page.getByLabel(/delivered to/i).selectOption("warehouse");
    await page.getByLabel(/delivery date/i).fill(new Date().toISOString().slice(0, 10));
    await page.getByLabel(/delivery note number/i).fill(noteRef);
    await page.getByLabel(/^product$/i).selectOption({ label: PRODUCT });
    await page.getByLabel(/^expected/i).fill("10");
    await page.getByLabel(/^received$/i).fill("10");

    await page.locator("#submitReceipt").click();
    await expect(page.getByText(/waiting for a manager to approve/i)).toBeVisible();
  });

  test("a Manager rejects it with a reason, and nothing moves", async ({ page }) => {
    await signInAs(page, "manager");
    const before = await stockAt(page, "warehouse", PRODUCT);

    await page.goto(RECEIVING_HREF);
    const card = page.getByRole("article", { name: `${supplierName} ${noteRef}`, exact: true });

    await card.getByRole("button", { name: /^reject$/i }).click();
    await card.getByLabel(/why are you rejecting/i).fill("wrong grade of ply delivered");
    await card.getByRole("button", { name: /confirm rejection/i }).click();

    await expect(card.getByText(/rejected by/i)).toBeVisible();

    // §4.3, AC-84: a rejection records the deciding Manager as a REJECTOR and no approver at all.
    await page.reload();
    const settled = page.getByRole("article", { name: `${supplierName} ${noteRef}`, exact: true });
    await expect(settled.getByText(/rejected by/i)).toBeVisible();
    await expect(settled.getByText(/approved by/i)).toHaveCount(0);
    await expect(settled.getByText(/wrong grade of ply/i)).toBeVisible();

    expect(await stockAt(page, "warehouse", PRODUCT)).toBe(before);
  });

  test("the rejection is attributed as completely as an approval would be", async ({ page }) => {
    await signInAs(page, "manager");
    await page.goto(RECEIVING_HREF);

    const card = page.getByRole("article", { name: `${supplierName} ${noteRef}`, exact: true });

    const entry = card.locator("[data-testid^='entry-record-']");
    await expect(entry).toContainText("E2E Sales Rep");
    await expect(entry).toContainText("Sales Representative");
    await expect(entry.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);

    // A rejection records no approver at all (§4.3, AC-84), so its decider and their role come
    // from the decision rather than from the approval. The record has to be just as complete —
    // refusing a delivery is a decision somebody is answerable for.
    const decision = card.locator("[data-testid^='decision-record-']");
    await expect(decision).toHaveAttribute("data-outcome", "rejected");
    await expect(decision).toHaveAttribute("data-decided-role", "manager");
    await expect(decision).toHaveAttribute("data-decided-at", /^\d{4}-\d{2}-\d{2}T/);
    await expect(decision).toContainText("Rejected by E2E Manager (Manager)");
    await expect(decision).toContainText(/decided/i);
    await expect(decision).toContainText(/wrong grade of ply/i);

    // Nowhere on a rejected card does the word "approved" appear about the decision.
    await expect(card.getByText(/approved by/i)).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// The interaction feedback contract, on a screen that did not exist when it was written
// ---------------------------------------------------------------------------
test.describe.serial("the feedback contract on an approval", () => {
  let supplierName: string;
  let noteRef: string;

  test("a pending delivery is prepared", async ({ page }) => {
    supplierName = unique("E2E Burst");
    noteRef = unique("DNB").replace(" ", "-");

    await signInAs(page, "director");
    await page.goto(SUPPLIERS_HREF);
    await page.getByLabel(/supplier name/i).fill(supplierName);
    await page.locator("#addSupplier").click();
    await expect(page.getByText(/supplier added/i)).toBeVisible();

    await page.context().clearCookies();
    await signInAs(page, "manager");
    await page.goto(RECEIVING_HREF);

    await page.locator("#newReceipt").click();
    await page.getByLabel(/^supplier$/i).selectOption({ label: supplierName });
    await page.getByLabel(/delivered to/i).selectOption("yard");
    await page.getByLabel(/delivery date/i).fill(new Date().toISOString().slice(0, 10));
    await page.getByLabel(/delivery note number/i).fill(noteRef);
    await page.getByLabel(/^product$/i).selectOption({ label: PRODUCT });
    await page.getByLabel(/^expected/i).fill("7");
    await page.getByLabel(/^received$/i).fill("7");
    await page.locator("#submitReceipt").click();
    await expect(page.getByText(/waiting for a manager to approve/i)).toBeVisible();
  });

  test("a burst on Approve acknowledges at once and produces exactly ONE decision", async ({
    page,
  }) => {
    await signInAs(page, "manager");
    const before = await stockAt(page, "yard", PRODUCT);

    // The server held for three seconds. Without a delay the request answers before a second tap is
    // physically possible, and the test would pass whether or not the guard exists.
    await page.route("**/inventory/receiving**", async (route) => {
      if (route.request().method() === "POST") {
        await new Promise((resolve) => setTimeout(resolve, SERVER_DELAY_MS));
      }
      await route.continue();
    });

    const payloads = recordServerActions(page);
    await page.goto(RECEIVING_HREF);

    const card = page.getByRole("article", { name: `${supplierName} ${noteRef}`, exact: true });
    const approve = card.getByRole("button", { name: /approve delivery/i });

    const elapsed = await measureTapToPending(approve, 6);
    expect(elapsed, `the tap was acknowledged after ${Math.round(elapsed)} ms`).toBeLessThan(
      TAP_TO_PENDING_BUDGET_MS,
    );

    // Its sibling closes with it, so a burst across both cannot send two decisions about one
    // record.
    await expect(card.getByRole("button", { name: /^reject$/i })).toBeDisabled();

    // The settled state, not the transient success line. Approving revalidates the route, the
    // record comes back approved, and the card then reports what it IS rather than what just
    // happened — which is the durable confirmation and the one still there after a refresh.
    await expect(card.getByText(/approved by/i)).toBeVisible({ timeout: 20_000 });

    // Six activations, one request. The guard is a ref written synchronously inside the handler,
    // before any await — `disabled` alone closes the control only once React has committed.
    expect(payloads).toHaveLength(1);

    // And, decisively, one helping of stock rather than six.
    expect(await stockAt(page, "yard", PRODUCT)).toBe(before + 7);
  });
});

// ---------------------------------------------------------------------------
// Internal transfers, including the refusal that carries its numbers
// ---------------------------------------------------------------------------
test.describe.serial("moving stock between locations", () => {
  test("a transfer bigger than the source holds is refused at approval, with the figures", async ({
    page,
  }) => {
    await signInAs(page, "manager");
    const atYard = await stockAt(page, "yard", PRODUCT);

    await page.goto(TRANSFERS_HREF);
    await page.locator("#newTransfer").click();

    await page.getByLabel(/^from$/i).selectOption("yard");
    await page.getByLabel(/^to$/i).selectOption("store");
    await page.getByLabel(/^product$/i).selectOption({ label: PRODUCT });
    await page.getByLabel(/^quantity/i).fill(String(atYard + 500));

    // The limit is SHOWN before submission (design.md §7.15) — and shown as a guide, because the
    // check that decides anything happens at approval, where stock can already have moved.
    await expect(page.getByTestId("transfer-available-0")).toContainText(String(atYard));

    await page.locator("#submitTransfer").click();
    await expect(page.getByText(/waiting for approval/i).first()).toBeVisible();

    await page.reload();
    const card = page.getByRole("article", { name: /yard.*store/i }).first();
    await card.getByRole("button", { name: /approve transfer/i }).click();

    // "Not enough" on its own is not actionable. The refusal names what is there and what was asked
    // for, which is what lets a Manager correct it without guessing.
    //
    // Scoped to the detail line rather than searched for loosely in the card: the requested
    // quantity also appears on the transfer's own line, and matching either would let this pass
    // while the figures the refusal carries were missing.
    // Since issue #7 the refusal names the rule that fired. A transfer takes nothing out of the
    // business — it moves goods we still own — so it can never consume a customer's promise, and
    // the LOCATION is the only question it has to answer.
    await expect(card.getByText(/not enough stock at that place/i)).toBeVisible();
    await expect(card.getByText(/there,.*asked for/i)).toContainText(
      new RegExp(`${atYard}\\s+there`),
    );
    await expect(card.getByText(/there,.*asked for/i)).toContainText(
      new RegExp(`${atYard + 500}\\s+asked for`),
    );

    expect(await stockAt(page, "yard", PRODUCT)).toBe(atYard);
  });
});

// ---------------------------------------------------------------------------
// What each role is offered, per device tier
// ---------------------------------------------------------------------------
test.describe("what the navigation offers", () => {
  test("a Manager reaches stock, receiving, transfers and corrections", async ({ page }, testInfo) => {
    await signInAs(page, "manager");
    const navigation = await openNavigation(page, testInfo);

    for (const destination of [/^stock$/i, /supplier receiving/i, /internal transfers/i, /stock corrections/i]) {
      await expect(navigation.getByRole("link", { name: destination })).toBeVisible();
    }
    // Registering a supplier is a Director's (see the Stage 10D plan): the destination is not
    // offered at all rather than offered and refused.
    await expect(navigation.getByRole("link", { name: /^suppliers$/i })).toHaveCount(0);
  });

  test("a Cashier reaches receiving and nothing else in the yard", async ({ page }, testInfo) => {
    await signInAs(page, "cashier");
    const navigation = await openNavigation(page, testInfo);

    await expect(navigation.getByRole("link", { name: /supplier receiving/i })).toBeVisible();
    await expect(navigation.getByRole("link", { name: /^stock$/i })).toHaveCount(0);
    await expect(navigation.getByRole("link", { name: /internal transfers/i })).toHaveCount(0);
  });

  test("a Cashier who types the stock URL is refused by the server, not by a hidden link", async ({
    page,
  }) => {
    await signInAs(page, "cashier");
    await page.goto(STOCK_HREF);
    await expect(page).toHaveURL(/\/no-access/);
  });

  test("a Sales Representative can record a delivery and decide nothing", async ({ page }) => {
    await signInAs(page, "salesRep");
    await page.goto(RECEIVING_HREF);

    await expect(page.locator("#newReceipt")).toBeVisible();
    await expect(page.getByRole("button", { name: /approve delivery/i })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Reading the yard on a phone
// ---------------------------------------------------------------------------
test.describe("the stock screen on every tier", () => {
  test("shows each location, and every product including the ones holding none", async ({
    page,
  }) => {
    await signInAs(page, "manager");
    await page.goto(STOCK_HREF);

    for (const location of ["store", "warehouse", "yard"]) {
      await expect(page.getByTestId(`location-tab-${location}`)).toBeVisible();
    }

    // A product missing because its balance is zero would be indistinguishable from a product that
    // does not exist. Everything in the catalogue is listed, whatever it holds.
    await expect(page.getByRole("article", { name: PRODUCT, exact: true })).toBeVisible();
    await expect(page.getByRole("article", { name: "Tofali 5\"", exact: true })).toBeVisible();
  });

  test("never scrolls the page sideways, whatever the tier", async ({ page }) => {
    await signInAs(page, "manager");
    await page.goto(RECEIVING_HREF);

    // design.md §3.5: a wide grid scrolls inside its own container. The receiving board carries the
    // widest table in the application, and on a 390px phone it is the one most likely to push the
    // body out.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "the page body scrolls horizontally").toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// The delivery date the form offers, which is the yard's today and not the device's
// ---------------------------------------------------------------------------
test.describe.serial("the delivery date a new receipt starts with", () => {
  // Eleven hours ahead of Dar es Salaam. For eleven hours out of every twenty-four this device
  // is on a different calendar day from the yard, which is exactly the disagreement a
  // browser-derived default would resolve the wrong way.
  test.use({ timezoneId: "Pacific/Kiritimati" });

  let supplierName: string;

  test("a supplier exists to receive from", async ({ page }) => {
    supplierName = unique("E2E Dated");

    await signInAs(page, "director");
    await page.goto(SUPPLIERS_HREF);
    await page.getByLabel(/supplier name/i).fill(supplierName);
    await page.locator("#addSupplier").click();
    await expect(page.getByText(/supplier added/i)).toBeVisible();
  });

  test("opens already filled in with today in Dar es Salaam", async ({ page }) => {
    await signInAs(page, "cashier");
    await page.goto(RECEIVING_HREF);
    await page.locator("#newReceipt").click();

    const field = page.getByLabel(/delivery date/i);
    // Computed in Node from the same helper the server uses — not read back off the page, which
    // would only prove the page agrees with itself.
    await expect(field).toHaveValue(businessDate());

    // What the DEVICE would have offered. When the two calendars disagree, this is the value a
    // default derived from the browser would have shown, and the field must not be showing it.
    const deviceDate = await page.evaluate(() => {
      const parts = new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date());
      const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
      return `${value("year")}-${value("month")}-${value("day")}`;
    });
    if (deviceDate !== businessDate()) {
      await expect(field).not.toHaveValue(deviceDate);
    }
  });

  test("a REFUSAL keeps the date the person entered, and everything else they typed", async ({
    page,
  }) => {
    await signInAs(page, "cashier");
    await page.goto(RECEIVING_HREF);
    await page.locator("#newReceipt").click();

    // Tomorrow in the yard. The database is what refuses a future delivery date (§15.3), so this
    // is a real round trip and a real refusal rather than a client-side guess.
    const tomorrow = new Date(Date.parse(`${businessDate()}T12:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const noteRef = unique("DND").replace(" ", "-");

    await page.getByLabel(/^supplier$/i).selectOption({ label: supplierName });
    await page.getByLabel(/delivered to/i).selectOption("store");
    await page.getByLabel(/delivery date/i).fill(tomorrow);
    await page.getByLabel(/delivery note number/i).fill(noteRef);
    await page.getByLabel(/^product$/i).selectOption({ label: PRODUCT });
    await page.getByLabel(/^expected/i).fill("4");
    await page.getByLabel(/^received$/i).fill("4");

    await page.locator("#submitReceipt").click();
    await expect(page.getByText(/cannot be dated in the future/i)).toBeVisible();

    // The refusal does NOT reset the form to the business date. Everything the person typed is
    // still there, including the date they chose, so the correction is one edit and not a retype
    // (design.md §12.7).
    await expect(page.getByLabel(/delivery date/i)).toHaveValue(tomorrow);
    await expect(page.getByLabel(/delivery note number/i)).toHaveValue(noteRef);
    await expect(page.getByLabel(/^received$/i)).toHaveValue("4");
  });

  test("a SUCCESS returns the field to the business date, not to blank", async ({ page }) => {
    await signInAs(page, "cashier");
    await page.goto(RECEIVING_HREF);
    await page.locator("#newReceipt").click();

    await page.getByLabel(/^supplier$/i).selectOption({ label: supplierName });
    await page.getByLabel(/delivered to/i).selectOption("store");
    await page.getByLabel(/delivery note number/i).fill(unique("DNS").replace(" ", "-"));
    await page.getByLabel(/^product$/i).selectOption({ label: PRODUCT });
    await page.getByLabel(/^expected/i).fill("6");
    await page.getByLabel(/^received$/i).fill("6");

    // The date is deliberately left as it opened — proving the default is submittable as it stands.
    await page.locator("#submitReceipt").click();
    await expect(page.getByText(/waiting for a manager to approve/i)).toBeVisible();

    // The next delivery is usually the same day's, so an emptied field would make the person type
    // what the server already knows.
    await expect(page.getByLabel(/delivery date/i)).toHaveValue(businessDate());
    await expect(page.getByLabel(/delivery note number/i)).toHaveValue("");
  });
});
