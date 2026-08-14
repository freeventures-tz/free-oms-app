import { getTranslations } from "next-intl/server";

import { CardSkeleton, LoadingRegion, PageHeaderSkeleton } from "@/components/ui/skeleton";

/**
 * The default loading boundary for every screen inside the shell (design.md §12.7 rule 3).
 *
 * Its second job matters as much as its first: because this boundary is static, Next can prefetch
 * it, so tapping a destination commits the route AT ONCE and this stands in until the server
 * answers. Without it a dynamic route shows the previous page, unchanged and unmarked, for as long
 * as the round trips take — which is exactly the two seconds of silence Part A was opened for.
 *
 * The shape is the one every module shell shares: a page header and a single card. A route whose
 * real layout differs supplies its own `loading.tsx` beside its `page.tsx`, because a skeleton of
 * the wrong shape buys the first layout shift with a second one.
 */
export default async function AppLoading() {
  const t = await getTranslations("common");

  return (
    <LoadingRegion label={t("loading")}>
      <PageHeaderSkeleton />
      <CardSkeleton lines={2} />
    </LoadingRegion>
  );
}
