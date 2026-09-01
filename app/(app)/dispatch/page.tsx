import { randomUUID } from "node:crypto";

import { getTranslations } from "next-intl/server";

import { DispatchBoard } from "@/app/(app)/dispatch/dispatch-board";
import { PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import { loadCatalogue } from "@/lib/catalogue/catalogue";
import { loadStockOverview } from "@/lib/inventory/inventory";
import {
  loadDispatchQueue,
  loadSettlementQueue,
  loadStorekeepers,
} from "@/lib/settlement/settlement";

/**
 * Dispatch queue (design.md §7.9, product.md §12.6 steps 9–14, §14).
 *
 * Three steps, three roles, and each one unlocks the next:
 *
 *   9.  The Cashier assigns a registered storekeeper. STOCK HAS NOT MOVED, and the screen says so.
 *   11. The Manager types in the number from the four-copy carbon book. Still nothing has moved —
 *       the OMS does not produce the note (§14, AC-37).
 *   13. The customer signs the paper and the Manager confirms it here. ONLY THEN does stock leave
 *       (§12.6 step 14, AC-35).
 *
 * Confirm Release stays disabled, with its reason shown, until a dispatch-note number exists
 * (design.md §6.3, §4.4). That is a temporary state the Manager can resolve, which is exactly when
 * a control is disabled rather than hidden.
 */
export default async function DispatchPage() {
  const viewer = await requireAccess("/dispatch");
  const t = await getTranslations("settlement.dispatch");

  const [queue, storekeepers, invoices, catalogue, overview] = await Promise.all([
    loadDispatchQueue(),
    loadStorekeepers(),
    loadSettlementQueue(),
    loadCatalogue(),
    loadStockOverview(),
  ]);

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <DispatchBoard
        dispatches={queue.dispatches}
        outstanding={queue.outstanding}
        storekeepers={storekeepers.filter((keeper) => keeper.isActive)}
        invoices={invoices.filter(
          (invoice) => invoice.settlement.releasable && invoice.cancelledAt === null,
        )}
        products={catalogue.products}
        locations={overview.locations}
        role={viewer.role}
        idempotencyKey={randomUUID()}
      />
    </>
  );
}
