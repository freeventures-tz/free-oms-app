import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type ElementHandle, type Locator, type Page } from "@playwright/test";

import { derivedAuthIdentifier } from "@/lib/auth/phone-identity";
import { expectLandsOn, fixtures, signIn } from "./fixtures";

/**
 * What the two changed stock commands cost a phone in the yard, over 4G (issue #7).
 *
 * OFF BY DEFAULT, like the server-side benchmark beside it. Run it deliberately:
 *
 *     FV_BENCHMARK=1 npx playwright test --project=mobile e2e/stock-mobile-benchmark.spec.ts
 *
 * WHY THIS EXISTS SEPARATELY FROM `tests/integration/stock-benchmark.test.ts`. That file times the
 * command inside the database, over local HTTP, on an unthrottled machine. It is the right
 * measurement of what this ticket ADDED — one more availability query and one more advisory lock
 * per line — and it is not a mobile measurement. Nor can a mobile figure be ARITHMETIC laid on top
 * of it: adding an assumed round trip to a local timing assumes the answer.
 *
 * ── WHAT IS MEASURED, AND WHY EACH END OF THE INTERVAL IS WHAT IT IS ──────────────────────────
 *
 * A REAL TOUCH STARTS THE CLOCK, and the run asserts it was one. `locator.tap()` drives the CDP
 * touch pipeline, and the instrument records `pointerType` and whether a `touchstart` was seen, so
 * a measurement silently taken with a mouse — which is what `click()` gives even on a project
 * configured `hasTouch` — fails instead of quietly describing the wrong input.
 *
 * A VISIBLE CHANGE ON THE CONTROL THAT WAS TOUCHED STOPS IT, and the touch is confirmed to have
 * landed there: the `pointerdown` is ignored unless its target is that element or inside it. The
 * element handle that was tapped is held, and the signal is a spinner rendered INSIDE it while it
 * carries `aria-busy`.
 *
 * AND A NODE IN THE TREE IS NOT YET A PIXEL. The spinner is required to have a non-zero box and a
 * computed style that can be seen, and the clock stops on the ANIMATION FRAME that carries that
 * render to the screen rather than on the DOM mutation. Both figures are reported. The residual
 * uncertainty is one frame: a rAF callback runs immediately before the paint it belongs to, and
 * nothing inside the page can observe the paint completing, so this is a close lower bound rather
 * than the paint itself.
 *
 * SUCCESS IS THE APPROVAL OF THE SAME ENTITY — approval, not merely a decision. For a batch, the
 * decision record carrying that batch's own id AND the card around it reading Approved, because
 * `batch-decision-<id>` renders for a rejection too. For a correction, the card carrying that
 * correction's own uniquely seeded reason showing its own "approved by" chip. A count of settled
 * records proves that SOMETHING settled, which is a different claim and was wrong here twice: once
 * because the decided queue pages at twenty-five so the count could not rise, and once because a
 * count says nothing about which record moved.
 *
 * ── WHICH SAMPLES ARE JUDGED ──────────────────────────────────────────────────────────────────
 *
 * ALL OF THEM. The first interaction after a page load is reported separately because it behaves
 * differently and hiding that would be dishonest, but it is inside the acceptance gate exactly like
 * every other tap. §12.7 rule 1 says every click or tap and states no exception for a page that has
 * just loaded. The 100 ms and 2,500 ms budgets below are the ones the specification sets.
 *
 * ── EVIDENCE CARRIED WITH EACH SAMPLE ─────────────────────────────────────────────────────────
 *
 * Every sample records `document.readyState` at the moment of the touch, how long after navigation
 * start the touch landed, and where the navigation's own `domContentLoadedEventEnd` and
 * `loadEventEnd` fell. Those are facts, not a theory: they are what makes it possible to say
 * whether a slow first tap landed while the page was still loading rather than to assert it.
 *
 * THE PROFILES are Chrome DevTools' own presets, named so a reader can reproduce them. Both are
 * measured because the workspace documents no single approved profile: design.md §2.1 and §11.9 say
 * "mid- or low-range Android phones" on a varying network and fix no figures.
 *
 * IT RUNS AGAINST THE BASE TOO. `FV_BENCHMARK_LABEL` names the tree, so the same file copied into a
 * checkout of `525418e` produces directly comparable output. Without that comparison any number
 * here is a reading with nothing to read it against.
 *
 * ── WHAT THE CORRECTED INSTRUMENT FOUND, 8 September 2026 ─────────────────────────────────────
 *
 * BOTH GATES ARE MET, ON BOTH TREES, and two earlier findings from this file are WITHDRAWN.
 *
 * Candidate and base run back to back with this exact file, 25 samples per command per profile,
 * all of them judged:
 *
 *                                   candidate            base
 *   Slow 4G · batch      worst ack    51 ms               77 ms
 *                        p95 done    931 ms            1 098 ms
 *   Slow 4G · correction worst ack    58 ms               67 ms
 *                        p95 done    832 ms              973 ms
 *   Fast 4G · batch      worst ack    60 ms               56 ms
 *                        p95 done    798 ms              755 ms
 *   Fast 4G · correction worst ack    45 ms               42 ms
 *                        p95 done    371 ms              406 ms
 *
 * Where it goes: `pointerdown → click` 5–39 ms, the browser's touch handling; `click → spinner`
 * 14–43 ms, the application's own share. The frame that carries the render costs 0–12 ms beyond
 * the DOM change. Nothing in either tree approaches 100 ms, and nothing approaches 2,500 ms.
 *
 * WITHDRAWN 1 — "the first tap waits for the page to become interactive". Disproved by this
 * file's own evidence: `readyState` was `complete` and the touch landed after `loadEventEnd` in
 * 100% of samples, first taps included, one to six seconds after navigation. It was asserted
 * without being measured.
 *
 * WITHDRAWN 2 — the proposed `active:` variant on the shared `Button`. It was proposed to fix a
 * defect the older instrument appeared to show and this one does not. No shared control is
 * changed and no application correction is proposed, because the measurements no longer evidence
 * one.
 *
 * THE EARLIER NUMBERS WERE THE INSTRUMENT, NOT THE APPLICATION. Three faults produced them, and
 * each is worth naming because each looked reasonable:
 *
 *   · a mouse click stood in for a touch, so the input pipeline under test was never exercised;
 *   · the busy-and-spinning check was document-wide, so any control could satisfy it;
 *   · success was a COUNT of settled records rather than the approval of the entity tapped.
 *
 * A fourth lived in this file for one round and never matched anything: a word-boundary regex
 * looking for "Approved" in a card whose `textContent` runs its elements together as
 * "…0001ApprovedYard…". It now finds the status chip element and compares its trimmed text, which
 * is what the card actually says rather than what a substring search hopes it says.
 *
 * WHAT REMAINS TRUE is that this machine's spread is wide, so single runs prove little and only
 * matched pairs run back to back are worth reading. That is how the table above was taken.
 */

const ENABLED = process.env.FV_BENCHMARK === "1";

/** Names the tree in the output, so a candidate run and a base run cannot be confused. */
const LABEL = process.env.FV_BENCHMARK_LABEL ?? "candidate";

/**
 * Samples per command per profile.
 *
 * FIRST taps each get their own page load — the only way to take more than one of them — and the
 * rest are taken consecutively on a page already in use. Both groups are judged.
 */
const FIRST_SAMPLES = 5;
const SUBSEQUENT_SAMPLES = 20;

/** design.md §12.7 rule 1, and the budget every other spec in this suite already holds to. */
const TAP_TO_VISIBLE_BUDGET_MS = 100;

/** The p95 the directive sets for a server-confirmed stock command. */
const COMPLETION_P95_BUDGET_MS = 2_500;

const PROFILES = [
  {
    name: "Slow 4G",
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
    latency: 562.5,
    cpu: 4,
  },
  {
    name: "Fast 4G",
    downloadThroughput: (9 * 1024 * 1024) / 8,
    uploadThroughput: (1.5 * 1024 * 1024) / 8,
    latency: 85,
    cpu: 4,
  },
] as const;

const CEMENT = "Dangote Cement 42R";
const SAND = "Sand";
const AGGREGATE = "Aggregate";
const BRICK_6 = 'Tofali 6"';

const SUFFIX = Math.random().toString(36).slice(2, 8).toUpperCase();
const SUPPLIER = `E2E Benchmark Supplier ${SUFFIX}`;

const PER_COMMAND = FIRST_SAMPLES + SUBSEQUENT_SAMPLES;

/** Every batch and every correction takes one bag, for both commands and both profiles, plus slack. */
const CEMENT_NEEDED = PER_COMMAND * PROFILES.length * 2 + 40;

type Board = "batch" | "adjustment";

/**
 * One measured touch, with the page-state facts that were true when it happened.
 *
 * `ack` is decomposed on purpose. A touch does not become a React `onClick` until the browser has
 * seen `touchend` and synthesised a click, and that part of the interval belongs to the input
 * pipeline rather than to the application. Reporting only the total would leave a reader unable to
 * tell a slow control from a slow browser — and the two have opposite fixes.
 */
type Sample = {
  /**
   * `pointerdown` → the animation frame that carries the spinner to the screen. The gate is judged
   * on this rather than on the DOM mutation, because a node in the tree is not yet a pixel.
   */
  ack: number;
  /** The same interval measured to the DOM change instead, so the frame's cost is visible. */
  ackDomChange: number;
  /** `pointerdown` → the synthesised `click`. The browser's touch handling, not ours. */
  inputDelay: number;
  /** `click` → the spinner. The application's own share of the acknowledgement. */
  appResponse: number;
  done: number;
  pointerType: string;
  sawTouchStart: boolean;
  trusted: boolean;
  readyState: string;
  sinceNavigation: number;
  loadEventEnd: number;
  /** Main-thread time spent in long tasks since navigation, and how recently one ended. */
  longTaskMs: number;
  msSinceLastLongTask: number;
};

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank, so a reported p95 is an observation rather than an interpolation between two.
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1];
}

type Summary = { n: number; p50: number; p95: number; worst: number };

function report(label: string, samples: number[]): Summary {
  const s: Summary = {
    n: samples.length,
    p50: Math.round(percentile(samples, 0.5)),
    p95: Math.round(percentile(samples, 0.95)),
    worst: Math.round(Math.max(...samples)),
  };
  console.log(`${label.padEnd(60)} n=${s.n}  p50=${s.p50}ms  p95=${s.p95}ms  worst=${s.worst}ms`);
  // Every sample, in the order taken. A percentile hides WHERE a slow one fell, and a reviewer
  // cannot re-derive a distribution from three numbers.
  console.log(`${" ".repeat(60)} raw: ${samples.map((v) => Math.round(v)).join(", ")}`);
  return s;
}

/** The page-state facts behind a group of samples, printed so the timings can be reasoned about. */
function reportPageState(label: string, samples: Sample[]): void {
  const loading = samples.filter((s) => s.readyState !== "complete").length;
  const beforeLoadEnd = samples.filter(
    (s) => s.loadEventEnd === 0 || s.sinceNavigation < s.loadEventEnd,
  ).length;
  console.log(
    `${label.padEnd(60)} touched at readyState≠complete: ${loading}/${samples.length} · ` +
      `before loadEventEnd: ${beforeLoadEnd}/${samples.length} · ` +
      `ms since navigation: ${samples.map((s) => Math.round(s.sinceNavigation)).join(", ")}`,
  );
  console.log(
    `${" ".repeat(60)} long-task ms since navigation: ` +
      `${samples.map((s) => Math.round(s.longTaskMs)).join(", ")} · ` +
      `ms since the last long task ended: ` +
      `${samples.map((s) => Math.round(s.msSinceLastLongTask)).join(", ")}`,
  );
}

/**
 * Where the acknowledgement actually went: the browser's share, then ours.
 *
 * A React `onClick` cannot run until the browser has synthesised a click from the touch. Splitting
 * the interval there is the difference between "the control is slow" and "the control is not
 * reached until late", which are not the same defect and do not have the same fix.
 */
function reportDecomposition(label: string, samples: Sample[]): void {
  const input = samples.map((s) => s.inputDelay);
  const app = samples.map((s) => s.appResponse);
  console.log(
    `${label.padEnd(60)} pointerdown→click p50=${Math.round(percentile(input, 0.5))}ms ` +
      `worst=${Math.round(Math.max(...input))}ms · ` +
      `click→spinner p50=${Math.round(percentile(app, 0.5))}ms ` +
      `worst=${Math.round(Math.max(...app))}ms`,
  );
  console.log(`${" ".repeat(60)} raw pointerdown→click: ${input.map((v) => Math.round(v)).join(", ")}`);
  console.log(`${" ".repeat(60)} raw click→spinner:     ${app.map((v) => Math.round(v)).join(", ")}`);
  const dom = samples.map((s) => s.ackDomChange);
  console.log(
    `${" ".repeat(60)} same interval to the DOM change instead of the frame: ` +
      `p50=${Math.round(percentile(dom, 0.5))}ms worst=${Math.round(Math.max(...dom))}ms`,
  );
}

async function signInAs(page: Page, who: "director" | "manager") {
  const account = fixtures()[who];
  await page.context().clearCookies();
  await signIn(page, account.phone, account.password);
  await expectLandsOn(page, "/dashboard");
}

/**
 * A session for one fixture account, through the same commands the screens call.
 *
 * The SEEDING is done this way and the MEASURING is not: fifty drafts through the forms would take
 * longer than the run and would time the forms rather than the command. Nothing here uses the
 * secret key, so what is seeded is only what that person could have done themselves.
 */
async function sessionFor(who: "director" | "manager"): Promise<{
  api: SupabaseClient;
  read: SupabaseClient;
}> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const account = fixtures()[who];

  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: derivedAuthIdentifier(account.phone),
      password: account.password,
    }),
  });

  const body = await response.json();
  if (response.status !== 200) throw new Error(`${who} could not sign in: ${JSON.stringify(body)}`);

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

/**
 * Arms the in-page instrument, taps for real, and reads back one sample.
 *
 * Every timestamp is `performance.now()` inside the page, on one clock, so nothing the harness
 * costs — a CDP round trip, Playwright's own polling — is charged to the application. The element
 * that was touched is passed in as a handle and held, because "did THIS control acknowledge" is the
 * question and a document-wide query answers a different one.
 */
async function measureTap(
  page: Page,
  approve: Locator,
  board: Board,
  entityId: string,
  /** For a correction, the unique reason text that identifies its card. Unused for a batch. */
  marker: string,
): Promise<Sample> {
  const node = (await approve.elementHandle()) as ElementHandle<HTMLElement>;
  expect(node, "the control to be tapped must exist").not.toBeNull();

  await page.evaluate(
    ({ target, kind, id, reason }) => {
      const w = window as unknown as Record<string, unknown>;

      // Tear the previous sample's instrument down first. Leaving them attached ran one more
      // document-wide MutationObserver per sample, a cost the instrument would then charge to the
      // application it is measuring.
      const previous = w.__fvTeardown as (() => void) | undefined;
      if (previous) previous();

      const settled = () => {
        if (kind === "batch") {
          // A DECISION IS NOT AN APPROVAL. `batch-decision-<id>` renders for any decided batch,
          // a rejection included, so it is paired with the card's own status: the record must be
          // this batch's AND the card carrying it must say Approved.
          const record = document.querySelector(`[data-testid="batch-decision-${id}"]`);
          if (!record) return false;
          const card = record.closest('[role="article"]');
          if (!card) return false;
          // THE STATUS CHIP ITSELF, not a substring of the card. A card's `textContent` runs its
          // elements together — "FV-BAT-20260908-0001ApprovedYard · 8 Sept…" — so "Approved" has a
          // letter on one side and a word boundary never matches it, while a bare substring test
          // would also accept the word arriving from somewhere else entirely.
          return Array.from(card.querySelectorAll("span")).some(
            (el) => (el.textContent ?? "").trim() === "Approved",
          );
        }
        // THIS correction, identified by its own reason text, showing its own approval chip.
        for (const card of Array.from(document.querySelectorAll('[role="article"]'))) {
          const text = card.textContent ?? "";
          if (text.includes(reason) && /approved by/i.test(text)) return true;
        }
        return false;
      };

      // Long tasks are collected from navigation onwards, so a touch can be described against a
      // main thread that was actually busy rather than one assumed to be.
      const longTasks: { start: number; end: number }[] = [];
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasks.push({ start: entry.startTime, end: entry.startTime + entry.duration });
          }
        }).observe({ type: "longtask", buffered: true });
      } catch {
        // Long-task timing is Chromium-only; its absence must not stop the measurement.
      }

      const state = {
        down: null as number | null,
        click: null as number | null,
        domChange: null as number | null,
        visible: null as number | null,
        done: null as number | null,
        pointerType: "",
        sawTouchStart: false,
        trusted: false,
        readyState: "",
        sinceNavigation: 0,
        loadEventEnd: 0,
        longTaskMs: 0,
        msSinceLastLongTask: -1,
      };
      w.__fvBench = state;

      const onPointerDown = (event: PointerEvent) => {
        if (state.down !== null) return;
        // WHICH CONTROL RECEIVED IT. A document-level listener would otherwise timestamp a touch
        // that landed somewhere else entirely and call it this control's acknowledgement.
        const hit = event.target as Node | null;
        if (!hit || !(target === hit || target.contains(hit))) return;
        state.down = performance.now();
        state.pointerType = event.pointerType;
        state.trusted = event.isTrusted;
        state.readyState = document.readyState;
        const nav = performance.getEntriesByType("navigation")[0] as
          | PerformanceNavigationTiming
          | undefined;
        state.sinceNavigation = nav ? performance.now() - nav.startTime : -1;
        state.loadEventEnd = nav ? nav.loadEventEnd : -1;
        state.longTaskMs = longTasks.reduce((total, t) => total + (t.end - t.start), 0);
        const last = longTasks.length > 0 ? longTasks[longTasks.length - 1].end : null;
        state.msSinceLastLongTask = last === null ? -1 : state.down - last;
      };

      // The synthesised click. A React onClick cannot run before this, so the interval before it
      // is the browser's and the interval after it is ours.
      const onClick = () => {
        if (state.click === null) state.click = performance.now();
      };
      const onTouchStart = () => {
        state.sawTouchStart = true;
      };

      document.addEventListener("pointerdown", onPointerDown, { capture: true });
      document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
      document.addEventListener("click", onClick, { capture: true });

      const check = () => {
        // VISIBLE, ON THE CONTROL THAT WAS TOUCHED: it says it is working AND it is rendering a
        // spinner that actually occupies space. `querySelector` alone proves DOM insertion, which
        // is not the same as something a person can see, so the element's own box and computed
        // style are checked too.
        if (state.visible === null && target.getAttribute("aria-busy") === "true") {
          const spinner = target.querySelector(".animate-spin");
          if (spinner) {
            const box = spinner.getBoundingClientRect();
            const style = getComputedStyle(spinner);
            const painted =
              box.width > 0 &&
              box.height > 0 &&
              style.visibility !== "hidden" &&
              style.display !== "none" &&
              Number(style.opacity) !== 0;

            if (painted) {
              state.domChange = performance.now();
              // AND THE FRAME THAT CARRIES IT TO THE SCREEN. A rAF callback runs immediately
              // before the paint that shows this render, so it is the closest a page can get to
              // timestamping its own paint. The gate is judged on this, the later of the two.
              // The residual uncertainty is one frame — the paint completes shortly after the
              // callback, and nothing inside the page can observe that moment directly.
              requestAnimationFrame(() => {
                if (state.visible === null) state.visible = performance.now();
              });
            }
          }
        }
        if (state.done === null && settled()) state.done = performance.now();
      };

      const observer = new MutationObserver(check);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });

      // THE POLL DRIVES THE CHECK AS WELL AS THE OBSERVER.
      //
      // A MutationObserver alone was not enough: one sample recorded its touch, its click and its
      // spinner, then sat for two minutes while the page plainly showed the approval it was
      // waiting for. Whatever swallowed that callback, an instrument that can miss the event it
      // exists to time is not one to reason from, so the animation-frame poll below re-evaluates
      // the same predicate. The cost is that a settled timestamp can be up to one frame late;
      // the benefit is that it cannot be missed altogether.
      w.__fvCheck = check;

      w.__fvTeardown = () => {
        observer.disconnect();
        document.removeEventListener("pointerdown", onPointerDown, { capture: true });
        document.removeEventListener("touchstart", onTouchStart, { capture: true });
        document.removeEventListener("click", onClick, { capture: true });
        w.__fvCheck = undefined;
      };

      check();
    },
    { target: node, kind: board, id: entityId, reason: marker },
  );

  // A REAL TOUCH. `tap()` drives the CDP touch pipeline; `click()` would send mouse events even on
  // a project configured with `hasTouch`, and would measure an input a phone never produces.
  await approve.tap();

  let handle;
  try {
    handle = await page.waitForFunction(
      () => {
        const w = window as unknown as Record<string, unknown>;
        const poll = w.__fvCheck as (() => void) | undefined;
        if (poll) poll();
        const s = w.__fvBench as Record<string, unknown> | undefined;
        if (!s || s.down === null || s.visible === null || s.done === null) return null;
        return {
          ack: (s.visible as number) - (s.down as number),
          ackDomChange: s.domChange === null ? -1 : (s.domChange as number) - (s.down as number),
          inputDelay: s.click === null ? -1 : (s.click as number) - (s.down as number),
          appResponse:
            s.click === null
              ? -1
              : (s.visible as number) - (s.click as number),
          done: (s.done as number) - (s.down as number),
          longTaskMs: s.longTaskMs,
          msSinceLastLongTask: s.msSinceLastLongTask,
          pointerType: s.pointerType,
          sawTouchStart: s.sawTouchStart,
          trusted: s.trusted,
          readyState: s.readyState,
          sinceNavigation: s.sinceNavigation,
          loadEventEnd: s.loadEventEnd,
        };
      },
      undefined,
      { timeout: 120_000, polling: "raf" },
    );
  } catch {
    // WHICH of the three never arrived is the whole diagnosis, and a bare timeout throws it away.
    const state = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__fvBench ?? null,
    );

    // AND WHAT THE SETTLED PREDICATE ACTUALLY SEES. "It never settled" is not a diagnosis; whether
    // the record is absent, or present in a card that does not say Approved, are different faults
    // with different fixes, and one of them is a fault in this instrument rather than in the app.
    const seen = await page.evaluate(
      ({ id, reason }) => {
        const record = document.querySelector(`[data-testid="batch-decision-${id}"]`);
        const card = record?.closest('[role="article"]') ?? null;
        return {
          recordFound: Boolean(record),
          cardLabel: card?.getAttribute("aria-label") ?? null,
          cardText: (card?.textContent ?? "").replace(/\s+/g, " ").slice(0, 240),
          articlesWithReason: Array.from(document.querySelectorAll('[role="article"]'))
            .filter((el) => (el.textContent ?? "").includes(reason))
            .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").slice(0, 160)),
        };
      },
      { id: entityId, reason: marker },
    );

    throw new Error(
      `the tap was never completely observed: ${JSON.stringify(state)}` +
        ` · settled() sees: ${JSON.stringify(seen)}`,
    );
  }

  const sample = (await handle.jsonValue()) as Sample;
  await node.dispose();

  // THE INPUT IS ASSERTED, NOT ASSUMED. A benchmark that quietly measured a mouse would describe an
  // interaction no phone performs.
  expect(sample.pointerType, "the measured input must be a touch").toBe("touch");
  expect(sample.sawTouchStart, "a touchstart must have been dispatched").toBe(true);
  expect(sample.trusted, "the input must be a trusted browser event").toBe(true);

  return sample;
}

// `test.describe.skipIf` is not in this Playwright version, so the choice is made here.
const describeBenchmark = ENABLED ? test.describe : test.describe.skip;

describeBenchmark("stock commands on a phone over 4G", () => {
  let manager: { api: SupabaseClient; read: SupabaseClient };
  let cementId = "";
  let brickId = "";
  let recipe: string[] = [];

  test.beforeAll(async ({ browser }, testInfo) => {
    // One tier, because this measures a network, a CPU and a touchscreen rather than a layout, and
    // the mobile project is the only one configured `hasTouch`. Run it with `--project=mobile`.
    if (testInfo.project.name !== "mobile") return;

    test.setTimeout(600_000);

    const page = await browser.newPage();
    try {
      await signInAs(page, "director");
      await page.goto("/settings/suppliers");
      await page.getByLabel(/supplier name/i).fill(SUPPLIER);
      await page.locator("#addSupplier").click();
      await expect(page.getByText(/supplier added/i)).toBeVisible();
    } finally {
      await page.close();
    }

    manager = await sessionFor("manager");
    cementId = await productId(manager.read, CEMENT);
    brickId = await productId(manager.read, BRICK_6);

    const { data: recipeRows } = await manager.read
      .from("production_recipe_inputs")
      .select("product_id");
    recipe = (recipeRows as { product_id: string }[]).map((row) => row.product_id);

    const { data: supplier } = await manager.read
      .from("suppliers")
      .select("id")
      .eq("name", SUPPLIER)
      .single();

    for (const [name, quantity] of [
      [CEMENT, CEMENT_NEEDED],
      [SAND, 600],
      [AGGREGATE, 600],
    ] as const) {
      const { data: entered } = await manager.api.rpc("staff_enter_stock_receipt", {
        p_supplier_id: (supplier as { id: string }).id,
        p_location_code: "yard",
        p_delivery_date: new Date().toISOString().slice(0, 10),
        p_delivery_note_ref: `BENCH-${randomUUID().slice(0, 8)}`,
        p_lines: [
          {
            product_id: await productId(manager.read, name),
            expected_quantity: quantity,
            received_quantity: quantity,
            damaged_quantity: 0,
          },
        ],
        p_idempotency_key: randomUUID(),
      });
      expect(entered?.ok, JSON.stringify(entered)).toBe(true);

      const { data: approved } = await manager.api.rpc("staff_approve_stock_receipt", {
        p_receipt_id: (entered.receipt as { id: string }).id,
        p_idempotency_key: randomUUID(),
      });
      expect(approved?.ok, JSON.stringify(approved)).toBe(true);
    }
  });

  for (const profile of PROFILES) {
    test(`approving a batch and a correction on ${profile.name}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "mobile", "the mobile profile only");
      test.setTimeout(1_800_000);

      const runId = randomUUID().slice(0, 8).toUpperCase();

      // ---------------------------------------------------------------------
      // Drafts, seeded unthrottled: seeding is not the measurement
      // ---------------------------------------------------------------------
      const batchIds: string[] = [];
      for (let i = 0; i < PER_COMMAND; i++) {
        const { data, error } = await manager.api.rpc("staff_enter_production_batch", {
          p_location_code: "yard",
          // FIVE MINUTES AGO, not `now`. The command refuses a moulding time in the future, and
          // the database container's clock and this process's need not agree to the millisecond —
          // one seeding loop was refused `moulded_at_invalid` for exactly that reason.
          p_moulded_at: new Date(Date.now() - 5 * 60_000).toISOString(),
          // Every recipe input answered for (AC-39); confirming zero is one of the answers.
          p_inputs: recipe.map((id) => ({
            product_id: id,
            actual_quantity: id === cementId ? 1 : 0,
          })),
          p_outputs: [{ product_id: brickId, quantity_moulded: 22 }],
          p_yield_note: null,
          p_idempotency_key: randomUUID(),
        });
        expect(data?.ok, JSON.stringify({ data, error })).toBe(true);
        batchIds.push((data.batch as { id: string }).id);
      }

      // EACH CORRECTION CARRIES ITS OWN REASON, and that is what makes its approval identifiable:
      // the adjustment card is keyed by product, so several corrections share one product and only
      // the reason distinguishes their cards on screen.
      const adjustmentIds: string[] = [];
      const adjustmentReasons: string[] = [];
      for (let i = 0; i < PER_COMMAND; i++) {
        const reason = `bench ${runId} ${profile.name.replace(/\s+/g, "")} ${String(i).padStart(2, "0")}`;
        const { data } = await manager.api.rpc("staff_enter_stock_adjustment", {
          p_product_id: cementId,
          p_location_code: "yard",
          p_quantity_delta: -1,
          p_reason: reason,
          p_idempotency_key: randomUUID(),
        });
        expect(data?.ok, JSON.stringify(data)).toBe(true);
        adjustmentIds.push((data.adjustment as { id: string }).id);
        adjustmentReasons.push(reason);
      }

      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.enable");

      async function throttle() {
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          downloadThroughput: profile.downloadThroughput,
          uploadThroughput: profile.uploadThroughput,
          latency: profile.latency,
        });
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
      }

      async function unthrottle() {
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          downloadThroughput: -1,
          uploadThroughput: -1,
          latency: 0,
        });
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      }

      type Series = { first: Sample[]; rest: Sample[] };
      const measured: Record<string, Series> = {
        "batch approval": { first: [], rest: [] },
        "negative correction": { first: [], rest: [] },
      };

      async function run(
        command: string,
        board: Board,
        route: string,
        who: "director" | "manager",
        ids: string[],
        markers: string[],
        control: (id: string) => Locator,
      ) {
        await unthrottle();
        await signInAs(page, who);

        // FIRST TAPS: one per page load, each on a route that has just arrived, loaded throttled
        // because that is the state a first tap actually happens in.
        for (let i = 0; i < FIRST_SAMPLES; i++) {
          await unthrottle();
          await page.goto(route);
          await throttle();
          await page.reload();

          const approve = control(ids[i]);
          await expect(approve).toBeVisible({ timeout: 120_000 });
          measured[command].first.push(await measureTap(page, approve, board, ids[i], markers[i]));
        }

        // SUBSEQUENT TAPS: the page stays put, as it does for somebody working through a queue.
        for (let i = FIRST_SAMPLES; i < ids.length; i++) {
          const approve = control(ids[i]);
          await expect(approve).toBeVisible({ timeout: 120_000 });
          measured[command].rest.push(await measureTap(page, approve, board, ids[i], markers[i]));
        }

        await unthrottle();
      }

      await run(
        "batch approval",
        "batch",
        "/production",
        "manager",
        batchIds,
        batchIds,
        (id) => page.getByTestId(`approve-batch-${id}`),
      );

      await run(
        "negative correction",
        "adjustment",
        "/inventory/adjustments",
        "director",
        adjustmentIds,
        adjustmentReasons,
        (id) => page.getByTestId(`approve-${id}`),
      );

      await unthrottle();

      // ---------------------------------------------------------------------
      // The numbers, printed in full and then judged in full
      // ---------------------------------------------------------------------
      console.log(
        `\n[${LABEL}] ${profile.name}: ` +
          `${(profile.downloadThroughput * 8) / 1024 / 1024} Mbit/s down, ` +
          `${(profile.uploadThroughput * 8) / 1024} kbit/s up, ${profile.latency} ms RTT, ` +
          `CPU ${profile.cpu}x, touch input · ${FIRST_SAMPLES} first taps + ` +
          `${SUBSEQUENT_SAMPLES} subsequent per command · dataset: ${CEMENT_NEEDED} bags received, ` +
          `${PER_COMMAND} drafts per command`,
      );

      for (const [command, series] of Object.entries(measured)) {
        const all = [...series.first, ...series.rest];

        report(`[${LABEL}] ${profile.name} · ${command} · FIRST tap · visible`, series.first.map((s) => s.ack));
        report(`[${LABEL}] ${profile.name} · ${command} · FIRST tap · confirmed`, series.first.map((s) => s.done));
        reportPageState(`[${LABEL}] ${profile.name} · ${command} · FIRST tap · page state`, series.first);
        reportDecomposition(`[${LABEL}] ${profile.name} · ${command} · FIRST tap · where it went`, series.first);

        report(`[${LABEL}] ${profile.name} · ${command} · later taps · visible`, series.rest.map((s) => s.ack));
        report(`[${LABEL}] ${profile.name} · ${command} · later taps · confirmed`, series.rest.map((s) => s.done));
        reportPageState(`[${LABEL}] ${profile.name} · ${command} · later taps · page state`, series.rest);
        reportDecomposition(`[${LABEL}] ${profile.name} · ${command} · later taps · where it went`, series.rest);

        const ack = report(`[${LABEL}] ${profile.name} · ${command} · ALL · visible`, all.map((s) => s.ack));
        const done = report(`[${LABEL}] ${profile.name} · ${command} · ALL · confirmed`, all.map((s) => s.done));

        // EVERY tap, including the first. Rule 1 names no exception, so the worst of all of them
        // carries it. SOFT, so a failure on the first command still leaves the second measured and
        // printed: a benchmark whose output depends on whether it passed is not evidence.
        expect
          .soft(
            ack.worst,
            `${command} on ${profile.name}: worst visible acknowledgement ${ack.worst} ms ` +
              `(p50 ${ack.p50}, p95 ${ack.p95}) over ${ack.n} touches including the first of each load`,
          )
          .toBeLessThan(TAP_TO_VISIBLE_BUDGET_MS);

        expect
          .soft(
            done.p95,
            `${command} on ${profile.name}: p95 server-confirmed ${done.p95} ms over ${done.n} touches`,
          )
          .toBeLessThan(COMPLETION_P95_BUDGET_MS);
      }
    });
  }
});
