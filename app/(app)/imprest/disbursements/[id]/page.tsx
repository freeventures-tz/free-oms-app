import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { DisbursementActions } from "@/app/(app)/imprest/disbursement-forms";
import { DisbursementStatusChip } from "@/app/(app)/imprest/spending";
import { Card, PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import { loadDisbursement } from "@/lib/imprest/disbursements";
import { openFor } from "@/lib/imprest/spending";
import { formatTzs } from "@/lib/money";
import { formatBusinessStamp } from "@/lib/time/business-date";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One disbursement and its history (product.md §13.3, issue #55).
 *
 * A Cashier can read only their own, so another Cashier's disbursement is simply not found. A
 * cancelled one keeps its approval in the history beside the cancellation (AC-101), and a rejected
 * one names who decided and why, and no approver (§4.3).
 */
export default async function DisbursementPage({ params }: PageProps<"/imprest/disbursements/[id]">) {
  const viewer = await requireAccess("/imprest");
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const disbursement = await loadDisbursement(id);
  if (!disbursement) notFound();

  const t = await getTranslations("imprest.spending");
  const roles = await getTranslations("admin.roles");
  const locale = await getLocale();
  const isOwn = disbursement.proposedById === viewer.userId;

  let age: string | null = null;
  if (disbursement.status === "approved" && disbursement.approvedAt) {
    const { unit, count } = openFor(disbursement.approvedAt);
    age = t(unit === "days" ? "lists.openDays" : unit === "hours" ? "lists.openHours" : "lists.openMinutes", {
      count,
    });
  }

  return (
    <>
      <PageHeader
        title={disbursement.disbursementNo}
        description={disbursement.purpose}
        action={<DisbursementStatusChip status={disbursement.status} />}
      />

      <Link href="/imprest" className="text-sm underline underline-offset-4">
        {t("detail.back")}
      </Link>

      <Card>
        <dl className="grid grid-cols-1 gap-4 md:grid-cols-3" data-testid="disbursement-figures">
          <div className="flex flex-col gap-1">
            <dt className="text-xs text-muted-foreground">{t("detail.amount")}</dt>
            <dd className="fv-numeric font-semibold">{formatTzs(disbursement.amount, locale)}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-xs text-muted-foreground">{t("detail.category")}</dt>
            <dd className="font-semibold">{t(`category.${disbursement.category}`)}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-xs text-muted-foreground">{t("detail.proposedBy")}</dt>
            <dd className="font-semibold">{disbursement.proposedBy}</dd>
          </div>
        </dl>
        {age ? (
          <p className="mt-4 text-sm" data-testid="open-for">
            {age}
          </p>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-3">
        <DisbursementActions
          disbursement={{
            id: disbursement.id,
            version: disbursement.version,
            status: disbursement.status,
            amount: disbursement.amount,
          }}
          role={viewer.role}
          isOwn={isOwn}
        />
        {disbursement.status === "proposed" && viewer.role === "cashier" ? (
          <p className="text-sm text-muted-foreground">{t("detail.waitingManager")}</p>
        ) : null}
        {viewer.role === "director" ? (
          <p className="text-sm text-muted-foreground" data-testid="read-only">
            {t("detail.readOnly")}
          </p>
        ) : null}
      </Card>

      <section className="flex flex-col gap-3" aria-labelledby="history-heading">
        <h2 id="history-heading" className="text-lg font-semibold">
          {(await getTranslations("imprest"))("history.title")}
        </h2>
        <ol className="flex flex-col gap-2" data-testid="disbursement-history">
          {disbursement.events.map((event) => (
            <li key={event.kind}>
              <Card className="flex flex-col gap-1">
                <span className="font-medium">{t(`history.${event.kind}`)}</span>
                <span className="text-sm text-muted-foreground">
                  {/* A Cashier may not read the Manager's profile, so they see the role instead. */}
                  {event.by || roles(event.role)} · {formatBusinessStamp(event.at, locale)}
                </span>
                {event.text ? <span className="text-sm">{event.text}</span> : null}
              </Card>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
