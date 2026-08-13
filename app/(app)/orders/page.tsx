import { getTranslations } from "next-intl/server";

import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";

/**
 * Sales Representative landing (design.md §4.1): the orders list, with Create New Order prominent.
 *
 * An honest module shell. Order entry belongs to the sales module and is not built — nothing here
 * pretends otherwise, and no order, stock or money behaviour is implied by its presence.
 */
export default async function OrdersPage() {
  const viewer = await requireAccess("/orders");
  const t = await getTranslations("landing");

  return (
    <>
      <PageHeader
        title={t("orders.title")}
        description={t("orders.description")}
        action={
          viewer.role === "sales_rep" || viewer.role === "manager" || viewer.role === "director" ? (
            <Button disabled>{t("orders.primaryAction")}</Button>
          ) : undefined
        }
      />
      <Card>
        <p className="text-sm text-muted-foreground">{t("orders.empty")}</p>
        <p className="mt-2 text-sm">{t("comingSoon")}</p>
      </Card>
    </>
  );
}
