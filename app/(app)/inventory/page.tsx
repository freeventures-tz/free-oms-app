import { randomUUID } from "node:crypto";

import { getTranslations } from "next-intl/server";

import { StockBoard } from "@/app/(app)/inventory/stock-board";
import { PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import { loadCatalogue } from "@/lib/catalogue/catalogue";
import { loadOpeningStockKeys, loadStockOverview } from "@/lib/inventory/inventory";

/**
 * Inventory › Stock by location (design.md §5.1, §7.13).
 *
 * The screen answers the question the paper system could not: what is actually here. Every figure
 * on it is the sum of the append-only ledger, so the number and the history behind it are the same
 * fact and cannot drift apart.
 *
 * It is careful about WHICH number it is showing. product.md §8.1 defines available stock as
 * physical minus reserved and committed, and reserved and committed are created by orders, which
 * do not exist yet. So this shows PHYSICAL stock and says so, rather than labelling it "available"
 * and quietly changing what that word means when sales arrive.
 */
export default async function InventoryPage() {
  const viewer = await requireAccess("/inventory");
  const t = await getTranslations("inventory.stock");

  // Concurrent: none of the three depends on another, and on this deployment every serial round
  // trip crosses the Atlantic twice (reviews/pr-04-review-brief.md §2).
  const [overview, catalogue, openingStockKeys] = await Promise.all([
    loadStockOverview(),
    loadCatalogue(),
    loadOpeningStockKeys(),
  ]);

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <StockBoard
        locations={overview.locations}
        balances={overview.balances}
        movements={overview.recentMovements}
        products={catalogue.products}
        units={catalogue.units}
        openingStockKeys={[...openingStockKeys]}
        canRecordOpeningStock={viewer.role === "director"}
        idempotencyKey={randomUUID()}
      />
    </>
  );
}
