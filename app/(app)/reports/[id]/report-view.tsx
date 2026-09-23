"use client";

import { ArrowDown, ArrowUp, ChevronDown, Equal, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { IntegrityChip, StateChip } from "@/app/(app)/reports/report-chips";
import { Card, PageHeader } from "@/components/ui/surface";
import { formatBusinessDate, formatBusinessStamp, intlLocale } from "@/lib/time/business-date";
import { formatTzs } from "@/lib/money";
import {
  readReport,
  type ReportFigure,
  type ReportOverview,
  type ReportSection,
} from "@/lib/reports/report-content";
import type { ReportDetail } from "@/lib/reports/reports";
import { cn } from "@/lib/utils";

/**
 * One report, read (design.md §7.21, §3.5).
 *
 * THE HARD PART OF THIS SCREEN IS THE ABSENCES, not the totals. product.md §15.2a forbids a
 * reconciliation that was never performed from looking like a balanced one, so a figure the
 * snapshot does not carry is rendered as words — "Not recorded" — in the same place a number would
 * have been, and the section carries a sentence saying which fact is missing and why. A dash, a
 * zero, or a hidden row would each turn "nobody counted" into "nothing was wrong".
 *
 * THE SECOND HARD PART IS THAT THERE ARE SEVENTEEN OF THEM. On a 390px phone the sections run to
 * several screens of scrolling, and a Director opening last night's report at the yard gate is
 * asking two questions, not seventeen: what came in, and does anything need me. So the phone gets
 * the overview first and the sections collapsed underneath it, each one still showing its heading
 * and its status chip while shut — an unresolved count is visible without opening anything.
 *
 * FROM TABLET WIDTH THERE IS ROOM, so the sections are open in a two-column grid and the reader
 * collapses one only if they want to. That difference is expressed in CSS rather than in a viewport
 * measured by JavaScript, which is what lets the server render the same markup for every device:
 * an untouched section carries `hidden md:flex`, and only a section the reader has actually pressed
 * is pinned open or shut at every width.
 */
/**
 * A variance, set apart from the amounts it was derived from (design.md §9.7, §11.5).
 *
 * THREE CHANNELS, NOT ONE. The arrow is the shape, the sign is the direction written out, and the
 * icon's own label is the word — so a reader in bright sunlight, a reader who cannot separate hues,
 * and a reader listening to the page all get the same finding. §11.5 exists because a variance
 * shown in red and nothing else is invisible to two of those three.
 *
 * The icon carries `role="img"` and a real label rather than `aria-hidden`, because nothing else on
 * the line says which way the difference goes: a screen reader announcing "minus five thousand" has
 * to guess whether that is money missing or money spare. It hears "Shortfall" instead.
 *
 * ZERO IS NOT SIGNED. A balanced count is neither over nor short, and "+TZS 0" would be a claim
 * about a direction that does not exist.
 */
const VARIANCE_ICON: Record<"surplus" | "shortfall" | "balanced", LucideIcon> = {
  surplus: ArrowUp,
  shortfall: ArrowDown,
  balanced: Equal,
};

function Variance({ value }: { value: number }) {
  const t = useTranslations("reports");
  const locale = useLocale();

  const direction = value > 0 ? "surplus" : value < 0 ? "shortfall" : "balanced";
  const Icon = VARIANCE_ICON[direction];
  // A real minus sign, not a hyphen: it is the same width as the plus beside it, which is the whole
  // point of setting these figures in tabular numerals.
  const sign = value > 0 ? "+" : value < 0 ? "\u2212" : "";

  return (
    <span
      // One step larger and one step heavier than the `text-sm font-medium` figures around it,
      // which is what §9.7 asks of a key figure.
      className="fv-numeric inline-flex items-center gap-1.5 text-base font-semibold"
      data-testid="report-variance"
    >
      <Icon role="img" aria-label={t(`variance.${direction}`)} className="size-4 shrink-0" />
      <span>
        {sign}
        {formatTzs(Math.abs(value), locale)}
      </span>
    </span>
  );
}

function Figure({ figure }: { figure: ReportFigure }) {
  const t = useTranslations("reports");
  const locale = useLocale();

  if (figure.kind === "unknown") {
    return <span className="text-muted-foreground italic">{t("notRecorded")}</span>;
  }

  // Withheld on purpose rather than missing, and said in different words: "not recorded" is a gap
  // in what happened, "not available" is a figure this system cannot give yet. The section states
  // why beneath its heading.
  if (figure.kind === "unavailable") {
    return <span className="text-muted-foreground italic">{t("notAvailable")}</span>;
  }

  if (figure.kind === "text") return <span>{figure.value}</span>;
  if (figure.kind === "variance") return <Variance value={figure.value} />;

  // `fv-numeric` is tabular numerals (design.md §11.3). Money, quantities and counts are read down
  // a column and compared against each other, and proportional digits make a column of figures
  // ragged enough that two totals of the same size look different.
  if (figure.kind === "money") {
    return <span className="fv-numeric">{formatTzs(figure.value, locale)}</span>;
  }

  return (
    <span className="fv-numeric">
      {new Intl.NumberFormat(intlLocale(locale)).format(figure.value)}
    </span>
  );
}

/**
 * Whether the viewport is at least `md` — used for one thing only: telling a screen reader whether
 * a section is currently open.
 *
 * The LAYOUT never asks this hook. CSS decides that, before hydration and without a measurement, so
 * there is no flash of the wrong shape and no server render that disagrees with the client. What
 * CSS cannot do is set `aria-expanded`, and a control that says "collapsed" while its content is on
 * screen is worse for a screen-reader user than one that says nothing. So the attribute — and only
 * the attribute — waits for the browser.
 *
 * It starts `false` so the first client render matches the server's, then corrects itself on mount.
 */
function useWideViewport(): boolean {
  const [wide, setWide] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const sync = () => setWide(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return wide;
}

function Section({ section }: { section: ReportSection }) {
  const t = useTranslations("reports");
  const root = useTranslations();
  const wide = useWideViewport();

  // `null` means "nobody has pressed this one", which is the state the server renders and the only
  // state in which the width decides. Once it is a boolean the reader has chosen, and their choice
  // holds at every width.
  const [pressed, setPressed] = useState<boolean | null>(null);
  const bodyId = `report-section-${section.key}`;
  const open = pressed ?? wide;

  return (
    <Card role="region" aria-label={t(`sections.${section.key}`)}>
      <div className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setPressed((current) => !(current ?? wide))}
            data-testid={`report-toggle-${section.key}`}
            // design.md §11.3: 44px minimum on a phone, where this is the control that opens a
            // section and a thumb has to find it among sixteen others. From `md` the sections start
            // open and the row goes back to being a heading, so the floor is lifted rather than
            // padding out seventeen cards that nobody is tapping.
            className="flex min-h-11 w-full items-start justify-between gap-3 text-start md:min-h-0"
          >
            <span className="flex flex-wrap items-center gap-2">
              {t(`sections.${section.key}`)}
              {/* Shown on the heading rather than inside the body, so a count nobody took is
                  legible on a phone without opening the section it belongs to. */}
              {section.state ? (
                <span data-testid={`report-state-${section.key}`}>
                  <StateChip state={section.state.state} />
                </span>
              ) : null}
            </span>
            <ChevronDown
              aria-hidden
              className={cn(
                "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
                // design.md §12.7 rule 6: a reader who has asked for less motion gets the new
                // state, not the journey to it. The chevron still points the other way; it just
                // arrives there at once. The global reduced-motion block in `globals.css` names
                // specific classes, so a transition added here has to opt out here.
                "motion-reduce:transition-none",
                pressed === null ? "md:rotate-180" : pressed && "rotate-180",
              )}
            />
          </button>
        </h2>

        <div
          id={bodyId}
          className={cn(
            "flex-col gap-4",
            pressed === null ? "hidden md:flex" : pressed ? "flex" : "hidden",
          )}
        >
          {section.state?.missingReasonKey ? (
            <p className="text-sm text-muted-foreground">
              {t(`missingReasons.${section.state.missingReasonKey}`)}
            </p>
          ) : null}

          {section.unavailableReasonKeys.map((reasonKey) => (
            <p
              key={reasonKey}
              className="text-sm text-muted-foreground"
              data-testid={`report-unavailable-${section.key}`}
            >
              {t(`unavailableReasons.${reasonKey}`)}
            </p>
          ))}

          {section.noteKey ? (
            <p className="text-sm text-muted-foreground">{t(`notes.${section.noteKey}`)}</p>
          ) : null}

          <dl className="flex flex-col gap-2">
            {section.rows.map((row) => (
              <div
                key={row.key}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border/60 pb-2 last:border-b-0 last:pb-0"
              >
                <dt className="text-sm text-muted-foreground">{t(`rows.${row.key}`)}</dt>
                <dd className="text-sm font-medium">
                  <Figure figure={row.figure} />
                </dd>
              </div>
            ))}
          </dl>

          {section.breakdown && section.breakdown.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{t("breakdown")}</h3>
              {section.breakdown.map((entry) => (
                <div key={entry.labelKey} className="flex flex-col gap-1 rounded-sm bg-muted/40 p-3">
                  <span className="text-sm font-medium">{root(entry.labelKey)}</span>
                  <dl className="flex flex-wrap gap-x-6 gap-y-1">
                    {entry.rows.map((row) => (
                      <div key={row.key} className="flex items-baseline gap-2">
                        <dt className="text-xs text-muted-foreground">{t(`rows.${row.key}`)}</dt>
                        <dd className="text-sm">
                          <Figure figure={row.figure} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/**
 * The four figures and the one warning a Director reads first.
 *
 * The unresolved line names the sections rather than counting them, because "2 counts unresolved"
 * sends the reader hunting through seventeen headings for which two. Naming them is the difference
 * between a summary and a teaser.
 */
function Overview({ overview }: { overview: ReportOverview }) {
  const t = useTranslations("reports");

  return (
    <Card role="region" aria-label={t("overview.label")}>
      <div className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">{t("overview.label")}</h2>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 xl:grid-cols-4">
          {overview.headline.map((row) => (
            <div key={row.key} className="flex flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">{t(`rows.${row.key}`)}</dt>
              <dd className="text-sm font-semibold">
                <Figure figure={row.figure} />
              </dd>
            </div>
          ))}
        </dl>

        {overview.unresolvedSectionKeys.length > 0 ? (
          <p className="text-sm" data-testid="report-unresolved">
            {t("overview.unresolved", {
              sections: overview.unresolvedSectionKeys
                .map((key) => t(`sections.${key}`))
                .join(t("overview.separator")),
            })}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{t("overview.allResolved")}</p>
        )}
      </div>
    </Card>
  );
}

export function ReportView({ report }: { report: ReportDetail }) {
  const t = useTranslations("reports");
  const roles = useTranslations("admin.roles");
  const locale = useLocale();

  const document = readReport(report.content);
  const businessDate = formatBusinessDate(report.businessDate, locale);
  const generatedAt = formatBusinessStamp(report.generatedAt, locale);

  return (
    <>
      <PageHeader
        title={t("detailTitle", { date: businessDate })}
        description={t("detailDescription", { time: generatedAt })}
      />

      {/* `inline-flex`, because an inline element ignores a height. design.md §11.3 again: this is
          the only way back on a phone, and a 20px line of text is not a target. */}
      <Link
        href="/reports"
        data-testid="report-back"
        className="inline-flex min-h-11 items-center self-start text-sm font-medium text-primary md:min-h-0"
      >
        {t("backToList")}
      </Link>

      {/* The integrity statement is a finding, not decoration: the digest was recomputed from the
          stored snapshot on this read. A report that no longer matches its fingerprint says so
          plainly and tells the reader not to act on it. */}
      <Card role="region" aria-label={t("integrity.label")}>
        <div className="flex flex-col gap-2">
          <span className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">{t("integrity.label")}</h2>
            <IntegrityChip integrity={report.integrity} />
          </span>
          <p className="text-sm text-muted-foreground">
            {t(`integrity.${report.integrity}Detail`)}
          </p>
          <p className="fv-identifier text-xs break-all text-muted-foreground">
            {t("fingerprint")}: {report.contentSha256}
          </p>
        </div>
      </Card>

      <Card role="region" aria-label={t("delivery.label")}>
        <div className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">{t("delivery.label")}</h2>
          <p className="text-sm text-muted-foreground">{t("delivery.inAppOnly")}</p>
          {report.recipients.length === 0 ? (
            // Not a formatting gap: it means the report was written when no Director or Manager
            // account existed. Saying so is the only honest reading (§12.7 rule 7).
            <p className="text-sm">{t("delivery.none")}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {report.recipients.map((recipient) => (
                // Keyed on the account, not on what it is called. A composed key collides the
                // moment two colleagues share a name, and React then reuses one row's DOM for the
                // other.
                <li key={recipient.id} className="text-sm">
                  {recipient.name} — {roles(recipient.role)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {/* A snapshot written by a later schema than this screen understands. Saying so is the honest
          answer; rendering the sections it did recognise and staying quiet about the rest is not. */}
      {document.understood ? null : (
        <Card role="alert">
          <p className="text-sm">{t("unknownSchema")}</p>
        </Card>
      )}

      <Overview overview={document.overview} />

      <div className="grid gap-4 md:grid-cols-2">
        {document.sections.map((section) => (
          <Section key={section.key} section={section} />
        ))}
      </div>
    </>
  );
}
