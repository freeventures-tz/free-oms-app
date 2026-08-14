import { randomUUID } from "node:crypto";

import { getTranslations } from "next-intl/server";

import { AddProductForm } from "@/app/(app)/settings/products/add-product-form";
import { ProductList } from "@/app/(app)/settings/products/product-list";
import { PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import { loadCatalogue } from "@/lib/catalogue/catalogue";

/**
 * Settings › Products & prices (design.md §5.1, §7.13).
 *
 * A Manager reaches this screen and a Director reaches this screen. What differs is not the data —
 * both see every product and every price — but the CONTROLS: a Manager has none, and they are
 * absent rather than greyed out, because a disabled button with a tooltip leaks the authority
 * structure (§4.3, §4.4).
 *
 * `canEdit` is a rendering decision only. It is not the boundary, and it is written on the
 * assumption that one day someone will reach a control it hid: the Server Actions re-derive the
 * role, `api.admin_*` derives the acting Director from the verified session, and the tables carry
 * no write grant for `authenticated`. Three refusals stand behind this one `if`.
 */
export default async function ProductsPage() {
  const viewer = await requireAccess("/settings/products");
  const t = await getTranslations("catalogue");

  const { products, units, history } = await loadCatalogue();
  const canEdit = viewer.role === "director";

  return (
    <>
      <PageHeader
        title={t("title")}
        description={canEdit ? t("description") : t("descriptionManager")}
      />

      {/* Hidden from a Manager, not disabled. */}
      {canEdit ? <AddProductForm units={units} idempotencyKey={randomUUID()} /> : null}

      <ProductList products={products} history={history} canEdit={canEdit} />
    </>
  );
}
