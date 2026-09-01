"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth/guard";
import { fieldErrors } from "@/lib/validation/auth";
import {
  addSupplier,
  approveStockAdjustment,
  approveStockReceipt,
  approveStockTransfer,
  enterStockAdjustment,
  enterStockReceipt,
  enterStockTransfer,
  recordOpeningStock,
  rejectStockAdjustment,
  rejectStockReceipt,
  rejectStockTransfer,
  setSupplierActive,
} from "@/lib/inventory/commands";
import {
  addSupplierSchema,
  decisionSchema,
  enterAdjustmentSchema,
  enterReceiptSchema,
  enterTransferSchema,
  openingStockSchema,
  rejectionSchema,
  setSupplierActiveSchema,
} from "@/lib/validation/inventory";
import { businessDate } from "@/lib/time/business-date";

/**
 * Stock writes (product.md §4.1, §9, §10).
 *
 * `requireRole` here produces the right SCREEN and refuses early. It is NOT what authorises the
 * change: every `api` function below derives the acting person from the same session independently
 * and takes no actor, and the tables carry no INSERT grant for `authenticated` at all. Neither
 * layer is permitted to be the only one.
 *
 * Note which roles appear where. They are not a design preference — each one is the row of
 * product.md §4.1 that governs the operation, and the awkward ones are the faithful ones: a
 * Director cannot enter or approve a supplier receipt, because §4.1 names the Manager and no
 * alternate.
 */

const KNOWN_ERROR_KEYS = new Set([
  "not_permitted",
  "generic",
  "idempotency_key_conflict",
  // Suppliers
  "supplier_name_required",
  "supplier_exists",
  "supplier_unchanged",
  "supplier_state_required",
  "no_supplier",
  // Products, locations, quantities
  "no_product",
  "no_location",
  "quantity_invalid",
  "quantity_not_whole",
  "opening_stock_exists",
  // Receiving
  "delivery_note_required",
  "delivery_date_required",
  "delivery_date_future",
  "lines_required",
  "line_invalid",
  "duplicate_product_line",
  "damaged_exceeds_received",
  "no_receipt",
  // Transfers and adjustments
  "no_transfer",
  "no_adjustment",
  "same_location",
  "insufficient_stock",
  // Decisions
  "no_approval_request",
  "already_settled",
  "reason_required",
]);

function errorKey(reason: string): string {
  return KNOWN_ERROR_KEYS.has(reason) ? `inventoryErrors.${reason}` : "inventoryErrors.generic";
}

export type InventoryActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  successKey?: string;
  /**
   * The numbers a refusal needs to be actionable. `insufficient_stock` without them says "no";
   * with them it says "there are 12 and you asked for 30", which is a sentence somebody can act on.
   */
  errorValues?: Record<string, string | number>;
  /**
   * The business date AT THE MOMENT THE COMMAND SUCCEEDED, for a form that clears itself.
   *
   * The date a page was rendered with is the right answer until the page outlives it. A receiving
   * screen left open across midnight in Dar es Salaam would otherwise reset to yesterday, and the
   * person recording the first delivery of the new day would not obviously see anything wrong.
   * Sent only on success, and computed on the server for the same reason the initial one is.
   */
  businessDate?: string;
};

/** Every stock screen revalidates the same three routes: a movement changes all of them. */
function revalidateStock() {
  revalidatePath("/inventory");
  revalidatePath("/inventory/receiving");
  revalidatePath("/inventory/transfers");
  // Create New Order shows what can be sold (§8.1), so a movement changes that screen too.
  revalidatePath("/orders/new");
}

/**
 * Line items arrive as one JSON string rather than as indexed form fields.
 *
 * A receipt has a variable number of lines, each with four numbers, and `lines[3].damagedQuantity`
 * style keys would need parsing and re-assembling on both sides of the wire. The JSON is validated
 * by the same Zod schema either way, and anything malformed is a field error rather than a throw.
 */
function parseLines(raw: FormDataEntryValue | null): unknown {
  if (typeof raw !== "string") return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Suppliers — Director only
//
// These live here rather than under `/settings/suppliers` because they share the error-key map
// above with every other stock command, and one map is what keeps a refusal reading the same
// wherever it surfaces. The route a Server Action is imported from does not constrain it.
// ---------------------------------------------------------------------------
export async function addSupplierAction(
  _previous: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  await requireRole(["director"]);

  const parsed = addSupplierSchema.safeParse({
    name: formData.get("name"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await addSupplier(parsed.data);
  if (!result.ok) return { error: errorKey(result.reason) };

  revalidatePath("/settings/suppliers");
  revalidatePath("/inventory/receiving");
  return { successKey: "inventory.suppliers.added" };
}

export async function setSupplierActiveAction(
  _previous: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  await requireRole(["director"]);

  const parsed = setSupplierActiveSchema.safeParse({
    supplierId: formData.get("supplierId"),
    isActive: formData.get("isActive"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await setSupplierActive(parsed.data);
  if (!result.ok) return { error: errorKey(result.reason) };

  revalidatePath("/settings/suppliers");
  revalidatePath("/inventory/receiving");
  return {
    successKey: parsed.data.isActive
      ? "inventory.suppliers.reactivated"
      : "inventory.suppliers.deactivated",
  };
}

// ---------------------------------------------------------------------------
// Opening stock — Director only
// ---------------------------------------------------------------------------
export async function recordOpeningStockAction(
  _previous: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  await requireRole(["director"]);

  const parsed = openingStockSchema.safeParse({
    productId: formData.get("productId"),
    locationCode: formData.get("locationCode"),
    quantity: formData.get("quantity"),
    note: formData.get("note") ?? "",
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await recordOpeningStock(parsed.data);
  if (!result.ok) return { error: errorKey(result.reason) };

  revalidateStock();
  return { successKey: "inventory.openingStock.recorded" };
}

// ---------------------------------------------------------------------------
// Supplier receiving — entered by Manager, Cashier or Sales Rep (§9.1); approved by Manager (§4.1)
// ---------------------------------------------------------------------------
export async function enterReceiptAction(
  _previous: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  await requireRole(["manager", "cashier", "sales_rep"]);

  const parsed = enterReceiptSchema.safeParse({
    supplierId: formData.get("supplierId"),
    locationCode: formData.get("locationCode"),
    deliveryDate: formData.get("deliveryDate"),
    deliveryNoteRef: formData.get("deliveryNoteRef"),
    lines: parseLines(formData.get("lines")),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await enterStockReceipt({
    supplierId: parsed.data.supplierId,
    locationCode: parsed.data.locationCode,
    deliveryDate: parsed.data.deliveryDate,
    deliveryNoteRef: parsed.data.deliveryNoteRef,
    lines: parsed.data.lines,
    idempotencyKey: parsed.data.idempotencyKey,
  });

  if (!result.ok) return { error: errorKey(result.reason) };

  revalidateStock();
  // Computed here, after the work, rather than reused from the request: this is the date the NEXT
  // delivery should start with, and the two differ exactly when the form has been open across
  // midnight — which is the case worth being right about.
  return { successKey: "inventory.receiving.entered", businessDate: businessDate() };
}

export async function approveReceiptAction(
  _previous: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  await requireRole(["manager"]);

  const parsed = decisionSchema.safeParse({
    entityId: formData.get("entityId"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await approveStockReceipt({
    receiptId: parsed.data.entityId,
    idempotencyKey: parsed.data.idempotencyKey,
  });

  if (!result.ok) return { error: errorKey(result.reason) };

  revalidateStock();
  return { successKey: "inventory.receiving.approved" };
}

export async function rejectReceiptAction(
  _previous: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  await requireRole(["manager"]);

  const parsed = rejectionSchema.safeParse({
    entityId: formData.get("entityId"),
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await rejectStockReceipt({
    receiptId: parsed.data.entityId,
    reason: parsed.data.reason,
    idempotencyKey: parsed.data.idempotencyKey,
  });

  if (!result.ok) return { error: errorKey(result.reason) };

  revalidateStock();
  return { successKey: "inventory.receiving.rejected" };
}

// ---------------------------------------------------------------------------
// Internal transfers — Manager enters and Manager approves (§4.1), as two separate acts (§4.2)
// ---------------------------------------------------------------------------
export async function enterTransferAction(
  _previous: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  await requireRole(["manager"]);

  const parsed = enterTransferSchema.safeParse({
    fromLocation: formData.get("fromLocation"),
    toLocation: formData.get("toLocation"),
    note: formData.get("note") ?? "",
    lines: parseLines(formData.get("lines")),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await enterStockTransfer({
    fromLocation: parsed.data.fromLocation,
    toLocation: parsed.data.toLocation,
    note: parsed.data.note,
    lines: parsed.data.lines,
    idempotencyKey: parsed.data.idempotencyKey,
  });

  if (!result.ok) return { error: errorKey(result.reason) };

  revalidateStock();
  return { successKey: "inventory.transfers.entered" };
}

export async function approveTransferAction(
  _previous: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  await requireRole(["manager"]);

  const parsed = decisionSchema.safeParse({
    entityId: formData.get("entityId"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await approveStockTransfer({
    transferId: parsed.data.entityId,
    idempotencyKey: parsed.data.idempotencyKey,
  });

  if (!result.ok) {
    // The one refusal that needs numbers to be useful. §7.15: the limit is shown, not merely hit.
    return {
      error: errorKey(result.reason),
      errorValues: result.context
        ? {
            available: Number(result.context.available),
            requested: Number(result.context.requested),
          }
        : undefined,
    };
  }

  revalidateStock();
  return { successKey: "inventory.transfers.approved" };
}

export async function rejectTransferAction(
  _previous: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  await requireRole(["manager"]);

  const parsed = rejectionSchema.safeParse({
    entityId: formData.get("entityId"),
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await rejectStockTransfer({
    transferId: parsed.data.entityId,
    reason: parsed.data.reason,
    idempotencyKey: parsed.data.idempotencyKey,
  });

  if (!result.ok) return { error: errorKey(result.reason) };

  revalidateStock();
  return { successKey: "inventory.transfers.rejected" };
}

// ---------------------------------------------------------------------------
// Manual stock adjustment — Manager enters, Director approves (§4.1)
// ---------------------------------------------------------------------------
export async function enterAdjustmentAction(
  _previous: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  await requireRole(["manager"]);

  const parsed = enterAdjustmentSchema.safeParse({
    productId: formData.get("productId"),
    locationCode: formData.get("locationCode"),
    quantityDelta: formData.get("quantityDelta"),
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await enterStockAdjustment(parsed.data);
  if (!result.ok) return { error: errorKey(result.reason) };

  revalidatePath("/inventory/adjustments");
  revalidatePath("/inventory");
  return { successKey: "inventory.adjustments.entered" };
}

export async function approveAdjustmentAction(
  _previous: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  await requireRole(["director"]);

  const parsed = decisionSchema.safeParse({
    entityId: formData.get("entityId"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await approveStockAdjustment({
    adjustmentId: parsed.data.entityId,
    idempotencyKey: parsed.data.idempotencyKey,
  });

  if (!result.ok) {
    return {
      error: errorKey(result.reason),
      errorValues: result.context
        ? {
            available: Number(result.context.available),
            requested: Number(result.context.requested),
          }
        : undefined,
    };
  }

  revalidatePath("/inventory/adjustments");
  revalidatePath("/inventory");
  return { successKey: "inventory.adjustments.approved" };
}

export async function rejectAdjustmentAction(
  _previous: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  await requireRole(["director"]);

  const parsed = rejectionSchema.safeParse({
    entityId: formData.get("entityId"),
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await rejectStockAdjustment({
    adjustmentId: parsed.data.entityId,
    reason: parsed.data.reason,
    idempotencyKey: parsed.data.idempotencyKey,
  });

  if (!result.ok) return { error: errorKey(result.reason) };

  revalidatePath("/inventory/adjustments");
  revalidatePath("/inventory");
  return { successKey: "inventory.adjustments.rejected" };
}
