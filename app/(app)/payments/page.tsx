import { getTranslations } from "next-intl/server";

import { Card, PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";

/** Cashier landing (design.md §4.1): work arrives as a queue to clear. Module shell only. */
export default async function PaymentsPage() {
  await requireAccess("/payments");
  const t = await getTranslations("landing");

  return (
    <>
      <PageHeader title={t("payments.title")} description={t("payments.description")} />
      <Card>
        <p className="text-sm text-muted-foreground">{t("payments.empty")}</p>
        <p className="mt-2 text-sm">{t("comingSoon")}</p>
      </Card>
    </>
  );
}
