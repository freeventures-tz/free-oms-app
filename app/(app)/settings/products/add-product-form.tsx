"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import {
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent,
} from "react";

import {
  addProductAction,
  addUnitAction,
  type AddUnitActionState,
  type CatalogueActionState,
} from "@/app/(app)/settings/products/actions";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FormError,
  FormSuccess,
  Help,
  Input,
  Label,
  Select,
} from "@/components/ui/field";
import { Card } from "@/components/ui/surface";
import type { Unit } from "@/lib/catalogue/catalogue";
import { unitLabel } from "@/lib/catalogue/unit-label";
import { useGuardedAction } from "@/lib/ui/use-guarded-action";

/**
 * Adding a product to the catalogue. Director-only, and rendered only for a Director — a Manager
 * does not get a greyed version of this card, they get no card (design.md §4.3, §4.4).
 *
 * A new product arrives with NO PRICE, deliberately. Asking for a price here would make the two
 * decisions one, and they are not: product.md §4 makes pricing a separate Director act with its own
 * immutable record and its own required reason. The product list says "No price set" until then.
 *
 * The form asks two separate questions about measurement, because they are two facts
 * (product.md §6): what the yard COUNTS — a bag, a bucket, a piece — and, optionally, what one of
 * those HOLDS. Nothing converts between them. A 50 kg bag and a 25 kg bag are two products here,
 * and both are meant to exist.
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
  const locale = useLocale();

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
  const [unitContent, setUnitContent] = useState("");

  /**
   * Units created during THIS interaction, merged over the ones the server sent.
   *
   * A Director who needs a `drum` gets it without leaving the form and without a reload, which is
   * the whole point: a reload would take the name, specification and content with it. After the
   * next refresh the server sends the same unit and the merge de-duplicates by code.
   */
  const [createdUnits, setCreatedUnits] = useState<Unit[]>([]);

  /**
   * True while the inline unit panel is open, including while its request is in flight.
   *
   * The panel lives INSIDE the product form, so for as long as it is open the Director is part-way
   * through a different decision. Leaving Add product live during that meant a tap — or an Enter —
   * could commit a product against the unit that was selected BEFORE the new one arrived, and a
   * product's counting unit cannot be edited afterwards (product.md §6, AC-119).
   */
  const [unitSubflowActive, setUnitSubflowActive] = useState(false);

  const activeUnits = useMemo(() => {
    const byCode = new Map<string, Unit>();
    // Only ACTIVE units are offered. The retired package-specific rows still exist so old products
    // can name their unit, and must never be chosen again (product.md §6).
    // BOTH sources are filtered. A unit created during this interaction went through the same
    // command and the same mapper as a loaded one, and gets the same question asked of it: a
    // freshly created row that comes back inactive is not a shortcut past the filter.
    for (const unit of [...units, ...createdUnits]) {
      if (unit.isActive) byCode.set(unit.code, unit);
    }
    return [...byCode.values()].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.labelEn.localeCompare(b.labelEn),
    );
  }, [units, createdUnits]);

  const [unitCode, setUnitCode] = useState(() => units.find((unit) => unit.isActive)?.code ?? "");

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
  }, [state, unitCode, activeUnits]);

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
          id="addAnother"
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
            {activeUnits.map((unit) => (
              // The label a Director typed, in the reader's language. Not a message key: a unit
              // created this morning has no message file behind it (design.md §8.2).
              <option key={unit.code} value={unit.code}>
                {unitLabel(unit, locale)}
              </option>
            ))}
          </Select>
          <Help>{t("catalogue.add.unitHelp")}</Help>
          <FieldError>
            {state.fieldErrors?.unitCode ? t(state.fieldErrors.unitCode) : null}
          </FieldError>

          <NewUnitPanel
            disabled={pending}
            onActiveChange={setUnitSubflowActive}
            onCreated={(unit) => {
              // Selecting a unit the picker will not offer would leave the form pointing at an
              // option that is not there. Nothing that cannot be chosen gets chosen.
              if (!unit.isActive) return;
              setCreatedUnits((existing) => [...existing, unit]);
              setUnitCode(unit.code);
            }}
          />
        </Field>

        <Field>
          <Label htmlFor="productContent">{t("catalogue.add.content")}</Label>
          <Input
            id="productContent"
            name="unitContent"
            autoComplete="off"
            disabled={pending}
            value={unitContent}
            onChange={(event) => setUnitContent(event.target.value)}
          />
          <Help>{t("catalogue.add.contentHelp")}</Help>
          <FieldError>
            {state.fieldErrors?.unitContent ? t(state.fieldErrors.unitContent) : null}
          </FieldError>
        </Field>

        <div className="flex flex-col gap-2">
          <Button
            id="addProduct"
            type="submit"
            disabled={unitSubflowActive}
            pending={pending}
            pendingLabel={t("common.loading")}
          >
            {t("catalogue.add.submit")}
          </Button>
          {/* Disabled, and it says why (design.md §4.4). Disabling the default button also stops
              the browser's implicit submission, so Enter anywhere in the product fields is closed
              by the same change rather than by a second guard that could drift from this one. */}
          {unitSubflowActive ? <Help>{t("catalogue.add.finishUnitFirst")}</Help> : null}
        </div>
      </form>
    </Card>
  );
}

/**
 * Creating a counting unit without leaving the product form (design.md §7.12a).
 *
 * Not a nested `<form>` — that is invalid HTML and the browser would submit the outer one. The
 * controls build their own `FormData` and hand it to `useGuardedAction`, exactly as the price form
 * does, which also gets the §12.7 behaviour for free: one operation per burst, a pending state that
 * belongs to the control pressed, and a retry that reuses the SAME idempotency key rather than
 * minting a second unit.
 */
function NewUnitPanel({
  disabled,
  onActiveChange,
  onCreated,
}: {
  disabled: boolean;
  /** Told whenever this panel takes or releases the form. */
  onActiveChange: (active: boolean) => void;
  onCreated: (unit: Unit) => void;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [labelEn, setLabelEn] = useState("");
  const [labelSw, setLabelSw] = useState("");

  /**
   * One idempotency key per unit, minted in an initialiser so the server and the client never
   * disagree about it, and rotated only once a unit has actually been created. A retry after a
   * failure therefore addresses the same unit rather than asking for a second one.
   *
   * Named for what it is: `key` reads like React's list key three lines from a `map`, and this is
   * the value that decides whether a second request creates a second unit.
   */
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const action = useGuardedAction<"createUnit", AddUnitActionState>({
    failureKey: "catalogueErrors.generic",
    onSettled: (outcome) => {
      if (!outcome.unit) return;
      onCreated(outcome.unit);
      setOpen(false);
      setLabelEn("");
      setLabelSw("");
      // Rotated only here, after the server confirmed a unit exists. Rotating on failure would let
      // a retry create a second one.
      setIdempotencyKey(crypto.randomUUID());
    },
  });
  const { pending, result } = action;

  // Reported from one place rather than from each of the three sites that open or close the panel,
  // so a future fourth cannot forget to hand the form back.
  useEffect(() => {
    onActiveChange(open);
  }, [open, onActiveChange]);

  /**
   * Enter inside this panel means "save this counting unit".
   *
   * Without this it means "submit the product", because these fields sit inside the product form
   * and the browser's implicit submission finds that form's default button. A Director typing a
   * label and pressing Enter would create a product against the OLD unit, and there is no path to
   * edit a product's unit afterwards.
   */
  function submitOnEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    submit();
  }

  function submit() {
    const data = new FormData();
    data.set("labelEn", labelEn);
    data.set("labelSw", labelSw);
    data.set("idempotencyKey", idempotencyKey);
    action.run("createUnit", addUnitAction, data);
  }

  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        {/* Confirmation of the last unit created, shown beside the select it was added to, and
            announced politely so a screen-reader user learns the unit exists and is selected. It
            is rendered only from a result the SERVER returned (§12.7 rule 5). */}
        <FormSuccess className="text-xs">
          {result.successKey ? t(result.successKey) : null}
        </FormSuccess>
        <div>
          <Button
            type="button"
            variant="ghost"
            size="small"
            disabled={disabled}
            onClick={() => {
              action.clear();
              setOpen(true);
            }}
          >
            {t("catalogue.add.newUnit")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-1 flex flex-col gap-4 rounded-sm border border-border bg-background p-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">{t("catalogue.add.newUnitHeading")}</h3>
        <Help>{t("catalogue.add.newUnitHelp")}</Help>
      </div>

      {result.error ? (
        <div className="flex flex-col gap-3">
          <FormError>{t(result.error)}</FormError>
          {action.retry ? (
            <div>
              <Button
                type="button"
                variant="secondary"
                size="small"
                pending={pending}
                pendingLabel={t("common.loading")}
                onClick={action.retry}
              >
                {t("common.retry")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <Field>
        <Label htmlFor="unitLabelEn">{t("catalogue.add.unitLabelEn")}</Label>
        <Input
          id="unitLabelEn"
          autoComplete="off"
          disabled={pending}
          onKeyDown={submitOnEnter}
          value={labelEn}
          onChange={(event) => setLabelEn(event.target.value)}
        />
        <FieldError>
          {result.fieldErrors?.labelEn ? t(result.fieldErrors.labelEn) : null}
        </FieldError>
      </Field>

      <Field>
        <Label htmlFor="unitLabelSw">{t("catalogue.add.unitLabelSw")}</Label>
        <Input
          id="unitLabelSw"
          autoComplete="off"
          disabled={pending}
          onKeyDown={submitOnEnter}
          value={labelSw}
          onChange={(event) => setLabelSw(event.target.value)}
        />
        <FieldError>
          {result.fieldErrors?.labelSw ? t(result.fieldErrors.labelSw) : null}
        </FieldError>
      </Field>

      <div className="flex flex-col gap-3 md:flex-row">
        <Button
          id="saveUnit"
          type="button"
          size="small"
          pending={pending}
          pendingLabel={t("common.loading")}
          onClick={submit}
        >
          {t("catalogue.add.unitSubmit")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="small"
          disabled={pending}
          onClick={() => setOpen(false)}
        >
          {t("catalogue.add.unitCancel")}
        </Button>
      </div>
    </div>
  );
}
