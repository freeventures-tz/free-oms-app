"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/surface";

/**
 * The temporary password, shown EXACTLY ONCE.
 *
 * It reached this component in one server response and exists nowhere else — not in the database,
 * not in the job row, not in a log. Leaving this panel reloads the page, which destroys the only
 * copy. That is why the warning is stated before the value, and why there is no "show again".
 */
export function TemporaryPasswordPanel({
  password,
  forName,
  onDone,
}: {
  password: string;
  forName: string;
  onDone: () => void;
}) {
  const t = useTranslations();
  const [copied, setCopied] = useState(false);

  return (
    <Card className="border-[color-mix(in_srgb,var(--fv-bronze)_60%,transparent)] bg-[color-mix(in_srgb,var(--fv-vanilla)_35%,transparent)]">
      <h2 className="text-lg font-semibold">{t("admin.accounts.temporaryPasswordTitle")}</h2>
      <p className="mt-2 text-sm">
        {t("admin.accounts.temporaryPasswordWarning", { name: forName })}
      </p>

      <p className="fv-identifier mt-4 rounded-sm border border-border bg-card px-4 py-3 text-lg tracking-wider break-all">
        {password}
      </p>

      <div className="mt-4 flex flex-col gap-3 md:flex-row">
        <Button
          type="button"
          variant="secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(password);
              setCopied(true);
            } catch {
              // Clipboard access can be refused; the value is on screen to be written down.
            }
          }}
        >
          {copied ? t("common.copied") : t("common.copy")}
        </Button>
        <Button type="button" onClick={onDone}>
          {t("admin.accounts.temporaryPasswordDone")}
        </Button>
      </div>
    </Card>
  );
}
