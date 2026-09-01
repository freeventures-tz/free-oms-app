import { getTranslations } from "next-intl/server";

import { DispatchBoard } from "@/app/(app)/dispatch/dispatch-board";
import { PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import { loadCatalogue } from "@/lib/catalogue/catalogue";
import { loadStockOverview } from "@/lib/inventory/inventory";
import {
  loadDispatchQueue,
  loadStorekeeperOptions,
  pageNumber,
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
 *       (§12.6 step 14, AC-35), and the confirmation names that consequence first (§11.8).
 *
 * Confirm Release stays disabled, with its reason shown, until a dispatch-note number exists
 * (design.md §6.3, §4.4). That is a temporary state the Manager can resolve, which is exactly when
 * a control is disabled rather than hidden.
 *
 * An invoice stays in the assignment list while it still has goods to hand over, so a PARTIAL
 * release can be followed by a second assignment for the remainder. That list is its own counted,
 * paged read rather than an arithmetic over whatever the paid-but-unreleased page happens to hold:
 * the two answer different questions and each carries its own total.
 */
export default async function DispatchPage({ searchParams }: PageProps<"/dispatch">) {
  const viewer = await requireAccess("/dispatch");
  const t = await getTranslations("settlement.dispatch");

  const params = await searchParams;

  const [queue, storekeepers, catalogue, overview] = await Promise.all([
    loadDispatchQueue({
      released: pageNumber(params.released),
      unreleased: pageNumber(params.unreleased),
      assignment: pageNumber(params.assignment),
    }),
    // The assignment SHAPE, not the personnel record: this board is a client component, and a
    // storekeeper's phone number and start date have no business being serialised into a page
    // that renders a name and a code.
    loadStorekeeperOptions(),
    loadCatalogue(),
    loadStockOverview(),
  ]);

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <DispatchBoard
        queue={queue}
        storekeepers={storekeepers}
        products={catalogue.products}
        locations={overview.locations}
        role={viewer.role}
      />
    </>
  );
}
