"use client";

import {
  CircleHelp,
  CircleSlash,
  Clock,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { StatusChip } from "@/components/ui/surface";
import { INTEGRITY_TONE, type ReportIntegrity } from "@/lib/reports/integrity";
import type { ReportState } from "@/lib/reports/report-content";

/**
 * The two chips a report shows, and the third channel each of them carries.
 *
 * design.md §11.5 says a status is never carried by colour alone, and until now this screen met
 * that with a word beside the tone. Two channels is better than one and still asks the reader to
 * read: on a phone held at arm's length in a yard, a column of chips reads as a column of colours
 * and the words arrive second. The icon is the shape channel — an outcome is legible before any of
 * the text is, and it survives a greyscale print, a bright screen and a colour-blind reader.
 *
 * ONE SHAPE PER MEANING, not one per chip. A shield says "this is about whether the file was
 * tampered with"; a clock says "somebody still has to act"; a struck-through circle says "this did
 * not happen". `not_counted` and `awaiting_manager_confirmation` are both unresolved and both keep
 * the attention tone, but they are DIFFERENT unresolved things (product.md §15.2a) and so they get
 * different shapes — which is the distinction most easily lost when a reader is scanning.
 *
 * Both chips live here rather than beside the screens that use them, because the archive card and
 * the report itself must state the same finding the same way. Two copies drift the first time one
 * is corrected.
 */

const INTEGRITY_ICON: Record<ReportIntegrity, LucideIcon> = {
  verified: ShieldCheck,
  failed: ShieldAlert,
  unknown: ShieldQuestion,
};

export function IntegrityChip({ integrity }: { integrity: ReportIntegrity }) {
  const t = useTranslations("reports");
  const Icon = INTEGRITY_ICON[integrity];

  return (
    <StatusChip
      tone={INTEGRITY_TONE[integrity]}
      // `aria-hidden`, because the word beside it already says this to a screen reader. An icon
      // that repeats the label reads it twice and adds nothing.
      icon={<Icon aria-hidden className="size-3.5 shrink-0" />}
    >
      {t(`integrity.${integrity}`)}
    </StatusChip>
  );
}

/**
 * product.md §18.2a: an unresolved count is "marked prominently as `Not counted` or `Awaiting
 * Manager confirmation`". BOTH are unresolved, so both are marked — a count the Manager has not
 * confirmed is not a settled one, and giving it the same quiet chip as `Confirmed` would put the
 * distinction in the wording alone, where a reader scanning the page will miss it.
 */
const STATE_TONE: Record<ReportState, "neutral" | "attention"> = {
  not_counted: "attention",
  awaiting_manager_confirmation: "attention",
  confirmed: "neutral",
  no_fund: "neutral",
  active: "neutral",
};

const STATE_ICON: Record<ReportState, LucideIcon> = {
  not_counted: CircleSlash,
  awaiting_manager_confirmation: Clock,
  confirmed: ShieldCheck,
  no_fund: CircleHelp,
  active: CircleHelp,
};

export function StateChip({ state }: { state: ReportState }) {
  const t = useTranslations("reports");
  const Icon = STATE_ICON[state];

  return (
    <StatusChip
      tone={STATE_TONE[state]}
      icon={<Icon aria-hidden className="size-3.5 shrink-0" />}
    >
      {t(`states.${state}`)}
    </StatusChip>
  );
}
