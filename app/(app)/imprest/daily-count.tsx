import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { CountControls, LateCountControl } from "@/app/(app)/imprest/count-forms";
import { Pager } from "@/components/ui/pager";
import { Card, StatusChip } from "@/components/ui/surface";
import type { AppRole } from "@/lib/auth/roles";
import {
  dayState,
  waitedFor,
  type DailyCount,
  type DayState,
  type OpenDay,
  type ResolvedCountAlert,
} from "@/lib/imprest/counting";
import type { CountFlag } from "@/lib/imprest/counts";
import type { Page } from "@/lib/settlement/settlement";
import { formatTzs } from "@/lib/money";
import { formatBusinessDate, formatBusinessStamp } from "@/lib/time/business-date";

/**
 * The daily count on the imprest screen (product.md §13.7 and §15, issue #68).
 *
 * One section for all three roles (design.md §7.19): the Cashier counts, the Manager confirms or
 * sends back, Directors read. Today's state leads. Not counted, Awaiting Manager confirmation,
 * Sent back, Balanced, Shortage and Excess each have their own label and tone, so an unknown day
 * never looks like a balanced one (§15.2a). Every figure is the database's; none is typed but the
 * cash counted.
 */

// Not counted is a missed control, so it takes the danger tone; today, before it closes, is only due.
const STATE_TONES: Record<DayState, "neutral" | "success" | "attention" | "danger"> = {
  due: "neutral",
  not_counted: "danger",
  awaiting_confirmation: "attention",
  sent_back: "attention",
  balanced: "success",
  shortage: "danger",
  excess: "attention",
};

export async function CountStateChip({ state }: { state: DayState }) {
  const t = await getTranslations("imprest.count.state");
  return (
    <StatusChip tone={STATE_TONES[state]}>
      <span data-testid={`count-state-${state}`}>{t(state)}</span>
    </StatusChip>
  );
}

/** A count's own state: the outcome once confirmed, else where it waits. */
function stateOf(c: DailyCount): DayState {
  if (c.status === "confirmed" && c.outcome) return c.outcome;
  return c.status === "sent_back" ? "sent_back" : "awaiting_confirmation";
}

/** "Short by TZS 1,000", "Over by TZS 500", or none, in words rather than a sign alone. */
async function varianceText(variance: number, locale: string): Promise<string> {
  const t = await getTranslations("imprest.count.figures");
  const amount = formatTzs(Math.abs(variance), locale);
  if (variance < 0) return t("short", { amount });
  if (variance > 0) return t("over", { amount });
  return t("none");
}

async function CountFigures({ count, testId }: { count: DailyCount; testId: string }) {
  const t = await getTranslations("imprest.count.figures");
  const locale = await getLocale();
  const variance = await varianceText(count.variance, locale);
  return (
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid={testId}>
      <div className="flex flex-col gap-0.5" data-testid="count-expected">
        <dt className="text-sm text-muted-foreground">{t("expected")}</dt>
        <dd className="fv-numeric text-lg font-semibold">{formatTzs(count.expected, locale)}</dd>
      </div>
      <div className="flex flex-col gap-0.5" data-testid="count-counted">
        <dt className="text-sm text-muted-foreground">{t("counted")}</dt>
        <dd className="fv-numeric text-lg font-semibold">{formatTzs(count.counted, locale)}</dd>
      </div>
      <div className="flex flex-col gap-0.5" data-testid="count-variance">
        <dt className="text-sm text-muted-foreground">{t("variance")}</dt>
        <dd className={`fv-numeric text-lg font-semibold ${count.variance < 0 ? "text-danger" : ""}`}>{variance}</dd>
      </div>
    </dl>
  );
}

/** Who did what to a count, and why: the note, the send-back and the confirmation, in order. */
async function CountRecord({ count }: { count: DailyCount }) {
  const t = await getTranslations("imprest.count.record");
  const e = await getTranslations("imprest.count.explanation");
  const locale = await getLocale();
  const stamp = (iso: string) => formatBusinessStamp(iso, locale);
  return (
    <ul className="flex flex-col gap-1 text-sm">
      <li>{t("counted", { name: count.countedBy, when: stamp(count.countedAt) })}</li>
      {count.lateReason ? (
        <li className="font-medium" data-testid="count-late">
          {t("late", { reason: count.lateReason })}
        </li>
      ) : null}
      {count.note ?<li className="text-muted-foreground">{t("note", { note: count.note })}</li> : null}
      {count.postedBalance !== null && count.awaitingVerification !== null ? (
        <li className="fv-numeric text-muted-foreground" data-testid="count-basis">
          {t("basis", {
            posted: formatTzs(count.postedBalance, locale),
            awaiting: formatTzs(count.awaitingVerification, locale),
          })}
        </li>
      ) : null}
      {count.returnReason && count.returnedAt ? (
        <li data-testid="count-return">
          {t("sentBack", { name: count.returnedBy ?? "", when: stamp(count.returnedAt), reason: count.returnReason })}
        </li>
      ) : null}
      {count.confirmedAt ? (
        <li data-testid="count-confirmation">
          {t("confirmed", { name: count.confirmedBy ?? "", when: stamp(count.confirmedAt) })}
          {count.explanation ? ` ${t("because", { explanation: e(count.explanation) })}` : ""}
          {count.explanationNote ? ` ${t("explanationNote", { note: count.explanationNote })}` : ""}
        </li>
      ) : null}
      {count.outcome === "shortage" ? (
        <li className="font-medium" data-testid="count-posted">
          {t("postedShortage", { amount: formatTzs(Math.abs(count.variance), locale) })}
        </li>
      ) : count.outcome === "excess" ? (
        <li className="font-medium" data-testid="count-posted">
          {t("postedExcess", { amount: formatTzs(count.variance, locale) })}
        </li>
      ) : null}
    </ul>
  );
}

export async function DailyCountSection({
  role,
  today,
  todays,
  history,
  countingStartsOn = null,
  otherParams = {},
  children,
}: {
  role: AppRole;
  /**
   * The active fund's first day to count (issue #72). After a retirement approved on the day of its
   * closing count, that day was counted already, and counting starts again the next day.
   */
  countingStartsOn?: string | null;
  /** What must be seen before the history: the days not closed (issue #69). */
  children?: React.ReactNode;
  /** Today's business date, `YYYY-MM-DD` in Africa/Dar_es_Salaam. */
  today: string;
  /** The counts that decide today's state: the first page, most recent first. */
  todays: DailyCount[];
  /** The page of counts the viewer is reading. */
  history: Page<DailyCount>;
  /** The other lists' current pages on this screen, so paging this one keeps their place. */
  otherParams?: Record<string, number>;
}) {
  const t = await getTranslations("imprest.count");
  const locale = await getLocale();
  const { state, latest } = dayState(todays, today);
  const notYet = countingStartsOn !== null && today < countingStartsOn && latest === null;
  // An earlier day's count still waiting for the Manager. The fund holds one waiting count at most,
  // and it blocks today's until the Manager decides it, so it is shown here with its controls.
  const earlier = todays.find((c) => c.status === "awaiting_confirmation" && c.businessDate < today) ?? null;
  const toDecide = earlier ?? (state === "awaiting_confirmation" ? latest : null);

  const help: Record<DayState, string> = {
    due: t(`help.due.${role === "cashier" ? "cashier" : "other"}`),
    not_counted: t("help.not_counted"),
    awaiting_confirmation: t(`help.awaiting_confirmation.${role === "manager" ? "manager" : "other"}`),
    sent_back: t(`help.sent_back.${role === "cashier" ? "cashier" : "other"}`),
    balanced: t("help.balanced"),
    shortage: t("help.shortage"),
    excess: t("help.excess"),
  };

  return (
    <section id="daily-count" className="flex flex-col gap-3" aria-labelledby="daily-count-heading" data-testid="daily-count">
      <h2 id="daily-count-heading" className="text-lg font-semibold">
        {t("title")}
      </h2>

      <Card className="flex flex-col gap-4" data-testid="count-today">
        <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
          <span className="text-sm text-muted-foreground">{formatBusinessDate(today, locale)}</span>
          {notYet ? null : <CountStateChip state={state} />}
        </div>
        <p className="text-sm" data-testid={notYet ? "count-not-yet" : undefined}>
          {notYet
            ? t("notYet", { date: formatBusinessDate(countingStartsOn, locale) })
            : earlier
            ? t(`earlier.${role === "cashier" ? "cashier" : role === "manager" ? "manager" : "other"}`, {
                date: formatBusinessDate(earlier.businessDate, locale),
              })
            : help[state]}
        </p>
        {latest ? <CountFigures count={latest} testId="count-today-figures" /> : null}
        {latest ? <CountRecord count={latest} /> : null}
        {earlier ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border p-4" data-testid="count-earlier">
            <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
              <h3 className="font-semibold">
                {t("earlier.title", { date: formatBusinessDate(earlier.businessDate, locale) })}
              </h3>
              <CountStateChip state="awaiting_confirmation" />
            </div>
            <CountFigures count={earlier} testId="count-earlier-figures" />
            <CountRecord count={earlier} />
          </div>
        ) : null}
        {role === "cashier" || role === "manager" ? (
          <CountControls
            role={role}
            businessDate={today}
            mayCount={!notYet && !earlier && (state === "due" || state === "sent_back")}
            replaces={
              state === "sent_back" && latest ? { id: latest.id, reason: latest.returnReason ?? "" } : null
            }
            waiting={
              toDecide
                ? {
                    id: toDecide.id,
                    version: toDecide.version,
                    expected: toDecide.expected,
                    counted: toDecide.counted,
                    variance: toDecide.variance,
                  }
                : null
            }
          />
        ) : null}
      </Card>

      {children}

      <section className="flex flex-col gap-3" aria-labelledby="count-history-heading" data-testid="count-history">
        <h3 id="count-history-heading" className="font-semibold">
          {t("history.title")}
        </h3>
        {history.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("history.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {history.rows.map((c) => (
              <li key={c.id} data-testid={`count-${c.businessDate}-${c.attempt}`}>
                <Card className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                    <span className="font-medium">
                      {t("history.day", { date: formatBusinessDate(c.businessDate, locale), attempt: c.attempt })}
                    </span>
                    <CountStateChip state={stateOf(c)} />
                  </div>
                  <CountFigures count={c} testId="count-figures" />
                  <CountRecord count={c} />
                </Card>
              </li>
            ))}
          </ul>
        )}
        <Pager
          page={history.page}
          pageSize={history.pageSize}
          total={history.total}
          param="counts"
          basePath="/imprest"
          label={t("history.title")}
          otherParams={otherParams}
        />
      </section>
    </section>
  );
}

/** "Waiting 3 days", in the viewer's words, from when the day started waiting to now. */
async function waitedText(since: string): Promise<string> {
  const t = await getTranslations("imprest.count.open.waited");
  const { unit, count } = waitedFor(since);
  return t(unit, { count });
}

/** Why one open day waits, and since when. */
async function OpenDayLine({ day }: { day: OpenDay }) {
  const t = await getTranslations("imprest.count.open");
  const locale = await getLocale();
  const stamp = (iso: string) => formatBusinessStamp(iso, locale);
  return (
    <span className="flex flex-col gap-0.5 text-sm">
      {day.notCountedSince ? <span>{t("notCountedSince", { when: stamp(day.notCountedSince) })}</span> : null}
      {day.awaitingSince ? <span>{t("awaitingSince", { when: stamp(day.awaitingSince) })}</span> : null}
      <span className="font-medium" data-testid="open-day-waited">
        {await waitedText(day.waitingSince)}
      </span>
    </span>
  );
}

/**
 * The days that are not closed, oldest first (issue #69, §15.2a): Not counted, or a count waiting
 * for the Manager. For Directors and the Manager these are the open alerts, and they stay here until
 * the day has a confirmed count. The Cashier counts a Not counted day late from here, unless a count
 * already waits, since the fund holds one at a time. Every page says how many there are.
 */
export async function OpenCountDays({
  role,
  days,
  mayCountLate,
  otherParams = {},
}: {
  role: AppRole;
  days: Page<OpenDay>;
  /** No count waits for the Manager anywhere in the fund. */
  mayCountLate: boolean;
  otherParams?: Record<string, number>;
}) {
  const t = await getTranslations("imprest.count.open");
  const locale = await getLocale();
  return (
    <section
      id="count-open-days"
      className="flex scroll-mt-4 flex-col gap-3"
      aria-labelledby="open-days-heading"
      data-testid="count-open-days"
    >
      <h3 id="open-days-heading" className="font-semibold">
        {t("title", { count: days.total })}
      </h3>
      <p className="text-sm text-muted-foreground">{t(role === "cashier" ? "helpCashier" : "help")}</p>
      {days.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {days.rows.map((day) => {
            const date = formatBusinessDate(day.businessDate, locale);
            return (
              <li key={day.businessDate} data-testid={`open-day-${day.businessDate}`}>
                <Card className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                    <span className="font-medium">{date}</span>
                    <CountStateChip state={day.state} />
                  </div>
                  <OpenDayLine day={day} />
                  {/* Mounted whatever the day's state, so the server's answer stays on screen when
                      a late count moves the day to Awaiting Manager confirmation. */}
                  {role === "cashier" ? (
                    <LateCountControl
                      businessDate={day.businessDate}
                      dateLabel={date}
                      mayOpen={day.state === "not_counted" && mayCountLate}
                      replaces={
                        day.latestStatus === "sent_back" && day.latestCountId
                          ? { id: day.latestCountId, reason: day.latestReturnReason ?? "" }
                          : null
                      }
                    />
                  ) : null}
                  {role === "cashier" && day.state === "not_counted" && !mayCountLate ? (
                    <p className="text-sm text-muted-foreground">{t("lateBlocked")}</p>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      <Pager
        page={days.page}
        pageSize={days.pageSize}
        total={days.total}
        param="missed"
        basePath="/imprest"
        label={t("title", { count: days.total })}
        otherParams={otherParams}
      />
    </section>
  );
}

/**
 * The open count alerts on the dashboard of both Directors and the Manager (issue #69, §15.2a,
 * AC-113): days Not counted or waiting for the Manager, oldest first. It says how many there are in
 * all and links to the imprest screen, where every one is listed. Nothing here dismisses an alert:
 * it goes when the day has a confirmed count.
 */
export async function CountAlerts({ days }: { days: Page<OpenDay> }) {
  if (days.total === 0) return null;
  const t = await getTranslations("imprest.count.alerts");
  const locale = await getLocale();
  const waited = await Promise.all(days.rows.map((day) => waitedText(day.waitingSince)));
  return (
    <section
      role="alert"
      aria-labelledby="count-alerts-heading"
      data-testid="count-alerts"
      className="flex flex-col gap-3 rounded-lg border border-danger/40 bg-danger/10 p-4 md:p-5 xl:p-6"
    >
      <div className="flex items-start gap-3">
        <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-danger" />
        <div className="flex flex-col gap-1">
          <h2 id="count-alerts-heading" className="font-semibold text-danger">
            {t("heading", { count: days.total })}
          </h2>
          <p className="text-sm text-foreground">{t("notZero")}</p>
        </div>
      </div>
      <ul className="flex flex-col gap-3">
        {days.rows.map((day, i) => (
          <li
            key={day.businessDate}
            data-testid={`count-alert-${day.businessDate}`}
            className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between"
          >
            <span className="font-medium">
              {t(day.state, { date: formatBusinessDate(day.businessDate, locale) })}
            </span>
            <span className="text-sm text-muted-foreground">{waited[i]}</span>
          </li>
        ))}
      </ul>
      <Link
        href="/imprest#count-open-days"
        className="inline-flex min-h-11 items-center self-start font-medium text-bronze-text underline-offset-4 hover:underline xl:min-h-8"
      >
        {t(days.total > days.rows.length ? "seeAll" : "open", { count: days.total })}
      </Link>
    </section>
  );
}

/**
 * Resolved count alerts, most recently resolved first (issue #69): a Not counted day counted late,
 * and every count that waited for the Manager until confirmed or sent back. Directors and the
 * Manager, to whom the alerts were raised.
 */
export async function CountAlertHistory({
  history,
  otherParams = {},
}: {
  history: Page<ResolvedCountAlert>;
  otherParams?: Record<string, number>;
}) {
  const t = await getTranslations("imprest.count.alertHistory");
  const locale = await getLocale();
  const stamp = (iso: string) => formatBusinessStamp(iso, locale);
  return (
    <section className="flex flex-col gap-3" aria-labelledby="alert-history-heading" data-testid="count-alert-history">
      <h3 id="alert-history-heading" className="font-semibold">
        {t("title")}
      </h3>
      {history.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {history.rows.map((a) => (
            <li
              key={`${a.kind}-${a.businessDate}-${a.countId ?? "day"}`}
              data-testid={`alert-history-${a.kind}-${a.businessDate}${a.attempt ? `-${a.attempt}` : ""}`}
            >
              <Card className="flex flex-col gap-1">
                <span className="text-sm font-medium">
                  {t(a.kind, { date: formatBusinessDate(a.businessDate, locale), attempt: a.attempt ?? 0 })}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t(`resolved.${a.resolution}`, { raised: stamp(a.raisedAt), resolved: stamp(a.resolvedAt) })}
                </span>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <Pager
        page={history.page}
        pageSize={history.pageSize}
        total={history.total}
        param="alerts"
        basePath="/imprest"
        label={t("title")}
        otherParams={otherParams}
      />
    </section>
  );
}

/**
 * The flags a confirmed shortage or excess raised to the Directors (§13.7, AC-58). Read-only: the
 * accountability decision is a later release, and a control that implied otherwise would tell a
 * Director they had decided something they have not.
 */
export async function CountFlags({ flags }: { flags: CountFlag[] }) {
  const t = await getTranslations("imprest.count.flags");
  const locale = await getLocale();
  return (
    <section className="flex flex-col gap-3" aria-labelledby="count-flags-heading" data-testid="count-flags">
      <h2 id="count-flags-heading" className="text-lg font-semibold">
        {t("title")}
      </h2>
      {flags.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {flags.map((f) => (
            <li key={f.id} data-testid={`count-flag-${f.businessDate}`}>
              <Card className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                <span className="text-sm">
                  {t(f.kind === "count_shortage" ? "shortage" : "excess", {
                    amount: formatTzs(f.amount, locale),
                    date: formatBusinessDate(f.businessDate, locale),
                  })}
                </span>
                <span className="flex flex-col items-start gap-1 md:items-end">
                  <StatusChip tone={f.kind === "count_shortage" ? "danger" : "attention"}>
                    {t(f.kind === "count_shortage" ? "waitingDecision" : "recorded")}
                  </StatusChip>
                  <span className="text-xs text-muted-foreground">
                    {t("raised", { when: formatBusinessStamp(f.raisedAt, locale) })}
                  </span>
                </span>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
