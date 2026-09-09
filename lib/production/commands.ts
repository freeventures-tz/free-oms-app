import { refusalContext } from "@/lib/stock-refusal";
import { userApi } from "@/lib/supabase/api";
import { instantFromBusinessLocal } from "@/lib/time/business-date";

/**
 * Production commands (product.md §11, §4.1).
 *
 * Every one goes through the caller's OWN session. The `api` functions derive the acting person and
 * the roles they may hold from the verified JWT and take no actor, so there is no branch in this
 * file deciding whether somebody may approve a batch — the database decides, and a Cashier
 * reaching this code is refused by it.
 *
 * The secret key is not imported here. Nothing in this module spans two systems, so nothing needs
 * the one credential that could bypass row-level security.
 */

export type ProductionResult =
  | { ok: true; detail: string; data?: Record<string, unknown> }
  /** `context` carries the numbers a refusal needs to be actionable. */
  | { ok: false; reason: string; context?: Record<string, unknown> };

export type ProductionApi = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{
    data: Record<string, unknown> | null;
    error: { message: string } | null;
  }>;
};

function mapDatabaseError(message: string): string {
  if (/not a live Director|may not perform this command|authenticated session/i.test(message)) {
    return "not_permitted";
  }
  return "generic";
}

/**
 * The refusals only production makes, and the keys that carry them.
 *
 * The STOCK keys are not listed here: `available`, `requested`, `promised`, `physical` and
 * `location` come from `refusalContext`, which inventory reads from too, because they are the shape
 * of what the database sends back rather than anything this module decides. These six are the ones
 * only a batch or a lot can be refused on — "ready at 14:20 on Thursday" beats "still curing", and
 * a recipe's expected and confirmed counts explain an entry that does not add up.
 */
const PRODUCTION_CONTEXT_KEYS = [
  "curing",
  "offered",
  "ready_at",
  "status",
  "expected",
  "confirmed",
] as const;

/**
 * The one place a command result becomes a `ProductionResult`, so five callers cannot differ.
 *
 * A NULL BODY IS A FAILURE, NOT A SHAPE TO READ INTO. PostgREST answers a raised exception with an
 * error and no body, and a proxy or a dropped connection can produce a null body with no error at
 * all — and `'available' in null` is a TypeError, not a refusal. The Server Action would then throw
 * where it meant to return a message, the whole form would be replaced by the error boundary, and
 * everything the Manager had typed would be gone. So the body is narrowed to an object before
 * anything is read out of it, and anything else is the generic refusal, with the entered values
 * still on screen and the retry still holding the same request.
 */
async function issue(
  api: ProductionApi,
  fn: string,
  args: Record<string, unknown>,
  successFallback: string,
): Promise<ProductionResult> {
  const { data, error } = await api.rpc(fn, args);

  if (error) return { ok: false, reason: mapDatabaseError(error.message) };

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    console.error(`[production] ${fn} answered with ${data === null ? "null" : typeof data}`);
    return { ok: false, reason: "generic" };
  }

  const body = data as Record<string, unknown>;

  if (body.ok !== true) {
    return {
      ok: false,
      reason: typeof body.reason === "string" ? body.reason : "generic",
      // "There are 12 and you asked for 30" beats "not enough"; "eighty are promised to a customer"
      // beats both, because it is the only one that explains a refusal in a yard the Manager can
      // see is full.
      context: refusalContext(body, PRODUCTION_CONTEXT_KEYS),
    };
  }

  return {
    ok: true,
    detail: typeof body.reason === "string" ? body.reason : successFallback,
    data: body,
  };
}

async function resolve(issuedBy?: ProductionApi): Promise<ProductionApi> {
  return issuedBy ?? ((await userApi()) as unknown as ProductionApi);
}

export type BatchInput = { productId: string; actualQuantity: number };
export type BatchOutput = {
  productId: string;
  quantityMoulded: number;
  rejectedQuantity: number;
  rejectReason: string | null;
};

/**
 * Records a batch. Deducts nothing and produces nothing — §11.1 puts both behind the approval, and
 * AC-39 requires the actual usage to be recorded before a batch can be completed, which is why the
 * quantities are required here rather than defaulted later.
 */
export async function enterProductionBatch(
  input: {
    locationCode: string;
    mouldedAt: string;
    inputs: BatchInput[];
    outputs: BatchOutput[];
    yieldNote: string | null;
    idempotencyKey: string;
  },
  issuedBy?: ProductionApi,
): Promise<ProductionResult> {
  // The browser writes a wall-clock string with no zone in it. §15.3 makes the business clock
  // Africa/Dar_es_Salaam, so that is the zone the string is read in — NOT the server's, which is
  // UTC, and not the browser's, which is whatever the phone is set to. `new Date(value)` would use
  // one of those two and shift the curing clock by the difference.
  const mouldedAt = instantFromBusinessLocal(input.mouldedAt);
  if (mouldedAt === null) return { ok: false, reason: "moulded_at_invalid" };

  return issue(
    await resolve(issuedBy),
    "staff_enter_production_batch",
    {
      p_location_code: input.locationCode,
      p_moulded_at: mouldedAt.toISOString(),
      p_inputs: input.inputs.map((line) => ({
        product_id: line.productId,
        actual_quantity: line.actualQuantity,
      })),
      p_outputs: input.outputs.map((line) => ({
        product_id: line.productId,
        quantity_moulded: line.quantityMoulded,
        rejected_quantity: line.rejectedQuantity,
        reject_reason: line.rejectReason,
      })),
      p_yield_note: input.yieldNote,
      p_idempotency_key: input.idempotencyKey,
    },
    "entered",
  );
}

/** The Manager's approval, and the moment the yard is actually consumed (§11.1, AC-38). */
export async function approveProductionBatch(
  input: { batchId: string; idempotencyKey: string },
  issuedBy?: ProductionApi,
): Promise<ProductionResult> {
  return issue(
    await resolve(issuedBy),
    "staff_approve_production_batch",
    { p_batch_id: input.batchId, p_idempotency_key: input.idempotencyKey },
    "approved",
  );
}

/** A completed decision that is NOT an approval (§4.3). Consumes nothing, produces nothing. */
export async function rejectProductionBatch(
  input: { batchId: string; reason: string; idempotencyKey: string },
  issuedBy?: ProductionApi,
): Promise<ProductionResult> {
  return issue(
    await resolve(issuedBy),
    "staff_reject_production_batch",
    {
      p_batch_id: input.batchId,
      p_reason: input.reason,
      p_idempotency_key: input.idempotencyKey,
    },
    "rejected",
  );
}

/** The inspection, and the only way a brick becomes sellable (§11.4, AC-45). */
export async function inspectCuringLot(
  input: {
    lotId: string;
    acceptedQuantity: number;
    rejectedQuantity: number;
    rejectReason: string | null;
    idempotencyKey: string;
  },
  issuedBy?: ProductionApi,
): Promise<ProductionResult> {
  return issue(
    await resolve(issuedBy),
    "staff_inspect_curing_lot",
    {
      p_lot_id: input.lotId,
      p_accepted: input.acceptedQuantity,
      p_rejected: input.rejectedQuantity,
      p_reject_reason: input.rejectReason,
      p_idempotency_key: input.idempotencyKey,
    },
    "inspected",
  );
}
