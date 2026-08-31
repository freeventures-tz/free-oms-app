"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import {
  addCustomerAction,
  createOrderAction,
  type SalesActionState,
} from "@/app/(app)/orders/actions";
import {
  draftSubtotal,
  emptyDraft,
  OrderLineList,
  ProductPicker,
  type DraftLine,
} from "@/app/(app)/orders/order-lines";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FormError, FormSuccess, Help, Input, Label } from "@/components/ui/field";
import { Card, StatusChip } from "@/components/ui/surface";
import type { CatalogueProduct, Unit } from "@/lib/catalogue/catalogue";
import { formatTzs } from "@/lib/money";
import type { Availability, Customer } from "@/lib/sales/sales";
import { useGuardedAction } from "@/lib/ui/use-guarded-action";
import { cn } from "@/lib/utils";

/**
 * Create New Order (design.md §7.4).
 *
 * THE THREE SECTIONS ARE ALWAYS IN THE DOM, and the phone shows one at a time.
 *
 * §7.4 asks for two different shapes: two columns on a large screen with a sticky summary, and
 * three steps — Customer → Items → Review — on a phone. They are the same three sections either
 * way, so the step is a CSS decision, not a rendering one: every section stays mounted and the
 * inactive ones are hidden below `md`.
 *
 * That is what makes "moving back keeps what was entered" true by construction rather than by
 * remembering to save a draft. There is no unmount, so there is nothing to restore — and no
 * `matchMedia` in the render path either, which would have made the first paint on a phone a guess.
 */

type Step = "customer" | "items" | "review";

const STEPS: Step[] = ["customer", "items", "review"];

/**
 * Which step a field error belongs to.
 *
 * Submitting lives on Review, and every field it can fail on lives on an EARLIER step — which on a
 * phone is a step that is not on screen. Without this the server answered, the answer rendered
 * inside a hidden section, and the person was left pressing a button that appeared to do nothing.
 */
function stepOfField(field: string): Step {
  if (field === "customerId") return "customer";
  return "items";
}

/** The problems, in step order, so the first one named is the first one to fix. */
function problemsFrom(fieldErrors: Record<string, string> | undefined) {
  if (!fieldErrors) return [];
  return Object.entries(fieldErrors)
    .map(([field, message]) => ({ field, message, step: stepOfField(field) }))
    .sort((a, b) => STEPS.indexOf(a.step) - STEPS.indexOf(b.step));
}

export function NewOrderForm({
  customers,
  products,
  units,
  availability,
  idempotencyKey,
}: {
  customers: Customer[];
  products: CatalogueProduct[];
  units: Unit[];
  availability: Availability[];
  idempotencyKey: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();

  const [step, setStep] = useState<Step>("customer");
  const [customerId, setCustomerId] = useState("");
  const [lines, setLines] = useState<DraftLine[]>(emptyDraft());
  const [key, setKey] = useState(idempotencyKey);

  const cashCustomer = customers.find((customer) => customer.isCashCustomer) ?? null;
  const chosenCustomer = customers.find((customer) => customer.id === customerId) ?? null;

  const alertRef = useRef<HTMLDivElement>(null);
  /** Bumped on every refused submission, so a second identical refusal still moves focus. */
  const [refusals, setRefusals] = useState(0);

  const action = useGuardedAction<"create", SalesActionState>({
    failureKey: "salesErrors.generic",
    onSettled: (outcome) => {
      if (outcome.successKey && outcome.createdOrderId) {
        // Straight to the order, where the proforma number is (design.md §7.6). The success state
        // on the way names the order and its proforma and mentions no invoice: telling a customer
        // they have been billed before they agreed to anything is what that rule exists to stop.
        router.push(`/orders/${outcome.createdOrderId}`);
        return;
      }
      if (outcome.successKey) {
        setKey(crypto.randomUUID());
        return;
      }
      // A refusal moves the person TO the first thing that is wrong. Nothing is cleared: every
      // entered value survives, because it is state and this only changes which step is shown.
      const first = problemsFrom(outcome.fieldErrors)[0];
      if (first) setStep(first.step);
      setRefusals((count) => count + 1);
    },
  });
  const { pending, result } = action;

  const problems = problemsFrom(result.fieldErrors);

  // Focus follows the announcement rather than racing it: the alert has to be rendered before it
  // can be focused, so this waits for the commit that renders it.
  useEffect(() => {
    if (refusals > 0) alertRef.current?.focus();
  }, [refusals]);

  const subtotal = draftSubtotal(lines, products);
  const stepIndex = STEPS.indexOf(step);

  /** Hidden below `md` unless it is the active step; always visible from `md` up. */
  function stepClass(section: Step) {
    return cn(step === section ? "flex" : "hidden", "md:flex", "flex-col gap-4");
  }

  return (
    <div className="flex flex-col gap-4 pb-24 md:pb-0">
      <AddCustomerPanel />

      {result.error ? (
        <Card>
          <div className="flex flex-col gap-3">
            <FormError>
              {t(result.error)}
              {result.errorValues?.available !== undefined ? (
                <span className="fv-numeric mt-1 block font-normal">
                  {t("salesErrors.insufficient_stock_detail", result.errorValues)}
                </span>
              ) : null}
            </FormError>
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
        </Card>
      ) : null}

      {/* OUTSIDE the step sections on purpose, so it is on screen whichever step is showing and on
          every tier. `role="alert"` announces it; `tabIndex={-1}` lets focus land on it without
          putting it in the tab order afterwards (design.md §11.6, §12.5). */}
      {problems.length > 0 ? (
        <Card>
          <div
            ref={alertRef}
            role="alert"
            tabIndex={-1}
            data-testid="order-problems"
            className="flex flex-col gap-3 outline-none"
          >
            <h2 className="text-sm font-semibold text-danger">
              {t("sales.newOrder.problemsHeading")}
            </h2>
            <ul className="flex flex-col gap-2">
              {problems.map((problem) => (
                <li
                  key={problem.field}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span className="text-danger">{t(problem.message)}</span>
                  {/* On a phone the failing field is on another step, so the way to it is a
                      control rather than a scroll. Above `md` every step is already on screen and
                      this simply moves nothing. */}
                  <Button
                    type="button"
                    variant="secondary"
                    size="small"
                    id={`goTo-${problem.step}`}
                    disabled={pending}
                    onClick={() => setStep(problem.step)}
                  >
                    {t("sales.newOrder.goToStep", { step: t(`sales.newOrder.step.${problem.step}`) })}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      ) : null}

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6">
        <div className="flex flex-col gap-4">
          <section className={stepClass("customer")} aria-label={t("sales.newOrder.customer")}>
            <Card>
              <div className="flex flex-col gap-3">
                <h2 className="text-sm font-semibold">{t("sales.newOrder.customer")}</h2>
                <CustomerPicker
                  customers={customers}
                  cashCustomer={cashCustomer}
                  customerId={customerId}
                  disabled={pending}
                  onSelect={setCustomerId}
                />
                <FieldError>
                  {result.fieldErrors?.customerId ? t(result.fieldErrors.customerId) : null}
                </FieldError>
                {cashCustomer && customerId === cashCustomer.id ? (
                  // §12.4 and design.md §7A.3: a walk-in sale has no unpaid stage, so it creates no
                  // invoice, no balance and no reservation until it is paid. Saying so here is what
                  // stops somebody expecting a bill that will not come.
                  <Help>{t("sales.newOrder.cashCustomerHelp")}</Help>
                ) : null}
              </div>
            </Card>
          </section>

          <section className={stepClass("items")} aria-label={t("sales.newOrder.items")}>
            <Card>
              <div className="flex flex-col gap-4">
                <h2 className="text-sm font-semibold">{t("sales.newOrder.items")}</h2>
                <FieldError>
                  {result.fieldErrors?.lines ? t(result.fieldErrors.lines) : null}
                </FieldError>

                <ProductPicker
                  products={products}
                  availability={availability}
                  chosen={lines.map((line) => line.productId)}
                  disabled={pending}
                  idPrefix="order"
                  onSelect={(productId) => {
                    setLines((current) =>
                      current.some((line) => line.productId === productId)
                        ? current
                        : [...current, { key: crypto.randomUUID(), productId, quantity: "1" }],
                    );
                  }}
                />

                <OrderLineList
                  lines={lines}
                  products={products}
                  units={units}
                  availability={availability}
                  disabled={pending}
                  fieldErrors={result.fieldErrors}
                  idPrefix="order"
                  onChange={setLines}
                />
              </div>
            </Card>
          </section>
        </div>

        <section
          className={cn(stepClass("review"), "lg:sticky lg:top-4")}
          aria-label={t("sales.newOrder.review")}
        >
          <Card>
            <div className="flex flex-col gap-4">
              <h2 className="text-sm font-semibold">{t("sales.newOrder.review")}</h2>

              <dl className="flex flex-col gap-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t("sales.newOrder.customer")}</dt>
                  <dd className="text-right font-medium" data-testid="review-customer">
                    {chosenCustomer?.name ?? t("sales.newOrder.chooseCustomer")}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t("sales.newOrder.items")}</dt>
                  <dd className="fv-numeric text-right font-medium" data-testid="review-items">
                    {t("sales.newOrder.itemCount", { count: lines.length })}
                  </dd>
                </div>
              </dl>

              {/* The running subtotal, always visible (design.md §7.4). Read-only, and there is no
                  field anywhere on this screen that would accept a total. */}
              <div className="flex items-center justify-between border-t border-border pt-3">
                <span className="text-sm font-medium">{t("sales.newOrder.subtotal")}</span>
                <span className="fv-numeric text-lg font-semibold" data-testid="order-subtotal">
                  {formatTzs(subtotal, locale)}
                </span>
              </div>

              <Button
                type="button"
                id="submitOrder"
                size="block"
                pending={pending}
                pendingLabel={t("common.loading")}
                onClick={() => {
                  const data = new FormData();
                  data.set("customerId", customerId);
                  data.set(
                    "lines",
                    JSON.stringify(
                      lines.map((line) => ({
                        productId: line.productId,
                        quantity: line.quantity,
                      })),
                    ),
                  );
                  data.set("idempotencyKey", key);
                  action.run("create", createOrderAction, data);
                }}
              >
                {t("sales.newOrder.submit")}
              </Button>

              {/* §7.6: the success state names the order and its proforma. It must not imply a
                  bill, so the screen says so before anybody presses anything. */}
              <Help>{t("sales.newOrder.submitConsequence")}</Help>
            </div>
          </Card>
        </section>
      </div>

      {/* The phone's persistent bar: which step, what is on the order, and what it comes to
          (§7.4, §3.5). Primary movement sits within thumb reach at the bottom. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card p-3 md:hidden">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground" data-testid="step-indicator">
              {t("sales.newOrder.stepOf", { step: stepIndex + 1, total: STEPS.length })} ·{" "}
              {t(`sales.newOrder.step.${step}`)}
            </span>
            <span className="fv-numeric text-sm font-semibold" data-testid="running-total">
              {t("sales.newOrder.itemCount", { count: lines.length })} ·{" "}
              {formatTzs(subtotal, locale)}
            </span>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              size="small"
              id="stepBack"
              disabled={stepIndex === 0 || pending}
              onClick={() => setStep(STEPS[Math.max(0, stepIndex - 1)])}
            >
              {t("sales.newOrder.back")}
            </Button>
            <Button
              type="button"
              size="small"
              id="stepNext"
              disabled={stepIndex === STEPS.length - 1 || pending}
              onClick={() => setStep(STEPS[Math.min(STEPS.length - 1, stepIndex + 1)])}
            >
              {t("sales.newOrder.next")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Search-first customer selection (design.md §7.5).
 *
 * Cash Customer is a single prominent preset pinned above the results, not an item lost in a list,
 * because it is the highest-frequency path. Recent-customer chips are NOT here: they need a record
 * of what this person recently sold to, nothing in this release stores one, and a row of chips
 * derived from anything else would be a guess dressed as a shortcut (§14.1).
 */
function CustomerPicker({
  customers,
  cashCustomer,
  customerId,
  disabled,
  onSelect,
}: {
  customers: Customer[];
  cashCustomer: Customer | null;
  customerId: string;
  disabled?: boolean;
  onSelect: (id: string) => void;
}) {
  const t = useTranslations();
  const [query, setQuery] = useState("");

  const needle = query.trim().toLowerCase();
  const results = customers.filter(
    (customer) =>
      !customer.isCashCustomer &&
      (needle.length === 0 || customer.name.toLowerCase().includes(needle)),
  );

  return (
    <div className="flex flex-col gap-3">
      {cashCustomer ? (
        <div>
          <Button
            type="button"
            variant={customerId === cashCustomer.id ? "primary" : "secondary"}
            size="small"
            id="cashCustomer"
            aria-pressed={customerId === cashCustomer.id}
            disabled={disabled}
            onClick={() => onSelect(cashCustomer.id)}
          >
            {t("sales.newOrder.cashCustomer")}
          </Button>
        </div>
      ) : null}

      <Field>
        <Label htmlFor="order-customer-search">{t("sales.newOrder.chooseCustomer")}</Label>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id="order-customer-search"
            type="search"
            autoComplete="off"
            className="pl-9"
            placeholder={t("sales.newOrder.searchCustomer")}
            value={query}
            disabled={disabled}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </Field>

      {results.length === 0 ? (
        <Help>{t("sales.newOrder.noCustomerResults")}</Help>
      ) : (
        <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto" data-testid="customer-results">
          {results.map((customer) => (
            <li key={customer.id}>
              <button
                type="button"
                disabled={disabled}
                aria-pressed={customerId === customer.id}
                onClick={() => onSelect(customer.id)}
                className={cn(
                  "flex min-h-11 w-full items-center justify-between gap-2 rounded-md border p-3 text-left text-sm transition-colors",
                  "hover:bg-[color-mix(in_srgb,var(--fv-periwinkle)_20%,transparent)]",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  "disabled:pointer-events-none disabled:opacity-50",
                  customerId === customer.id
                    ? "border-primary bg-vanilla/40"
                    : "border-border bg-card",
                )}
              >
                <span className="font-medium">{customer.name}</span>
                {customerId === customer.id ? (
                  <StatusChip tone="success">{t("sales.newOrder.selected")}</StatusChip>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Registering a customer without leaving the order being built (design.md §7.5). */
function AddCustomerPanel() {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());

  const action = useGuardedAction<"add", SalesActionState>({
    failureKey: "salesErrors.generic",
    onSettled: (outcome) => {
      if (outcome.successKey) {
        setName("");
        setKey(crypto.randomUUID());
      }
    },
  });
  const { pending, result } = action;

  if (!open) {
    return (
      <div>
        <Button type="button" variant="secondary" id="addCustomer" onClick={() => setOpen(true)}>
          {t("sales.customers.add")}
        </Button>
      </div>
    );
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold">{t("sales.customers.addHeading")}</h2>

      <div className="mt-4 flex flex-col gap-4">
        {result.error ? <FormError>{t(result.error)}</FormError> : null}
        <FormSuccess>{result.successKey ? t(result.successKey) : null}</FormSuccess>

        <Field>
          <Label htmlFor="customer-name">{t("sales.customers.name")}</Label>
          <Input
            id="customer-name"
            type="text"
            autoComplete="off"
            value={name}
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
          />
          <Help>{t("sales.customers.nameHelp")}</Help>
          <FieldError>{result.fieldErrors?.name ? t(result.fieldErrors.name) : null}</FieldError>
        </Field>

        <div className="flex flex-col gap-2 md:flex-row">
          <Button
            type="button"
            id="saveCustomer"
            pending={pending}
            pendingLabel={t("common.loading")}
            onClick={() => {
              const data = new FormData();
              data.set("name", name);
              data.set("idempotencyKey", key);
              action.run("add", addCustomerAction, data);
            }}
          >
            {t("sales.customers.submit")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => setOpen(false)}
          >
            {t("common.cancel")}
          </Button>
        </div>

        {/* The new customer arrives in the picker on the next render of this route, which
            `revalidatePath` triggers. Saying so beats leaving somebody wondering. */}
        <Help>{t("sales.customers.afterAdd")}</Help>
      </div>
    </Card>
  );
}
