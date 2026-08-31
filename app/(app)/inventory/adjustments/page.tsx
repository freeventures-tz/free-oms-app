import { randomUUID } from "node:crypto";

import { getTranslations } from "next-intl/server";

import { AdjustmentBoard } from "@/app/(app)/inventory/adjustments/adjustment-board";
import { PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import { loadCatalogue } from "@/lib/catalogue/catalogue";
import { loadAdjustments, loadStockOverview } from "@/lib/inventory/inventory";

/**
 * Inventory › Stock corrections (product.md §4.1: "Manual stock adjustment, unexplained loss,
 * shortage correction — entered by a Manager, approved by a Director").
 *
 * This screen exists because an append-only ledger with no correction path is not a safe record but
 * a trap: the first miscounted opening stock would be permanent and every balance after it wrong.
 * The correction is itself a movement, with a reason, an enterer and a Director's approval, so
 * fixing a number leaves more history behind rather than less.
 *
 * The reason is required. Every other movement has a document behind it — a delivery note, a
 * transfer, an opening count. This one has only the explanation, so the explanation is not optional.
 */
export default async function AdjustmentsPage() {
  const viewer = await requireAccess("/inventory/adjustments");
  const t = await getTranslations("inventory.adjustments");

  const [adjustments, catalogue, overview] = await Promise.all([
    loadAdjustments(),
    loadCatalogue(),
    loadStockOverview(),
  ]);

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <AdjustmentBoard
        adjustments={adjustments}
        products={catalogue.products.filter((product) => product.isActive)}
        units={catalogue.units}
        locations={overview.locations}
        balances={overview.balances}
        canEnter={viewer.role === "manager"}
        canDecide={viewer.role === "director"}
        idempotencyKey={randomUUID()}
      />
    </>
  );
}
