import { useLocale, useTranslations } from "next-intl";

import { Card, StatusChip } from "@/components/ui/surface";
import type { DisbursementStockReceipt } from "@/lib/imprest/disbursements";
import { formatBusinessStamp } from "@/lib/time/business-date";

/**
 * The deliveries a payment paid for (issue #73, product.md §9.1 and §13.9).
 *
 * Each was marked Paid from imprest when it was entered on the receiving screen, so the purchase is
 * recorded once. Where each stands is the Manager's decision on the receipt: stock rose only for an
 * approved one, and nothing on this page moves stock or money.
 */
export function DisbursementStockReceipts({ receipts }: { receipts: DisbursementStockReceipt[] }) {
  const t = useTranslations();
  const locale = useLocale();

  return (
    <Card className="flex flex-col gap-3" data-testid="disbursement-stock-receipts">
      <h2 className="text-sm font-semibold">{t("imprest.spending.stockReceipts.heading")}</h2>
      {receipts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("imprest.spending.stockReceipts.none")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {receipts.map((receipt) => {
            const tone =
              receipt.approvalStatus === "approved"
                ? "success"
                : receipt.approvalStatus === "pending"
                  ? "attention"
                  : "danger";
            const status = ["approved", "pending", "rejected"].includes(receipt.approvalStatus)
              ? receipt.approvalStatus
              : "rejected";
            return (
              <li
                key={receipt.receiptId}
                className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 md:flex-row md:items-start md:justify-between"
                data-testid={`stock-receipt-${receipt.receiptId}`}
              >
                <div className="flex flex-col gap-1">
                  <p className="font-medium">
                    {receipt.supplier} · <span className="fv-identifier">{receipt.deliveryNoteRef}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t(`inventory.stock.locations.${receipt.locationCode}`)} · {receipt.deliveryDate}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("inventory.receiving.enteredBy", {
                      who: receipt.enteredBy,
                      role: t(`admin.roles.${receipt.enteredRole}`),
                    })}{" "}
                    · <time dateTime={receipt.linkedAt}>{formatBusinessStamp(receipt.linkedAt, locale)}</time>
                  </p>
                </div>
                <div className="shrink-0">
                  <StatusChip tone={tone}>{t(`inventory.status.${status}`)}</StatusChip>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
