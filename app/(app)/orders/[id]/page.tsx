import { randomUUID } from "node:crypto";

import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { OrderDetail } from "@/app/(app)/orders/[id]/order-detail";
import { PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import { loadCatalogue } from "@/lib/catalogue/catalogue";
import { loadAvailability, loadOrder } from "@/lib/sales/sales";

/**
 * One order: its quotation history, the decision it is waiting on, and — once the customer has
 * confirmed — its invoice (design.md §7A.1, §7A.2).
 *
 * The screen is careful about WHAT EXISTS WHEN (§7.6). Before confirmation there is an order number
 * and a proforma number and no invoice, and the page must not imply otherwise. After confirmation
 * the invoice is a first-class element and the proforma versions become history.
 */
export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAccess("/orders");
  const { id } = await params;
  const t = await getTranslations("sales.orders");

  const order = await loadOrder(id);

  // A genuine absence, not a failed read. `loadOrder` throws for the second, so this is safe to
  // treat as "there is no such order" rather than as "we could not find out".
  if (!order) notFound();

  // The catalogue and §8.1 availability are what the revision panel is built from: revising a
  // quotation picks products and sets quantities exactly as creating one does. They were read here
  // before anything used them, which is a round trip a reader cannot justify; now they are used.
  const [catalogue, availability] = await Promise.all([loadCatalogue(), loadAvailability()]);

  return (
    <>
      <PageHeader title={t("detailTitle", { no: order.orderNo })} description={order.customerName} />
      <OrderDetail
        order={order}
        products={catalogue.products}
        units={catalogue.units}
        availability={availability}
        role={viewer.role}
        idempotencyKey={randomUUID()}
      />
    </>
  );
}
