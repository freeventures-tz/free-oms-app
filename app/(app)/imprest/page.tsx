import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { ProposeDisbursementForm } from "@/app/(app)/imprest/disbursement-forms";
import { RequestFundingForm } from "@/app/(app)/imprest/funding-forms";
import { CountFlags, DailyCountSection } from "@/app/(app)/imprest/daily-count";
import { FundingStatusChip } from "@/app/(app)/imprest/funding-status";
import { DisbursementList, SpendingFigures } from "@/app/(app)/imprest/spending";
import { Pager } from "@/components/ui/pager";
import { Card, PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import {
  loadAwaitingDecision,
  loadHandedOut,
  loadOpenApprovals,
  loadSentBack,
  loadSettledWaiting,
  loadVerified,
  loadOwnDisbursements,
  loadRecentPurposes,
  loadSpendingPosition,
} from "@/lib/imprest/disbursements";
import { loadCountFlags, loadCounts } from "@/lib/imprest/counts";
import { loadFundings } from "@/lib/imprest/funding";
import { formatTzs } from "@/lib/money";
import { pageNumber } from "@/lib/settlement/settlement";
import { businessDate, formatBusinessStamp } from "@/lib/time/business-date";

/**
 * Imprest (product.md §13.2 and §13.3, issues #48 and #55).
 *
 * The Manager requests and confirms funding, and approves, rejects and cancels disbursements. A
 * Director decides, provides and corrects funding, and reads disbursements without acting on them.
 *
 * The Cashier's imprest work is spending. They see Free to approve, the propose form and their own
 * disbursements, and nothing about funding: the database does not send them posted funding or what
 * is set aside, and this screen does not read the funding list for them.
 *
 * Every figure is calculated on each read. Posted funding keeps its released label, because a reader
 * could otherwise take it for the cash in the tin or for what may be spent.
 */
export default async function ImprestPage({ searchParams }: PageProps<"/imprest">) {
  const viewer = await requireAccess("/imprest");
  const params = await searchParams;
  if (viewer.role === "cashier") {
    return <CashierImprest viewerId={viewer.userId} mine={pageNumber(params.mine)} counts={pageNumber(params.counts)} />;
  }

  const t = await getTranslations("imprest");
  const locale = await getLocale();
  const page = pageNumber(params.page);

  const countPage = pageNumber(params.counts);
  const [position, counts, todays, flags, waiting, open, out, settled, back, verified, fundings] = await Promise.all([
    loadSpendingPosition(),
    loadCounts(countPage),
    countPage === 1 ? null : loadCounts(1),
    viewer.role === "director" ? loadCountFlags() : null,
    loadAwaitingDecision(pageNumber(params.waiting)),
    loadOpenApprovals(pageNumber(params.open)),
    loadHandedOut(pageNumber(params.out)),
    loadSettledWaiting(pageNumber(params.settled)),
    loadSentBack(pageNumber(params.back)),
    loadVerified(pageNumber(params.verified)),
    loadFundings(page),
  ]);
  // Each list pages on its own parameter and keeps the others where they were.
  const pages = {
    waiting: waiting.page,
    open: open.page,
    out: out.page,
    settled: settled.page,
    back: back.page,
    verified: verified.page,
    page: fundings.page,
    counts: counts.page,
  };
  const others = (own: keyof typeof pages) =>
    Object.fromEntries(Object.entries(pages).filter(([name]) => name !== own));

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />

      <SpendingFigures position={position} />

      {/* The flags a confirmed shortage or excess raised to the Directors (issue #68). */}
      {flags ? <CountFlags flags={flags} /> : null}

      {position ? (
        <DailyCountSection
          role={viewer.role}
          today={businessDate()}
          todays={(todays ?? counts).rows}
          history={counts}
          otherParams={others("counts")}
        />
      ) : null}

      <DisbursementList
        id="disbursements-waiting"
        title={t("spending.lists.waiting", { count: waiting.total })}
        empty={t("spending.lists.waitingEmpty")}
        page={waiting}
        param="waiting"
        otherParams={others("waiting")}
      />

      <DisbursementList
        id="disbursements-open"
        title={t("spending.lists.open", { count: open.total })}
        empty={t("spending.lists.openEmpty")}
        page={open}
        param="open"
        showOpenFor
        otherParams={others("open")}
      />

      <DisbursementList
        id="disbursements-handed-out"
        title={t("spending.lists.handedOut", { count: out.total })}
        empty={t("spending.lists.handedOutEmpty")}
        page={out}
        param="out"
        otherParams={others("out")}
      />

      {/* The Manager opens one to verify it (issue #64); Directors read the same list. */}
      <DisbursementList
        id="disbursements-settled"
        title={t(viewer.role === "manager" ? "spending.lists.settled" : "spending.lists.settledDirector", {
          count: settled.total,
        })}
        empty={t("spending.lists.settledEmpty")}
        note={t(viewer.role === "manager" ? "spending.lists.settledNote" : "spending.lists.settledNoteDirector")}
        page={settled}
        param="settled"
        otherParams={others("settled")}
      />

      {/* Sent back to the Cashier with a reason (issue #65). Directors read the same list. */}
      <DisbursementList
        id="disbursements-sent-back"
        title={t(viewer.role === "manager" ? "spending.lists.sentBack" : "spending.lists.sentBackDirector", {
          count: back.total,
        })}
        empty={t("spending.lists.sentBackEmpty")}
        note={t(viewer.role === "manager" ? "spending.lists.sentBackNote" : "spending.lists.sentBackNoteDirector")}
        page={back}
        param="back"
        otherParams={others("back")}
      />

      {/* Once verified a payment leaves the queue above; this is where it can be found again. */}
      <DisbursementList
        id="disbursements-verified"
        title={t("spending.lists.verified", { count: verified.total })}
        empty={t("spending.lists.verifiedEmpty")}
        page={verified}
        param="verified"
        otherParams={others("verified")}
      />

      {viewer.role === "manager" ? (
        <Card className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">{t("request.title")}</h2>
          <RequestFundingForm />
        </Card>
      ) : null}

      <section className="flex flex-col gap-3" aria-labelledby="funding-list-heading">
        <h2 id="funding-list-heading" className="text-lg font-semibold">
          {t("list.title")}
        </h2>
        {fundings.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("list.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {fundings.rows.map((f) => (
              <li key={f.id}>
                <Link
                  href={`/imprest/${f.id}`}
                  className="block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2"
                  data-testid={`funding-${f.fundingNo}`}
                >
                  <Card className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <div className="flex flex-col gap-1">
                      <span className="font-medium">{f.fundingNo}</span>
                      <span className="text-sm text-muted-foreground">
                        {f.requestedBy} · {formatBusinessStamp(f.requestedAt, locale)}
                      </span>
                      <span className="text-sm">{f.reason}</span>
                    </div>
                    <div className="flex flex-col items-start gap-1 md:items-end">
                      <FundingStatusChip status={f.status} />
                      <span className="fv-numeric text-sm">
                        {t("list.requested", { amount: formatTzs(f.requestedAmount, locale) })}
                      </span>
                      {f.receivedAmount !== null ? (
                        <span className="fv-numeric text-sm font-medium">
                          {t("list.received", { amount: formatTzs(f.receivedAmount, locale) })}
                        </span>
                      ) : null}
                    </div>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Pager
          page={fundings.page}
          pageSize={fundings.pageSize}
          total={fundings.total}
          param="page"
          basePath="/imprest"
          label={t("list.title")}
          otherParams={others("page")}
        />
      </section>
    </>
  );
}

async function CashierImprest({ viewerId, mine, counts: countPage }: { viewerId: string; mine: number; counts: number }) {
  const t = await getTranslations("imprest");
  const [position, own, purposes, counts, todays] = await Promise.all([
    loadSpendingPosition(),
    loadOwnDisbursements(viewerId, mine),
    loadRecentPurposes(viewerId),
    loadCounts(countPage),
    countPage === 1 ? null : loadCounts(1),
  ]);

  return (
    <>
      <PageHeader title={t("title")} description={t("spending.cashierDescription")} />

      <SpendingFigures position={position} />

      {/* The Cashier counts the tin each day (issue #68). */}
      {position ? (
        <DailyCountSection
          role="cashier"
          today={businessDate()}
          todays={(todays ?? counts).rows}
          history={counts}
          otherParams={{ mine: own.page }}
        />
      ) : null}

      {position ? (
        <Card className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">{t("spending.propose.title")}</h2>
          <ProposeDisbursementForm freeToApprove={position.freeToApprove} recentPurposes={purposes} />
        </Card>
      ) : null}

      <DisbursementList
        id="disbursements-mine"
        title={t("spending.lists.mine")}
        empty={t("spending.lists.mineEmpty")}
        page={own}
        param="mine"
        showOpenFor
        showProposer={false}
        showNextStep
        otherParams={{ counts: counts.page }}
      />
    </>
  );
}
