"use server";

import { revalidatePath } from "next/cache";

import { addProduct, addUnit, setProductPrice, type Unit } from "@/lib/catalogue/catalogue";
import { requireRole } from "@/lib/auth/guard";
import { fieldErrors } from "@/lib/validation/auth";
import { addProductSchema, addUnitSchema, setPriceSchema } from "@/lib/validation/catalogue";

/**
 * Catalogue writes (product.md §4: Directors only, either Director independently).
 *
 * `requireRole` here produces the right SCREEN and refuses early. It is NOT what authorises the
 * change: `api.admin_add_product` and `api.admin_set_product_price` derive the acting Director from
 * the same session independently and take no actor, and the tables carry no INSERT grant for
 * `authenticated` at all. Neither layer is permitted to be the only one.
 */

const KNOWN_ERROR_KEYS = new Set([
  "not_permitted",
  "product_exists",
  "unknown_unit",
  "no_product",
  "price_unchanged",
  "price_required",
  "reason_required",
  "name_required",
  "idempotency_key_conflict",
  "unit_exists",
  "label_required",
]);

function errorKey(reason: string): string {
  return KNOWN_ERROR_KEYS.has(reason)
    ? `catalogueErrors.${reason}`
    : "catalogueErrors.generic";
}

export type CatalogueActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  successKey?: string;
  successName?: string;
};

export async function addProductAction(
  _previous: CatalogueActionState,
  formData: FormData,
): Promise<CatalogueActionState> {
  await requireRole(["director"]);

  const parsed = addProductSchema.safeParse({
    name: formData.get("name"),
    specification: formData.get("specification") ?? "",
    unitCode: formData.get("unitCode"),
    unitContent: formData.get("unitContent") ?? "",
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await addProduct({
    name: parsed.data.name,
    specification: parsed.data.specification,
    unitCode: parsed.data.unitCode,
    unitContent: parsed.data.unitContent,
    idempotencyKey: parsed.data.idempotencyKey,
  });

  if (!result.ok) return { error: errorKey(result.reason) };

  revalidatePath("/settings/products");
  // The order form offers this catalogue and quotes these prices, so a change here changes what a
  // Sales Representative can sell. Without this, a Director adds a product and it is missing from
  // Create New Order until the route cache happens to expire — which an E2E run found, and which
  // would have read in the yard as "the system has not got it yet".
  revalidatePath("/orders/new");
  return { successKey: "catalogue.add.added", successName: parsed.data.name };
}

export type AddUnitActionState = CatalogueActionState & {
  /** The unit that was created, so the form can select it without going back to the server. */
  unit?: Unit;
};

/**
 * Creating a counting unit (product.md §6.1 rule 5).
 *
 * `revalidatePath` is deliberately NOT called here. The Director is part-way through adding a
 * product, and revalidating would re-render the form underneath them and discard the name,
 * specification and content they have already typed. The new unit travels back in the result
 * instead, and the next add-product submission carries it to the server by code.
 */
export async function addUnitAction(
  _previous: AddUnitActionState,
  formData: FormData,
): Promise<AddUnitActionState> {
  await requireRole(["director"]);

  const parsed = addUnitSchema.safeParse({
    labelEn: formData.get("labelEn"),
    labelSw: formData.get("labelSw"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await addUnit({
    labelEn: parsed.data.labelEn,
    labelSw: parsed.data.labelSw,
    idempotencyKey: parsed.data.idempotencyKey,
  });

  if (!result.ok) return { error: errorKey(result.reason) };

  return { successKey: "catalogue.add.unitCreated", unit: result.unit };
}

export async function setPriceAction(
  _previous: CatalogueActionState,
  formData: FormData,
): Promise<CatalogueActionState> {
  await requireRole(["director"]);

  const parsed = setPriceSchema.safeParse({
    productId: formData.get("productId"),
    price: formData.get("price"),
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await setProductPrice({
    productId: parsed.data.productId,
    priceTzs: parsed.data.price,
    reason: parsed.data.reason,
    idempotencyKey: parsed.data.idempotencyKey,
  });

  if (!result.ok) return { error: errorKey(result.reason) };

  revalidatePath("/settings/products");
  revalidatePath("/orders/new");
  return { successKey: "catalogue.price.saved" };
}
