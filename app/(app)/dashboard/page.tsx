import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Card, PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";

/**
 * Manager and Director landing (design.md §4.1): the same information architecture, with
 * Director-only controls added for a Director and HIDDEN — not disabled — for a Manager (§4.3).
 */
export default async function DashboardPage() {
  const viewer = await requireAccess("/dashboard");
  const t = await getTranslations();

  return (
    <>
      <PageHeader
        title={t("landing.dashboard.title")}
        description={t("landing.dashboard.description")}
      />

      <Card>
        <p className="text-sm text-muted-foreground">{t("landing.dashboard.empty")}</p>
        <p className="mt-2 text-sm">{t("landing.comingSoon")}</p>
      </Card>

      {viewer.role === "director" ? (
        <Card>
          <h2 className="text-lg font-semibold">{t("admin.accounts.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("admin.accounts.description")}</p>
          <Link
            href="/admin/accounts"
            className="mt-4 inline-flex min-h-11 items-center font-medium text-bronze-text underline-offset-4 hover:underline xl:min-h-8"
          >
            {t("nav.accounts")}
          </Link>
        </Card>
      ) : null}
    </>
  );
}
