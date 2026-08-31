"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, StatusChip } from "@/components/ui/surface";
import type { OrderSummary } from "@/lib/sales/sales";
import { formatTzs } from "@/lib/money";

/**
 * Orders as cards on every tier (design.md §3.5, §7.3).
 *
 * A table wins on a desktop and loses on the phone a Sales Representative actually carries, and an
 * order carries little enough — a number, a customer, a state, a total — that a card holds it at
 * every width.
 *
 * The state chip never relies on colour alone (§11.5): the word is always there, and `Confirmed`
 * and `Quotation` are as different in text as they are in tone.
 */
const STATUS_TONE: Record<string, "neutral" | "success" | "attention" | "danger"> = {
  proforma: "attention",
  confirmed: "success",
  cancelled: "danger",
};

export function OrderList({
  orders,
  canCreate,
}: {
  orders: OrderSummary[];
  canCreate: boolean;
}) {
  const t = useTranslations("sales.orders");
  const locale = useLocale();
  const [filter, setFilter] = useState<string>("all");

  const shown = filter === "all" ? orders : orders.filter((order) => order.status === filter);

  if (orders.length === 0) {
    return (
      <Card>
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
        {canCreate ? (
          <Button asChild className="mt-3">
            <Link href="/orders/new">{t("create")}</Link>
          </Button>
        ) : null}
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Status filter chips above the list (§7.3). They scroll inside their own container on a
          phone rather than pushing the page sideways (§3.5). */}
      <div className="-mx-1 overflow-x-auto px-1">
        <div role="tablist" aria-label={t("filterLabel")} className="flex gap-2">
          {["all", "proforma", "confirmed", "cancelled"].map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={value === filter}
              data-testid={`order-filter-${value}`}
              onClick={() => setFilter(value)}
              className={
                value === filter
                  ? "min-h-11 shrink-0 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground xl:min-h-10"
                  : "min-h-11 shrink-0 rounded-md border border-input bg-card px-4 text-sm font-medium xl:min-h-10"
              }
            >
              {t(`filters.${value}`)}
            </button>
          ))}
        </div>
      </div>

      <p className="text-sm text-muted-foreground">{t("count", { count: shown.length })}</p>

      {shown.length === 0 ? (
        <Card>
          <p className="text-sm text-muted-foreground">{t("noneInFilter")}</p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {shown.map((order) => (
            <Card key={order.id} role="article" aria-label={order.orderNo}>
              <Link
                href={`/orders/${order.id}`}
                className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between"
              >
                <div className="flex flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="fv-identifier font-medium">{order.orderNo}</span>
                    <StatusChip tone={STATUS_TONE[order.status] ?? "neutral"}>
                      {t(`status.${order.status}`)}
                    </StatusChip>
                    {/* A walk-in sale behaves differently at every later step (§12.4), so it is
                        marked from the list rather than discovered on the detail screen. */}
                    {order.isCashSale ? (
                      <StatusChip tone="neutral">{t("cashSale")}</StatusChip>
                    ) : null}
                  </span>
                  <span className="text-sm text-muted-foreground">{order.customerName}</span>
                  {order.invoiceNo ? (
                    <span className="fv-identifier text-xs text-muted-foreground">
                      {t("invoiceNo", { no: order.invoiceNo })}
                    </span>
                  ) : null}
                </div>

                <span className="fv-numeric text-lg font-semibold">
                  {formatTzs(order.totalTzs, locale)}
                </span>
              </Link>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
