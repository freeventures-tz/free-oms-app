"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth/guard";
import { fieldErrors } from "@/lib/validation/auth";
import {
  approveProductionBatch,
  enterProductionBatch,
  inspectCuringLot,
  rejectProductionBatch,
} from "@/lib/production/commands";
import {
  batchDecisionSchema,
  batchRejectionSchema,
  enterBatchSchema,
  inspectLotSchema,
} from "@/lib/validation/production";

/**
 * Production writes (product.md §11, §4.1).
 *
 * `requireRole` here produces the right SCREEN and refuses early. It is NOT what authorises the
 * change: every `api` function below derives the acting person from the same session independently
 * and takes no actor, and the tables carry no INSERT grant for `authenticated` at all. Neither
 * layer is permitted to be the only one.
 *
 * §4.1 gives production to the MANAGER, entry and approval alike, and names no alternate. That is
 * why a Director appears nowhere in this file: a Director reads the yard (design.md §4.2) and
 * decides nothing on it, and inferring an alternate from seniority would be an invention.
 */

const KNOWN_ERROR_KEYS = new Set([
  "not_permitted",
  "generic",
  "idempotency_key_conflict",
  // Entry
  "no_location",
  "no_product",
  "moulded_at_invalid",
  "inputs_required",
  "outputs_required",
  "line_invalid",
  "duplicate_product_line",
  "incomplete_recipe_inputs",
  "not_a_recipe_input",
  "not_a_produced_product",
  "quantity_invalid",
  "quantity_not_whole",
  "rejects_exceed_output",
  "reject_reason_required",
  "reject_reason_invalid",
  "reject_reason_without_rejects",
  "yield_explanation_required",
  "yield_within_range",
  // Decisions
  "no_batch",
  "already_settled",
  "reason_required",
  "insufficient_stock",
  // Inspection
  "no_lot",
  "batch_not_approved",
  "already_inspected",
  "still_curing",
  "inspection_must_account_for_all",
]);

function errorKey(reason: string): string {
  return KNOWN_ERROR_KEYS.has(reason) ? `productionErrors.${reason}` : "productionErrors.generic";
}

export type ProductionActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  successKey?: string;
  /**
   * The numbers a refusal needs to be actionable. `insufficient_stock` without them says "no"; with
   * them it says "there are 12 and you asked for 30". `still_curing` without them says "wait"; with
   * them it says when.
   */
  errorValues?: Record<string, string | number>;
};

/**
 * Which screens a production action can have changed, and no more.
 *
 * ENTERING OR REJECTING A BATCH MOVES NOTHING (§11.1, AC-39), so neither touches the stock screens:
 * revalidating them would throw away caches that are still correct, on the one route a Manager is
 * about to look at from a phone in a yard.
 *
 * APPROVING AND INSPECTING BOTH MOVE STOCK. `/orders/new` is included for the reason a receipt
 * includes it: §8.1 shows a Sales Representative what can be sold, and an approval that consumed
 * materials or an inspection that made eighteen bricks available changes that answer.
 */
function revalidateProductionOnly() {
  revalidatePath("/production");
}

function revalidateProductionAndStock() {
  revalidatePath("/production");
  revalidatePath("/inventory");
  revalidatePath("/orders/new");
}

/**
 * Line items arrive as one JSON string rather than as indexed form fields.
 *
 * A batch has three inputs and up to two outputs, each with several numbers, and
 * `outputs[1].rejectReason` style keys would need parsing and re-assembling on both sides of the
 * wire. The JSON is validated by the same Zod schema either way, and anything malformed is a field
 * error rather than a throw.
 */
function parseLines(raw: FormDataEntryValue | null): unknown {
  if (typeof raw !== "string") return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** Refusals whose numbers the screen shows. Everything else is a sentence on its own. */
function valuesFrom(context: Record<string, unknown> | undefined) {
  if (!context) return undefined;

  const values: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(context)) {
    values[key] = typeof value === "number" ? value : String(value);
  }
  return Object.keys(values).length > 0 ? values : undefined;
}

// ---------------------------------------------------------------------------
// Entering a batch — Manager only, and it moves nothing
// ---------------------------------------------------------------------------
export async function enterBatchAction(
  _previous: ProductionActionState,
  formData: FormData,
): Promise<ProductionActionState> {
  await requireRole(["manager"]);

  const parsed = enterBatchSchema.safeParse({
    locationCode: formData.get("locationCode"),
    mouldedAt: formData.get("mouldedAt"),
    inputs: parseLines(formData.get("inputs")),
    outputs: parseLines(formData.get("outputs")),
    yieldNote: formData.get("yieldNote") ?? "",
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await enterProductionBatch(parsed.data);
  if (!result.ok) {
    return { error: errorKey(result.reason), errorValues: valuesFrom(result.context) };
  }

  revalidateProductionOnly();
  return { successKey: "production.batch.entered" };
}

// ---------------------------------------------------------------------------
// Approving a batch — the moment the yard is consumed (§11.1, AC-38)
// ---------------------------------------------------------------------------
export async function approveBatchAction(
  _previous: ProductionActionState,
  formData: FormData,
): Promise<ProductionActionState> {
  await requireRole(["manager"]);

  const parsed = batchDecisionSchema.safeParse({
    batchId: formData.get("batchId"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await approveProductionBatch(parsed.data);
  if (!result.ok) {
    return { error: errorKey(result.reason), errorValues: valuesFrom(result.context) };
  }

  revalidateProductionAndStock();
  return { successKey: "production.batch.approved" };
}

export async function rejectBatchAction(
  _previous: ProductionActionState,
  formData: FormData,
): Promise<ProductionActionState> {
  await requireRole(["manager"]);

  const parsed = batchRejectionSchema.safeParse({
    batchId: formData.get("batchId"),
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await rejectProductionBatch(parsed.data);
  if (!result.ok) {
    return { error: errorKey(result.reason), errorValues: valuesFrom(result.context) };
  }

  revalidateProductionOnly();
  return { successKey: "production.batch.rejected" };
}

// ---------------------------------------------------------------------------
// Inspecting a lot — the ONLY way a brick becomes sellable (§11.4, AC-45)
// ---------------------------------------------------------------------------
export async function inspectLotAction(
  _previous: ProductionActionState,
  formData: FormData,
): Promise<ProductionActionState> {
  await requireRole(["manager"]);

  const parsed = inspectLotSchema.safeParse({
    lotId: formData.get("lotId"),
    acceptedQuantity: formData.get("acceptedQuantity"),
    rejectedQuantity: formData.get("rejectedQuantity"),
    rejectReason: formData.get("rejectReason") ?? "",
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await inspectCuringLot(parsed.data);
  if (!result.ok) {
    return { error: errorKey(result.reason), errorValues: valuesFrom(result.context) };
  }

  revalidateProductionAndStock();
  return { successKey: "production.inspection.recorded" };
}
