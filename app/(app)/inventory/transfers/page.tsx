import { randomUUID } from "node:crypto";

import { getTranslations } from "next-intl/server";

import { TransferBoard } from "@/app/(app)/inventory/transfers/transfer-board";
import { PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import { loadCatalogue } from "@/lib/catalogue/catalogue";
import { loadStockOverview, loadTransfers } from "@/lib/inventory/inventory";

/**
 * Inventory › Internal transfers (design.md §7.15, product.md §10).
 *
 * §4.1 puts both entry and approval on the Manager, and §4.2 keeps them two separate acts: entering
 * a transfer moves nothing, and approving it is a deliberate second step. A Director reads the
 * board and is offered no control, because §4.1 names the Manager on both sides.
 *
 * The source balance is shown beside each product while the transfer is being built, so the limit
 * is visible before submission rather than discovered at approval (§7.15). It is still re-checked
 * at approval, which is the moment that decides anything — stock can move in between.
 */
export default async function TransfersPage() {
  const viewer = await requireAccess("/inventory/transfers");
  const t = await getTranslations("inventory.transfers");

  const [transfers, catalogue, overview] = await Promise.all([
    loadTransfers(),
    loadCatalogue(),
    loadStockOverview(),
  ]);

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <TransferBoard
        transfers={transfers}
        products={catalogue.products.filter((product) => product.isActive)}
        units={catalogue.units}
        locations={overview.locations}
        balances={overview.balances}
        canManage={viewer.role === "manager"}
        idempotencyKey={randomUUID()}
      />
    </>
  );
}
