import { getTranslations } from "next-intl/server";

import { OpenTillDays, TillHistory, TillTodaySection } from "@/app/(app)/till/till-count";
import { PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import { pageNumber } from "@/lib/settlement/settlement";
import { businessDate } from "@/lib/time/business-date";
import type { TillCount } from "@/lib/till/counting";
import {
  loadOldestWaitingDay,
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
  const serverToday = businessDate();
  const seesExpected = viewer.role === "manager" || viewer.role === "director";

  const [day, serverTodays, open, history, serverExpected, oldestWaiting] = await Promise.all([
    loadTillToday(),
    loadTillDayCounts(serverToday),
    loadOpenTillDays(pageNumber(params.open)),
    loadTillCounts(pageNumber(params.counts)),
    seesExpected ? loadTillExpected(serverToday) : null,
    seesExpected ? loadOldestWaitingDay() : null,
  ]);

  // Today is the database's day, which is the one it accepts a count for. On the rare request that
  // straddles midnight in Dar es Salaam the two clocks differ, and today's reads are repeated for it.
  const today = day?.businessDate ?? serverToday;
  const [todays, expected] =
    today === serverToday
      ? [serverTodays, serverExpected]
      : await Promise.all([loadTillDayCounts(today), seesExpected ? loadTillExpected(today) : null]);

  // The oldest past day whose count waits for the Manager, decided one at a time above the list,
  // found whatever page of open days it is on. Today's count is decided on today's card, so it is
  // not offered twice. A Cashier is not offered it at all.
  const pastWaiting: TillCount | null =
    oldestWaiting && oldestWaiting.businessDate < today
      ? ((await loadTillDayCounts(oldestWaiting.businessDate)).find((c) => c.status === "awaiting_confirmation") ??
        null)
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
