"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, useState } from "react";

import { addProductAction, type CatalogueActionState } from "@/app/(app)/settings/products/actions";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FormError, Help, Input, Label, Select } from "@/components/ui/field";
import { Card } from "@/components/ui/surface";
import type { Unit } from "@/lib/catalogue/catalogue";

/**
 * Adding a product to the catalogue. Director-only, and rendered only for a Director — a Manager
 * does not get a greyed version of this card, they get no card (design.md §4.3, §4.4).
 *
 * A new product arrives with NO PRICE, deliberately. Asking for a price here would make the two
 * decisions one, and they are not: product.md §4 makes pricing a separate Director act with its own
 * immutable record and its own required reason. The product list says "No price set" until then.
 */
export function AddProductForm({
  units,
  idempotencyKey,
}: {
  units: Unit[];
  idempotencyKey: string;
}) {
  const t = useTranslations();

  /**
   * The same guard Stage 10 Part A arrived at for account creation, and for the same reason.
   *
   * React queues form actions and runs them one at a time, handing each the state as it was at
   * DISPATCH — so a burst of taps is not stopped by `disabled`, by an `onSubmit` handler, or by
   * checking the `previous` argument. Only a record of what already succeeded survives that gap.
   * Here the consequence of a second submission is a duplicate product rather than a lost
   * credential, but the mechanism is identical.
   */
  const added = useRef(false);

  async function addOnce(
    previous: CatalogueActionState,
    data: FormData,
  ): Promise<CatalogueActionState> {
    if (added.current) return previous;
    try {
      const result = await addProductAction(previous, data);
      if (result.successKey) added.current = true;
      return result;
    } catch {
      // Thrown, not returned: the request never reached a verdict. Left uncaught it escapes into
      // the shell's error boundary and takes the typed details with it.
      return { error: "catalogueErrors.generic" };
    }
  }

  const [state, formAction, pending] = useActionState<CatalogueActionState, FormData>(addOnce, {});

  /**
   * Held in state, because React clears an uncontrolled field once a form action completes —
   * including when it completes with a refusal. A Director who hit "that product already exists"
   * would otherwise have to type the whole thing again (design.md §12.5).
   */
  const [name, setName] = useState("");
  const [specification, setSpecification] = useState("");
  const [unitCode, setUnitCode] = useState(units[0]?.code ?? "");

  /**
   * A `<select>` needs putting back by hand after that reset and an `<input>` does not: React
   * restores a controlled text field itself but leaves a select showing the first option, while
   * still believing the chosen value is current.
   */
  const unitField = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (unitField.current && unitField.current.value !== unitCode) {
      unitField.current.value = unitCode;
    }
  }, [state, unitCode]);

  if (state.successKey) {
    return (
      <Card>
        <p className="text-sm text-success">
          {t(state.successKey, { name: state.successName ?? "" })}
        </p>
        <Button
          type="button"
          variant="secondary"
          size="small"
          className="mt-3"
          // A fresh idempotency key is needed for the next product, and it is minted on the server
          // so the two sides cannot disagree about it.
          onClick={() => window.location.reload()}
        >
          {t("catalogue.add.heading")}
        </Button>
      </Card>
    );
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold">{t("catalogue.add.heading")}</h2>

      <form action={formAction} className="mt-4 flex flex-col gap-5" noValidate>
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

        <FormError>{state.error ? t(state.error) : null}</FormError>

        <Field>
          <Label htmlFor="productName">{t("catalogue.add.name")}</Label>
          <Input
            id="productName"
            name="name"
            required
            autoComplete="off"
            disabled={pending}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Help>{t("catalogue.add.nameHelp")}</Help>
          <FieldError>{state.fieldErrors?.name ? t(state.fieldErrors.name) : null}</FieldError>
        </Field>

        <Field>
          <Label htmlFor="productSpecification">{t("catalogue.add.specification")}</Label>
          <Input
            id="productSpecification"
            name="specification"
            autoComplete="off"
            className="fv-identifier"
            disabled={pending}
            value={specification}
            onChange={(event) => setSpecification(event.target.value)}
          />
          <Help>{t("catalogue.add.specificationHelp")}</Help>
          <FieldError>
            {state.fieldErrors?.specification ? t(state.fieldErrors.specification) : null}
          </FieldError>
        </Field>

        <Field>
          <Label htmlFor="productUnit">{t("catalogue.add.unit")}</Label>
          <Select
            ref={unitField}
            id="productUnit"
            name="unitCode"
            value={unitCode}
            disabled={pending}
            onChange={(event) => setUnitCode(event.target.value)}
          >
            {units.map((unit) => (
              <option key={unit.code} value={unit.code}>
                {t(`catalogue.units.${unit.code}`)}
              </option>
            ))}
          </Select>
          <FieldError>
            {state.fieldErrors?.unitCode ? t(state.fieldErrors.unitCode) : null}
          </FieldError>
        </Field>

        <Button type="submit" pending={pending} pendingLabel={t("common.loading")}>
          {t("catalogue.add.submit")}
        </Button>
      </form>
    </Card>
  );
}
