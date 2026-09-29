import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { DisbursementActions } from "@/app/(app)/imprest/disbursement-forms";
import { DecideReversal, RequestReversal } from "@/app/(app)/imprest/reversal-forms";
import { CashierStep, ReceiptView } from "@/app/(app)/imprest/settlement-forms";
import { DisbursementFlags, DisbursementStatusChip } from "@/app/(app)/imprest/spending";
import { Card, PageHeader, StatusChip } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import {
  earlierReceipts,
  loadDisbursement,
  loadSpendingPosition,
  type DisbursementDetail,
  type SettlementCycle,
} from "@/lib/imprest/disbursements";
import { openFor } from "@/lib/imprest/spending";
import { formatTzs } from "@/lib/money";
import { formatBusinessStamp } from "@/lib/time/business-date";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One disbursement and its history (product.md §13.3, issues #55, #62 and #65).
 *
 * A Cashier can read only their own, so another Cashier's disbursement is simply not found. Once
 * settled, it always shows its breakdown: Approved, Used, Returned and, when above zero, Not
 * accounted for, with every line and its receipt or No-receipt reason (criterion 8). A settlement
 * sent back and settled again shows every cycle in order, each with the reason it was returned.
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
  // What a raise would take out of Free to approve, shown to the Manager who decides it; and where a
  // reversal would take the posted balance, shown to the Director who decides that (issue #71).
  const position =
    (viewer.role === "manager" && disbursement.openRequest) ||
    (viewer.role === "director" && disbursement.openReversals > 0)
      ? await loadSpendingPosition()
      : null;
  const sentBack = disbursement.sentBack
    ? {
        reason: disbursement.sentBack.reason,
        by: disbursement.sentBack.returnedBy || roles("manager"),
        at: formatBusinessStamp(disbursement.sentBack.returnedAt, locale),
      }
    : null;

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
          {disbursement.raises.some((r) => r.status === "raised" || r.status === "handed_out") ? (
            <div className="flex flex-col gap-1" data-testid="original-amount">
              <dt className="text-xs text-muted-foreground">{t("detail.originalAmount")}</dt>
              <dd className="fv-numeric font-semibold">{formatTzs(disbursement.originalAmount, locale)}</dd>
            </div>
          ) : null}
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

      {disbursement.raises.length > 0 ? <ApprovalHistory disbursement={disbursement} /> : null}

      {disbursement.openRequest ? (
        <RequestForMore
          request={disbursement.openRequest}
          approved={disbursement.amount}
          name={disbursement.proposedBy}
        />
      ) : null}

      {disbursement.cycles.map((cycle) => (
        <Breakdown key={cycle.id} disbursement={disbursement} cycle={cycle} />
      ))}

      {disbursement.status === "verified" ? (
        <Corrections
          disbursement={disbursement}
          mayRequest={viewer.role === "manager" || cashierDue}
          decides={viewer.role === "director"}
          postedBalance={position?.postedBalance ?? null}
          freeToApprove={position?.freeToApprove ?? null}
        />
      ) : null}

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
          raiseRequest={
            disbursement.openRequest
              ? { id: disbursement.openRequest.id, amount: disbursement.openRequest.amount }
              : null
          }
          freeToApprove={position?.freeToApprove ?? null}
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
        {disbursement.awaitingHandOut && viewer.role !== "cashier" ? (
          <p className="text-sm text-muted-foreground" data-testid="raise-hand-out-note">
            {t("raise.waitingHandOut")}
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
        {disbursement.status === "sent_back" && viewer.role !== "cashier" ? (
          <p className="text-sm text-muted-foreground" data-testid="sent-back-note">
            {t("detail.sentBackNote")}
          </p>
        ) : null}
        {disbursement.status === "verified" ? (
          <p className="text-sm text-muted-foreground" data-testid="verified-note">
            {t("detail.verifiedNote")}
          </p>
        ) : null}
        {/* Directors read a payment's steps; a reversal waiting for them is theirs to decide (issue #71). */}
        {viewer.role === "director" && disbursement.openReversals === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="read-only">
            {t("detail.readOnly")}
          </p>
        ) : null}
      </Card>

      {/* Always in this place for the proposing Cashier, so its confirmation outlives the step. */}
      {cashierDue ? (
        <CashierStep
          status={disbursement.status}
          disbursement={target}
          amount={disbursement.amount}
          raise={{
            openRequest: disbursement.openRequest
              ? { id: disbursement.openRequest.id, amount: disbursement.openRequest.amount }
              : null,
            awaitingHandOut: disbursement.awaitingHandOut
              ? { id: disbursement.awaitingHandOut.id, amount: disbursement.awaitingHandOut.amount }
              : null,
          }}
          sentBack={sentBack}
          previous={disbursement.status === "sent_back" ? (disbursement.cycles.at(-1) ?? null) : null}
          earlier={disbursement.status === "sent_back" ? earlierReceipts(disbursement.cycles) : []}
        />
      ) : null}

      <section className="flex flex-col gap-3" aria-labelledby="history-heading">
        <h2 id="history-heading" className="text-lg font-semibold">
          {(await getTranslations("imprest"))("history.title")}
        </h2>
        <ol className="flex flex-col gap-2" data-testid="disbursement-history">
          {disbursement.events.map((event, index) => (
            <li key={`${event.kind}-${event.cycle ?? 0}-${index}`}>
              <Card className="flex flex-col gap-1">
                <span className="font-medium">
                  {t(`history.${event.kind}`)}
                  {event.cycle && disbursement.cycles.length > 1 ? ` · ${t("history.cycle", { cycle: event.cycle })}` : ""}
                </span>
                <span className="text-sm text-muted-foreground">
                  {/* A Cashier may not read the Manager's profile, so they see the role instead. */}
                  {event.by || roles(event.role)} · {formatBusinessStamp(event.at, locale)}
                </span>
                {event.amount !== undefined && event.posting ? (
                  <span className="fv-numeric text-sm" data-testid="history-amount">
                    {t(event.posting === "expense" ? "posted.expense" : "posted.loss")} ·{" "}
                    {event.kind === "reversal_requested"
                      ? t("history.correctAmount", { amount: formatTzs(event.amount, locale) })
                      : formatTzs(event.kind === "reversal_posted" ? -event.amount : event.amount, locale)}
                  </span>
                ) : null}
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
 * The Cashier's request for more and the decision it waits for (issue #70), in words for everyone who
 * can read the disbursement. The Manager's controls are in the actions card below.
 */
async function RequestForMore({
  request,
  approved,
  name,
}: {
  request: DisbursementDetail["raises"][number];
  approved: number;
  name: string;
}) {
  const t = await getTranslations("imprest.spending");
  const roles = await getTranslations("admin.roles");
  const locale = await getLocale();
  return (
    <Card className="flex flex-col gap-2" data-testid="raise-request">
      <h2 className="text-lg font-semibold">{t("raise.requestTitle")}</h2>
      <p className="fv-numeric text-sm">
        {t("raise.requestLine", {
          name: name || roles("cashier"),
          amount: formatTzs(request.amount, locale),
          approved: formatTzs(approved, locale),
          total: formatTzs(approved + request.amount, locale),
        })}
      </p>
      <p className="text-sm" data-testid="raise-request-reason">
        <span className="font-medium">{t("raise.requestReason")}</span> {request.reason}
      </p>
    </Card>
  );
}

/**
 * The original approval and every raise, each with who, when and why, and the approved amount as
 * their sum (issue #70). Nothing here is typed: the total is the database's calculation.
 */
async function ApprovalHistory({ disbursement }: { disbursement: DisbursementDetail }) {
  const t = await getTranslations("imprest.spending");
  const roles = await getTranslations("admin.roles");
  const locale = await getLocale();
  const stamp = (at: string) => formatBusinessStamp(at, locale);
  return (
    <Card className="flex flex-col gap-3" data-testid="approval-history">
      <h2 className="text-lg font-semibold">{t("approval.title")}</h2>
      <ol className="flex flex-col gap-3">
        <li className="flex items-start justify-between gap-3" data-testid="approval-first">
          <span className="font-medium">{t("approval.first")}</span>
          <span className="fv-numeric font-semibold">{formatTzs(disbursement.originalAmount, locale)}</span>
        </li>
        {disbursement.raises.map((raise) => (
          <li
            key={raise.id}
            className="flex flex-col gap-1 border-t border-border pt-3"
            data-testid={"raise-" + raise.raiseNo}
            data-status={raise.status}
          >
            <div className="flex items-start justify-between gap-3">
              <span className="font-medium">{t("approval.raiseLine", { number: raise.raiseNo })}</span>
              <span
                className={
                  "fv-numeric font-semibold " +
                  (raise.status === "refused" ? "text-muted-foreground line-through" : "")
                }
              >
                {formatTzs(raise.amount, locale)}
              </span>
            </div>
            <span className="text-xs text-muted-foreground" data-testid="raise-status">
              {t("approval.status." + raise.status)}
            </span>
            <span className="text-sm">{raise.reason}</span>
            <span className="text-xs text-muted-foreground">
              {t("approval.requestedBy", {
                name: disbursement.proposedBy || roles("cashier"),
                at: stamp(raise.requestedAt),
              })}
            </span>
            {raise.decidedAt ? (
              <span className="text-xs text-muted-foreground">
                {t("approval.decidedBy", { name: raise.decidedBy || roles("manager"), at: stamp(raise.decidedAt) })}
              </span>
            ) : null}
            {raise.status === "refused" && raise.refusalReason ? (
              <span className="text-sm" data-testid="raise-refusal">
                {t("approval.refusedBecause", { reason: raise.refusalReason })}
              </span>
            ) : null}
            {raise.status === "handed_out" && raise.handedOutAt ? (
              <span className="text-xs text-muted-foreground">
                {t("approval.handedOut", { recipient: raise.recipient ?? "", at: stamp(raise.handedOutAt) })}
              </span>
            ) : null}
          </li>
        ))}
        <li className="flex items-start justify-between gap-3 border-t border-border pt-3" data-testid="approval-total">
          <span className="font-semibold">{t("approval.total")}</span>
          <span className="fv-numeric font-semibold">{formatTzs(disbursement.amount, locale)}</span>
        </li>
      </ol>
    </Card>
  );
}

/**
 * Corrections of a verified payment (issue #71). What stands now, each with the way to ask for a
 * reversal; every request with who asked, why, and what the Director decided; and every posting in
 * the order it was posted, so the original, its reversal and its replacement read top to bottom.
 */
async function Corrections({
  disbursement,
  mayRequest,
  decides,
  postedBalance,
  freeToApprove,
}: {
  disbursement: DisbursementDetail;
  mayRequest: boolean;
  decides: boolean;
  postedBalance: number | null;
  freeToApprove: number | null;
}) {
  const t = await getTranslations("imprest");
  const roles = await getTranslations("admin.roles");
  const locale = await getLocale();
  const tzs = (value: number) => formatTzs(value, locale);
  const stamp = (at: string) => formatBusinessStamp(at, locale);
  const kindLabel = (kind: string) => t(kind === "expense" ? "spending.posted.expense" : "spending.posted.loss");
  const standing = disbursement.postings.filter((p) => p.entry !== "reversal" && !p.reversed);
  const waitingFor = new Set(disbursement.reversals.filter((r) => r.status === "requested").map((r) => r.postingId));
  const corrected = disbursement.postings.some((p) => p.entry !== "original");
  const tones = { requested: "attention", approved: "success", rejected: "danger" } as const;

  return (
    <Card className="flex flex-col gap-4" data-testid="corrections">
      <h2 className="text-lg font-semibold">{t("reversal.title")}</h2>
      <p className="text-sm text-muted-foreground">{t("reversal.help")}</p>

      <ul className="flex flex-col gap-3" data-testid="standing-postings">
        {standing.map((p) => (
          <li
            key={p.id}
            className="flex flex-col gap-2 border-t border-border pt-3"
            data-testid={`standing-${p.kind}`}
            data-entry={p.entry}
          >
            <div className="flex items-start justify-between gap-3">
              <span className="flex flex-col">
                <span className="font-medium">{kindLabel(p.kind)}</span>
                <span className="text-xs text-muted-foreground">{t(`reversal.entry.${p.entry}`)}</span>
                {p.needsDirectorDecision ? (
                  <span className="text-xs text-muted-foreground">{t("spending.posted.lossNote")}</span>
                ) : null}
              </span>
              <span className={`fv-numeric font-semibold ${p.kind === "unexplained_loss" ? "text-danger" : ""}`}>
                {tzs(p.amount)}
              </span>
            </div>
            {mayRequest ? (
              <RequestReversal postingId={p.id} waiting={waitingFor.has(p.id)} />
            ) : waitingFor.has(p.id) ? (
              <p className="text-sm text-muted-foreground" data-testid="reversal-waiting">
                {t("reversal.waiting")}
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      {disbursement.reversals.length > 0 ? (
        <section className="flex flex-col gap-3 border-t border-border pt-3" aria-labelledby="reversals-heading">
          <h3 id="reversals-heading" className="font-semibold">
            {t("reversal.requestsTitle")}
          </h3>
          <ol className="flex flex-col gap-3" data-testid="reversal-requests">
            {disbursement.reversals.map((r, index) => (
              <li
                key={r.id}
                className="flex flex-col gap-1 rounded-lg border border-border p-3"
                data-testid={`reversal-${index + 1}`}
                data-status={r.status}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="fv-numeric font-medium">
                    {t("reversal.requestLine", {
                      kind: kindLabel(r.kind),
                      original: tzs(r.original),
                      correct: tzs(r.correct),
                    })}
                  </span>
                  <StatusChip tone={tones[r.status]}>
                    <span data-testid="reversal-status">{t(`reversal.status.${r.status}`)}</span>
                  </StatusChip>
                </div>
                <span className="text-sm" data-testid="reversal-reason">
                  {r.reason}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("reversal.requestedBy", { name: r.requestedBy || roles(r.requestedRole), at: stamp(r.requestedAt) })}
                </span>
                {r.decidedAt ? (
                  <span className="text-xs text-muted-foreground" data-testid="reversal-decided-by">
                    {t("reversal.decidedBy", { name: r.decidedBy || roles("director"), at: stamp(r.decidedAt) })}
                  </span>
                ) : null}
                {r.status === "rejected" && r.rejectionReason ? (
                  <span className="text-sm" data-testid="reversal-rejection">
                    {t("reversal.rejectedBecause", { reason: r.rejectionReason })}
                  </span>
                ) : null}
                {r.status === "approved" ? (
                  <span className="fv-numeric text-sm" data-testid="reversal-posted">
                    {t("reversal.posted", {
                      original: tzs(r.original),
                      replacement:
                        r.correct > 0
                          ? t("reversal.replacementOf", { amount: tzs(r.correct) })
                          : t("reversal.noReplacement"),
                    })}
                  </span>
                ) : null}
                {decides ? (
                  <DecideReversal
                    key={r.id}
                    reversal={{ id: r.id, version: r.version, original: r.original, correct: r.correct }}
                    open={r.status === "requested"}
                    postedBalance={postedBalance}
                    freeToApprove={freeToApprove}
                  />
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {corrected ? (
        <section className="flex flex-col gap-2 border-t border-border pt-3" aria-labelledby="ledger-heading">
          <h3 id="ledger-heading" className="font-semibold">
            {t("reversal.ledgerTitle")}
          </h3>
          <ol className="flex flex-col gap-2" data-testid="posting-ledger">
            {disbursement.postings.map((p) => (
              <li
                key={p.id}
                className="flex items-start justify-between gap-3 text-sm"
                data-testid="ledger-row"
                data-entry={p.entry}
                data-kind={p.kind}
              >
                <span className="flex flex-col">
                  <span>
                    {t(`reversal.entry.${p.entry}`)} · {kindLabel(p.kind)}
                    {p.reversed ? ` · ${t("reversal.reversed")}` : ""}
                  </span>
                  <span className="text-xs text-muted-foreground">{stamp(p.postedAt)}</span>
                </span>
                <span className={`fv-numeric font-semibold ${p.reversed ? "text-muted-foreground line-through" : ""}`}>
                  {tzs(p.entry === "reversal" ? -p.amount : p.amount)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </Card>
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

/**
 * One settlement cycle: Approved = Used + Returned + Not accounted for, every line behind Used and,
 * when the Manager sent it back, who did, when and why (issue #65). The latest cycle keeps the
 * `settlement-breakdown` hook and carries what verification posted.
 */
async function Breakdown({ disbursement, cycle }: { disbursement: DisbursementDetail; cycle: SettlementCycle }) {
  const t = await getTranslations("imprest.spending");
  const roles = await getTranslations("admin.roles");
  const locale = await getLocale();
  const settlement = cycle;
  const latest = disbursement.settlement?.id === cycle.id;
  const several = disbursement.cycles.length > 1;
  const figures = [
    // What this cycle explained: a later raise leaves an earlier cycle at the amount it was held to.
    { key: "approved", value: settlement.approved },
    { key: "used", value: settlement.used },
    { key: "returned", value: settlement.returned },
    ...(settlement.unaccounted > 0 ? [{ key: "notAccounted", value: settlement.unaccounted }] : []),
  ];

  return (
    <Card
      className="flex flex-col gap-4"
      data-testid={latest ? "settlement-breakdown" : `settlement-cycle-${cycle.cycle}`}
      data-cycle={cycle.cycle}
    >
      <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
        {several ? t("breakdown.cycle", { cycle: cycle.cycle }) : t("breakdown.title")}
        {several && latest ? (
          <span className="text-xs font-normal text-muted-foreground">· {t("breakdown.latest")}</span>
        ) : null}
      </h2>
      {cycle.sentBack ? (
        <div
          className="flex flex-col gap-1 rounded-lg border border-danger/40 bg-danger/5 p-3"
          data-testid="cycle-returned"
        >
          <p className="text-sm">
            <span className="font-medium">{t("breakdown.returnReason")}</span> {cycle.sentBack.reason}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("breakdown.returnedBy", {
              name: cycle.sentBack.returnedBy || roles("manager"),
              at: formatBusinessStamp(cycle.sentBack.returnedAt, locale),
            })}
          </p>
        </div>
      ) : null}
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

      {latest && disbursement.verification ? <Postings disbursement={disbursement} /> : null}

      {cycle.lines.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="no-lines">
          {t("breakdown.noLines")}
        </p>
      ) : (
        <ol className="flex flex-col gap-3" data-testid="settlement-lines">
          {cycle.lines.map((line) => (
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
