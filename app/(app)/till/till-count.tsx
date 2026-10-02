import { getLocale, getTranslations } from "next-intl/server";

import { LateTillCountControl, TillCountControls } from "@/app/(app)/till/till-forms";
import { Pager } from "@/components/ui/pager";
import { Card, StatusChip } from "@/components/ui/surface";
import type { AppRole } from "@/lib/auth/roles";
import { formatTzs } from "@/lib/money";
import type { Page } from "@/lib/settlement/settlement";
import { formatBusinessDate, formatBusinessStamp } from "@/lib/time/business-date";
import {
  countState,
  dayStateOf,
  shortAndOver,
  type OpenTillDay,
  type TillDayRow,
  type TillCount,
  type TillDayState,
} from "@/lib/till/counting";
import type { TillExpectedLine } from "@/lib/till/counts";

/**
 * The daily till count (issue #83, design.md §7.19): one screen for all three roles. The Cashier
 * counts, the Manager confirms or sends back, Directors read. Not counted, Awaiting Manager
 * confirmation, Sent back, Balanced, Shortage and Excess each have their own label and tone, so an
 * unknown day never looks like a balanced one (§15.2a). Every figure is the database's; only the
 * counted figures are typed.
 */

const STATE_TONES: Record<TillDayState, "neutral" | "success" | "attention" | "danger"> = {
  due: "neutral",
  not_counted: "danger",
  awaiting_confirmation: "attention",
  sent_back: "attention",
  balanced: "success",
  shortage: "danger",
  excess: "attention",
};

export async function TillStateChip({ state }: { state: TillDayState }) {
  const t = await getTranslations("till.state");
  return (
    <StatusChip tone={STATE_TONES[state]}>
      <span data-testid={`till-state-${state}`}>{t(state)}</span>
    </StatusChip>
  );
}

/** "Short by TZS 1,000", "Over by TZS 500", "None", or Not counted: words, not a sign alone. */
async function differenceText(variance: number | null, locale: string): Promise<string> {
  const t = await getTranslations("till.figures");
  if (variance === null) return t("notCounted");
  const amount = formatTzs(Math.abs(variance), locale);
  if (variance < 0) return t("short", { amount });
  if (variance > 0) return t("over", { amount });
  return t("none");
}

/**
 * Expected, counted and the difference for each payment method, then the totals. On a phone each
 * method is a card; from `md` it is a grid that scrolls inside its own container, never the page.
 */
async function TillLines({ count, testId }: { count: TillCount; testId: string }) {
  const t = await getTranslations("till.figures");
  const m = await getTranslations("settlement.methods");
  const locale = await getLocale();
  const rows = await Promise.all(
    count.lines.map(async (l) => ({ ...l, difference: await differenceText(l.variance, locale) })),
  );
  const totalDifference = await differenceText(count.variance, locale);
  const { short, over } = shortAndOver(count.lines);
  const counted = (value: number | null) => (value === null ? t("notCounted") : formatTzs(value, locale));

  // One structure for every tier, so the page carries each figure once: a card per method on a
  // phone, the same rows as a four-column grid from `md`. The column labels repeat inside each card
  // on a phone and are read out, not shown, from `md`, where the header row names the columns.
  const row =
    "grid grid-cols-3 gap-x-2 gap-y-1 rounded-lg border border-border p-3 text-sm " +
    "md:grid-cols-[2fr_1fr_1fr_1fr] md:gap-4 md:rounded-none md:border-0 md:border-b md:px-0 md:py-2";
  const label = "block text-muted-foreground md:sr-only";
  const figure = "flex flex-col md:block md:text-right";
  const cells = (expected: number, countedValue: number | null, difference: string, short: boolean) => (
    <>
      <p className={figure}>
        <span className={label}>{t("expected")}</span>
        <span className="fv-numeric">{formatTzs(expected, locale)}</span>
      </p>
      <p className={figure}>
        <span className={label}>{t("counted")}</span>
        <span className="fv-numeric">{counted(countedValue)}</span>
      </p>
      <p className={figure}>
        <span className={label}>{t("variance")}</span>
        <span className={`fv-numeric ${short ? "text-danger" : ""}`}>{difference}</span>
      </p>
    </>
  );

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="overflow-x-auto" data-testid="till-grid-scroll">
        <div className="flex flex-col gap-2 md:min-w-[36rem] md:gap-0">
          <div
            aria-hidden
            className="hidden border-b border-border py-2 text-sm text-muted-foreground md:grid md:grid-cols-[2fr_1fr_1fr_1fr] md:gap-4"
          >
            <span>{t("method")}</span>
            <span className="text-right">{t("expected")}</span>
            <span className="text-right">{t("counted")}</span>
            <span className="text-right">{t("variance")}</span>
          </div>
          {rows.map((l) => (
            <div key={l.line} className={row} data-testid={`till-line-${l.line}`}>
              <p className="col-span-3 font-medium md:col-span-1 md:font-normal">{m(l.line)}</p>
              {cells(l.expected, l.counted, l.difference, (l.variance ?? 0) < 0)}
            </div>
          ))}
          <div className={`${row} bg-muted/40 font-semibold md:border-b-0 md:bg-transparent`} data-testid="till-totals">
            <p className="col-span-3 md:col-span-1">{t("total")}</p>
            {cells(count.expected, count.counted, totalDifference, (count.variance ?? 0) < 0)}
          </div>
        </div>
      </div>
      {short > 0 && over > 0 ? (
        <p className="text-sm font-medium" data-testid="till-short-and-over">
          {t("shortAndOver", { short: formatTzs(short, locale), over: formatTzs(over, locale) })}
        </p>
      ) : null}
    </div>
  );
}

/** Who did what to a count, and why. */
async function TillRecord({ count }: { count: TillCount }) {
  const t = await getTranslations("till.record");
  const r = await getTranslations("till.reason");
  const locale = await getLocale();
  const stamp = (iso: string) => formatBusinessStamp(iso, locale);
  return (
    <ul className="flex flex-col gap-1 text-sm">
      <li>{t("counted", { name: count.countedBy, when: stamp(count.countedAt) })}</li>
      {count.lateReason ? (
        <li className="font-medium" data-testid="till-late">
          {t("late", { reason: count.lateReason })}
        </li>
      ) : null}
      {count.note ? <li className="text-muted-foreground">{t("note", { note: count.note })}</li> : null}
      {count.returnReason && count.returnedAt ? (
        <li data-testid="till-return">
          {t("sentBack", { name: count.returnedBy ?? "", when: stamp(count.returnedAt), reason: count.returnReason })}
        </li>
      ) : null}
      {count.confirmedAt ? (
        <li data-testid="till-confirmation">
          {t("confirmed", { name: count.confirmedBy ?? "", when: stamp(count.confirmedAt) })}
          {count.explanation ? ` ${t("because", { reason: r(count.explanation) })}` : ""}
          {count.explanationNote ? ` ${t("reasonNote", { note: count.explanationNote })}` : ""}
        </li>
      ) : null}
    </ul>
  );
}

/** The figure for a count waiting on the Manager's decision. */
function toDecide(c: TillCount) {
  const { short, over } = shortAndOver(c.lines);
  return { id: c.id, version: c.version, short, over };
}

/** What the till should hold so far today, per method. Directors and the Manager only. */
async function ExpectedSoFar({ lines }: { lines: TillExpectedLine[] }) {
  const t = await getTranslations("till.expected");
  const f = await getTranslations("till.figures");
  const m = await getTranslations("settlement.methods");
  const locale = await getLocale();
  const total = lines.reduce((sum, l) => sum + l.expected, 0);
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border p-4" data-testid="till-expected">
      <h3 className="font-semibold">{t("title")}</h3>
      <p className="text-sm text-muted-foreground">{t("help")}</p>
      <ul className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2 xl:grid-cols-3">
        {lines.map((l) => (
          <li key={l.line} className="flex items-baseline justify-between gap-3" data-testid={`till-expected-${l.line}`}>
            <span>
              {m(l.line)} <span className="text-muted-foreground">({t("payments", { count: l.payments })})</span>
            </span>
            <span className="fv-numeric font-medium">{formatTzs(l.expected, locale)}</span>
          </li>
        ))}
      </ul>
      <p className="fv-numeric text-sm font-semibold">
        {f("total")}: {formatTzs(total, locale)}
      </p>
    </section>
  );
}

export async function TillTodaySection({
  role,
  today,
  day,
  todays,
  expected,
}: {
  role: AppRole;
  today: string;
  /** Where today stands, from the database: its state and its latest count, whoever entered it. */
  day: TillDayRow | null;
  /** Every count of today the viewer may read. A Cashier reads only their own. */
  todays: TillCount[];
  /** What today should hold so far, for Directors and the Manager; null for the Cashier. */
  expected: TillExpectedLine[] | null;
}) {
  const t = await getTranslations("till");
  const locale = await getLocale();
  const state = dayStateOf(day);
  // The figures of the day's latest count, when the viewer may read them. A Cashier is not sent
  // another Cashier's count, so the chip comes from the day's state, never from figures.
  const latest = day?.latestId ? (todays.find((c) => c.id === day.latestId) ?? null) : null;
  const help: Record<TillDayState, string> = {
    due: t(`help.due.${role === "cashier" ? "cashier" : "other"}`),
    not_counted: t("help.not_counted"),
    awaiting_confirmation: t(`help.awaiting_confirmation.${role === "manager" ? "manager" : "other"}`),
    sent_back: t(`help.sent_back.${role === "cashier" ? "cashier" : "other"}`),
    balanced: t("help.balanced"),
    shortage: t("help.shortage"),
    excess: t("help.excess"),
  };
  const open = state === "due" || state === "sent_back";

  return (
    <Card className="flex flex-col gap-4" data-testid="till-today">
      <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
        <span className="text-sm text-muted-foreground">{formatBusinessDate(today, locale)}</span>
        <TillStateChip state={state} />
      </div>
      <p className="text-sm">{help[state]}</p>
      {latest ? <TillLines count={latest} testId="till-today-figures" /> : null}
      {latest ? <TillRecord count={latest} /> : null}
      {expected !== null && open ? <ExpectedSoFar lines={expected} /> : null}
      {role === "cashier" || role === "manager" ? (
        <TillCountControls
          role={role}
          businessDate={today}
          mayCount={open}
          replaces={
            state === "sent_back" && day?.latestId ? { id: day.latestId, reason: day.latestReturnReason ?? "" } : null
          }
          waiting={state === "awaiting_confirmation" && latest ? toDecide(latest) : null}
        />
      ) : null}
    </Card>
  );
}

/**
 * The days that are not closed, oldest first (§15.2a): Not counted, or a count waiting for the
 * Manager. Each stays here until the day has a confirmed count. The Cashier counts a missed day late
 * from here.
 *
 * The Manager decides past days' waiting counts one at a time, oldest first, in one card above the
 * list. The card's controls stay mounted in the same place while the days move, so the answer to a
 * confirmation stays on screen after its day leaves the list.
 */
export async function OpenTillDays({
  role,
  days,
  pastWaiting,
  otherParams = {},
}: {
  role: AppRole;
  days: Page<OpenTillDay>;
  /** The oldest past day's count waiting for the Manager, for Directors and the Manager. */
  pastWaiting: TillCount | null;
  otherParams?: Record<string, number>;
}) {
  const t = await getTranslations("till.open");
  const locale = await getLocale();
  const stamp = (iso: string) => formatBusinessStamp(iso, locale);
  return (
    <section id="till-open-days" className="flex scroll-mt-4 flex-col gap-3" aria-labelledby="till-open-heading" data-testid="till-open-days">
      <h2 id="till-open-heading" className="text-lg font-semibold">
        {t("title", { count: days.total })}
      </h2>
      <p className="text-sm text-muted-foreground">{t(role === "cashier" ? "helpCashier" : "help")}</p>
      {role === "manager" || role === "director" ? (
        <div className="flex flex-col gap-3" data-testid="till-past-decision">
          {pastWaiting ? (
            <Card className="flex flex-col gap-3" data-testid={`till-past-${pastWaiting.businessDate}`}>
              <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                <h3 className="font-semibold">
                  {t(role === "manager" ? "decideTitle" : "waitingTitle", {
                    date: formatBusinessDate(pastWaiting.businessDate, locale),
                  })}
                </h3>
                <TillStateChip state="awaiting_confirmation" />
              </div>
              <TillLines count={pastWaiting} testId="till-past-figures" />
              <TillRecord count={pastWaiting} />
            </Card>
          ) : null}
          {role === "manager" ? (
            <TillCountControls
              key="past"
              role="manager"
              businessDate={pastWaiting?.businessDate ?? ""}
              mayCount={false}
              replaces={null}
              waiting={pastWaiting ? toDecide(pastWaiting) : null}
            />
          ) : null}
        </div>
      ) : null}
      {days.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {days.rows.map((day) => {
            const date = formatBusinessDate(day.businessDate, locale);
            return (
              <li key={day.businessDate} data-testid={`till-open-${day.businessDate}`}>
                <Card className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                    <span className="font-medium">{date}</span>
                    <TillStateChip state={day.state} />
                  </div>
                  <span className="flex flex-col gap-0.5 text-sm">
                    {day.notCountedSince ? <span>{t("notCountedSince", { when: stamp(day.notCountedSince) })}</span> : null}
                    {day.awaitingSince ? <span>{t("awaitingSince", { when: stamp(day.awaitingSince) })}</span> : null}
                  </span>
                  {/* Mounted whatever the day's state, so the server's answer stays on screen when a
                      late count moves the day to Awaiting Manager confirmation. */}
                  {role === "cashier" ? (
                    <LateTillCountControl
                      businessDate={day.businessDate}
                      dateLabel={date}
                      mayOpen={day.state === "not_counted"}
                      replaces={
                        day.latestStatus === "sent_back" && day.latestId
                          ? { id: day.latestId, reason: day.latestReturnReason ?? "" }
                          : null
                      }
                    />
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
        param="open"
        basePath="/till"
        label={t("title", { count: days.total })}
        otherParams={otherParams}
      />
    </section>
  );
}

/** Every count the viewer may read, most recently entered first. A Cashier's list is their own. */
export async function TillHistory({
  role,
  history,
  otherParams = {},
}: {
  role: AppRole;
  history: Page<TillCount>;
  otherParams?: Record<string, number>;
}) {
  const t = await getTranslations("till.history");
  const locale = await getLocale();
  const title = t(role === "cashier" ? "titleCashier" : "title");
  return (
    <section className="flex flex-col gap-3" aria-labelledby="till-history-heading" data-testid="till-history">
      <h2 id="till-history-heading" className="text-lg font-semibold">
        {title}
      </h2>
      {history.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {history.rows.map((c) => (
            <li key={c.id} data-testid={`till-count-${c.businessDate}-${c.attempt}`}>
              <Card className="flex flex-col gap-3">
                <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                  <span className="font-medium">
                    {t("day", { date: formatBusinessDate(c.businessDate, locale), attempt: c.attempt })}
                  </span>
                  <TillStateChip state={countState(c)} />
                </div>
                <TillLines count={c} testId="till-figures" />
                <TillRecord count={c} />
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
        basePath="/till"
        label={title}
        otherParams={otherParams}
      />
    </section>
  );
}
