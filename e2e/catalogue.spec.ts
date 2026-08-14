import { expect, test, type Page } from "@playwright/test";

import { expectLandsOn, fixtures, openNavigation, signIn } from "./fixtures";

/**
 * Products & prices, on every device tier.
 *
 * Two things are being proved here that no other layer can prove. First, that a MANAGER finds no
 * way to change a price on the screen — pgTAP and the integration tests show the database refusing
 * them, and this shows the interface not offering it, which is the other half of design.md §4.3.
 * Second, that the Stage 10 Part A interaction contract holds on a screen that did not exist when
 * that contract was written.
 *
 * The Part A test matrix is NOT repeated per control. It was proved once, against the account
 * screens, for the primitives every screen now shares. What is proved here is that this screen uses
 * them: one delayed navigation, one delayed action, one failure and one retry.
 */

const SERVER_DELAY_MS = 3000;
const ACKNOWLEDGEMENT_BUDGET_MS = 500;
const PRODUCTS_HREF = "/settings/products";

async function signInAs(page: Page, who: "director" | "manager") {
  const account = fixtures()[who];
  await signIn(page, account.phone, account.password);
  await expectLandsOn(page, "/dashboard");
}

/**
 * The row for one product, found by its accessible name — the pair (name, grade) that IS the
 * product. Locating it by loose text would match the two Nondo 12 mm rows equally.
 */
function productCard(page: Page, name: string) {
  return page.getByRole("article", { name, exact: true });
}

test.describe("reading the catalogue", () => {
  test("a Director sees the approved catalogue, and what has no price", async ({ page }, testInfo) => {
    await signInAs(page, "director");

    const navigation = await openNavigation(page, testInfo);
    await navigation.getByRole("link", { name: /products/i }).click();

    await expect(page.getByRole("heading", { level: 1, name: /products/i })).toBeVisible();

    // The approved catalogue is on screen, including both Nondo grades as SEPARATE products —
    // grade is identity, not an attribute (product.md §6).
    //
    // The count is deliberately not pinned here: the three device projects share one database and
    // the add-product test below changes it. That the seed is exactly 21 is asserted where it can
    // be asserted decisively — in pgTAP, and by the migration itself, which refuses to apply
    // otherwise.
    for (const product of ["Tofali 5\"", "Dangote Cement 42R", "Marine 18 mm"]) {
      await expect(page.getByRole("article", { name: product, exact: true })).toBeVisible();
    }
    await expect(page.getByRole("article", { name: "Nondo 12 mm BS 300", exact: true })).toBeVisible();
    await expect(page.getByRole("article", { name: "Nondo 12 mm BS 500", exact: true })).toBeVisible();

    // Never "TZS 0" — a missing price is a named state, not a number nobody approved.
    await expect(page.getByText(/no price set/i).first()).toBeVisible();
    await expect(page.getByText("TZS 0")).toHaveCount(0);
  });

  test("a Manager reads prices and is offered no way to change one", async ({ page }, testInfo) => {
    await signInAs(page, "manager");

    const navigation = await openNavigation(page, testInfo);
    await expect(navigation.getByRole("link", { name: /products/i })).toBeVisible();
    await navigation.getByRole("link", { name: /products/i }).click();

    await expect(page.getByRole("heading", { level: 1, name: /products/i })).toBeVisible();
    await expect(page.getByRole("article", { name: "Nondo 12 mm BS 300", exact: true })).toBeVisible();

    // Hidden, not disabled (design.md §4.3, §4.4): no greyed button, no tooltip, nothing that
    // leaks the authority structure. And no way to add a product either.
    await expect(page.getByRole("button", { name: /^set price$/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^change price$/i })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /add a product/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^add product$/i })).toHaveCount(0);
  });

  test("a Sales Representative is not offered the destination at all", async ({ page }, testInfo) => {
    const { salesRep } = fixtures();
    await signIn(page, salesRep.phone, salesRep.password);
    await expectLandsOn(page, "/orders");

    const navigation = await openNavigation(page, testInfo);
    await expect(navigation.getByRole("link", { name: /products/i })).toHaveCount(0);

    // …and typing the address is refused server-side, not merely unlinked.
    await page.goto(PRODUCTS_HREF);
    await expect(page).toHaveURL(/\/no-access/);
  });
});

test.describe("setting prices", () => {
  test("a Director sets a price, and the history records why", async ({ page }, testInfo) => {
    await signInAs(page, "director");
    await page.goto(PRODUCTS_HREF);

    // Per tier, so the three projects do not price the same product and race each other.
    const product = { mobile: "Tofali 5\"", tablet: "Tofali 6\"", desktop: "Culvert 900D" }[
      testInfo.project.name as "mobile" | "tablet" | "desktop"
    ]!;

    const card = productCard(page, product);
    await card.getByRole("button", { name: /^set price$/i }).click();

    await page.getByLabel(/price in tzs/i).fill("12,500");
    await page.getByLabel(/why is it changing/i).fill("Opening price for the season");
    await page.getByRole("button", { name: /^save price$/i }).click();

    await expect(page.getByText(/price saved/i)).toBeVisible({ timeout: 15_000 });

    // Grouped, in full, with no decimal artefact (design.md §8.5).
    await page.reload();
    await expect(productCard(page, product).getByText("TZS 12,500")).toBeVisible();

    // The reason and the Director are part of the permanent record (product.md §4.4).
    await productCard(page, product).getByRole("button", { name: /price history/i }).click();
    await expect(page.getByText("Opening price for the season")).toBeVisible();
    await expect(page.getByText(/first price/i)).toBeVisible();
  });

  test("changing a price records what it was", async ({ page }, testInfo) => {
    await signInAs(page, "director");
    await page.goto(PRODUCTS_HREF);

    const product = { mobile: "Timber 1 × 6", tablet: "Timber 1 × 8", desktop: "Timber 2 × 2" }[
      testInfo.project.name as "mobile" | "tablet" | "desktop"
    ]!;

    for (const [amount, reason] of [
      ["8000", "Opening price"],
      ["9500", "Timber supplier raised prices"],
    ]) {
      const card = productCard(page, product);
      await card.getByRole("button", { name: /^set price$|^change price$/i }).click();
      await page.getByLabel(/price in tzs/i).fill(amount);
      await page.getByLabel(/why is it changing/i).fill(reason);
      await page.getByRole("button", { name: /^save price$/i }).click();
      await expect(page.getByText(/price saved/i)).toBeVisible({ timeout: 15_000 });
      await page.reload();
    }

    await expect(productCard(page, product).getByText("TZS 9,500")).toBeVisible();

    await productCard(page, product).getByRole("button", { name: /price history/i }).click();
    // Both entries survive: history is appended to, never overwritten.
    await expect(page.getByText("Timber supplier raised prices")).toBeVisible();
    await expect(page.getByText("Opening price")).toBeVisible();
    await expect(page.getByText(/was TZS 8,000/i)).toBeVisible();
  });

  test("a refused price is reported inline, with everything still typed", async ({ page }) => {
    await signInAs(page, "director");
    await page.goto(PRODUCTS_HREF);

    const card = productCard(page, "Sand");
    await card.getByRole("button", { name: /^set price$|^change price$/i }).click();

    // Cents are refused rather than rounded away: the figure would reach a customer.
    await page.getByLabel(/price in tzs/i).fill("4500.50");
    await page.getByLabel(/why is it changing/i).fill("Trying a price with cents");
    await page.getByRole("button", { name: /^save price$/i }).click();

    await expect(page.getByRole("alert").first()).toContainText(/whole shillings/i, {
      timeout: 15_000,
    });
    // Nothing was lost, and no success was claimed.
    await expect(page.getByLabel(/price in tzs/i)).toHaveValue("4500.50");
    await expect(page.getByLabel(/why is it changing/i)).toHaveValue("Trying a price with cents");
    await expect(page.getByText(/price saved/i)).toHaveCount(0);
  });
});

test.describe("adding a product", () => {
  test("a Director adds one, and it arrives with no price", async ({ page }, testInfo) => {
    await signInAs(page, "director");
    await page.goto(PRODUCTS_HREF);

    const name = `E2E Product ${testInfo.project.name}`;

    await page.getByLabel(/product name/i).fill(name);
    await page.getByLabel(/grade or specification/i).fill("Grade Z");
    await page.selectOption("#productUnit", "sheet");
    await page.getByRole("button", { name: /^add product$/i }).click();

    await expect(page.getByText(new RegExp(`${name} added`, "i"))).toBeVisible({ timeout: 15_000 });

    await page.goto(PRODUCTS_HREF);
    // Found by its full identity: the grade is part of what the product is, so it is part of the
    // card's accessible name too.
    const card = productCard(page, `${name} Grade Z`);
    await expect(card.getByText(/no price set/i)).toBeVisible();
    // Pricing is a separate Director decision with its own record (product.md §4, §4.4).
    await expect(card.getByRole("button", { name: /^set price$/i })).toBeVisible();
  });

  test("a duplicate is refused by name and grade together", async ({ page }) => {
    await signInAs(page, "director");
    await page.goto(PRODUCTS_HREF);

    // Grade is part of identity, so this pair already exists in the seeded catalogue.
    await page.getByLabel(/product name/i).fill("nondo 12 mm");
    await page.getByLabel(/grade or specification/i).fill("bs 300");
    await page.selectOption("#productUnit", "bar");
    await page.getByRole("button", { name: /^add product$/i }).click();

    await expect(page.getByRole("alert").first()).toContainText(/already in the catalogue/i, {
      timeout: 15_000,
    });
    // Everything typed survives the refusal, including the unit (design.md §12.5).
    await expect(page.getByLabel(/product name/i)).toHaveValue("nondo 12 mm");
    await expect(page.getByLabel(/grade or specification/i)).toHaveValue("bs 300");
    await expect(page.locator("#productUnit")).toHaveValue("bar");
  });
});

test.describe("the interaction contract on this screen", () => {
  test("the destination is marked before the catalogue arrives", async ({ page }, testInfo) => {
    // Prefetch refused and the route slowed: the cold case, a phone that has not been handed the
    // route in advance.
    await page.route(/\/settings\/products/, async (route, request) => {
      if (request.headers()["next-router-prefetch"]) return route.abort();
      await new Promise((resolve) => setTimeout(resolve, SERVER_DELAY_MS));
      await route.continue();
    });

    await signInAs(page, "director");
    const navigation = await openNavigation(page, testInfo);

    await page.evaluate((target) => {
      const state = { t0: performance.now(), markedAt: null as number | null };
      const selector = `a[aria-current="page"][href="${target}"], [data-pending-nav="${target}"]`;
      const check = () => {
        if (state.markedAt === null && document.querySelector(selector)) {
          state.markedAt = performance.now() - state.t0;
        }
      };
      new MutationObserver(check).observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
      });
      (window as unknown as { __fvNav: typeof state }).__fvNav = state;
    }, PRODUCTS_HREF);

    await navigation.getByRole("link", { name: /products/i }).click({ noWaitAfter: true });

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __fvNav: { markedAt: number | null } }).__fvNav.markedAt,
          ),
        { timeout: 5000 },
      )
      .toBeLessThan(ACKNOWLEDGEMENT_BUDGET_MS);

    await expect(page.locator(`[data-pending-nav="${PRODUCTS_HREF}"]`)).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: /products/i })).toBeVisible({
      timeout: 15_000,
    });
  });

  test("a loading catalogue shows a skeleton shaped like it", async ({ page }, testInfo) => {
    await signInAs(page, "director");

    let seen = 0;
    await page.route(/\/settings\/products/, async (route) => {
      seen += 1;
      if (seen > 1) await new Promise((resolve) => setTimeout(resolve, SERVER_DELAY_MS));
      await route.continue();
    });

    const navigation = await openNavigation(page, testInfo);
    await navigation.getByRole("link", { name: /products/i }).click({ noWaitAfter: true });

    const skeleton = page.getByRole("status");
    await expect(skeleton).toBeVisible({ timeout: 5000 });
    await expect(skeleton).toContainText(/working/i);
    expect(await skeleton.locator("[data-slot='skeleton']").count()).toBeGreaterThan(5);

    await expect(page.getByRole("heading", { level: 1, name: /products/i })).toBeVisible({
      timeout: 15_000,
    });
  });

  test("saving a price repeatedly saves it exactly once", async ({ page }, testInfo) => {
    await signInAs(page, "director");
    await page.goto(PRODUCTS_HREF);

    const product = { mobile: "Marine 12 mm", tablet: "Marine 18 mm", desktop: "Mirunda 4 × 12" }[
      testInfo.project.name as "mobile" | "tablet" | "desktop"
    ]!;

    const serverActions: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.headers()["next-action"]) {
        serverActions.push(request.url());
      }
    });

    const card = productCard(page, product);
    await card.getByRole("button", { name: /^set price$/i }).click();
    await page.getByLabel(/price in tzs/i).fill("33000");
    await page.getByLabel(/why is it changing/i).fill("Pressed more than once on purpose");

    // The action is slowed so the burst genuinely overlaps a request in flight.
    await page.route(/\/settings\/products/, async (route, request) => {
      if (request.method() !== "POST") return route.continue();
      await new Promise((resolve) => setTimeout(resolve, SERVER_DELAY_MS));
      await route.continue();
    });

    const save = page.getByRole("button", { name: /^save price$/i });
    // Dispatched natively in one tick, bypassing every actionability check Playwright applies.
    await save.evaluate((node: HTMLButtonElement) => {
      for (let i = 0; i < 6; i++) node.click();
    });

    // The pending state belongs to the control that was pressed, and says so in words.
    await expect(page.locator("button[data-slot='button'][aria-busy='true']")).toContainText(
      /working/i,
    );

    await expect(page.getByText(/price saved/i)).toBeVisible({ timeout: 20_000 });
    expect(serverActions, "more than one request reached the server").toHaveLength(1);

    // And permanent history holds one entry, not six.
    await page.goto(PRODUCTS_HREF);
    await productCard(page, product).getByRole("button", { name: /price history \(1\)/i }).click();
    await expect(page.getByText("Pressed more than once on purpose")).toBeVisible();
  });
});
