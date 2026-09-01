import { DATA_UNAVAILABLE, requireRows } from "@/lib/supabase/query";
import { createServerSupabase } from "@/lib/supabase/server";
import { pagedQuery, scopedTo, type Page } from "@/lib/settlement/settlement";
import type { AppRole } from "@/lib/auth/roles";

/**
 * Brick production: batches, curing lots and inspections (product.md §11).
 *
 * READS go through the caller's own session under RLS, like every other list in this application:
 * if the policies were ever wrong the screen would show less, not more. The secret key is not
 * imported here at all — nothing in this module spans two systems.
 *
 * A failed read is NOT an empty yard. `requireRows` throws so the shell's error boundary can say
 * the system could not be reached, rather than rendering "no batches" during an outage and telling
 * a Manager something false about their own production.
 *
 * THE TWO WORK QUEUES ARE READ INDEPENDENTLY OF THE HISTORY, and that is the whole shape of this
 * module. A single "latest fifty batches" read, with the drafts and the uninspected lots picked out
 * of it afterwards, loses the oldest work first: a batch entered on Monday and forgotten drops off
 * the list the moment fifty newer ones exist, and the screen then says there is nothing waiting.
 * The forgotten batch is exactly what a work queue is for. So drafts, curing lots and settled
 * history are three separate counted, paged, independently ordered reads, and none of them can push
 * another off the page.
 *
 * NOTHING IS READ PER CARD. Inputs and lots are fetched once per page, scoped to that page's batch
 * ids, and in batches of a thousand — because `.in(...)` is still subject to the Data API's row
 * cap, and a truncated read there would silently drop the last card's materials.
 */

/** What one mixer batch is EXPECTED to consume (§11.1). The pre-fill, never the deduction. */
export type RecipeInput = {
  productId: string;
  productName: string;
  unitCode: string;
  standardQuantity: number;
  sortOrder: number;
};

/** The approved yield per batch (§11.2). Output outside it is flagged, never blocked (AC-41). */
export type YieldRange = {
  productId: string;
  productName: string;
  minPerBatch: number;
  maxPerBatch: number;
};

export type BatchInputLine = {
  productId: string;
  productName: string;
  unitCode: string;
  standardQuantity: number;
  actualQuantity: number;
  /** Calculated by the database (§5.2). Recorded whatever it says, and never suppressed (§15.1). */
  varianceQuantity: number;
};

/** A lot as it appears ON A BATCH: what was moulded, and how the inspection ended if it has. */
export type BatchLot = {
  id: string;
  productId: string;
  productName: string;
  quantityMoulded: number;
  rejectedAtMoulding: number;
  mouldingRejectReason: string | null;
  curingStartedAt: string;
  inspectedAt: string | null;
  acceptedQuantity: number | null;
  rejectedAtInspection: number | null;
  inspectionRejectReason: string | null;
};

export type ProductionBatch = {
  id: string;
  batchNo: string;
  locationCode: string;
  status: "draft" | "approved" | "rejected" | "cancelled";
  mouldedAt: string;
  yieldNote: string | null;
  enteredByName: string;
  enteredRole: AppRole;
  enteredAt: string;
  decidedByName: string | null;
  decidedRole: AppRole | null;
  decidedAt: string | null;
  decisionReason: string | null;
  inputs: BatchInputLine[];
  lots: BatchLot[];
};

/**
 * A lot inside its curing period, as the inspection queue reads it.
 *
 * `readyAt` and `readyForInspection` come from the `curing_lots` view. The 72 hours of §11.4 live
 * in one place, and a second copy in TypeScript would be a second clock — one running on the web
 * server rather than on the business's. The screen counts DOWN to `readyAt` so an open page keeps
 * up with the deadline, and the server is still what decides whether an inspection is allowed.
 */
export type CuringLot = {
  lotId: string;
  batchId: string;
  batchNo: string;
  productId: string;
  productName: string;
  locationCode: string;
  quantityCuring: number;
  quantityMoulded: number;
  rejectedAtMoulding: number;
  mouldingRejectReason: string | null;
  curingStartedAt: string;
  readyAt: string;
  readyForInspection: boolean;
};

type ProductRef = { id: string; name: string; unit_code: string };

function nameOf(product: ProductRef | ProductRef[] | null): string {
  const row = Array.isArray(product) ? product[0] : product;
  return row?.name ?? "";
}

function unitOf(product: ProductRef | ProductRef[] | null): string {
  const row = Array.isArray(product) ? product[0] : product;
  return row?.unit_code ?? "";
}

/**
 * A name from an embedded `profiles` row.
 *
 * Takes `unknown` on purpose. PostgREST types a to-one embed as an array in the generated types
 * even where the foreign key makes it single, and casting each call site to the shape we expect is
 * how a runtime shape and a compile-time one drift apart. Narrowing here handles both and returns
 * an empty name rather than throwing on a row that is genuinely absent — `decided_by` is null on
 * every draft batch.
 */
function personOf(profile: unknown): string {
  const row = Array.isArray(profile) ? profile[0] : profile;
  if (row && typeof row === "object" && "full_name" in row) {
    return String((row as { full_name: unknown }).full_name ?? "");
  }
  return "";
}

/**
 * The numbers this screen makes decisions with, checked rather than coerced.
 *
 * `Number(undefined)` is `NaN` and `Number(null)` is `0`, and both of those would render as a
 * quantity somebody acts on: "0 curing" beside a lot holding twenty bricks is worse than an error
 * page, because nobody goes looking for it. A read that comes back the wrong shape did not work,
 * and it reaches the reader as the failure it is.
 */
function requireNumber(value: unknown, what: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (typeof value !== "number" && typeof value !== "string") {
    console.error(`[data] ${what} returned ${value === null ? "null" : typeof value}`);
    throw new Error(`${DATA_UNAVAILABLE}: ${what}`);
  }
  if (!Number.isFinite(parsed)) {
    console.error(`[data] ${what} returned a value that is not a number`);
    throw new Error(`${DATA_UNAVAILABLE}: ${what}`);
  }
  return parsed;
}

/** The same, for readiness — where a coerced value would be a claim about the 72 hours. */
function requireBoolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") {
    console.error(`[data] ${what} returned ${value === null ? "null" : typeof value}`);
    throw new Error(`${DATA_UNAVAILABLE}: ${what}`);
  }
  return value;
}

/** And for the two instants the countdown is built from. */
function requireInstant(value: unknown, what: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    console.error(`[data] ${what} returned ${value === null ? "null" : typeof value}`);
    throw new Error(`${DATA_UNAVAILABLE}: ${what}`);
  }
  return value;
}

/**
 * The standard recipe and the expected yield, as the batch form needs them.
 *
 * Both are reference data fixed by product.md and seeded by migration, so this is a read of the
 * business's own definition rather than of anything a user typed.
 *
 * AN EMPTY RECIPE IS A FAILED READ, not an empty form. §11.1 fixes three inputs and §11.2 fixes two
 * sizes, and the migration that seeds them refuses to install without all five — so a recipe that
 * comes back short means the read did not work, and a batch form pre-filled with nothing would
 * invite a Manager to record a batch that consumed no materials.
 */
export async function loadProductionReference(): Promise<{
  recipe: RecipeInput[];
  yields: YieldRange[];
}> {
  const supabase = await createServerSupabase();

  const [recipeRows, yieldRows] = await Promise.all([
    supabase
      .from("production_recipe_inputs")
      .select("product_id, standard_quantity, sort_order, products!inner(id, name, unit_code)")
      .order("sort_order"),
    supabase
      .from("production_yield_ranges")
      .select("product_id, min_per_batch, max_per_batch, products!inner(id, name, unit_code)"),
  ]);

  const recipe = requireRows(recipeRows, "production.recipe").map((row) => ({
    productId: String(row.product_id),
    productName: nameOf(row.products as ProductRef | ProductRef[] | null),
    unitCode: unitOf(row.products as ProductRef | ProductRef[] | null),
    standardQuantity: requireNumber(row.standard_quantity, "production.recipe.standard"),
    sortOrder: requireNumber(row.sort_order, "production.recipe.sort"),
  }));

  const yields = requireRows(yieldRows, "production.yields")
    .map((row) => ({
      productId: String(row.product_id),
      productName: nameOf(row.products as ProductRef | ProductRef[] | null),
      minPerBatch: requireNumber(row.min_per_batch, "production.yields.min"),
      maxPerBatch: requireNumber(row.max_per_batch, "production.yields.max"),
    }))
    // §11.2 names the two sizes; ordering them by name keeps the form stable between renders.
    .sort((a, b) => a.productName.localeCompare(b.productName));

  if (recipe.length === 0 || yields.length === 0) {
    console.error("[data] production.reference came back empty; the seed guarantees it is not");
    throw new Error(`${DATA_UNAVAILABLE}: production.reference`);
  }

  return { recipe, yields };
}

const BATCH_COLUMNS = `
  id, batch_no, location_code, status, moulded_at, yield_note,
  entered_role, entered_at, decided_role, decided_at, decision_reason,
  entered:profiles!production_batches_entered_by_fkey(full_name),
  decided:profiles!production_batches_decided_by_fkey(full_name)
`;

type BatchRow = Record<string, unknown>;

/**
 * One page of batches, with the inputs and lots belonging to exactly those batches.
 *
 * The order ends on `id`, which is unique: a range over a non-deterministic order is not a page,
 * and two batches entered in the same millisecond would otherwise be free to appear on two pages or
 * on neither.
 */
async function batchesPage(
  page: number,
  status: "draft" | "settled",
  label: string,
): Promise<Page<ProductionBatch>> {
  const supabase = await createServerSupabase();

  const batches = await pagedQuery<BatchRow>(
    page,
    (from, to) => {
      const query = supabase
        .from("production_batches")
        .select(BATCH_COLUMNS, { count: "exact" });

      return (status === "draft" ? query.eq("status", "draft") : query.neq("status", "draft"))
        .order("entered_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to);
    },
    label,
  );

  const ids = batches.rows.map((row) => String(row.id));

  const [inputRows, lotRows] = await Promise.all([
    scopedTo<Record<string, unknown>>(
      ids,
      (from, to) =>
        supabase
          .from("production_batch_inputs")
          .select(
            `batch_id, product_id, standard_quantity, actual_quantity, variance_quantity,
             products!inner(id, name, unit_code)`,
          )
          .in("batch_id", ids)
          .order("batch_id")
          .order("product_id")
          .range(from, to),
      `${label}.inputs`,
    ),
    scopedTo<Record<string, unknown>>(
      ids,
      (from, to) =>
        supabase
          .from("production_lots")
          .select(
            `id, batch_id, product_id, quantity_moulded, rejected_at_moulding,
             moulding_reject_reason, curing_started_at, inspected_at, accepted_quantity,
             rejected_at_inspection, inspection_reject_reason,
             products!inner(id, name, unit_code)`,
          )
          .in("batch_id", ids)
          .order("batch_id")
          .order("product_id")
          .range(from, to),
      `${label}.lots`,
    ),
  ]);

  const inputsByBatch = new Map<string, BatchInputLine[]>();
  for (const line of inputRows) {
    const key = String(line.batch_id);
    const list = inputsByBatch.get(key) ?? [];
    list.push({
      productId: String(line.product_id),
      productName: nameOf(line.products as ProductRef | ProductRef[] | null),
      unitCode: unitOf(line.products as ProductRef | ProductRef[] | null),
      standardQuantity: requireNumber(line.standard_quantity, `${label}.inputs.standard`),
      actualQuantity: requireNumber(line.actual_quantity, `${label}.inputs.actual`),
      varianceQuantity: requireNumber(line.variance_quantity, `${label}.inputs.variance`),
    });
    inputsByBatch.set(key, list);
  }

  const lotsByBatch = new Map<string, BatchLot[]>();
  for (const lot of lotRows) {
    const key = String(lot.batch_id);
    const list = lotsByBatch.get(key) ?? [];
    list.push({
      id: String(lot.id),
      productId: String(lot.product_id),
      productName: nameOf(lot.products as ProductRef | ProductRef[] | null),
      quantityMoulded: requireNumber(lot.quantity_moulded, `${label}.lots.moulded`),
      rejectedAtMoulding: requireNumber(lot.rejected_at_moulding, `${label}.lots.rejected`),
      mouldingRejectReason: (lot.moulding_reject_reason as string | null) ?? null,
      curingStartedAt: requireInstant(lot.curing_started_at, `${label}.lots.curingStartedAt`),
      inspectedAt: (lot.inspected_at as string | null) ?? null,
      acceptedQuantity:
        lot.accepted_quantity === null || lot.accepted_quantity === undefined
          ? null
          : requireNumber(lot.accepted_quantity, `${label}.lots.accepted`),
      rejectedAtInspection:
        lot.rejected_at_inspection === null || lot.rejected_at_inspection === undefined
          ? null
          : requireNumber(lot.rejected_at_inspection, `${label}.lots.rejectedAtInspection`),
      inspectionRejectReason: (lot.inspection_reject_reason as string | null) ?? null,
    });
    lotsByBatch.set(key, list);
  }

  const sortByName = <T extends { productName: string }>(rows: T[]) =>
    rows.sort((a, b) => a.productName.localeCompare(b.productName));

  return {
    ...batches,
    rows: batches.rows.map((batch) => {
      const id = String(batch.id);
      return {
        id,
        batchNo: String(batch.batch_no),
        locationCode: String(batch.location_code),
        status: batch.status as ProductionBatch["status"],
        mouldedAt: requireInstant(batch.moulded_at, `${label}.mouldedAt`),
        yieldNote: (batch.yield_note as string | null) ?? null,
        enteredByName: personOf(batch.entered),
        enteredRole: batch.entered_role as AppRole,
        enteredAt: requireInstant(batch.entered_at, `${label}.enteredAt`),
        decidedByName: batch.decided ? personOf(batch.decided) : null,
        decidedRole: (batch.decided_role as AppRole | null) ?? null,
        decidedAt: (batch.decided_at as string | null) ?? null,
        decisionReason: (batch.decision_reason as string | null) ?? null,
        inputs: sortByName(inputsByBatch.get(id) ?? []),
        lots: sortByName(lotsByBatch.get(id) ?? []),
      };
    }),
  };
}

/**
 * Batches waiting for a decision (§11.1, AC-39).
 *
 * Read on its own, so that however much history exists, the oldest undecided batch is still on a
 * page somebody can reach.
 */
export function loadProductionDrafts(page = 1): Promise<Page<ProductionBatch>> {
  return batchesPage(page, "draft", "production.drafts");
}

/** Everything already decided — approved, rejected or cancelled. Bounded, paged and navigable. */
export function loadSettledBatches(page = 1): Promise<Page<ProductionBatch>> {
  return batchesPage(page, "settled", "production.history");
}

/**
 * The inspection queue: every lot that is curing and has not been inspected (§11.4).
 *
 * Oldest first, because the oldest lot is the one whose 72 hours are closest to being up. Read from
 * `curing_lots`, which is where the deadline is computed, and independently of the batch history
 * for the same reason the drafts are.
 */
export async function loadOpenCuringLots(page = 1): Promise<Page<CuringLot>> {
  const supabase = await createServerSupabase();

  const lots = await pagedQuery<Record<string, unknown>>(
    page,
    (from, to) =>
      supabase
        .from("curing_lots")
        .select(
          `lot_id, batch_id, batch_no, product_id, location_code, quantity_curing,
           quantity_moulded, rejected_at_moulding, moulding_reject_reason,
           curing_started_at, ready_at, ready_for_inspection`,
          { count: "exact" },
        )
        .is("inspected_at", null)
        .order("curing_started_at", { ascending: true })
        .order("lot_id", { ascending: true })
        .range(from, to),
    "production.curing",
  );

  // Product names come from a scoped read of `products` rather than from an embed on the view.
  // PostgREST can sometimes infer a relationship through a view and sometimes cannot, and a
  // resolution that depends on inference is one upgrade away from becoming a failed read.
  const productIds = Array.from(new Set(lots.rows.map((row) => String(row.product_id))));
  const products =
    productIds.length === 0
      ? []
      : requireRows(
          await supabase.from("products").select("id, name").in("id", productIds),
          "production.curing.products",
        );

  const nameById = new Map(products.map((row) => [String(row.id), String(row.name)]));

  return {
    ...lots,
    rows: lots.rows.map((row) => ({
      lotId: String(row.lot_id),
      batchId: String(row.batch_id),
      batchNo: String(row.batch_no),
      productId: String(row.product_id),
      productName: nameById.get(String(row.product_id)) ?? "",
      locationCode: String(row.location_code),
      quantityCuring: requireNumber(row.quantity_curing, "production.curing.quantity"),
      quantityMoulded: requireNumber(row.quantity_moulded, "production.curing.moulded"),
      rejectedAtMoulding: requireNumber(row.rejected_at_moulding, "production.curing.rejected"),
      mouldingRejectReason: (row.moulding_reject_reason as string | null) ?? null,
      curingStartedAt: requireInstant(row.curing_started_at, "production.curing.startedAt"),
      readyAt: requireInstant(row.ready_at, "production.curing.readyAt"),
      readyForInspection: requireBoolean(row.ready_for_inspection, "production.curing.ready"),
    })),
  };
}
