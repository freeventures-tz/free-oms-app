import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { DisbursementActions } from "@/app/(app)/imprest/disbursement-forms";
import { CashierStep, ReceiptView } from "@/app/(app)/imprest/settlement-forms";
import { DisbursementFlags, DisbursementStatusChip } from "@/app/(app)/imprest/spending";
import { Card, PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import { loadDisbursement, type DisbursementDetail } from "@/lib/imprest/disbursements";
import { openFor } from "@/lib/imprest/spending";
import { formatTzs } from "@/lib/money";
import { formatBusinessStamp } from "@/lib/time/business-date";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One disbursement and its history (product.md §13.3, issues #55 and #62).
 *
 * A Cashier can read only their own, so another Cashier's disbursement is simply not found. Once
 * settled, it always shows its breakdown: Approved, Used, Returned and, when above zero, Not
 * accounted for, with every line and its receipt or No-receipt reason (criterion 8).
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
  const cashierDue = viewer.role === "cashier" && isOwn;

  let age: string | null = null;
  if (disbursement.status === "approved" && disbursement.approvedAt) {
    const { unit, count } = openFor(disbursement.approvedAt);
    age = t(unit === "days" ? "lists.openDays" : unit === "hours" ? "lists.openHours" : "lists.openMinutes", {
      count,
    });
  }

  const target = { id: disbursement.id, version: disbursement.version };

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

      <Card className="flex flex-col gap-4">
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
          {disbursement.recipient && disbursement.handedOutAt ? (
            <div className="flex flex-col gap-1" data-testid="recipient">
              <dt className="text-xs text-muted-foreground">{t("detail.recipient")}</dt>
              <dd className="font-semibold">
                {disbursement.recipient}
                <span className="block text-xs font-normal text-muted-foreground">
                  {t("detail.handedOutAt", { at: formatBusinessStamp(disbursement.handedOutAt, locale) })}
                </span>
              </dd>
            </div>
          ) : null}
        </dl>
        <DisbursementFlags flags={disbursement.flags} />
        {age ? (
          <p className="text-sm" data-testid="open-for">
            {age}
          </p>
        ) : null}
      </Card>

      {disbursement.settlement ? <Breakdown disbursement={disbursement} /> : null}

      {/* Hidden when this viewer has nothing to do here and no answer to show (a Cashier's decided row). */}
      <Card className="flex flex-col gap-3 empty:hidden" data-testid="disbursement-actions">
        <DisbursementActions
          disbursement={{
            id: disbursement.id,
            version: disbursement.version,
            status: disbursement.status,
            amount: disbursement.amount,
          }}
          role={viewer.role}
          isOwn={isOwn}
          settlement={
            disbursement.status === "settled" && disbursement.settlement
              ? {
                  id: disbursement.settlement.id,
                  used: disbursement.settlement.used,
                  returned: disbursement.settlement.returned,
                  unaccounted: disbursement.settlement.unaccounted,
                }
              : null
          }
        />
        {disbursement.status === "proposed" && viewer.role === "cashier" ? (
          <p className="text-sm text-muted-foreground">{t("detail.waitingManager")}</p>
        ) : null}
        {disbursement.status === "handed_out" && viewer.role !== "cashier" ? (
          <p className="text-sm text-muted-foreground" data-testid="handed-out-note">
            {t("detail.handedOutNote")}
          </p>
        ) : null}
        {disbursement.status === "settled" && viewer.role === "director" ? (
          <p className="text-sm text-muted-foreground" data-testid="verify-by-manager">
            {t("lists.settledNoteDirector")}
          </p>
        ) : null}
        {disbursement.status === "settled" && cashierDue ? (
          <p className="text-sm text-muted-foreground" data-testid="waiting-verification">
            {t("detail.waitingVerification")}
          </p>
        ) : null}
        {disbursement.status === "verified" ? (
          <p className="text-sm text-muted-foreground" data-testid="verified-note">
            {t("detail.verifiedNote")}
          </p>
        ) : null}
        {viewer.role === "director" ? (
          <p className="text-sm text-muted-foreground" data-testid="read-only">
            {t("detail.readOnly")}
          </p>
        ) : null}
      </Card>

      {/* Always in this place for the proposing Cashier, so its confirmation outlives the step. */}
      {cashierDue ? (
        <CashierStep status={disbursement.status} disbursement={target} amount={disbursement.amount} />
      ) : null}

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

/**
 * What the Manager's verification posted (issue #64): the imprest expense and, when there was a
 * remainder, the unexplained loss that waits for a Director. Both are final; there is no control.
 */
async function Postings({ disbursement }: { disbursement: DisbursementDetail }) {
  const t = await getTranslations("imprest.spending");
  const roles = await getTranslations("admin.roles");
  const locale = await getLocale();
  const verification = disbursement.verification!;
  const verifiedBy = disbursement.events.find((event) => event.kind === "verified")?.by || roles("manager");

  return (
    <section className="flex flex-col gap-3 border-t border-border pt-3" data-testid="postings">
      <h3 className="font-semibold">{t("posted.title")}</h3>
      <dl className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1" data-testid="posting-expense">
          <dt className="text-xs text-muted-foreground">{t("posted.expense")}</dt>
          <dd className="fv-numeric font-semibold">{formatTzs(verification.expense, locale)}</dd>
        </div>
        {verification.loss !== null ? (
          <div className="flex flex-col gap-1" data-testid="posting-loss">
            <dt className="text-xs text-muted-foreground">{t("posted.loss")}</dt>
            <dd className="fv-numeric font-semibold text-danger">{formatTzs(verification.loss, locale)}</dd>
            <dd className="text-xs text-muted-foreground">{t("posted.lossNote")}</dd>
          </div>
        ) : null}
      </dl>
      <p className="text-sm text-muted-foreground" data-testid="verified-by">
        {t("posted.verifiedBy", { name: verifiedBy, at: formatBusinessStamp(verification.verifiedAt, locale) })}
      </p>
    </section>
  );
}

/** Approved = Used + Returned + Not accounted for, and every line behind Used. */
async function Breakdown({ disbursement }: { disbursement: DisbursementDetail }) {
  const t = await getTranslations("imprest.spending");
  const locale = await getLocale();
  const settlement = disbursement.settlement!;
  const figures = [
    { key: "approved", value: disbursement.amount },
    { key: "used", value: settlement.used },
    { key: "returned", value: settlement.returned },
    ...(settlement.unaccounted > 0 ? [{ key: "notAccounted", value: settlement.unaccounted }] : []),
  ];

  return (
    <Card className="flex flex-col gap-4" data-testid="settlement-breakdown">
      <h2 className="text-lg font-semibold">{t("breakdown.title")}</h2>
      <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {figures.map((f) => (
          <div key={f.key} className="flex flex-col gap-1" data-testid={`breakdown-${f.key}`}>
            <dt className="text-xs text-muted-foreground">{t(`breakdown.${f.key}`)}</dt>
            <dd className={`fv-numeric font-semibold ${f.key === "notAccounted" ? "text-danger" : ""}`}>
              {formatTzs(f.value, locale)}
            </dd>
          </div>
        ))}
      </dl>
      {settlement.explanation ? (
        <p className="text-sm" data-testid="unaccounted-explanation">
          <span className="font-medium">{t("breakdown.explanation")}</span> {settlement.explanation}
        </p>
      ) : null}

      {disbursement.verification ? <Postings disbursement={disbursement} /> : null}

      {disbursement.lines.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="no-lines">
          {t("breakdown.noLines")}
        </p>
      ) : (
        <ol className="flex flex-col gap-3" data-testid="settlement-lines">
          {disbursement.lines.map((line) => (
            <li
              key={line.lineNo}
              className="flex flex-col gap-2 border-t border-border pt-3 md:flex-row md:items-start md:justify-between"
              data-testid={`line-${line.lineNo}`}
            >
              <div className="flex flex-col gap-1">
                <span className="font-medium">{line.purpose}</span>
                {line.reason ? (
                  <span className="text-sm" data-testid="line-no-receipt">
                    <span className="font-medium">{t("flags.noReceipt")}</span> ·{" "}
                    {t(`noReceiptReason.${line.reason}`)}
                    {line.note ? ` · ${line.note}` : ""}
                  </span>
                ) : line.receipt ? (
                  <div className="flex flex-col gap-1" data-testid="line-receipt">
                    <span className="text-sm text-muted-foreground">{line.receipt.fileName}</span>
                    <ReceiptView receipt={line.receipt} />
                  </div>
                ) : null}
              </div>
              <span className="fv-numeric font-semibold">{formatTzs(line.amount, locale)}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
