import { randomUUID } from "node:crypto";

import { getTranslations } from "next-intl/server";

import { ProductionBoard } from "@/app/(app)/production/production-board";
import { PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import { loadCatalogue } from "@/lib/catalogue/catalogue";
import { loadInventoryLocations } from "@/lib/inventory/inventory";
import {
  loadOpenCuringLots,
  loadProductionDrafts,
  loadProductionReference,
  loadSettledBatches,
} from "@/lib/production/production";
import { pageNumber } from "@/lib/settlement/settlement";
import { businessDateTimeLocal } from "@/lib/time/business-date";

/**
 * Production (design.md §7.16–§7.18, product.md §11).
 *
 * ONE ROLE WORKS THIS SCREEN. §4.1 gives batch entry, approval and inspection to the Manager and
 * names no alternate, so a Director reads it for oversight (design.md §4.2) and is offered no
 * control at all — not a greyed one. That is the same faithful-but-awkward reading receiving takes,
 * and for the same reason: inferring an alternate from seniority would be an invention.
 *
 * A Cashier and a Sales Representative do not work a mixer and cannot reach the route.
 *
 * THREE INDEPENDENT PAGERS, one per section. Drafts, curing lots and settled history are separate
 * reads with separate page numbers, so paging the history cannot move the queue a Manager is
 * working, and nothing that is waiting can be pushed off the end of the world by newer work.
 * `pageNumber` normalises anything that is not a positive integer to 1, and the loader falls back
 * to the real last page when the number is past the end.
 */
export default async function ProductionPage({ searchParams }: PageProps<"/production">) {
  const viewer = await requireAccess("/production");
  const t = await getTranslations("production");

  const params = await searchParams;
  const draftsPage = pageNumber(params.drafts);
  const curingPage = pageNumber(params.curing);
  const historyPage = pageNumber(params.history);

  const [drafts, curing, history, reference, locations, catalogue] = await Promise.all([
    loadProductionDrafts(draftsPage),
    loadOpenCuringLots(curingPage),
    loadSettledBatches(historyPage),
    loadProductionReference(),
    loadInventoryLocations(),
    loadCatalogue(),
  ]);

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <ProductionBoard
        drafts={drafts}
        curing={curing}
        history={history}
        recipe={reference.recipe}
        yields={reference.yields}
        locations={locations}
        units={catalogue.units}
        canRun={viewer.role === "manager"}
        idempotencyKey={randomUUID()}
        // The yard's wall clock, resolved on the server. §11.4 pre-fills the moulding time and
        // §15.3 makes the business day Tanzanian: a phone left on another zone would otherwise
        // offer a time three hours out and start a permanent curing clock in the wrong place.
        businessNow={businessDateTimeLocal()}
      />
    </>
  );
}
