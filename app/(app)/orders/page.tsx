import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { OrderList } from "@/app/(app)/orders/order-list";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import { loadOrders } from "@/lib/sales/sales";

/**
 * Orders list (design.md §7.3), and the Sales Representative's landing view (§4.1).
 *
 * Create New Order is offered to the three roles §12.6 step 1 and design.md §4.2 name; a Cashier
 * reads the list and is offered no way to start one, absent rather than greyed (§4.3, §4.4).
 */
export default async function OrdersPage() {
  const viewer = await requireAccess("/orders");
  const t = await getTranslations("sales.orders");

  const orders = await loadOrders();
  const canCreate =
    viewer.role === "sales_rep" || viewer.role === "manager" || viewer.role === "director";

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("description")}
        action={
          canCreate ? (
            <Button asChild>
              <Link href="/orders/new">{t("create")}</Link>
            </Button>
          ) : undefined
        }
      />
      <OrderList orders={orders} canCreate={canCreate} />
    </>
  );
}
