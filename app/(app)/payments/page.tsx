import { getTranslations } from "next-intl/server";

import { PaymentQueue } from "@/app/(app)/payments/payment-queue";
import { PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import {
  loadCashSalesAwaitingPayment,
  loadSettlementQueue,
  pageNumber,
} from "@/lib/settlement/settlement";

/**
 * Payments (design.md §7.7), and the Cashier's landing view (§4.1).
 *
 * Work arrives as a queue to clear. The screen is built around three rules that are easy to get
 * subtly wrong and expensive when they are:
 *
 *   · The balance due is the most prominent figure (§7.7 hierarchy), because it is the number the
 *     Cashier reads out to the customer.
 *   · CREDIT SITS APART FROM THE SIX TENDERS and never presents itself as money received (§12.5).
 *     Choosing it changes the panel from "amount received" to "amount to be carried as credit,
 *     pending approval", and an invoice settled entirely on credit still reads Unpaid.
 *   · THE QUEUE IS PAGED, and says how much of it is off screen. An unsettled invoice from three
 *     weeks ago is exactly the record this screen exists to surface, and it is the first thing a
 *     silent row limit loses.
 */
export default async function PaymentsPage({ searchParams }: PageProps<"/payments">) {
  const viewer = await requireAccess("/payments");
  const t = await getTranslations("settlement.payments");

  // Every page parameter is normalised here and again in the loader: `pageNumber` turns anything
  // that is not a positive integer into 1, and `pagedQuery` falls back to the real last page when
  // the number is past the end. A hand-edited `?awaiting=999` therefore shows the last page of
  // work rather than an empty queue over the top of it.
  const params = await searchParams;
  const awaitingPage = pageNumber(params.awaiting);
  const settledPage = pageNumber(params.settled);
  const cashPage = pageNumber(params.cash);

  const [queue, awaitingCashSale] = await Promise.all([
    loadSettlementQueue({ awaiting: awaitingPage, settled: settledPage }),
    loadCashSalesAwaitingPayment(cashPage),
  ]);

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <PaymentQueue
        queue={queue}
        awaitingCashSale={awaitingCashSale}
        role={viewer.role}
      />
    </>
  );
}
