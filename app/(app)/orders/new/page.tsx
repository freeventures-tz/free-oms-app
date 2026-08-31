import { randomUUID } from "node:crypto";

import { getTranslations } from "next-intl/server";

import { NewOrderForm } from "@/app/(app)/orders/new/new-order-form";
import { PageHeader } from "@/components/ui/surface";
import { requireAccess } from "@/lib/auth/guard";
import { loadCatalogue } from "@/lib/catalogue/catalogue";
import { loadAvailability, loadCustomers } from "@/lib/sales/sales";

/**
 * Create New Order (design.md §7.4).
 *
 * The screen exists to make an order out of as little typing as possible (product.md §5): the
 * customer is selected, the product is selected, the quantity is a number, and every total on the
 * page is calculated. There is no price field and no total field, because §5.2 says there must not
 * be one.
 *
 * A product with no approved price is offered but cannot be added, and the screen says why. That is
 * deliberate rather than filtering it out: "we do not sell that" and "nobody has priced it yet" are
 * different answers, and only one of them is a Director's to fix.
 */
export default async function NewOrderPage() {
  await requireAccess("/orders");
  const t = await getTranslations("sales.newOrder");

  const [customers, catalogue, availability] = await Promise.all([
    loadCustomers(),
    loadCatalogue(),
    loadAvailability(),
  ]);

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <NewOrderForm
        customers={customers.filter((customer) => customer.isActive)}
        products={catalogue.products.filter((product) => product.isActive)}
        units={catalogue.units}
        availability={availability}
        idempotencyKey={randomUUID()}
      />
    </>
  );
}
