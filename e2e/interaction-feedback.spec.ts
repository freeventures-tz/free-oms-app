import { expect, test, type Page } from "@playwright/test";

import { expectLandsOn, fixtures, freshPhone, openNavigation, signIn } from "./fixtures";

/**
 * The interaction feedback contract (design.md §12.7), proved under DELIBERATE delay.
 *
 * Every test here makes the server slow on purpose, because that is the only way to tell an
 * interface that acknowledges a tap apart from one that merely happens to be fast. On the yard's
 * connection the second kind goes silent for seconds, and a person who gets no answer taps again —
 * which, on a screen that moves stock and money, is not a harmless thing to do.
 *
 * All three device tiers run every test: the phone is where this matters most and where the layout
 * differs most.
 */

/** Long enough that nothing here can pass by being quick, short enough to keep the suite usable. */
const SERVER_DELAY_MS = 3000;

/**
 * The budget from §12.7 rule 1. Measured in the page from the instant of the tap, so it is the
 * acknowledgement itself being timed and not Playwright's polling interval. Generous against the
 * ~60ms this actually takes, because a slow CI runner failing this test should mean the contract
 * broke, not that the machine was busy.
 */
const ACKNOWLEDGEMENT_BUDGET_MS = 500;

const ACCOUNTS_HREF = "/admin/accounts";
const ACCOUNTS_HEADING = "User accounts";

/** Delays every request for a path, so a navigation or an action cannot complete quickly. */
async function delay(page: Page, pattern: RegExp, ms = SERVER_DELAY_MS, method?: string) {
  await page.route(pattern, async (route, request) => {
    if (method && request.method() !== method) return route.continue();
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue();
  });
}

/**
 * The cold case, made deterministic: prefetches are refused outright and the real navigation is
 * slow. Merely delaying everything is not enough — a prefetch issued as the previous page loaded
 * can still land first and warm the route, and then the test is silently exercising the easy path.
 *
 * This is the yard: a phone that has not been handed the route in advance.
 */
async function starveOfPrefetch(page: Page, pattern: RegExp, ms = SERVER_DELAY_MS) {
  await page.route(pattern, async (route, request) => {
    if (request.headers()["next-router-prefetch"]) return route.abort();
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue();
  });
}

/**
 * Stamps, inside the page, how long after the tap the destination first reads as selected.
 *
 * Either mechanism counts, because to the person holding the phone they are the same promise kept:
 * `aria-current` means the route committed at once and the skeleton is up; `data-pending-nav` means
 * the route is still in flight and the item said so anyway.
 */
type NavigationTimings = { markedAt: number | null; arrivedAt: number | null };

/**
 * Both instants are stamped INSIDE the page, from one clock, started immediately before the tap.
 *
 * Timing this from the test process instead would be measuring Playwright's round trips as much as
 * the interface: each assertion costs milliseconds, and a claim about a 100ms budget cannot be
 * built out of measurements that expensive.
 */
async function watchNavigation(page: Page, href: string, heading: string) {
  await page.evaluate(
    ({ target, headingText }) => {
      const state: {
        t0: number;
        markedAt: number | null;
        arrivedAt: number | null;
      } = { t0: performance.now(), markedAt: null, arrivedAt: null };

      const selector = `a[aria-current="page"][href="${target}"], [data-pending-nav="${target}"]`;
      const check = () => {
        if (state.markedAt === null && document.querySelector(selector)) {
          state.markedAt = performance.now() - state.t0;
        }
        if (state.arrivedAt === null) {
          const h1 = document.querySelector("main h1");
          if (h1?.textContent?.trim() === headingText) {
            state.arrivedAt = performance.now() - state.t0;
          }
        }
      };

      new MutationObserver(check).observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      check();
      (window as unknown as { __fvNav: typeof state }).__fvNav = state;
    },
    { target: href, headingText: heading },
  );
}

async function navigationTimings(page: Page): Promise<NavigationTimings> {
  return page.evaluate(
    () => (window as unknown as { __fvNav: NavigationTimings }).__fvNav,
  ) as Promise<NavigationTimings>;
}

/**
 * The destination's own `h1`, and nothing else.
 *
 * A plain name match is not specific enough here: the Director's dashboard carries a card headed
 * "User accounts" too, so a loose locator reports the page as arrived while it is still on screen.
 */
function accountsHeading(page: Page) {
  return page.getByRole("heading", { level: 1, name: ACCOUNTS_HEADING, exact: true });
}

async function signInAsDirector(page: Page) {
  const { director } = fixtures();
  await signIn(page, director.phone, director.password);
  await expectLandsOn(page, "/dashboard");
}

test.describe("navigation feedback", () => {
  test("a tapped destination is marked before the server answers", async ({ page }, testInfo) => {
    // Installed BEFORE signing in: the sidebar starts prefetching the moment the dashboard renders,
    // and a prefetch that lands first would leave the test quietly exercising the warm path.
    await starveOfPrefetch(page, /\/admin\/accounts/);
    await signInAsDirector(page);

    const navigation = await openNavigation(page, testInfo);
    const link = navigation.getByRole("link", { name: /user accounts/i });
    await expect(link).toBeVisible();

    await watchNavigation(page, ACCOUNTS_HREF, ACCOUNTS_HEADING);
    await link.click({ noWaitAfter: true });

    await expect
      .poll(async () => (await navigationTimings(page)).markedAt, { timeout: 5000 })
      .toBeLessThan(ACKNOWLEDGEMENT_BUDGET_MS);

    // Nothing has committed yet — the route is still in flight, and the item said so anyway.
    await expect(page.locator(`[data-pending-nav="${ACCOUNTS_HREF}"]`)).toBeVisible();

    // It does arrive, and at the right page.
    await expect(accountsHeading(page)).toBeVisible({
      timeout: 15_000,
    });

    // The whole claim, from one clock: the interface answered long before the server did.
    const { markedAt, arrivedAt } = await navigationTimings(page);
    expect(markedAt).not.toBeNull();
    expect(arrivedAt).not.toBeNull();
    expect(arrivedAt! - markedAt!).toBeGreaterThan(SERVER_DELAY_MS / 2);
  });

  test("a route still loading shows a skeleton in place of the page", async ({ page }, testInfo) => {
    await signInAsDirector(page);

    // The first request through is the prefetch of the static loading boundary; everything after it
    // is the page's own data. This is the warm case, where the route commits at once and the
    // skeleton is what stands in until the data lands.
    let seen = 0;
    await page.route(/\/admin\/accounts/, async (route) => {
      seen += 1;
      if (seen > 1) await new Promise((resolve) => setTimeout(resolve, SERVER_DELAY_MS));
      await route.continue();
    });

    const navigation = await openNavigation(page, testInfo);
    await navigation.getByRole("link", { name: /user accounts/i }).click({ noWaitAfter: true });

    const skeleton = page.getByRole("status");
    await expect(skeleton).toBeVisible({ timeout: 5000 });
    // Announced in words, not drawn only in grey — §12.7 rule 6.
    await expect(skeleton).toContainText(/working/i);
    // Shaped like the page it replaces, rather than a centred spinner (§12.7 rule 3).
    expect(await skeleton.locator("[data-slot='skeleton']").count()).toBeGreaterThan(5);

    await expect(accountsHeading(page)).toBeVisible({
      timeout: 15_000,
    });
    await expect(skeleton).toHaveCount(0);
  });

  test("the feedback survives prefers-reduced-motion", async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await starveOfPrefetch(page, /\/admin\/accounts/);
    await signInAsDirector(page);

    const navigation = await openNavigation(page, testInfo);
    await watchNavigation(page, ACCOUNTS_HREF, ACCOUNTS_HEADING);
    await navigation.getByRole("link", { name: /user accounts/i }).click({ noWaitAfter: true });

    await expect
      .poll(async () => (await navigationTimings(page)).markedAt, { timeout: 5000 })
      .toBeLessThan(ACKNOWLEDGEMENT_BUDGET_MS);

    // Nothing is moving, and the state is still legible: the destination carries the selected
    // surface, and the hint beside it is visible rather than animating.
    const hint = page.locator("[data-pending-nav] .fv-nav-hint");
    await expect(hint).toBeVisible();
    expect(await hint.evaluate((node) => getComputedStyle(node).animationName)).toBe("none");
  });
});

test.describe("action feedback", () => {
  /** Opens User Accounts and fills the create form, without submitting it. */
  async function fillNewAccount(page: Page, name: string, phone: string) {
    await page.goto("/admin/accounts");
    await expect(accountsHeading(page)).toBeVisible();
    await page.getByLabel(/full name/i).fill(name);
    await page.getByLabel(/phone number/i).fill(phone);
  }

  test("a pending button keeps its size and says what it is doing", async ({ page }) => {
    await signInAsDirector(page);
    await fillNewAccount(page, "Feedback Size Test", freshPhone());

    const submit = page.getByRole("button", { name: /^create account$/i });
    const before = await submit.boundingBox();

    // Only the action is slowed; the page is already on screen.
    await delay(page, /\/admin\/accounts/, SERVER_DELAY_MS, "POST");
    await submit.click({ noWaitAfter: true });

    const pendingButton = page.locator("button[data-slot='button'][aria-busy='true']");
    await expect(pendingButton).toBeVisible({ timeout: 5000 });

    // Rule 4: the control must not resize, or a row of buttons shifts under a thumb mid-tap.
    const during = await pendingButton.boundingBox();
    expect(Math.abs((during?.width ?? 0) - (before?.width ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((during?.height ?? 0) - (before?.height ?? 0))).toBeLessThanOrEqual(1);

    // …and it is not saying so by colour alone.
    await expect(pendingButton).toContainText(/working/i);
    await expect(pendingButton).toBeDisabled();
  });

  test("activating an action repeatedly performs it exactly once", async ({ page }, testInfo) => {
    await signInAsDirector(page);

    // Named per device tier: the three projects share one database, so a fixed name would have
    // this test counting the accounts the other two tiers created.
    const name = `Feedback Once ${testInfo.project.name}`;
    await fillNewAccount(page, name, freshPhone());

    // Count what actually reaches the server. A guard that only hides the button is not a guard.
    const serverActions: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.headers()["next-action"]) {
        serverActions.push(request.url());
      }
    });

    await delay(page, /\/admin\/accounts/, SERVER_DELAY_MS, "POST");

    const submit = page.getByRole("button", { name: /^create account$/i });
    // Dispatched natively, in one tick, bypassing every actionability check Playwright would
    // otherwise apply — the impatient double-tap, reproduced faithfully.
    await submit.evaluate((node: HTMLButtonElement) => {
      for (let i = 0; i < 6; i++) node.click();
    });

    // The one operation completes and hands over exactly one credential.
    await expect(page.getByText(/temporary password/i)).toBeVisible({ timeout: 20_000 });
    expect(serverActions).toHaveLength(1);

    // And the database holds one account, not six.
    await page.goto("/admin/accounts");
    await expect(page.getByText(name)).toHaveCount(1);
  });

  test("a refused action is reported honestly, with a way to try again", async ({ page }) => {
    await signInAsDirector(page);

    // A number that already belongs to someone: the server refuses, and the screen must say so
    // rather than show a success it did not receive (§12.7 rule 5).
    const { cashier } = fixtures();
    await fillNewAccount(page, "Feedback Refusal Test", cashier.phone);
    await page.getByRole("button", { name: /^create account$/i }).click();

    await expect(page.getByRole("alert")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/temporary password/i)).toHaveCount(0);
    // The remedy that actually helps is offered by name (design.md §12.5).
    await expect(
      page.getByRole("button", { name: /set a new password for this account/i }),
    ).toBeVisible();
  });
});
