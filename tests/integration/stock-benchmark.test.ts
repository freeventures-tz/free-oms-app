import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createLiveStaff,
  ensureDirector,
  mouldedJustNow,
  type Fixture,
} from "@/tests/integration/helpers";

/**
 * How long the stock commands take once the ledger is not empty (issue #7).
 *
 * OFF BY DEFAULT. It seeds thousands of movements and takes minutes, which is the wrong shape for a
 * suite that runs on every change. Run it deliberately:
 *
 *     FV_BENCHMARK=1 npx vitest run --project integration tests/integration/stock-benchmark.test.ts
 *
 * WHAT IT MEASURES, and what it does not. Every figure below is the SERVER-CONFIRMED round trip:
 * the time from issuing the RPC to the committed answer coming back, over real HTTP through
 * PostgREST, against the local Supabase stack. That is the part this ticket changed — the extra
 * work is one more availability query and one more advisory lock per line, plus a deferred
 * constraint at commit.
 *
 * It is NOT a measurement over a mobile 4G network, and nothing here should be read as one — nor
 * may the mobile figure be ARITHMETIC done on top of these numbers, which would assume the very
 * thing it claims to show. The mobile profile is measured where it can actually be measured, in a
 * throttled browser: `e2e/stock-mobile-benchmark.spec.ts` emulates the network and the CPU and
 * times the same two commands end to end.
 *
 * The 100 ms acknowledgement target is a different claim again — it is about the interface
 * responding BEFORE the server does, which is `useGuardedAction` and the feedback contract
 * (design.md §12.7). A server timing cannot prove it; the throttled browser run does, and
 * `e2e/interaction-feedback.spec.ts` proves the contract itself.
 */

const ENABLED = process.env.FV_BENCHMARK === "1";

/** Movements seeded onto the product under test, so the availability sum has real work to do. */
const LEDGER_ROWS = 2_000;

/** Samples per command. Enough for a p95 to mean something without the run taking an hour. */
const SAMPLES = 40;

let director: Fixture;
let manager: Fixture;
let salesRep: Fixture;
let cementId: string;
let brickId: string;
let customerId: string;

const YARD = "yard";

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank. With 40 samples the p95 is the 38th, which is a real observation rather than an
  // interpolation between two of them.
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1];
}

function report(name: string, samples: number[]): Record<string, number> {
  const summary = {
    samples: samples.length,
    p50: Math.round(percentile(samples, 0.5)),
    p95: Math.round(percentile(samples, 0.95)),
    worst: Math.round(Math.max(...samples)),
  };
  // Printed, because the ticket asks for the numbers to be captured rather than merely asserted.
  console.log(
    `${name.padEnd(34)} n=${summary.samples}  p50=${summary.p50}ms  p95=${summary.p95}ms  worst=${summary.worst}ms`,
  );
  return summary;
}

/**
 * `PromiseLike`, not `Promise`: a PostgREST builder is a thenable that only becomes a promise when
 * it is awaited, and asking for the narrower type rejects every call site.
 */
async function timed(run: () => PromiseLike<{ error: unknown }>): Promise<number> {
  const started = performance.now();
  const { error } = await run();
  const elapsed = performance.now() - started;
  expect(error, JSON.stringify(error)).toBeNull();
  return elapsed;
}

async function seededProduct(name: string): Promise<string> {
  const { data } = await director.read.from("products").select("id").eq("name", name).maybeSingle();
  return (data as { id: string }).id;
}

async function availability(): Promise<number> {
  const { data } = await director.read
    .from("product_availability")
    .select("available_quantity")
    .eq("product_id", cementId)
    .maybeSingle();
  return Number((data as { available_quantity: number }).available_quantity);
}

async function topUp(quantity: number): Promise<void> {
  const { data: entered } = await manager.api.rpc("staff_enter_stock_adjustment", {
    p_product_id: cementId,
    p_location_code: YARD,
    p_quantity_delta: quantity,
    p_reason: "benchmark top-up",
    p_idempotency_key: randomUUID(),
  });
  const { data: approved } = await director.api.rpc("admin_approve_stock_adjustment", {
    p_adjustment_id: (entered.adjustment as { id: string }).id,
    p_idempotency_key: randomUUID(),
  });
  expect(approved?.ok, JSON.stringify(approved)).toBe(true);
}


/**
 * Every recipe input answered for, with only the cement carrying a quantity.
 *
 * `staff_enter_production_batch` refuses `incomplete_recipe_inputs` unless each input the recipe
 * names is accounted for (AC-39); confirming zero is one of the answers it accepts. The recipe is
 * read from the database so a later change cannot leave this benchmark timing a refusal.
 */
let cachedRecipe: string[] | null = null;
async function recipeInputs(cementQuantity: number) {
  if (!cachedRecipe) {
    const { data } = await director.read.from("production_recipe_inputs").select("product_id");
    cachedRecipe = (data as { product_id: string }[]).map((row) => row.product_id);
  }
  return cachedRecipe.map((productId) => ({
    product_id: productId,
    actual_quantity: productId === cementId ? cementQuantity : 0,
  }));
}

describe.skipIf(!ENABLED)("stock command timings on a loaded ledger", () => {
  const results: Record<string, Record<string, number>> = {};

  beforeAll(async () => {
    // Seeding thousands of movements through the real commands is the point; it is also slow.
    director = await ensureDirector();
    manager = await createLiveStaff(director, "manager");
    salesRep = await createLiveStaff(director, "sales_rep");

    cementId = await seededProduct("Dangote Cement 42R");
    brickId = await seededProduct('Tofali 6"');

    await director.api.rpc("admin_set_product_price", {
      p_product_id: cementId,
      p_price_tzs: 20000,
      p_reason: "benchmark",
      p_idempotency_key: randomUUID(),
    });

    const { data: customer } = await salesRep.api.rpc("staff_add_customer", {
      p_name: `Benchmark Customer ${randomUUID().slice(0, 8)}`,
      p_idempotency_key: randomUUID(),
    });
    customerId = (customer.customer as { id: string }).id;

    // THE DATASET. Each approved correction is one ledger row, so the availability sum and the
    // no-negative constraint both walk a real table rather than an empty one.
    console.log(`seeding ${LEDGER_ROWS} ledger movements…`);
    for (let index = 0; index < LEDGER_ROWS; index++) {
      await topUp(10);
    }

    const rows = await director.read
      .from("inventory_ledger")
      .select("id", { count: "exact", head: true })
      .eq("product_id", cementId);
    console.log(`ledger rows for the product under test: ${rows.count}`);
  }, 1_800_000);

  it("approves a production batch", async () => {
    const samples: number[] = [];

    for (let index = 0; index < SAMPLES; index++) {
      const { data: batch } = await manager.api.rpc("staff_enter_production_batch", {
        p_location_code: YARD,
        p_moulded_at: mouldedJustNow(),
        p_inputs: await recipeInputs(1),
        p_outputs: [{ product_id: brickId, quantity_moulded: 22 }],
        p_yield_note: null,
        p_idempotency_key: randomUUID(),
      });

      samples.push(
        await timed(() =>
          manager.api.rpc("staff_approve_production_batch", {
            p_batch_id: (batch.batch as { id: string }).id,
            p_idempotency_key: randomUUID(),
          }),
        ),
      );
    }

    results["production.approve_batch"] = report("production.approve_batch", samples);
    expect(results["production.approve_batch"].p95).toBeLessThan(2_500);
  }, 600_000);

  it("approves a downward stock correction", async () => {
    const samples: number[] = [];

    for (let index = 0; index < SAMPLES; index++) {
      const { data: entered } = await manager.api.rpc("staff_enter_stock_adjustment", {
        p_product_id: cementId,
        p_location_code: YARD,
        p_quantity_delta: -1,
        p_reason: "benchmark measurement",
        p_idempotency_key: randomUUID(),
      });

      samples.push(
        await timed(() =>
          director.api.rpc("admin_approve_stock_adjustment", {
            p_adjustment_id: (entered.adjustment as { id: string }).id,
            p_idempotency_key: randomUUID(),
          }),
        ),
      );
    }

    results["inventory.approve_adjustment"] = report("inventory.approve_adjustment", samples);
    expect(results["inventory.approve_adjustment"].p95).toBeLessThan(2_500);
  }, 600_000);

  it("approves an internal transfer", async () => {
    const samples: number[] = [];

    for (let index = 0; index < SAMPLES; index++) {
      const { data: entered } = await manager.api.rpc("staff_enter_stock_transfer", {
        p_from_location: YARD,
        p_to_location: "store",
        p_note: null,
        p_lines: [{ product_id: cementId, quantity: 1 }],
        p_idempotency_key: randomUUID(),
      });

      samples.push(
        await timed(() =>
          manager.api.rpc("staff_approve_stock_transfer", {
            p_transfer_id: (entered.transfer as { id: string }).id,
            p_idempotency_key: randomUUID(),
          }),
        ),
      );
    }

    results["inventory.approve_transfer"] = report("inventory.approve_transfer", samples);
    expect(results["inventory.approve_transfer"].p95).toBeLessThan(2_500);
  }, 600_000);

  it("confirms an order, which is the reservation side of the same rule", async () => {
    const samples: number[] = [];

    for (let index = 0; index < SAMPLES; index++) {
      await topUp(5);

      const { data: order } = await salesRep.api.rpc("staff_create_order", {
        p_customer_id: customerId,
        p_lines: [{ product_id: cementId, quantity: 1 }],
        p_idempotency_key: randomUUID(),
      });

      samples.push(
        await timed(() =>
          salesRep.api.rpc("staff_confirm_order", {
            p_order_id: (order.order as { id: string }).id,
            p_idempotency_key: randomUUID(),
          }),
        ),
      );
    }

    results["sales.confirm_order"] = report("sales.confirm_order", samples);
    expect(results["sales.confirm_order"].p95).toBeLessThan(2_500);
  }, 600_000);

  it("refuses a batch, which is the path a full yard takes", async () => {
    // The refusal now writes an audit row before it returns, so it is not free and is measured
    // rather than assumed to be cheaper than the success it replaces.
    const before = await availability();
    const { data: order } = await salesRep.api.rpc("staff_create_order", {
      p_customer_id: customerId,
      p_lines: [{ product_id: cementId, quantity: before }],
      p_idempotency_key: randomUUID(),
    });
    await salesRep.api.rpc("staff_confirm_order", {
      p_order_id: (order.order as { id: string }).id,
      p_idempotency_key: randomUUID(),
    });
    expect(await availability()).toBe(0);

    const samples: number[] = [];

    for (let index = 0; index < SAMPLES; index++) {
      const { data: batch } = await manager.api.rpc("staff_enter_production_batch", {
        p_location_code: YARD,
        p_moulded_at: mouldedJustNow(),
        p_inputs: await recipeInputs(1),
        p_outputs: [{ product_id: brickId, quantity_moulded: 22 }],
        p_yield_note: null,
        p_idempotency_key: randomUUID(),
      });

      samples.push(
        await timed(() =>
          manager.api.rpc("staff_approve_production_batch", {
            p_batch_id: (batch.batch as { id: string }).id,
            p_idempotency_key: randomUUID(),
          }),
        ),
      );
    }

    results["production.approve_batch (refused)"] = report(
      "production.approve_batch (refused)",
      samples,
    );
    expect(results["production.approve_batch (refused)"].p95).toBeLessThan(2_500);

    console.log("\nAll figures are server-confirmed round trips on the local stack.");
    console.log(JSON.stringify(results, null, 2));
  }, 600_000);
});
