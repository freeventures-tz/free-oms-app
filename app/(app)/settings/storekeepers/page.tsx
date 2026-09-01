import { getTranslations } from "next-intl/server";

import { StorekeeperAdmin } from "@/app/(app)/settings/storekeepers/storekeeper-admin";
import { PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import { loadStorekeepers } from "@/lib/settlement/settlement";

/**
 * Settings › Storekeeper records (product.md §3.2, design.md §4.2).
 *
 * Storekeepers participate in operations and are NOT users: no login, no permissions, no role. The
 * record exists so a Cashier can assign one to a dispatch by name, and §3.2 lists exactly what it
 * holds — a generated code, a name, an optional phone, an active state, a start date, a
 * deactivation date when deactivated, and an optional note. That list is the whole screen.
 *
 * A Director registers them; a Manager reads the list and is offered no control, absent rather than
 * greyed (§4.3, §4.4).
 */
export default async function StorekeepersPage() {
  const viewer = await requireAccess("/settings/storekeepers");
  const t = await getTranslations("settlement.storekeepers");

  const storekeepers = await loadStorekeepers();

  return (
    <>
      <PageHeader
        title={t("title")}
        description={viewer.role === "director" ? t("description") : t("descriptionManager")}
      />
      <StorekeeperAdmin storekeepers={storekeepers} canEdit={viewer.role === "director"} />
    </>
  );
}
