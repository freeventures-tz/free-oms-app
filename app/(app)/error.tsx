"use client";

import { useEffect, useRef, useTransition } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/surface";

/**
 * The third kind of error (design.md §12.5): the system is unavailable.
 *
 * Validation errors sit next to their field and operation failures sit on the affected record, both
 * inline. This one is different in kind — the page has no content to attach a message to, so it is
 * page-level, and it must offer a way forward rather than leave a dead screen.
 *
 * It is scoped to the application shell rather than the whole site, so the sidebar, the language
 * switcher and the sign-out control all survive: a database that cannot be reached is no reason to
 * throw someone out of the application.
 *
 * `retry` re-fetches the segment, which is what a person means by trying again. `reset` would only
 * clear the error and re-render the same failed content.
 *
 * THE RETRY IS PENDING UNTIL THE REFRESH ACTUALLY SETTLES (design.md §12.7). `retry()` returns at
 * once: it only starts Next's own transition, which refreshes the router and clears the boundary,
 * and the new server content arrives later. Treating that return as completion left a live button
 * on a screen that was still waiting, so each press sent another refresh and none was
 * acknowledged. So `retry()` is called inside this component's own transition. Next's refresh and
 * reset are both scheduled synchronously inside it, so they share its lane, and `isPending` stays
 * true until that render commits. That is either the recovered page, which replaces this one, or
 * this fallback again after another failure. In the second case the button is live for a fresh,
 * deliberate retry. There is no timer, because a timer would only guess when the read finished.
 *
 * `pending` gives the Button its fixed size, spinner, `aria-busy` and `disabled`. The ref covers
 * the gap before `disabled` commits, so two activations dispatched in one tick cannot both start a
 * refresh, which is the same guard `useGuardedAction` keeps for writes.
 *
 * The message says three things on purpose — nothing was lost, nothing was changed, try again —
 * because the reasonable fear when a screen that moves money fails is that something half-happened.
 * The underlying error is deliberately not shown: it is a database message, and it is of no use to
 * a Director and of some use to anyone else.
 */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const t = useTranslations("unavailable");
  const common = useTranslations("common");
  const [pending, startTransition] = useTransition();
  const started = useRef(false);

  // Released only once the transition has settled, never on the synchronous return of `retry()`.
  useEffect(() => {
    if (!pending) started.current = false;
  }, [pending]);

  function tryAgain() {
    if (started.current) return;
    started.current = true;
    startTransition(() => retry());
  }

  return (
    <>
      <PageHeader title={t("title")} />
      <Card>
        <div role="alert" className="flex flex-col items-start gap-4">
          <p className="text-sm text-muted-foreground">{t("body")}</p>
          <Button
            type="button"
            onClick={tryAgain}
            pending={pending}
            pendingLabel={common("loading")}
          >
            {t("retry")}
          </Button>
          {/* The digest is the only handle on the server-side log for this exact failure, and it
              carries no detail of its own. Shown quietly so it can be quoted when reporting. */}
          {error.digest ? (
            <p className="fv-identifier text-xs text-muted-foreground">{error.digest}</p>
          ) : null}
        </div>
      </Card>
    </>
  );
}
