import { userApi } from "@/lib/supabase/api";
import { requireRows } from "@/lib/supabase/query";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * The product catalogue and its selling prices (product.md §6, §4, §4.4).
 *
 * READS go through the caller's own session under RLS, like every other list in this application:
 * if the policies were ever wrong the screen would show less, not more.
 *
 * WRITES go through `api.admin_*`, which derive the acting Director from the verified session and
 * take no actor. There is no server-side branch anywhere that decides whether the caller is allowed
 * to set a price — the database decides, and a Manager calling this function is refused by it.
 * The secret key is not imported here at all: nothing in this slice spans two systems, so nothing
 * needs it.
 */

export type Unit = { code: string; sortOrder: number };

export type CatalogueProduct = {
  id: string;
  name: string;
  specification: string | null;
  unitCode: string;
  isActive: boolean;
  /** `null` is a real state — no Director has approved a price — and never a zero. */
  priceTzs: number | null;
  priceSetAt: string | null;
};

export type PriceHistoryEntry = {
  id: string;
  priceTzs: number;
  previousPriceTzs: number | null;
  reason: string;
  setByName: string;
  effectiveAt: string;
};

export type CatalogueResult = { ok: true; detail: string } | { ok: false; reason: string };

/**
 * Everything the Products & prices screen renders, in two concurrent round trips.
 *
 * Concurrent because neither read depends on the other — the same lesson the Stage 10 Part A
 * measurement recorded about `getViewer`: a chain that waits on itself costs a whole round trip
 * for nothing, and on this deployment a round trip is not cheap.
 */
export type Catalogue = {
  products: CatalogueProduct[];
  units: Unit[];
  /** Immutable price history per product, newest first (product.md §4.4). */
  history: Record<string, PriceHistoryEntry[]>;
};

export async function loadCatalogue(): Promise<Catalogue> {
  const supabase = await createServerSupabase();

  // Three reads, ONE round trip's worth of waiting. None of them depends on another, and awaiting
  // them in sequence would cost two extra crossings for nothing — the lesson the Stage 10 Part A
  // measurement recorded about `getViewer`.
  //
  // History is fetched whole rather than per product on expand. Twenty-one products changing price
  // a handful of times a year is a small table for a long time, and one query beats twenty-one
  // round trips triggered by curiosity. When it stops being small, paginate it — but measure first.
  const [productRows, unitRows, priceRows, historyRows] = await Promise.all([
    supabase
      .from("products")
      .select("id, name, specification, unit_code, is_active")
      .order("name")
      .order("specification", { nullsFirst: true }),
    supabase.from("units").select("code, sort_order").order("sort_order"),
    supabase.from("product_current_prices").select("product_id, price_tzs, effective_at"),
    supabase
      .from("product_prices")
      .select(
        "id, product_id, price_tzs, previous_price_tzs, reason, effective_at, profiles!inner(full_name)",
      )
      // `entry_seq`, not `effective_at`: two entries written in one transaction share a timestamp,
      // and the sequence is the only thing that says which came second.
      .order("entry_seq", { ascending: false }),
  ]);

  // A failed read is not an empty catalogue. Showing "No products yet" during an outage would tell
  // a Director something false about their own business (lib/supabase/query.ts).
  const products = requireRows(productRows, "catalogue.products");
  const units = requireRows(unitRows, "catalogue.units");
  const prices = requireRows(priceRows, "catalogue.current_prices");
  const history = requireRows(historyRows, "catalogue.price_history");

  const priceByProduct = new Map(
    prices.map((row) => [
      row.product_id as string,
      { priceTzs: Number(row.price_tzs), effectiveAt: row.effective_at as string },
    ]),
  );

  const historyByProduct: Record<string, PriceHistoryEntry[]> = {};
  for (const row of history) {
    // The Director's name is joined from `profiles` rather than copied onto the price row, so
    // someone who later corrects the spelling of their name does not leave two of themselves in
    // the record.
    const profile = row.profiles as { full_name: string } | { full_name: string }[] | null;
    const setByName = (Array.isArray(profile) ? profile[0]?.full_name : profile?.full_name) ?? "";
    const productId = row.product_id as string;

    (historyByProduct[productId] ??= []).push({
      id: row.id as string,
      priceTzs: Number(row.price_tzs),
      previousPriceTzs: row.previous_price_tzs === null ? null : Number(row.previous_price_tzs),
      reason: row.reason as string,
      setByName,
      effectiveAt: row.effective_at as string,
    });
  }

  return {
    history: historyByProduct,
    units: units.map((row) => ({ code: row.code as string, sortOrder: row.sort_order as number })),
    products: products.map((row) => {
      const current = priceByProduct.get(row.id as string);
      return {
        id: row.id as string,
        name: row.name as string,
        specification: (row.specification as string | null) ?? null,
        unitCode: row.unit_code as string,
        isActive: row.is_active as boolean,
        priceTzs: current?.priceTzs ?? null,
        priceSetAt: current?.effectiveAt ?? null,
      };
    }),
  };
}

/** A caller acting under a Director's own session. Injectable so tests drive the real function. */
export type CatalogueApi = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{
    data: Record<string, unknown> | null;
    error: { message: string } | null;
  }>;
};

function reasonOf(data: { reason?: unknown } | null, fallback: string): string {
  return String(data?.reason ?? fallback);
}

/**
 * The database raises for authority failures. A Manager reaching this — by a stale page, a crafted
 * request, or a role changed a minute ago — arrives here and is refused there, not by a branch in
 * this file.
 */
function mapDatabaseError(message: string): string {
  if (/not a live Director|authenticated session/i.test(message)) return "not_permitted";
  return "generic";
}

export async function addProduct(
  input: { name: string; specification: string | null; unitCode: string; idempotencyKey: string },
  issuedBy?: CatalogueApi,
): Promise<CatalogueResult> {
  const api = issuedBy ?? ((await userApi()) as unknown as CatalogueApi);

  const { data, error } = await api.rpc("admin_add_product", {
    p_name: input.name,
    p_specification: input.specification,
    p_unit_code: input.unitCode,
    p_idempotency_key: input.idempotencyKey,
  });

  if (error) return { ok: false, reason: mapDatabaseError(error.message) };
  if (!data?.ok) return { ok: false, reason: reasonOf(data, "generic") };
  return { ok: true, detail: reasonOf(data, "added") };
}

export async function setProductPrice(
  input: { productId: string; priceTzs: number; reason: string; idempotencyKey: string },
  issuedBy?: CatalogueApi,
): Promise<CatalogueResult> {
  const api = issuedBy ?? ((await userApi()) as unknown as CatalogueApi);

  const { data, error } = await api.rpc("admin_set_product_price", {
    p_product_id: input.productId,
    p_price_tzs: input.priceTzs,
    p_reason: input.reason,
    p_idempotency_key: input.idempotencyKey,
  });

  if (error) return { ok: false, reason: mapDatabaseError(error.message) };
  if (!data?.ok) return { ok: false, reason: reasonOf(data, "generic") };
  return { ok: true, detail: reasonOf(data, "set") };
}
