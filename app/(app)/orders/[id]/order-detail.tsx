"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import {
  approveDiscountAction,
  cancelOrderAction,
  confirmOrderAction,
  rejectDiscountAction,
  requestDiscountAction,
  reviseOrderAction,
  type SalesActionState,
} from "@/app/(app)/orders/actions";
import {
  draftFrom,
  draftSubtotal,
  OrderLineList,
  ProductPicker,
  type DraftLine,
} from "@/app/(app)/orders/order-lines";
import { Button } from "@/components/ui/button";
import { ConfirmSheet } from "@/components/ui/confirm-sheet";
import { Field, FieldError, FormError, FormSuccess, Help, Input, Label } from "@/components/ui/field";
import { Card, StatusChip } from "@/components/ui/surface";
import type { CatalogueProduct, Unit } from "@/lib/catalogue/catalogue";
import { formatTzs } from "@/lib/money";
import { mayDecideDiscount } from "@/lib/sales/discount-authority";
import type { Availability, Order, Proforma } from "@/lib/sales/sales";
import type { AppRole } from "@/lib/auth/roles";
import { useGuardedAction } from "@/lib/ui/use-guarded-action";

export function OrderDetail({
  order,
  products,
  units,
  availability,
  role,
  idempotencyKey,
}: {
  order: Order;
  products: CatalogueProduct[];
  units: Unit[];
  availability: Availability[];
  role: AppRole;
  idempotencyKey: string;
}) {
  const t = useTranslations();
  const locale = useLocale();

  const live = order.proformas.find((proforma) => proforma.supersededAt === null) ?? null;
  const history = order.proformas.filter((proforma) => proforma.supersededAt !== null);

  const canAct =
    role === "sales_rep" || role === "manager" || role === "director";

  /**
   * The order total AS IT IS NOW — the same figure `private.order_totals` sums, and the figure the
   * database judges a discount decision against. Reading `required_role` off the request instead
   * would be reading a decision made when the request was raised, and the order can be revised
   * afterwards (product.md §4).
   */
  const currentSubtotal = order.lines.reduce((sum, line) => sum + line.lineTotalTzs, 0);

  const canDecideDiscount =
    order.discount !== null &&
    mayDecideDiscount(role, order.discount.requestedPercent, currentSubtotal);

  const discountPending = order.discount?.status === "pending";
  const expired =
    live !== null && new Date(live.validUntil) < new Date(new Date().toDateString());

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip
              tone={
                order.status === "confirmed"
                  ? "success"
                  : order.status === "cancelled"
                    ? "danger"
                    : "attention"
              }
            >
              {t(`sales.orders.status.${order.status}`)}
            </StatusChip>
            {order.isCashSale ? (
              <StatusChip tone="neutral">{t("sales.orders.cashSale")}</StatusChip>
            ) : null}
          </div>

          <p className="text-xs text-muted-foreground">
            {t("sales.orders.createdBy", {
              who: order.createdByName,
              role: t(`admin.roles.${order.createdRole}`),
            })}
          </p>

          {order.cancelReason ? (
            <p className="text-xs text-muted-foreground">
              {t("sales.orders.cancelledBecause", { reason: order.cancelReason })}
            </p>
          ) : null}

          {/* §12.1 point 3 made unmissable: the whole risk of this screen is a reader treating a
              quotation as a bill. */}
          {order.status === "proforma" ? <Help>{t("sales.orders.proformaIsNotABill")}</Help> : null}
        </div>
      </Card>

      {live ? <ProformaCard proforma={live} live /> : null}

      {/* The invoice appears only once one exists (design.md §7.6). Before confirmation there is
          nothing here at all, rather than an empty placeholder implying a bill is on its way. */}
      {order.invoice ? (
        <Card role="article" aria-label={order.invoice.invoiceNo}>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-col gap-1">
                <h2 className="text-sm font-semibold">{t("sales.invoice.heading")}</h2>
                <span className="fv-identifier text-sm">{order.invoice.invoiceNo}</span>
              </div>
              {/* §12.3: the status is CALCULATED from money received, never chosen. No payment
                  exists yet in this stage, so it is Unpaid — and it says Unpaid rather than
                  pretending the question has not been asked. */}
              <StatusChip tone={order.invoice.cancelledAt ? "danger" : "attention"}>
                {order.invoice.cancelledAt
                  ? t("sales.invoice.cancelled")
                  : t("sales.invoice.unpaid")}
              </StatusChip>
            </div>

            <LineTable lines={order.invoice.lines} locale={locale} />

            <Totals
              subtotal={order.invoice.subtotalTzs}
              discount={order.invoice.discountTzs}
              total={order.invoice.totalTzs}
              locale={locale}
            />

            {order.invoice.cancelReason ? (
              <p className="text-xs text-muted-foreground">
                {t("sales.invoice.cancelledBecause", { reason: order.invoice.cancelReason })}
              </p>
            ) : null}

            <Help>{t("sales.invoice.immutable")}</Help>
          </div>
        </Card>
      ) : null}

      {/* Reserved, not moved. §8.1 and AC-34: the goods are physically present and simply cannot
          be sold again. */}
      {order.reservedQuantity > 0 ? (
        <Card>
          <StatusChip tone="neutral">
            {t("sales.orders.reserved", { count: order.reservedQuantity })}
          </StatusChip>
          <Help className="mt-2">{t("sales.orders.reservedHelp")}</Help>
        </Card>
      ) : null}

      {order.discount ? (
        <DiscountCard
          order={order}
          role={role}
          canDecide={canDecideDiscount}
          idempotencyKey={idempotencyKey}
        />
      ) : null}

      {/* §12.1 point 4: "a proforma may be revised before acceptance, with full version history."
          The command has always existed; until now no screen called it, so the one thing a customer
          most often asks for — change the quantity — could not be done at all. */}
      {order.status === "proforma" && canAct ? (
        <RevisePanel
          order={order}
          products={products}
          units={units}
          availability={availability}
          blockedReason={
            discountPending ? t("sales.orders.blockedByDiscount") : null
          }
          idempotencyKey={idempotencyKey}
        />
      ) : null}

      {/* A confirmed order keeps its actions, because §4.3 lets it be cancelled and the database
          already does exactly that: the reservation is released and the invoice is cancelled
          KEEPING its number (AC-11). Only cancellation survives confirmation — confirming and
          re-quoting do not, and `OrderActions` withholds them. A cancelled order offers nothing. */}
      {(order.status === "proforma" || order.status === "confirmed") && canAct ? (
        <OrderActions
          order={order}
          discountPending={discountPending}
          expired={expired}
          idempotencyKey={idempotencyKey}
        />
      ) : null}

      {history.length > 0 ? (
        <details className="rounded-lg border border-border bg-card p-4 md:p-5 xl:p-6">
          <summary className="cursor-pointer text-sm font-medium">
            {t("sales.proforma.history", { count: history.length })}
          </summary>
          <div className="mt-4 flex flex-col gap-4">
            {history.map((proforma) => (
              <ProformaCard key={proforma.id} proforma={proforma} live={false} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function LineTable({
  lines,
  locale,
}: {
  lines: Proforma["lines"];
  locale: string;
}) {
  const t = useTranslations("sales.lineTable");

  return (
    // The one wide grid on this screen scrolls inside its own container; the page body never
    // scrolls sideways (design.md §3.5).
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[420px] text-left text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th scope="col" className="py-1 pr-3 font-medium">{t("product")}</th>
            <th scope="col" className="py-1 pr-3 font-medium">{t("quantity")}</th>
            <th scope="col" className="py-1 pr-3 font-medium">{t("unitPrice")}</th>
            <th scope="col" className="py-1 font-medium">{t("lineTotal")}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id} className="border-t border-border">
              <td className="py-2 pr-3">
                {[line.productName, line.productSpecification, line.unitContent]
                  .filter(Boolean)
                  .join(" · ")}
              </td>
              <td className="fv-numeric py-2 pr-3">
                {line.quantity} {line.unitCode}
              </td>
              <td className="fv-numeric py-2 pr-3">{formatTzs(line.unitPriceTzs, locale)}</td>
              <td className="fv-numeric py-2 font-medium">
                {formatTzs(line.lineTotalTzs, locale)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Totals({
  subtotal,
  discount,
  total,
  locale,
}: {
  subtotal: number;
  discount: number;
  total: number;
  locale: string;
}) {
  const t = useTranslations("sales.lineTable");

  return (
    <dl className="flex flex-col gap-1 border-t border-border pt-3 text-sm">
      <div className="flex justify-between">
        <dt className="text-muted-foreground">{t("subtotal")}</dt>
        <dd className="fv-numeric">{formatTzs(subtotal, locale)}</dd>
      </div>
      {discount > 0 ? (
        <div className="flex justify-between">
          <dt className="text-muted-foreground">{t("discount")}</dt>
          <dd className="fv-numeric">− {formatTzs(discount, locale)}</dd>
        </div>
      ) : null}
      <div className="flex justify-between font-semibold">
        <dt>{t("total")}</dt>
        <dd className="fv-numeric" data-testid="order-total">
          {formatTzs(total, locale)}
        </dd>
      </div>
    </dl>
  );
}

function ProformaCard({ proforma, live }: { proforma: Proforma; live: boolean }) {
  const t = useTranslations();
  const locale = useLocale();

  return (
    <Card role="article" aria-label={proforma.proformaNo}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold">
              {t("sales.proforma.heading", { version: proforma.version })}
            </h2>
            <span className="fv-identifier text-sm">{proforma.proformaNo}</span>
          </div>
          {live ? (
            <StatusChip tone="attention">
              {t("sales.proforma.validUntil", { date: proforma.validUntil })}
            </StatusChip>
          ) : (
            <StatusChip tone="neutral">{t("sales.proforma.superseded")}</StatusChip>
          )}
        </div>

        <LineTable lines={proforma.lines} locale={locale} />

        <Totals
          subtotal={proforma.subtotalTzs}
          discount={proforma.discountTzs}
          total={proforma.totalTzs}
          locale={locale}
        />
      </div>
    </Card>
  );
}

function DiscountCard({
  order,
  role,
  canDecide,
  idempotencyKey,
}: {
  order: Order;
  role: AppRole;
  canDecide: boolean;
  idempotencyKey: string;
}) {
  const t = useTranslations();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [key] = useState(idempotencyKey);

  const action = useGuardedAction<"approve" | "reject", SalesActionState>({
    failureKey: "salesErrors.generic",
  });
  const { pending, running, result } = action;

  const discount = order.discount!;
  const settled = discount.status !== "pending";

  return (
    <Card>
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">{t("sales.discount.heading")}</h2>

        {/* A Sales Representative now sees a colleague's pending request, and `profiles` still
            admits a Manager and a Director only — so the name comes back empty for them. Saying
            "asked for by " with nothing after it would be worse than not naming anybody: the
            pending state is what they need, and the identity is not theirs to read. */}
        <p className="text-sm">
          {discount.requestedByName
            ? t("sales.discount.requested", {
                percent: discount.requestedPercent,
                who: discount.requestedByName,
              })
            : t("sales.discount.requestedAnon", { percent: discount.requestedPercent })}
        </p>

        {settled ? (
          <StatusChip tone={discount.status === "approved" ? "success" : "danger"}>
            {/* Same rule as the request line above: a Cashier and a Sales Representative cannot
                read the decider's `profiles` row, and "Approved by " with nothing after it claims
                to name somebody and then does not. The outcome is theirs to see; the name is not. */}
            {discount.status === "approved"
              ? discount.decidedByName
                ? t("sales.discount.approvedBy", { who: discount.decidedByName })
                : t("sales.discount.approvedState")
              : t("sales.discount.rejectedState")}
          </StatusChip>
        ) : (
          <>
            {/* The limit is SHOWN, not merely enforced (design.md §7.8). Whose decision it is
                comes from product.md §4 and is stated before anybody taps anything. */}
            <StatusChip tone="attention">
              {discount.requiredRole === "director"
                ? t("sales.discount.needsDirector")
                : t("sales.discount.needsManager")}
            </StatusChip>

            {result.error ? (
              <div className="flex flex-col gap-2">
                <FormError>
                  {t(result.error)}
                  {result.errorValues?.requestedPercent !== undefined ? (
                    <span className="fv-numeric mt-1 block font-normal">
                      {t("salesErrors.director_approval_required_detail", result.errorValues)}
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
            ) : null}

            <FormSuccess>{result.successKey ? t(result.successKey) : null}</FormSuccess>

            {/* A Manager looking at a discount only a Director may decide is told so and offered
                nothing. design.md §4.4 puts that under HIDDEN rather than disabled: this is not a
                block they can clear, and the database refuses both the approval AND the rejection
                — §4.3 makes a rejection a completed decision, so a Manager who could refuse it
                would be deciding it either way. */}
            {!canDecide && role === "manager" ? (
              <Help id="discountBeyondManagerLimit">
                {t("sales.discount.beyondManagerLimit")}
              </Help>
            ) : null}

            {/* Hidden from a Sales Representative, not greyed: their role can never decide this
                (design.md §4.3, §4.4). */}
            {canDecide && !result.successKey ? (
              rejecting ? (
                <div className="flex flex-col gap-3">
                  <Field>
                    <Label htmlFor="discount-reason">{t("sales.discount.rejectReason")}</Label>
                    <Input
                      id="discount-reason"
                      type="text"
                      autoComplete="off"
                      value={reason}
                      disabled={pending}
                      onChange={(event) => setReason(event.target.value)}
                    />
                    <FieldError>
                      {result.fieldErrors?.reason ? t(result.fieldErrors.reason) : null}
                    </FieldError>
                  </Field>
                  <div className="flex flex-col gap-2 md:flex-row">
                    <Button
                      type="button"
                      variant="danger"
                      size="small"
                      id="confirmRejectDiscount"
                      pending={running === "reject"}
                      pendingLabel={t("common.loading")}
                      disabled={pending}
                      onClick={() => {
                        const data = new FormData();
                        data.set("entityId", order.id);
                        data.set("reason", reason);
                        data.set("idempotencyKey", key);
                        action.run("reject", rejectDiscountAction, data);
                      }}
                    >
                      {t("sales.discount.confirmReject")}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="small"
                      disabled={pending}
                      onClick={() => setRejecting(false)}
                    >
                      {t("common.cancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2 md:flex-row">
                  <Button
                    type="button"
                    size="small"
                    id="approveDiscount"
                    pending={running === "approve"}
                    pendingLabel={t("common.loading")}
                    disabled={pending}
                    onClick={() => {
                      const data = new FormData();
                      data.set("entityId", order.id);
                      data.set("idempotencyKey", key);
                      action.run("approve", approveDiscountAction, data);
                    }}
                  >
                    {t("sales.discount.approve")}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="small"
                    id="rejectDiscount"
                    disabled={pending}
                    onClick={() => setRejecting(true)}
                  >
                    {t("sales.discount.reject")}
                  </Button>
                </div>
              )
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}

/**
 * Confirm, discount and cancel.
 *
 * Confirm is DISABLED with its reason shown when a discount is undecided or the quotation has
 * expired — a temporary state the person can resolve, which is exactly when design.md §4.4 says to
 * disable rather than hide, and §4.4 also says a disabled control with no explanation is a defect.
 */
function OrderActions({
  order,
  discountPending,
  expired,
  idempotencyKey,
}: {
  order: Order;
  discountPending: boolean;
  expired: boolean;
  idempotencyKey: string;
}) {
  const t = useTranslations();
  const [mode, setMode] = useState<"none" | "discount" | "cancel">("none");
  const [confirming, setConfirming] = useState(false);
  const [percent, setPercent] = useState("");
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(idempotencyKey);
  /**
   * Confirmation carries its OWN idempotency key and its own guard.
   *
   * Its own key because the three commands in this panel are different operations, and a key
   * already claimed for `sales.confirm_order` is refused as a conflict if a discount request reuses
   * it. Its own guard because the confirmation lives in a sheet: its result has to be rendered
   * there, and a shared `result` could not tell which control the message belonged to.
   */
  const [confirmKey, setConfirmKey] = useState(() => crypto.randomUUID());

  const action = useGuardedAction<"discount" | "cancel", SalesActionState>({
    failureKey: "salesErrors.generic",
    onSettled: (outcome) => {
      if (outcome.successKey) {
        setMode("none");
        setPercent("");
        setReason("");
        setKey(crypto.randomUUID());
      }
    },
  });

  const confirmAction = useGuardedAction<"confirm", SalesActionState>({
    failureKey: "salesErrors.generic",
    onSettled: (outcome) => {
      // The sheet closes ONLY on a success. A refusal keeps it open, because the refusal and its
      // retry are rendered inside it — closing would put the answer behind the thing that was just
      // dismissed, and the person would have to dismiss a sheet to find out whether it worked.
      if (outcome.successKey) {
        setConfirming(false);
        setConfirmKey(crypto.randomUUID());
      }
    },
  });

  const { running, result } = action;
  /** Any command in this panel, including the one inside the sheet, closes every other control. */
  const pending = action.pending || confirmAction.pending;

  function runConfirm() {
    const data = new FormData();
    data.set("orderId", order.id);
    data.set("idempotencyKey", confirmKey);
    confirmAction.run("confirm", confirmOrderAction, data);
  }

  // Confirming and re-quoting belong to the quotation stage alone. An invoice is immutable
  // (AC-12), so once one exists the only decision left is whether to cancel the order.
  const quotationStage = order.status === "proforma";

  const blockedReason = quotationStage
    ? discountPending
      ? t("sales.orders.blockedByDiscount")
      : expired
        ? t("sales.orders.blockedByExpiry")
        : null
    : null;

  return (
    <Card>
      <div className="flex flex-col gap-4">
        {result.error ? (
          <div className="flex flex-col gap-2">
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
        ) : null}

        <FormSuccess>{result.successKey ? t(result.successKey) : null}</FormSuccess>

        {mode === "discount" ? (
          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold">{t("sales.discount.requestHeading")}</h2>
            <Field>
              <Label htmlFor="discount-percent">{t("sales.discount.percent")}</Label>
              <Input
                id="discount-percent"
                type="text"
                inputMode="decimal"
                className="fv-numeric"
                value={percent}
                disabled={pending}
                onChange={(event) => setPercent(event.target.value)}
              />
              <Help>{t("sales.discount.percentHelp")}</Help>
              <FieldError>
                {result.fieldErrors?.percent ? t(result.fieldErrors.percent) : null}
              </FieldError>
            </Field>
            <Field>
              <Label htmlFor="discount-request-reason">{t("sales.discount.reason")}</Label>
              <Input
                id="discount-request-reason"
                type="text"
                autoComplete="off"
                value={reason}
                disabled={pending}
                onChange={(event) => setReason(event.target.value)}
              />
              <FieldError>
                {result.fieldErrors?.reason ? t(result.fieldErrors.reason) : null}
              </FieldError>
            </Field>
            <div className="flex flex-col gap-2 md:flex-row">
              <Button
                type="button"
                id="submitDiscount"
                pending={running === "discount"}
                pendingLabel={t("common.loading")}
                disabled={pending}
                onClick={() => {
                  const data = new FormData();
                  data.set("orderId", order.id);
                  data.set("percent", percent);
                  data.set("reason", reason);
                  data.set("idempotencyKey", key);
                  action.run("discount", requestDiscountAction, data);
                }}
              >
                {t("sales.discount.submit")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => setMode("none")}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        ) : mode === "cancel" ? (
          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold">{t("sales.orders.cancelHeading")}</h2>
            <Field>
              <Label htmlFor="cancel-reason">{t("sales.orders.cancelReason")}</Label>
              <Input
                id="cancel-reason"
                type="text"
                autoComplete="off"
                value={reason}
                disabled={pending}
                onChange={(event) => setReason(event.target.value)}
              />
              <FieldError>
                {result.fieldErrors?.reason ? t(result.fieldErrors.reason) : null}
              </FieldError>
            </Field>
            <div className="flex flex-col gap-2 md:flex-row">
              <Button
                type="button"
                variant="danger"
                id="confirmCancel"
                pending={running === "cancel"}
                pendingLabel={t("common.loading")}
                disabled={pending}
                onClick={() => {
                  const data = new FormData();
                  data.set("orderId", order.id);
                  data.set("reason", reason);
                  data.set("idempotencyKey", key);
                  action.run("cancel", cancelOrderAction, data);
                }}
              >
                {t("sales.orders.confirmCancel")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => setMode("none")}
              >
                {t("common.close")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 md:flex-row">
              {quotationStage ? (
                <>
                  {/* STEP ONE of two. This opens the confirmation and commits to nothing;
                      §7A.2 requires the mobile confirmation to be a two-step sheet, and confirming
                      an order creates a financial record and reserves stock. */}
                  <Button
                    type="button"
                    id="confirmOrder"
                    disabled={pending || blockedReason !== null}
                    onClick={() => setConfirming(true)}
                  >
                    {t("sales.orders.confirm")}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    id="requestDiscount"
                    disabled={pending || discountPending}
                    onClick={() => setMode("discount")}
                  >
                    {t("sales.discount.request")}
                  </Button>
                </>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                id="cancelOrder"
                disabled={pending}
                onClick={() => setMode("cancel")}
              >
                {t("sales.orders.cancel")}
              </Button>
            </div>

            {/* A disabled control ALWAYS says why (design.md §4.4). */}
            {blockedReason ? <Help>{blockedReason}</Help> : null}

            {/* What the action will do, before it happens (§10.8). Three different consequences:
                confirming a credit order, confirming a walk-in — the surprising half — and, once
                an invoice exists, cancelling the only thing left to decide. */}
            <Help>
              {!quotationStage
                ? t("sales.orders.cancelConsequenceConfirmed")
                : order.isCashSale
                  ? t("sales.orders.confirmConsequenceCash")
                  : t("sales.orders.confirmConsequence")}
            </Help>
          </div>
        )}
      </div>

      {/* STEP TWO of two. A bottom sheet on a phone and a centred modal above it, naming the exact
          consequence before it happens (§10.8, §11.8) and offering an explicit way out. */}
      <ConfirmSheet
        open={confirming}
        onOpenChange={(next) => {
          if (confirmAction.pending) return;
          setConfirming(next);
          // A dismissed sheet starts clean next time; a stale refusal reappearing over a fresh
          // decision would be a message about something that already happened.
          if (!next) confirmAction.clear();
        }}
        title={t("sales.orders.confirmHeading")}
        consequence={
          order.isCashSale
            ? t("sales.orders.confirmConsequenceCash")
            : t("sales.orders.confirmConsequence")
        }
        confirmLabel={t("sales.orders.confirmYes")}
        confirmId="confirmOrderYes"
        cancelLabel={t("sales.orders.confirmBack")}
        pending={confirmAction.pending}
        pendingLabel={t("common.loading")}
        onConfirm={runConfirm}
      >
        {/* The refusal belongs HERE, inside the surface that holds focus. `AlertDialog` traps
            focus, so an error rendered on the card behind it is a message nobody can reach without
            first dismissing the thing that produced it. */}
        {confirmAction.result.error ? (
          <div className="flex flex-col gap-2">
            <FormError>
              {t(confirmAction.result.error)}
              {confirmAction.result.errorValues?.available !== undefined ? (
                <span className="fv-numeric mt-1 block font-normal">
                  {t(
                    "salesErrors.insufficient_stock_detail",
                    confirmAction.result.errorValues,
                  )}
                </span>
              ) : null}
            </FormError>
            {confirmAction.retry ? (
              <div>
                {/* The SAME request, not a new one: `retry` replays the stored FormData, so the
                    idempotency key inside it is the one the first attempt used and a command that
                    did reach the database is resumed rather than repeated. */}
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  id="retryConfirmOrder"
                  pending={confirmAction.pending}
                  pendingLabel={t("common.loading")}
                  onClick={confirmAction.retry}
                >
                  {t("common.retry")}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </ConfirmSheet>
    </Card>
  );
}

/**
 * Revising the quotation (product.md §12.1 point 4, design.md §7A.1).
 *
 * The new line set REPLACES the old one and the customer is quoted again: `staff_revise_proforma`
 * supersedes the live version and issues a new one beside it, so what they were told last week is
 * still readable underneath. Nothing here overwrites anything.
 *
 * The draft starts from the order as it stands, so the common change — one quantity — is two taps
 * on a stepper. Entered values survive a refusal because the draft is state, not a form that
 * re-renders from the server, and the idempotency key is only rotated once the server has answered
 * with a success (§12.7 rule 5).
 */
function RevisePanel({
  order,
  products,
  units,
  availability,
  blockedReason,
  idempotencyKey,
}: {
  order: Order;
  products: CatalogueProduct[];
  units: Unit[];
  availability: Availability[];
  blockedReason: string | null;
  idempotencyKey: string;
}) {
  const t = useTranslations();
  const locale = useLocale();

  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>(() => draftFrom(order.lines));
  const [key, setKey] = useState(idempotencyKey);

  const action = useGuardedAction<"revise", SalesActionState>({
    failureKey: "salesErrors.generic",
    onSettled: (outcome) => {
      if (outcome.successKey) {
        setOpen(false);
        setKey(crypto.randomUUID());
      }
    },
  });
  const { pending, result } = action;

  const subtotal = draftSubtotal(lines, products);

  if (!open) {
    return (
      <Card>
        <div className="flex flex-col gap-3">
          <div>
            <Button
              type="button"
              variant="secondary"
              id="reviseOrder"
              disabled={blockedReason !== null}
              onClick={() => {
                setLines(draftFrom(order.lines));
                setOpen(true);
              }}
            >
              {t("sales.orders.revise")}
            </Button>
          </div>
          {/* A disabled control ALWAYS says why (design.md §4.4). */}
          <Help>{blockedReason ?? t("sales.orders.reviseHelp")}</Help>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold">{t("sales.orders.reviseHeading")}</h2>

        {result.error ? (
          <div className="flex flex-col gap-2">
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
        ) : null}

        <FieldError>{result.fieldErrors?.lines ? t(result.fieldErrors.lines) : null}</FieldError>

        {/* Only an active product may be ADDED, but the line list below is given the whole
            catalogue: a product retired after this order was written still has to render with its
            name rather than as a blank row. */}
        <ProductPicker
          products={products.filter((product) => product.isActive)}
          availability={availability}
          chosen={lines.map((line) => line.productId)}
          disabled={pending}
          idPrefix="revise"
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
          idPrefix="revise"
          onChange={setLines}
        />

        <div className="flex items-center justify-between border-t border-border pt-3">
          <span className="text-sm font-medium">{t("sales.newOrder.subtotal")}</span>
          <span className="fv-numeric text-lg font-semibold" data-testid="revise-subtotal">
            {formatTzs(subtotal, locale)}
          </span>
        </div>

        <div className="flex flex-col gap-2 md:flex-row">
          <Button
            type="button"
            id="submitRevision"
            pending={pending}
            pendingLabel={t("common.loading")}
            disabled={pending}
            onClick={() => {
              const data = new FormData();
              data.set("orderId", order.id);
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
              action.run("revise", reviseOrderAction, data);
            }}
          >
            {t("sales.orders.reviseSubmit")}
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

        <Help>{t("sales.orders.reviseConsequence")}</Help>
      </div>
    </Card>
  );
}
