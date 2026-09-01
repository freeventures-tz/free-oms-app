import { randomUUID } from "node:crypto";

import { getTranslations } from "next-intl/server";

import { PaymentQueue } from "@/app/(app)/payments/payment-queue";
import { PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import { loadOrders } from "@/lib/sales/sales";
import { loadSettlementQueue } from "@/lib/settlement/settlement";

/**
 * Payments (design.md §7.7), and the Cashier's landing view (§4.1).
 *
 * Work arrives as a queue to clear. The screen is built around two rules that are easy to get
 * subtly wrong and expensive when they are:
 *
 *   · The balance due is the most prominent figure (§7.7 hierarchy), because it is the number the
 *     Cashier reads out to the customer.
 *   · CREDIT SITS APART FROM THE SIX TENDERS and never presents itself as money received (§12.5).
 *     Choosing it changes the panel from "amount received" to "amount to be carried as credit,
 *     pending approval", and an invoice settled entirely on credit still reads Unpaid.
 */
export default async function PaymentsPage() {
  const viewer = await requireAccess("/payments");
  const t = await getTranslations("settlement.payments");

  const [invoices, orders] = await Promise.all([loadSettlementQueue(), loadOrders()]);

  // Walk-in orders that are confirmed and have no invoice: §12.4 says nothing exists for them until
  // payment, so they are not in the invoice queue and would otherwise be invisible to the Cashier
  // who has to take the money.
  const invoicedOrderIds = new Set(invoices.map((invoice) => invoice.orderId));
  const awaitingCashSale = orders.filter(
    (order) => order.isCashSale && order.status === "confirmed" && !invoicedOrderIds.has(order.id),
  );

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <PaymentQueue
        invoices={invoices}
        awaitingCashSale={awaitingCashSale}
        role={viewer.role}
        idempotencyKey={randomUUID()}
      />
    </>
  );
}
