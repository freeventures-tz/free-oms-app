import { requireRows } from "@/lib/supabase/query";
import { userApi } from "@/lib/supabase/api";
import { createServerSupabase } from "@/lib/supabase/server";
import type { AppRole } from "@/lib/auth/roles";
import type { ImprestCategory } from "@/lib/imprest/spending";

/**
 * Suppliers, stock and the movements behind it (product.md §8, §9, §10, §4.1).
 *
 * READS go through the caller's own session under RLS, like every other list in this application:
 * if the policies were ever wrong the screen would show less, not more. The secret key is not
 * imported here at all — nothing in this module spans two systems.
 *
 * A failed read is NOT an empty yard. `requireRows` throws so the shell's error boundary can say
 * the system could not be reached, rather than rendering "no stock recorded" during an outage and
 * telling a Manager something false about their own business (lib/supabase/query.ts).
 */

export type Supplier = {
  id: string;
  name: string;
  isActive: boolean;
};

/** The three V1 locations, as reference data rather than as a hard-coded list (product.md §7). */
export type InventoryLocation = { code: string; sortOrder: number };

/**
 * A balance at one location, for one product, in one state.
 *
 * This is PHYSICAL stock. It is not "available stock" in the §8.1 sense, which subtracts reserved
 * and committed quantities — those are created by orders and do not exist yet. The screen says
 * which one it is showing rather than letting the reader assume.
 */
export type StockBalance = {
  productId: string;
  locationCode: string;
  quantity: number;
  lastMovementAt: string | null;
};

export type LedgerEntry = {
  id: string;
  productId: string;
  locationCode: string;
  quantityDelta: number;
  movementKind: string;
  sourceType: string;
  sourceId: string;
  actorName: string;
  approverName: string;
  occurredAt: string;
};

/**
 * Where a record stands, read from `approval_requests` rather than from a column on the record.
 *
 * The record carries no status of its own on purpose: §4.3's rule — only an approved outcome
 * records an approver — is enforced by a check constraint on that table, and a mirrored column
 * would be a second copy of the truth to keep in step.
 */
export type ApprovalState = {
  status: "pending" | "approved" | "rejected" | string;
  decidedByName: string | null;
  /**
   * The role the decider held AT THE MOMENT THEY DECIDED, not the role they hold now.
   *
   * Both sources store it beside the decision for that reason — a person whose role changes later
   * must not silently rewrite who authorised a stock movement last month (§4.2).
   */
  decidedRole: AppRole | null;
  decidedAt: string | null;
  /** Present on a rejection: the reason the decider gave (§4.3). */
  note: string | null;
};

export type ReceiptLine = {
  id: string;
  productId: string;
  expectedQuantity: number;
  receivedQuantity: number;
  damagedQuantity: number;
  /** Calculated by the database, never typed (product.md §5.2, AC-27). */
  shortQuantity: number;
  excessQuantity: number;
  acceptedQuantity: number;
  damageNote: string | null;
};

/**
 * An imprest payment as a stock receipt shows it (issue #73): its number, where it stands, its
 * category, the payee it was handed out to and the approved amount, raises included. All of it is
 * read from the payment; none of it is typed on the receipt.
 */
export type PaidFromDisbursement = {
  id: string;
  disbursementNo: string;
  status: string;
  category: ImprestCategory;
  recipient: string | null;
  approved: number;
  handedOutAt: string | null;
};

/** The payment a receipt was paid from, and who marked it, when the receipt was entered. */
export type ReceiptImprestLink = {
  disbursement: PaidFromDisbursement;
  linkedBy: string;
  linkedRole: AppRole;
  linkedAt: string;
};

export type StockReceipt = {
  id: string;
  supplierId: string;
  supplierName: string;
  locationCode: string;
  deliveryNoteRef: string;
  deliveryDate: string;
  enteredByName: string;
  enteredRole: AppRole;
  enteredAt: string;
  approval: ApprovalState;
  lines: ReceiptLine[];
  /** Paid from imprest (issue #73), or `null` when it was not. Never changes once entered. */
  paidFrom: ReceiptImprestLink | null;
};

export type TransferLine = { id: string; productId: string; quantity: number };

export type StockTransfer = {
  id: string;
  fromLocation: string;
  toLocation: string;
  note: string | null;
  enteredByName: string;
  enteredAt: string;
  approval: ApprovalState;
  lines: TransferLine[];
};

export type StockAdjustment = {
  id: string;
  productId: string;
  locationCode: string;
  quantityDelta: number;
  reason: string;
  enteredByName: string;
  enteredAt: string;
  approval: ApprovalState;
};

type ProfileRow = { full_name: string } | { full_name: string }[] | null;

/** PostgREST returns an embedded one-to-one as an object or, on some paths, a one-element array. */
function nameOf(profile: unknown): string {
  const value = profile as ProfileRow;
  return (Array.isArray(value) ? value[0]?.full_name : value?.full_name) ?? "";
}

/**
 * Approval rows for a set of entities, keyed by entity id.
 *
 * One query for the whole board rather than one per record: twenty pending receipts would otherwise
 * be twenty round trips, and on this deployment a round trip crosses the Atlantic twice
 * (reviews/pr-04-review-brief.md §2).
 */
async function approvalsFor(
  supabase: Awaited<ReturnType<typeof createServerSupabase>>,
  entityType: string,
): Promise<Map<string, ApprovalState>> {
  const rows = requireRows(
    await supabase
      .from("approval_requests")
      .select(`
        entity_id, status, approved_at, approved_role,
        profiles!approval_requests_approved_by_fkey(full_name)
      `)
      .eq("entity_type", entityType),
    `inventory.approvals.${entityType}`,
  );

  // The decision itself, for the reason a rejection carries. `approval_requests` deliberately holds
  // no rejector — §4.3 — so the note and the decider come from append-only decision history.
  const decisions = requireRows(
    await supabase
      .from("approval_decisions")
      .select(`
        request_id, outcome, note, decided_at, decided_role,
        approval_requests!inner(entity_id, entity_type),
        profiles!approval_decisions_decided_by_fkey(full_name)
      `)
      .eq("approval_requests.entity_type", entityType)
      .order("decided_at", { ascending: false }),
    `inventory.decisions.${entityType}`,
  );

  const latestDecision = new Map<
    string,
    { name: string; role: AppRole | null; note: string | null; at: string }
  >();
  for (const row of decisions) {
    const parent = row.approval_requests as { entity_id: string } | { entity_id: string }[] | null;
    const entityId = Array.isArray(parent) ? parent[0]?.entity_id : parent?.entity_id;
    if (!entityId || latestDecision.has(entityId)) continue;
    latestDecision.set(entityId, {
      name: nameOf(row.profiles),
      role: (row.decided_role as AppRole | null) ?? null,
      note: (row.note as string | null) ?? null,
      at: row.decided_at as string,
    });
  }

  const byEntity = new Map<string, ApprovalState>();
  for (const row of rows) {
    const entityId = row.entity_id as string;
    const decision = latestDecision.get(entityId) ?? null;
    byEntity.set(entityId, {
      status: row.status as string,
      // On an approval both sources agree; on a rejection only the decision has a name, because
      // `approved_by` is null by design and reading it would show a rejection as unattributed.
      decidedByName: nameOf(row.profiles) || decision?.name || null,
      // The same asymmetry, for the same reason: `approval_fields_match_status` permits
      // `approved_role` only on an approval, so a rejection's role comes from the decision row.
      decidedRole: (row.approved_role as AppRole | null) ?? decision?.role ?? null,
      decidedAt: (row.approved_at as string | null) ?? decision?.at ?? null,
      note: decision?.note ?? null,
    });
  }
  return byEntity;
}

const PENDING: ApprovalState = {
  status: "pending",
  decidedByName: null,
  decidedRole: null,
  decidedAt: null,
  note: null,
};

export type StockOverview = {
  locations: InventoryLocation[];
  balances: StockBalance[];
  /**
   * Bricks inside their 72-hour curing period (product.md §8, §11.4).
   *
   * A SEPARATE list rather than a second field on `balances`, because §8 makes Available and
   * Curing two states and merging them into one number is exactly what the document forbids.
   * They are physically at the location — which is what the Stock screen says it shows — and
   * not one of them may be sold until a Manager accepts it (AC-44).
   */
  curing: StockBalance[];
  recentMovements: LedgerEntry[];
};

export async function loadStockOverview(): Promise<StockOverview> {
  const supabase = await createServerSupabase();

  // Concurrent, because neither read depends on the other. Awaiting them in sequence would cost an
  // extra crossing for nothing — the lesson the Stage 10 Part A measurement recorded about
  // `getViewer` (plans/stage-10-catalogue-suppliers-inventory.md §0).
  const [locationRows, balanceRows, curingRows, movementRows] = await Promise.all([
    supabase.from("inventory_locations").select("code, sort_order").order("sort_order"),
    supabase
      .from("current_stock")
      .select("product_id, location_code, stock_state, quantity, last_movement_at")
      .eq("stock_state", "available"),
    // Read separately rather than filtered out of one query, so the two states arrive as two
    // answers. §8 keeps them apart and so does this. A failure here is a FAILED READ like any
    // other, never a quiet zero: `requireRows` throws and the page says the system could not be
    // reached, rather than reporting an empty curing shed on a yard full of bricks.
    supabase
      .from("current_stock")
      .select("product_id, location_code, stock_state, quantity, last_movement_at")
      .eq("stock_state", "curing")
      .gt("quantity", 0),
    supabase
      .from("inventory_ledger")
      // A no-substitution template literal, NOT a concatenation. supabase-js infers the row type
      // from the select string's literal type, and `"a" + "b"` widens to `string`, which collapses
      // every column to `GenericStringError`. supabase-js strips the whitespace before sending it.
      .select(`
        id, product_id, location_code, quantity_delta, movement_kind, source_type, source_id,
        occurred_at,
        actor:profiles!inventory_ledger_actor_id_fkey(full_name),
        approver:profiles!inventory_ledger_approved_by_fkey(full_name)
      `)
      // `entry_seq`, not `occurred_at`: movements written by one approval share a timestamp, and
      // the sequence is the only thing that says which came second.
      .order("entry_seq", { ascending: false })
      .limit(100),
  ]);

  const locations = requireRows(locationRows, "inventory.locations");
  const balances = requireRows(balanceRows, "inventory.current_stock");
  const curing = requireRows(curingRows, "inventory.curing_stock");
  const movements = requireRows(movementRows, "inventory.ledger");

  return {
    locations: locations.map((row) => ({
      code: row.code as string,
      sortOrder: Number(row.sort_order),
    })),
    balances: balances.map((row) => ({
      productId: row.product_id as string,
      locationCode: row.location_code as string,
      quantity: Number(row.quantity),
      lastMovementAt: (row.last_movement_at as string | null) ?? null,
    })),
    curing: curing.map((row) => ({
      productId: row.product_id as string,
      locationCode: row.location_code as string,
      quantity: Number(row.quantity),
      lastMovementAt: (row.last_movement_at as string | null) ?? null,
    })),
    recentMovements: movements.map((row) => ({
      id: row.id as string,
      productId: row.product_id as string,
      locationCode: row.location_code as string,
      quantityDelta: Number(row.quantity_delta),
      movementKind: row.movement_kind as string,
      sourceType: row.source_type as string,
      sourceId: row.source_id as string,
      actorName: nameOf(row.actor),
      approverName: nameOf(row.approver),
      occurredAt: row.occurred_at as string,
    })),
  };
}

/**
 * The three locations, and nothing else (product.md §7).
 *
 * Split out for the production batch form, which needs the list for one dropdown. Calling
 * `loadStockOverview` for it would read every current balance and a hundred ledger rows to fill
 * in a `<select>` with three options.
 */
export async function loadInventoryLocations(): Promise<InventoryLocation[]> {
  const supabase = await createServerSupabase();

  const rows = requireRows(
    await supabase.from("inventory_locations").select("code, sort_order").order("sort_order"),
    "inventory.locations",
  );

  return rows.map((row) => ({ code: row.code as string, sortOrder: Number(row.sort_order) }));
}

export async function loadSuppliers(): Promise<Supplier[]> {
  const supabase = await createServerSupabase();

  const rows = requireRows(
    await supabase.from("suppliers").select("id, name, is_active").order("name"),
    "inventory.suppliers",
  );

  return rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    isActive: row.is_active as boolean,
  }));
}

export async function loadReceipts(): Promise<StockReceipt[]> {
  const supabase = await createServerSupabase();

  const [receiptRows, lineRows] = await Promise.all([
    supabase
      .from("stock_receipts")
      .select(`
        id, supplier_id, location_code, delivery_note_ref, delivery_date, entered_role, entered_at,
        suppliers!inner(name),
        profiles!stock_receipts_entered_by_fkey(full_name)
      `)
      .order("entered_at", { ascending: false })
      .limit(200),
    supabase.from("stock_receipt_lines").select(`
        id, receipt_id, product_id, expected_quantity, received_quantity, damaged_quantity,
        short_quantity, excess_quantity, accepted_quantity, damage_note
      `),
  ]);

  const receipts = requireRows(receiptRows, "inventory.receipts");
  const lines = requireRows(lineRows, "inventory.receipt_lines");
  const [approvals, paidFrom] = await Promise.all([
    approvalsFor(supabase, "stock_receipt"),
    imprestLinksFor(receipts.map((row) => row.id as string)),
  ]);

  const linesByReceipt = new Map<string, ReceiptLine[]>();
  for (const row of lines) {
    const receiptId = row.receipt_id as string;
    const list = linesByReceipt.get(receiptId) ?? [];
    list.push({
      id: row.id as string,
      productId: row.product_id as string,
      expectedQuantity: Number(row.expected_quantity),
      receivedQuantity: Number(row.received_quantity),
      damagedQuantity: Number(row.damaged_quantity),
      shortQuantity: Number(row.short_quantity),
      excessQuantity: Number(row.excess_quantity),
      acceptedQuantity: Number(row.accepted_quantity),
      damageNote: (row.damage_note as string | null) ?? null,
    });
    linesByReceipt.set(receiptId, list);
  }

  return receipts.map((row) => {
    const supplier = row.suppliers as { name: string } | { name: string }[] | null;
    return {
      id: row.id as string,
      supplierId: row.supplier_id as string,
      supplierName:
        (Array.isArray(supplier) ? supplier[0]?.name : supplier?.name) ?? "",
      locationCode: row.location_code as string,
      deliveryNoteRef: row.delivery_note_ref as string,
      deliveryDate: row.delivery_date as string,
      enteredByName: nameOf(row.profiles),
      enteredRole: row.entered_role as AppRole,
      enteredAt: row.entered_at as string,
      // A receipt with no approval row would be a record nobody can decide on. It cannot happen —
      // the command writes both in one transaction — and defaulting to pending rather than throwing
      // keeps one impossible row from blanking the whole board.
      approval: approvals.get(row.id as string) ?? PENDING,
      lines: linesByReceipt.get(row.id as string) ?? [],
      paidFrom: paidFrom.get(row.id as string) ?? null,
    };
  });
}

type DisbursementSummaryRow = {
  id: string;
  disbursement_no: string;
  status: string;
  category: ImprestCategory;
  recipient: string | null;
  approved_tzs: number | string;
  handed_out_at: string | null;
};

function summaryOf(row: DisbursementSummaryRow): PaidFromDisbursement {
  return {
    id: row.id,
    disbursementNo: row.disbursement_no,
    status: row.status,
    category: row.category,
    recipient: row.recipient,
    approved: Number(row.approved_tzs),
    handedOutAt: row.handed_out_at,
  };
}

/**
 * The payment of each receipt, keyed by receipt, from `api.staff_stock_receipt_imprest_links`. The
 * database answers only for receipts the caller may read, so this adds nothing to what the board
 * already shows them. A failed read throws, like every other read of the board: a receipt must not
 * be shown as unpaid because the answer did not arrive.
 */
async function imprestLinksFor(receiptIds: string[]): Promise<Map<string, ReceiptImprestLink>> {
  const links = new Map<string, ReceiptImprestLink>();
  if (receiptIds.length === 0) return links;

  const api = await userApi();
  const rows = requireRows(
    (await api.rpc("staff_stock_receipt_imprest_links", { p_receipt_ids: receiptIds })) as {
      data:
        | {
            receipt_id: string;
            linked_by: string;
            linked_role: AppRole;
            linked_at: string;
            disbursement: DisbursementSummaryRow;
          }[]
        | null;
      error: { message: string } | null;
    },
    "inventory.receipt_imprest_links",
  );

  for (const row of rows) {
    links.set(row.receipt_id, {
      disbursement: summaryOf(row.disbursement),
      linkedBy: row.linked_by,
      linkedRole: row.linked_role,
      linkedAt: row.linked_at,
    });
  }
  return links;
}

/**
 * The payments a new receipt can be marked paid from (issue #73): the active fund's that were handed
 * out, settled, sent back or verified, newest hand-out first. The Manager is sent every one and a
 * Cashier their own; the database decides which.
 */
export async function loadImprestPaymentOptions(): Promise<PaidFromDisbursement[]> {
  const api = await userApi();
  const rows = requireRows(
    (await api.rpc("staff_imprest_receipt_payment_options")) as {
      data: DisbursementSummaryRow[] | null;
      error: { message: string } | null;
    },
    "inventory.imprest_payment_options",
  );
  return rows.map(summaryOf);
}

export async function loadTransfers(): Promise<StockTransfer[]> {
  const supabase = await createServerSupabase();

  const [transferRows, lineRows] = await Promise.all([
    supabase
      .from("stock_transfers")
      .select(`
        id, from_location, to_location, note, entered_at,
        profiles!stock_transfers_entered_by_fkey(full_name)
      `)
      .order("entered_at", { ascending: false })
      .limit(200),
    supabase.from("stock_transfer_lines").select("id, transfer_id, product_id, quantity"),
  ]);

  const transfers = requireRows(transferRows, "inventory.transfers");
  const lines = requireRows(lineRows, "inventory.transfer_lines");
  const approvals = await approvalsFor(supabase, "stock_transfer");

  const linesByTransfer = new Map<string, TransferLine[]>();
  for (const row of lines) {
    const transferId = row.transfer_id as string;
    const list = linesByTransfer.get(transferId) ?? [];
    list.push({
      id: row.id as string,
      productId: row.product_id as string,
      quantity: Number(row.quantity),
    });
    linesByTransfer.set(transferId, list);
  }

  return transfers.map((row) => ({
    id: row.id as string,
    fromLocation: row.from_location as string,
    toLocation: row.to_location as string,
    note: (row.note as string | null) ?? null,
    enteredByName: nameOf(row.profiles),
    enteredAt: row.entered_at as string,
    approval: approvals.get(row.id as string) ?? PENDING,
    lines: linesByTransfer.get(row.id as string) ?? [],
  }));
}

export async function loadAdjustments(): Promise<StockAdjustment[]> {
  const supabase = await createServerSupabase();

  const rows = requireRows(
    await supabase
      .from("stock_adjustments")
      .select(`
        id, product_id, location_code, quantity_delta, reason, entered_at,
        profiles!stock_adjustments_entered_by_fkey(full_name)
      `)
      .order("entered_at", { ascending: false })
      .limit(200),
    "inventory.adjustments",
  );

  const approvals = await approvalsFor(supabase, "stock_adjustment");

  return rows.map((row) => ({
    id: row.id as string,
    productId: row.product_id as string,
    locationCode: row.location_code as string,
    quantityDelta: Number(row.quantity_delta),
    reason: row.reason as string,
    enteredByName: nameOf(row.profiles),
    enteredAt: row.entered_at as string,
    approval: approvals.get(row.id as string) ?? PENDING,
  }));
}

export async function loadOpeningStockKeys(): Promise<Set<string>> {
  const supabase = await createServerSupabase();

  const rows = requireRows(
    await supabase.from("opening_stock_entries").select("product_id, location_code"),
    "inventory.opening_stock",
  );

  // "product:location" rather than a nested map: the only question the screen asks is whether this
  // pair has been entered, because opening stock is recorded once and never again.
  return new Set(rows.map((row) => `${row.product_id as string}:${row.location_code as string}`));
}
