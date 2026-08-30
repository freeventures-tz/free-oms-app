import { requireRows } from "@/lib/supabase/query";
import { createServerSupabase } from "@/lib/supabase/server";
import type { AppRole } from "@/lib/auth/roles";

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
  recentMovements: LedgerEntry[];
};

export async function loadStockOverview(): Promise<StockOverview> {
  const supabase = await createServerSupabase();

  // Concurrent, because neither read depends on the other. Awaiting them in sequence would cost an
  // extra crossing for nothing — the lesson the Stage 10 Part A measurement recorded about
  // `getViewer` (plans/stage-10-catalogue-suppliers-inventory.md §0).
  const [locationRows, balanceRows, movementRows] = await Promise.all([
    supabase.from("inventory_locations").select("code, sort_order").order("sort_order"),
    supabase
      .from("current_stock")
      .select("product_id, location_code, stock_state, quantity, last_movement_at")
      .eq("stock_state", "available"),
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
  const approvals = await approvalsFor(supabase, "stock_receipt");

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
    };
  });
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
