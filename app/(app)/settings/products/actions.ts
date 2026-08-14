"use server";

import { revalidatePath } from "next/cache";

import { addProduct, setProductPrice } from "@/lib/catalogue/catalogue";
import { requireRole } from "@/lib/auth/guard";
import { fieldErrors } from "@/lib/validation/auth";
import { addProductSchema, setPriceSchema } from "@/lib/validation/catalogue";

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
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await addProduct({
    name: parsed.data.name,
    specification: parsed.data.specification,
    unitCode: parsed.data.unitCode,
    idempotencyKey: parsed.data.idempotencyKey,
  });

  if (!result.ok) return { error: errorKey(result.reason) };

  revalidatePath("/settings/products");
  return { successKey: "catalogue.add.added", successName: parsed.data.name };
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
  return { successKey: "catalogue.price.saved" };
}
