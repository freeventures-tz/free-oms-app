import { userApi } from "@/lib/supabase/api";

/**
 * Stock commands (product.md §4.1, §9, §10).
 *
 * Every one of these goes through the caller's OWN session. The `api` functions derive the acting
 * person and the roles they are allowed to hold from the verified JWT and take no actor, so there
 * is no server-side branch in this file deciding whether someone may approve a receipt — the
 * database decides, and a Cashier reaching this code is refused by it.
 *
 * The secret key is not imported here. Nothing in this module spans two systems, so nothing needs
 * the one credential that could bypass row-level security.
 */

export type CommandResult =
  | { ok: true; detail: string }
  /** `context` carries the numbers a refusal needs to be actionable, e.g. what stock is available. */
  | { ok: false; reason: string; context?: Record<string, unknown> };

/** A caller acting under a user's own session. Injectable so tests drive the real function. */
export type InventoryApi = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{
    data: Record<string, unknown> | null;
    error: { message: string } | null;
  }>;
};

/**
 * The database raises for authority failures — `private.acting_director` and
 * `private.acting_staff` both throw `insufficient_privilege`. Somebody arriving here through a
 * stale page, a crafted request, or a role changed a minute ago is refused there, not by a branch
 * in this file.
 */
function mapDatabaseError(message: string): string {
  if (/not a live Director|may not perform this command|authenticated session/i.test(message)) {
    return "not_permitted";
  }
  return "generic";
}

function reasonOf(data: { reason?: unknown } | null, fallback: string): string {
  return String(data?.reason ?? fallback);
}

/** The one place a command result becomes a `CommandResult`, so twelve callers cannot differ. */
async function issue(
  api: InventoryApi,
  fn: string,
  args: Record<string, unknown>,
  successFallback: string,
): Promise<CommandResult> {
  const { data, error } = await api.rpc(fn, args);

  if (error) return { ok: false, reason: mapDatabaseError(error.message) };

  if (!data?.ok) {
    const reason = reasonOf(data, "generic");
    // `insufficient_stock` is the one refusal a person can act on only if they are told the
    // numbers: "there are 12, you asked for 30" beats "not enough".
    const context =
      data && "available" in data
        ? { available: Number(data.available), requested: Number(data.requested) }
        : undefined;
    return { ok: false, reason, context };
  }

  return { ok: true, detail: reasonOf(data, successFallback) };
}

async function resolve(issuedBy?: InventoryApi): Promise<InventoryApi> {
  return issuedBy ?? ((await userApi()) as unknown as InventoryApi);
}

export async function addSupplier(
  input: { name: string; idempotencyKey: string },
  issuedBy?: InventoryApi,
): Promise<CommandResult> {
  return issue(
    await resolve(issuedBy),
    "admin_add_supplier",
    { p_name: input.name, p_idempotency_key: input.idempotencyKey },
    "added",
  );
}

export async function setSupplierActive(
  input: { supplierId: string; isActive: boolean; idempotencyKey: string },
  issuedBy?: InventoryApi,
): Promise<CommandResult> {
  return issue(
    await resolve(issuedBy),
    "admin_set_supplier_active",
    {
      p_supplier_id: input.supplierId,
      p_is_active: input.isActive,
      p_idempotency_key: input.idempotencyKey,
    },
    "deactivated",
  );
}

export async function recordOpeningStock(
  input: {
    productId: string;
    locationCode: string;
    quantity: number;
    note: string | null;
    idempotencyKey: string;
  },
  issuedBy?: InventoryApi,
): Promise<CommandResult> {
  return issue(
    await resolve(issuedBy),
    "admin_record_opening_stock",
    {
      p_product_id: input.productId,
      p_location_code: input.locationCode,
      p_quantity: input.quantity,
      p_note: input.note,
      p_idempotency_key: input.idempotencyKey,
    },
    "recorded",
  );
}

export type ReceiptLineInput = {
  productId: string;
  expectedQuantity: number;
  receivedQuantity: number;
  damagedQuantity: number;
  damageNote: string | null;
};

export async function enterStockReceipt(
  input: {
    supplierId: string;
    locationCode: string;
    deliveryDate: string;
    deliveryNoteRef: string;
    lines: ReceiptLineInput[];
    idempotencyKey: string;
  },
  issuedBy?: InventoryApi,
): Promise<CommandResult> {
  return issue(
    await resolve(issuedBy),
    "staff_enter_stock_receipt",
    {
      p_supplier_id: input.supplierId,
      p_location_code: input.locationCode,
      p_delivery_date: input.deliveryDate,
      p_delivery_note_ref: input.deliveryNoteRef,
      // snake_case because the database reads these keys directly out of the jsonb. Naming them
      // twice is the price of not having a second parsing layer between the form and the command.
      p_lines: input.lines.map((line) => ({
        product_id: line.productId,
        expected_quantity: line.expectedQuantity,
        received_quantity: line.receivedQuantity,
        damaged_quantity: line.damagedQuantity,
        damage_note: line.damageNote,
      })),
      p_idempotency_key: input.idempotencyKey,
    },
    "entered",
  );
}

export async function approveStockReceipt(
  input: { receiptId: string; idempotencyKey: string },
  issuedBy?: InventoryApi,
): Promise<CommandResult> {
  return issue(
    await resolve(issuedBy),
    "staff_approve_stock_receipt",
    { p_receipt_id: input.receiptId, p_idempotency_key: input.idempotencyKey },
    "approved",
  );
}

export async function rejectStockReceipt(
  input: { receiptId: string; reason: string; idempotencyKey: string },
  issuedBy?: InventoryApi,
): Promise<CommandResult> {
  return issue(
    await resolve(issuedBy),
    "staff_reject_stock_receipt",
    {
      p_receipt_id: input.receiptId,
      p_reason: input.reason,
      p_idempotency_key: input.idempotencyKey,
    },
    "rejected",
  );
}

export type TransferLineInput = { productId: string; quantity: number };

export async function enterStockTransfer(
  input: {
    fromLocation: string;
    toLocation: string;
    note: string | null;
    lines: TransferLineInput[];
    idempotencyKey: string;
  },
  issuedBy?: InventoryApi,
): Promise<CommandResult> {
  return issue(
    await resolve(issuedBy),
    "staff_enter_stock_transfer",
    {
      p_from_location: input.fromLocation,
      p_to_location: input.toLocation,
      p_note: input.note,
      p_lines: input.lines.map((line) => ({
        product_id: line.productId,
        quantity: line.quantity,
      })),
      p_idempotency_key: input.idempotencyKey,
    },
    "entered",
  );
}

export async function approveStockTransfer(
  input: { transferId: string; idempotencyKey: string },
  issuedBy?: InventoryApi,
): Promise<CommandResult> {
  return issue(
    await resolve(issuedBy),
    "staff_approve_stock_transfer",
    { p_transfer_id: input.transferId, p_idempotency_key: input.idempotencyKey },
    "approved",
  );
}

export async function rejectStockTransfer(
  input: { transferId: string; reason: string; idempotencyKey: string },
  issuedBy?: InventoryApi,
): Promise<CommandResult> {
  return issue(
    await resolve(issuedBy),
    "staff_reject_stock_transfer",
    {
      p_transfer_id: input.transferId,
      p_reason: input.reason,
      p_idempotency_key: input.idempotencyKey,
    },
    "rejected",
  );
}

export async function enterStockAdjustment(
  input: {
    productId: string;
    locationCode: string;
    quantityDelta: number;
    reason: string;
    idempotencyKey: string;
  },
  issuedBy?: InventoryApi,
): Promise<CommandResult> {
  return issue(
    await resolve(issuedBy),
    "staff_enter_stock_adjustment",
    {
      p_product_id: input.productId,
      p_location_code: input.locationCode,
      p_quantity_delta: input.quantityDelta,
      p_reason: input.reason,
      p_idempotency_key: input.idempotencyKey,
    },
    "entered",
  );
}

export async function approveStockAdjustment(
  input: { adjustmentId: string; idempotencyKey: string },
  issuedBy?: InventoryApi,
): Promise<CommandResult> {
  return issue(
    await resolve(issuedBy),
    "admin_approve_stock_adjustment",
    { p_adjustment_id: input.adjustmentId, p_idempotency_key: input.idempotencyKey },
    "approved",
  );
}

export async function rejectStockAdjustment(
  input: { adjustmentId: string; reason: string; idempotencyKey: string },
  issuedBy?: InventoryApi,
): Promise<CommandResult> {
  return issue(
    await resolve(issuedBy),
    "admin_reject_stock_adjustment",
    {
      p_adjustment_id: input.adjustmentId,
      p_reason: input.reason,
      p_idempotency_key: input.idempotencyKey,
    },
    "rejected",
  );
}
