"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";

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
 *
 * This outer component exists for one reason: to prepare the NEXT product without a page reload.
 *
 * The fields below carry state that must be genuinely empty for a new product — the entered values,
 * the guard that remembers a product was already added, and `useActionState`, which has no reset.
 * A remount is the only honest way to clear all three, so the fields are keyed on a generation this
 * component owns and bumps once a fresh idempotency key has actually arrived from the server.
 *
 * Keying them on the idempotency key itself would look simpler and be wrong: the Server Action
 * revalidates this route, so a new key arrives the moment the add succeeds — and the confirmation
 * the Director is still reading would vanish before they had read it.
 */
export function AddProductForm({
  units,
  idempotencyKey,
}: {
  units: Unit[];
  idempotencyKey: string;
}) {
  const t = useTranslations();
  const router = useRouter();

  const [generation, setGeneration] = useState(0);
  const [preparing, startPreparing] = useTransition();
  const [prepareFailed, setPrepareFailed] = useState(false);

  /**
   * The key we asked the server to replace. `null` when nothing was asked for.
   *
   * Also the single-flight guard: written synchronously inside the handler, before React has
   * committed anything, so a burst of taps in one tick cannot start two refreshes. `disabled`
   * closes the control only after that commit — the same gap Stage 10 Part A found on the account
   * screens.
   */
  const requestedFrom = useRef<string | null>(null);

  useEffect(() => {
    if (preparing) return;
    if (requestedFrom.current === null) return;

    if (requestedFrom.current !== idempotencyKey) {
      // A fresh key arrived: the refresh landed, and the catalogue below now includes the product
      // that was just added. Give the Director an empty form to type the next one into.
      requestedFrom.current = null;
      setPrepareFailed(false);
      setGeneration((value) => value + 1);
    } else {
      // The transition finished and the key is unchanged, so the server was never reached. Say so,
      // and leave the control offered: pressing it again is the whole remedy.
      requestedFrom.current = null;
      setPrepareFailed(true);
    }
  }, [preparing, idempotencyKey]);

  function prepareAnother() {
    if (requestedFrom.current !== null) return;
    requestedFrom.current = idempotencyKey;
    setPrepareFailed(false);

    // Inside the transition, so `preparing` stays true until the new tree has actually committed —
    // which is what makes the pending state honest rather than decorative.
    startPreparing(() => {
      router.refresh();
    });
  }

  return (
    <AddProductFields
      key={generation}
      units={units}
      idempotencyKey={idempotencyKey}
      preparing={preparing}
      prepareFailed={prepareFailed}
      onPrepareAnother={prepareAnother}
      addAnotherLabel={t("catalogue.add.another")}
      pendingLabel={t("common.loading")}
      prepareFailedMessage={t("catalogueErrors.generic")}
    />
  );
}

function AddProductFields({
  units,
  idempotencyKey,
  preparing,
  prepareFailed,
  onPrepareAnother,
  addAnotherLabel,
  pendingLabel,
  prepareFailedMessage,
}: {
  units: Unit[];
  idempotencyKey: string;
  preparing: boolean;
  prepareFailed: boolean;
  onPrepareAnother: () => void;
  addAnotherLabel: string;
  pendingLabel: string;
  prepareFailedMessage: string;
}) {
  const t = useTranslations();

  /**
   * The product this form has already added, remembered outside React state.
   *
   * A burst of taps raises a burst of submissions, and the obvious guards do not stop the second
   * one. React queues form actions and hands each the state as it was at DISPATCH, so checking the
   * `previous` argument is told the form is still empty; `disabled` closes the button only after
   * React commits; an `onSubmit` handler is delegated at the root and runs too late. Only a record
   * of what already succeeded survives that gap — the same conclusion Stage 10 Part A reached for
   * account creation, where the cost was a lost credential rather than a duplicate product.
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

        {prepareFailed ? (
          <div className="mt-3">
            <FormError>{prepareFailedMessage}</FormError>
          </div>
        ) : null}

        <Button
          type="button"
          variant="secondary"
          size="small"
          className="mt-3"
          pending={preparing}
          pendingLabel={pendingLabel}
          onClick={onPrepareAnother}
        >
          {addAnotherLabel}
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
