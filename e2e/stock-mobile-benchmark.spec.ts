import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Locator, type Page } from "@playwright/test";

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
 * of it: adding an assumed round trip to a local timing assumes the answer. A phone's number comes
 * from throttling a real browser and timing the real Server Action, which is what this file does.
 *
 * ── WHAT IS MEASURED, AND WHY EACH END OF THE INTERVAL IS WHAT IT IS ──────────────────────────
 *
 * A REAL TAP STARTS THE CLOCK. Playwright's `click()` dispatches trusted input through the
 * browser, and the clock starts at the `pointerdown` that input produces — not at a scripted
 * `node.click()`, which skips the input pipeline this measurement is supposed to include.
 *
 * A VISIBLE CHANGE STOPS IT. `aria-busy` is an attribute; a person in a yard cannot see an
 * attribute. The signal taken here is the rendered spinner inside a busy control — the same render
 * that hides the label — because that is the pixel change §12.7 rule 1 is about. Colour is not
 * used for it either way (§11.5).
 *
 * SUCCESS IS A POSITIVE RECORD, not the absence of a control. A control disappearing proves
 * nothing: an error boundary removes controls too, and so does a refusal. What is timed instead is
 * a settled decision APPEARING — for a batch, the decision record carrying that batch's own id; for
 * a correction, one more "approved by" chip than before the tap. Neither can be produced by a
 * failure, so this cannot pass on an error and cannot pass on a refusal either.
 *
 * ── WHICH SAMPLES ARE JUDGED ──────────────────────────────────────────────────────────────────
 *
 * ALL OF THEM. The first interaction after a page load is reported separately because it behaves
 * differently and hiding that would be dishonest, but it is inside the acceptance gate exactly like
 * every other tap. §12.7 rule 1 says every click or tap, and states no exception for a page that
 * has just loaded; a benchmark is not the place to invent one. The 100 ms budget below is the
 * design document's number, unchanged.
 *
 * THE PROFILES are Chrome DevTools' own presets, named here so a reader can reproduce them rather
 * than trust a number. Both are measured because the workspace documents no single approved
 * profile: design.md §2.1 and §11.9 say "mid- or low-range Android phones" on a varying network and
 * fix no figures, so the honest thing is to report the pair and let the slower one carry the
 * verdict.
 *
 * IT RUNS AGAINST THE BASE TOO. `FV_BENCHMARK_LABEL` names the tree under test so the same file,
 * copied into a checkout of `525418e`, produces directly comparable output. Without that
 * comparison, any number here is a reading with nothing to read it against.
 *
 * ── WHAT IT CURRENTLY REPORTS, 8 September 2026 ───────────────────────────────────────────────
 *
 * THIS BENCHMARK FAILS ITS ACKNOWLEDGEMENT GATE, ON THIS TREE AND ON `525418e` ALIKE. That is the
 * finding, not a broken test, and the gate is left failing rather than relaxed: the budget belongs
 * to design.md §12.7 and a benchmark may not rewrite it to suit what it measured.
 *
 * The FIRST tap after a page load costs roughly 85–160 ms to acknowledge visibly. Every tap after
 * it, on the page already in use, costs 34–79 ms — comfortably inside the budget. Both trees show
 * the same shape, and `525418e` exceeded 100 ms in three of the six series measured on it, so
 * whatever this is, issue #7 did not introduce it. Run-to-run spread on one machine (89–161 ms
 * worst) is wider than the gap between the two trees, so these figures can neither establish nor
 * exclude a small regression on top of it; what they do establish is that the cost is already
 * there on the base.
 *
 * WHY THE FIRST TAP IS DIFFERENT, as far as this measures rather than assumes: `buttonVariants` in
 * `components/ui/button.tsx` carries `hover:` and `transition-colors` and no `active:` state at
 * all, so every acknowledgement this application gives is rendered by React — `data-pending`,
 * `aria-busy`, the hidden label and the spinner arrive together or not at all. A tap on a route
 * that has just arrived therefore waits for the page to become interactive, and a tap on a page
 * already in use does not. That is consistent with the two groups above and with the component as
 * written; it is not a claim this file has isolated by instrumenting hydration directly.
 *
 * THE SMALLEST FIX, recorded for an Owner decision and deliberately NOT made here: give
 * `buttonVariants` an `active:` variant, so a press paints from the first frame the CSS is applied
 * — before hydration, with no JavaScript, exactly as design.md §7.1 says the authentication screens
 * already do. It is one line in one shared component, changes no layout and no behaviour, and it
 * belongs to whoever owns that control rather than to a stock-invariant release.
 */

const ENABLED = process.env.FV_BENCHMARK === "1";

/** Names the tree in the output, so a candidate run and a base run cannot be confused. */
const LABEL = process.env.FV_BENCHMARK_LABEL ?? "candidate";

/**
 * Samples per command per profile.
 *
 * FIRST taps each get their own page load — that is the only way to take more than one of them —
 * and the rest are taken consecutively on a page already in use. Both groups are judged.
 */
const FIRST_SAMPLES = 5;
const SUBSEQUENT_SAMPLES = 20;

/** design.md §12.7 rule 1, and the budget every other spec in this suite already holds to. */
const TAP_TO_VISIBLE_BUDGET_MS = 100;

/** The p95 the directive sets for a server-confirmed stock command. */
const COMPLETION_P95_BUDGET_MS = 2_500;

/**
 * Chrome DevTools' throttling presets, in the units the CDP takes (bytes per second).
 *
 * `cpu` is the DevTools multiplier: 4× is its standard stand-in for a mid-tier Android against a
 * development machine, which is the device design.md §2.1 names.
 */
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

/** Which board a sample is taken on, and what a settled success looks like there. */
type Board = "batch" | "adjustment";

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank, so a reported p95 is an observation rather than an interpolation between two.
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1];
}

type Summary = { n: number; p50: number; p95: number; worst: number };

function summarise(samples: number[]): Summary {
  return {
    n: samples.length,
    p50: Math.round(percentile(samples, 0.5)),
    p95: Math.round(percentile(samples, 0.95)),
    worst: Math.round(Math.max(...samples)),
  };
}

function report(label: string, samples: number[]): Summary {
  const s = summarise(samples);
  console.log(
    `${label.padEnd(58)} n=${s.n}  p50=${s.p50}ms  p95=${s.p95}ms  worst=${s.worst}ms`,
  );
  // Every sample, in the order taken. A percentile hides WHERE a slow one fell, and a reviewer
  // cannot re-derive a distribution from three numbers.
  console.log(`${" ".repeat(58)} raw: ${samples.map((v) => Math.round(v)).join(", ")}`);
  return s;
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
  if (response.status !== 200) {
    throw new Error(`${who} could not sign in: ${JSON.stringify(body)}`);
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

/**
 * Arms the in-page instrument, then reads back both intervals for ONE real tap.
 *
 * All three timestamps are taken by `performance.now()` inside the page, on one clock, so nothing
 * the test harness costs — a CDP round trip, Playwright's own polling — is charged to the
 * application. The listeners go on `document` rather than on the button so that React replacing the
 * element mid-render cannot lose the measurement.
 */
async function measureTap(
  page: Page,
  approve: Locator,
  board: Board,
  entityId: string,
): Promise<{ ack: number; done: number }> {
  await page.evaluate(({ kind, id }: { kind: Board; id: string }) => {
    const w = window as unknown as Record<string, unknown>;

    // TEAR THE PREVIOUS SAMPLE'S INSTRUMENT DOWN FIRST.
    //
    // Without this every sample left its observer and its listener attached, so by the twenty-fifth
    // tap the page was running twenty-five document-wide MutationObservers on every render — under
    // 4× CPU throttling that is a measurable cost, charged to the application by the instrument
    // measuring it, and on the faster profile it was enough to stall the run outright.
    const previous = w.__fvTeardown as (() => void) | undefined;
    if (previous) previous();

    /**
     * A BATCH IS WATCHED BY ITS OWN DECISION RECORD, not by a count of them.
     *
     * The decided queue is a page of twenty-five (QUEUE_PAGE_SIZE). Once it is full, approving one
     * more pushes the oldest off the page and the COUNT never changes — which is not "no decision
     * arrived", but a count-based instrument cannot tell the two apart, and it stalled a whole
     * profile before this was written the right way round. `batch-decision-<id>` is the record for
     * the batch that was actually approved, so it appears exactly once and cannot be crowded out:
     * the decided queue is ordered newest first and this is the newest.
     */
    const countSettled = () => {
      if (kind === "batch") {
        return document.querySelector(`[data-testid="batch-decision-${id}"]`) ? 1 : 0;
      }
      // The success chips a settled correction renders. A count is safe here and only here:
      // `loadAdjustments` returns up to two hundred rows in one list with no paging, and this run
      // creates fifty, so the number can only go up.
      let n = 0;
      for (const el of Array.from(document.querySelectorAll('[role="article"] span'))) {
        if (/^\s*approved by/i.test(el.textContent ?? "")) n += 1;
      }
      return n;
    };

    const state = { down: null as number | null, visible: null as number | null, settled: null as number | null };
    w.__fvBench = state;
    const baseline = countSettled();

    const onPointerDown = () => {
      if (state.down === null) state.down = performance.now();
    };
    document.addEventListener("pointerdown", onPointerDown, { capture: true });

    const check = () => {
      // VISIBLE: a rendered spinner inside a control that is working. The same render hides the
      // label, so this is the moment the button visibly changes rather than the moment an
      // attribute did.
      if (state.visible === null && document.querySelector('button[aria-busy="true"] .animate-spin')) {
        state.visible = performance.now();
      }
      // SERVER-CONFIRMED: one more settled decision on the board than there was before the tap.
      if (state.settled === null && countSettled() > baseline) {
        state.settled = performance.now();
      }
    };

    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    w.__fvTeardown = () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
    };

    check();
  }, { kind: board, id: entityId });

  // A REAL tap: trusted input through the browser, not a scripted click.
  await approve.click();

  let handle;
  try {
    handle = await page.waitForFunction(
      () => {
        const s = (window as unknown as Record<string, { down: number | null; visible: number | null; settled: number | null }>)
          .__fvBench;
        if (!s || s.down === null || s.visible === null || s.settled === null) return null;
        return { ack: s.visible - s.down, done: s.settled - s.down };
      },
      undefined,
      { timeout: 120_000, polling: "raf" },
    );
  } catch {
    // WHICH of the three never arrived is the whole diagnosis, and a bare timeout throws it away:
    // no `down` means the tap never landed, no `visible` means the control never acknowledged, and
    // no `settled` means the command did not commit a decision.
    const state = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__fvBench ?? null,
    );
    throw new Error(
      `the tap was never completely observed. down/visible/settled = ${JSON.stringify(state)}`,
    );
  }

  const measured = (await handle.jsonValue()) as { ack: number; done: number };
  expect(measured.ack, "a visible acknowledgement was never observed").toBeGreaterThanOrEqual(0);
  expect(measured.done, "no settled decision arrived").toBeGreaterThan(0);
  return measured;
}

// `test.describe.skipIf` is not in this Playwright version, so the choice is made here.
const describeBenchmark = ENABLED ? test.describe : test.describe.skip;

describeBenchmark("stock commands on a phone over 4G", () => {
  let manager: { api: SupabaseClient; read: SupabaseClient };
  let cementId = "";
  let brickId = "";
  let recipe: string[] = [];

  test.beforeAll(async ({ browser }, testInfo) => {
    // One tier, because this measures a network and a CPU rather than a layout, and the mobile
    // project is the device design.md §2.1 describes. Run it with `--project=mobile`.
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

    // The yard, stocked through supplier receiving exactly as the business does it.
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

      // ---------------------------------------------------------------------
      // Drafts, seeded unthrottled: seeding is not the measurement
      // ---------------------------------------------------------------------
      const batchIds: string[] = [];
      for (let i = 0; i < PER_COMMAND; i++) {
        const { data } = await manager.api.rpc("staff_enter_production_batch", {
          p_location_code: "yard",
          p_moulded_at: new Date().toISOString(),
          // Every recipe input answered for (AC-39); confirming zero is one of the answers.
          p_inputs: recipe.map((id) => ({
            product_id: id,
            actual_quantity: id === cementId ? 1 : 0,
          })),
          p_outputs: [{ product_id: brickId, quantity_moulded: 22 }],
          p_yield_note: null,
          p_idempotency_key: randomUUID(),
        });
        expect(data?.ok, JSON.stringify(data)).toBe(true);
        batchIds.push((data.batch as { id: string }).id);
      }

      const adjustmentIds: string[] = [];
      for (let i = 0; i < PER_COMMAND; i++) {
        const { data } = await manager.api.rpc("staff_enter_stock_adjustment", {
          p_product_id: cementId,
          p_location_code: "yard",
          p_quantity_delta: -1,
          p_reason: "mobile benchmark",
          p_idempotency_key: randomUUID(),
        });
        expect(data?.ok, JSON.stringify(data)).toBe(true);
        adjustmentIds.push((data.adjustment as { id: string }).id);
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

      type Series = { first: { ack: number; done: number }[]; rest: { ack: number; done: number }[] };
      const measured: Record<string, Series> = {
        "batch approval": { first: [], rest: [] },
        "negative correction": { first: [], rest: [] },
      };

      /**
       * One command, measured on a freshly loaded page and then on the page already in use.
       *
       * The sign-in and the navigation are done UNTHROTTLED and the throttling is applied
       * immediately before the tap, so what is being timed is the interaction rather than how long
       * the route took to arrive. The page for a first-tap sample is loaded WITH throttling on,
       * because that is the state a first tap actually happens in.
       */
      async function run(
        command: string,
        board: Board,
        route: string,
        who: "director" | "manager",
        ids: string[],
        control: (id: string) => Locator,
      ) {
        await unthrottle();
        await signInAs(page, who);

        // FIRST TAPS: one per page load, each on a route that has just arrived.
        for (let i = 0; i < FIRST_SAMPLES; i++) {
          await unthrottle();
          await page.goto(route);
          await throttle();
          await page.reload();

          const approve = control(ids[i]);
          await expect(approve).toBeVisible({ timeout: 120_000 });
          measured[command].first.push(await measureTap(page, approve, board, ids[i]));
        }

        // SUBSEQUENT TAPS: the page stays put, as it does for somebody working through a queue.
        for (let i = FIRST_SAMPLES; i < ids.length; i++) {
          const approve = control(ids[i]);
          await expect(approve).toBeVisible({ timeout: 120_000 });
          measured[command].rest.push(await measureTap(page, approve, board, ids[i]));
        }

        await unthrottle();
      }

      await run("batch approval", "batch", "/production", "manager", batchIds, (id) =>
        page.getByTestId(`approve-batch-${id}`),
      );

      await run(
        "negative correction",
        "adjustment",
        "/inventory/adjustments",
        "director",
        adjustmentIds,
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
          `CPU ${profile.cpu}x · ${FIRST_SAMPLES} first taps + ${SUBSEQUENT_SAMPLES} subsequent ` +
          `per command · dataset: ${CEMENT_NEEDED} bags received, ${PER_COMMAND} drafts per command`,
      );

      for (const [command, series] of Object.entries(measured)) {
        const all = [...series.first, ...series.rest];

        // Reported in three groups, because the first tap behaves differently and saying so is
        // useful. Judged as one, because §12.7 rule 1 makes no distinction.
        report(`[${LABEL}] ${profile.name} · ${command} · FIRST tap · visible`, series.first.map((s) => s.ack));
        report(`[${LABEL}] ${profile.name} · ${command} · FIRST tap · confirmed`, series.first.map((s) => s.done));
        report(`[${LABEL}] ${profile.name} · ${command} · later taps · visible`, series.rest.map((s) => s.ack));
        report(`[${LABEL}] ${profile.name} · ${command} · later taps · confirmed`, series.rest.map((s) => s.done));

        const ack = report(`[${LABEL}] ${profile.name} · ${command} · ALL · visible`, all.map((s) => s.ack));
        const done = report(`[${LABEL}] ${profile.name} · ${command} · ALL · confirmed`, all.map((s) => s.done));

        // EVERY tap, including the first. Rule 1 is about every click or tap and names no
        // exception, so the worst of all of them carries it.
        //
        // SOFT, so that a failure on the first command still leaves the second one measured and
        // printed. A hard assertion here threw away half the evidence: the correction was timed and
        // then never reported, because the batch had already failed the gate. A benchmark whose
        // output depends on whether it passed is not evidence.
        expect
          .soft(
            ack.worst,
            `${command} on ${profile.name}: worst visible acknowledgement ${ack.worst} ms ` +
              `(p50 ${ack.p50}, p95 ${ack.p95}) over ${ack.n} taps including the first of each load`,
          )
          .toBeLessThan(TAP_TO_VISIBLE_BUDGET_MS);

        expect
          .soft(
            done.p95,
            `${command} on ${profile.name}: p95 server-confirmed ${done.p95} ms over ${done.n} taps`,
          )
          .toBeLessThan(COMPLETION_P95_BUDGET_MS);
      }
    });
  }
});
