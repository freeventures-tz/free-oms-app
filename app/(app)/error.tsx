"use client";

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

  return (
    <>
      <PageHeader title={t("title")} />
      <Card>
        <div role="alert" className="flex flex-col items-start gap-4">
          <p className="text-sm text-muted-foreground">{t("body")}</p>
          <Button type="button" onClick={() => retry()}>
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
