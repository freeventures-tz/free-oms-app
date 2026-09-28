import { getLocale, getTranslations } from "next-intl/server";

import { CountControls } from "@/app/(app)/imprest/count-forms";
import { Pager } from "@/components/ui/pager";
import { Card, StatusChip } from "@/components/ui/surface";
import type { AppRole } from "@/lib/auth/roles";
import { dayState, type DailyCount, type DayState } from "@/lib/imprest/counting";
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

const STATE_TONES: Record<DayState, "neutral" | "success" | "attention" | "danger"> = {
  not_counted: "neutral",
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
      {count.note ? <li className="text-muted-foreground">{t("note", { note: count.note })}</li> : null}
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
  otherParams = {},
}: {
  role: AppRole;
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

  const help: Record<DayState, string> = {
    not_counted: t(`help.not_counted.${role === "cashier" ? "cashier" : "other"}`),
    awaiting_confirmation: t(`help.awaiting_confirmation.${role === "manager" ? "manager" : "other"}`),
    sent_back: t(`help.sent_back.${role === "cashier" ? "cashier" : "other"}`),
    balanced: t("help.balanced"),
    shortage: t("help.shortage"),
    excess: t("help.excess"),
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="daily-count-heading" data-testid="daily-count">
      <h2 id="daily-count-heading" className="text-lg font-semibold">
        {t("title")}
      </h2>

      <Card className="flex flex-col gap-4" data-testid="count-today">
        <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
          <span className="text-sm text-muted-foreground">{formatBusinessDate(today, locale)}</span>
          <CountStateChip state={state} />
        </div>
        <p className="text-sm">{help[state]}</p>
        {latest ? <CountFigures count={latest} testId="count-today-figures" /> : null}
        {latest ? <CountRecord count={latest} /> : null}
        {role === "cashier" || role === "manager" ? (
          <CountControls
            role={role}
            businessDate={today}
            mayCount={state === "not_counted" || state === "sent_back"}
            replaces={
              state === "sent_back" && latest ? { id: latest.id, reason: latest.returnReason ?? "" } : null
            }
            waiting={
              state === "awaiting_confirmation" && latest
                ? {
                    id: latest.id,
                    version: latest.version,
                    expected: latest.expected,
                    counted: latest.counted,
                    variance: latest.variance,
                  }
                : null
            }
          />
        ) : null}
      </Card>

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
