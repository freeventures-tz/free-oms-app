import { getTranslations } from "next-intl/server";

import { OpenTillDays, TillHistory, TillTodaySection } from "@/app/(app)/till/till-count";
import { PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import { pageNumber } from "@/lib/settlement/settlement";
import { businessDate } from "@/lib/time/business-date";
import type { TillCount } from "@/lib/till/counting";
import {
  loadOpenTillDays,
  loadTillCounts,
  loadTillDayCounts,
  loadTillExpected,
  loadTillToday,
} from "@/lib/till/counts";

/**
 * The daily till count (issue #83, design.md §7.19). One screen for the Cashier, the Manager and
 * Directors, with role-specific actions and information:
 *
 *   Cashier   enters the count for each payment method, without seeing what is expected, and reads
 *             only the counts they entered. Counts a missed day late.
 *   Manager   sees what is expected so far today, every count, and confirms or sends back.
 *   Director  reads everything and decides nothing here.
 *
 * What each role may read is decided by the database; this page only chooses what to ask for.
 */
export default async function TillPage({ searchParams }: PageProps<"/till">) {
  const viewer = await requireAccess("/till");
  const params = await searchParams;
  const t = await getTranslations("till");
  const today = businessDate();
  const seesExpected = viewer.role === "manager" || viewer.role === "director";

  const [day, todays, open, history, expected] = await Promise.all([
    loadTillToday(today),
    loadTillDayCounts(today),
    loadOpenTillDays(pageNumber(params.open)),
    loadTillCounts(pageNumber(params.counts)),
    seesExpected ? loadTillExpected(today) : null,
  ]);

  // The oldest past day whose count waits for the Manager, decided one at a time above the list.
  // Today's count is decided on today's card, so it is not offered twice. The open list is oldest
  // first, so its first page holds the oldest; a Cashier is not offered it at all.
  const pastDay = seesExpected
    ? open.rows.find((d) => d.state === "awaiting_confirmation" && d.businessDate !== today)
    : undefined;
  const pastWaiting: TillCount | null = pastDay
    ? ((await loadTillDayCounts(pastDay.businessDate)).find((c) => c.status === "awaiting_confirmation") ?? null)
    : null;

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <TillTodaySection role={viewer.role} today={today} day={day} todays={todays} expected={expected} />
      <OpenTillDays role={viewer.role} days={open} pastWaiting={pastWaiting} otherParams={{ counts: history.page }} />
      <TillHistory role={viewer.role} history={history} otherParams={{ open: open.page }} />
    </>
  );
}
