import { getTranslations } from "next-intl/server";

import { SupplierAdmin } from "@/app/(app)/settings/suppliers/supplier-admin";
import { PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import { loadSuppliers } from "@/lib/inventory/inventory";

/**
 * Settings › Suppliers.
 *
 * product.md §9 requires a receipt to identify its supplier and defines no supplier record beyond
 * that, so this screen holds a name and an on/off switch and nothing somebody guessed at. There is
 * no rename: a receipt references its supplier permanently, and changing what a past delivery says
 * it came from is the kind of quiet rewrite §16 forbids.
 *
 * WHO MAY REGISTER ONE IS A DERIVED DECISION, flagged for the owner in the stage plan.
 * product.md never says. Every other piece of reference data the catalogue rests on — products,
 * counting units, storekeeper records (§3.2) — is Director-only, so this is too.
 *
 * A Manager reads the list and is offered no control, absent rather than greyed (§4.3, §4.4).
 */
export default async function SuppliersPage() {
  const viewer = await requireAccess("/settings/suppliers");
  const t = await getTranslations("inventory.suppliers");

  const suppliers = await loadSuppliers();
  const canEdit = viewer.role === "director";

  return (
    <>
      <PageHeader
        title={t("title")}
        description={canEdit ? t("description") : t("descriptionManager")}
      />
      <SupplierAdmin suppliers={suppliers} canEdit={canEdit} />
    </>
  );
}
