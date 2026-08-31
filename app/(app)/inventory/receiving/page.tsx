import { randomUUID } from "node:crypto";

import { getTranslations } from "next-intl/server";

import { ReceivingBoard } from "@/app/(app)/inventory/receiving/receiving-board";
import { PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import { loadCatalogue } from "@/lib/catalogue/catalogue";
import { loadReceipts, loadStockOverview, loadSuppliers } from "@/lib/inventory/inventory";
import { businessDate } from "@/lib/time/business-date";

/**
 * Inventory › Supplier receiving (design.md §7.14, product.md §9).
 *
 * Two roles do two different things on one screen, and the difference is authority rather than
 * layout:
 *
 *   ENTRY is delegable — a Manager, a Cashier or a Sales Representative may record what arrived
 *   (§9.1). Nothing they do moves stock.
 *
 *   APPROVAL is the Manager's, always (§4.1), and it is the moment stock increases. §4.2 makes it a
 *   separate act even when the same Manager entered the receipt.
 *
 * A Director sees the board and is offered no control on it at all — not a greyed one — because
 * §4.1 names three enterers and one approver, and a Director is none of them.
 */
export default async function ReceivingPage() {
  const viewer = await requireAccess("/inventory/receiving");
  const t = await getTranslations("inventory.receiving");

  const [receipts, suppliers, catalogue, overview] = await Promise.all([
    loadReceipts(),
    loadSuppliers(),
    loadCatalogue(),
    loadStockOverview(),
  ]);

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <ReceivingBoard
        receipts={receipts}
        suppliers={suppliers.filter((supplier) => supplier.isActive)}
        products={catalogue.products.filter((product) => product.isActive)}
        units={catalogue.units}
        locations={overview.locations}
        canEnter={
          viewer.role === "manager" || viewer.role === "cashier" || viewer.role === "sales_rep"
        }
        canApprove={viewer.role === "manager"}
        idempotencyKey={randomUUID()}
        // Today in Dar es Salaam, decided here rather than in the browser. Most deliveries are
        // recorded on the day they arrive, so this is the answer that is usually right — and when
        // it is not, the field is still an ordinary date input the person can change.
        today={businessDate()}
      />
    </>
  );
}
