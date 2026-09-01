"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import {
  approveCreditAction,
  approvePaymentReversalAction,
  approveSettlementAction,
  recordPaymentAction,
  rejectCreditAction,
  requestCreditAction,
  requestPaymentReversalAction,
  takeCashPaymentAction,
  type SettlementActionState,
} from "@/app/(app)/payments/actions";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FormError, FormSuccess, Help, Input, Label } from "@/components/ui/field";
import { Card, StatusChip } from "@/components/ui/surface";
import { formatTzs } from "@/lib/money";
import type { OrderSummary } from "@/lib/sales/sales";
import { PAYMENT_METHODS, type PaymentMethod } from "@/lib/settlement/methods";
import type { SettlementInvoice } from "@/lib/settlement/settlement";
import type { AppRole } from "@/lib/auth/roles";
import { creditExposureByCustomer } from "@/lib/settlement/exposure";
import { useGuardedAction } from "@/lib/ui/use-guarded-action";

const STATUS_TONE: Record<string, "neutral" | "success" | "attention" | "danger"> = {
  unpaid: "attention",
  partially_paid: "attention",
  paid: "success",
  cancelled: "danger",
};

export function PaymentQueue({
  invoices,
  awaitingCashSale,
  role,
  idempotencyKey,
}: {
  invoices: SettlementInvoice[];
  awaitingCashSale: OrderSummary[];
  role: AppRole;
  idempotencyKey: string;
}) {
  const t = useTranslations("settlement.payments");

  const awaitingSettlement = invoices.filter(
    (invoice) => invoice.cancelledAt === null && invoice.settlementApprovedAt === null,
  );
  // What each customer ALREADY owes on approved credit, totalled once for the whole queue rather
  // than per card (design.md §7.8). A per-invoice limit cannot see a customer's fourth unpaid
  // balance of the week; this can.
  const exposure = creditExposureByCustomer(invoices);
  const settled = invoices.filter(
    (invoice) => invoice.cancelledAt === null && invoice.settlementApprovedAt !== null,
  );

  return (
    <div className="flex flex-col gap-6">
      {awaitingCashSale.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">
            {t("cashSalesHeading", { count: awaitingCashSale.length })}
          </h2>
          {/* §12.4: these orders have no invoice and no reservation. Everything happens here, at
              payment, in one action. */}
          <Help>{t("cashSalesHelp")}</Help>
          {awaitingCashSale.map((order) => (
            <CashSaleCard
              key={order.id}
              order={order}
              canTakeMoney={role === "cashier"}
              idempotencyKey={idempotencyKey}
            />
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">
          {t("awaitingHeading", { count: awaitingSettlement.length })}
        </h2>
        {awaitingSettlement.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">{t("nothingWaiting")}</p>
          </Card>
        ) : (
          awaitingSettlement.map((invoice) => (
            <InvoiceCard
              key={invoice.id}
              invoice={invoice}
              role={role}
              exposureTzs={exposure.get(invoice.customerId) ?? 0}
              idempotencyKey={idempotencyKey}
            />
          ))
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">{t("settledHeading")}</h2>
        {settled.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">{t("noneSettled")}</p>
          </Card>
        ) : (
          settled.map((invoice) => (
            <InvoiceCard
              key={invoice.id}
              invoice={invoice}
              role={role}
              exposureTzs={exposure.get(invoice.customerId) ?? 0}
              idempotencyKey={idempotencyKey}
            />
          ))
        )}
      </section>
    </div>
  );
}

function InvoiceCard({
  invoice,
  role,
  exposureTzs,
  idempotencyKey,
}: {
  invoice: SettlementInvoice;
  role: AppRole;
  /** What this customer already owes on approved credit, across every invoice (design.md §7.8). */
  exposureTzs: number;
  idempotencyKey: string;
}) {
  const t = useTranslations();
  const locale = useLocale();

  const canTakeMoney = role === "cashier";
  const canDecideCredit = role === "manager" || role === "director";
  const canApproveReversal = role === "director";
  const canRequestReversal = role === "cashier" || role === "manager";

  const { settlement } = invoice;

  return (
    <Card role="article" aria-label={invoice.invoiceNo}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <Link href={`/orders/${invoice.orderId}`} className="fv-identifier font-medium underline">
                {invoice.invoiceNo}
              </Link>
              {/* Never colour alone (§11.5): the state is a word first. Calculated from money
                  received, never chosen (§12.3, AC-14). */}
              <StatusChip tone={STATUS_TONE[settlement.status] ?? "neutral"}>
                {t(`settlement.status.${settlement.status}`)}
              </StatusChip>
              {invoice.settlementApprovedAt ? (
                <StatusChip tone="success">{t("settlement.status.settled")}</StatusChip>
              ) : null}
            </span>
            <span className="text-sm text-muted-foreground">{invoice.customerName}</span>
            <span className="text-xs text-muted-foreground">{invoice.businessDate}</span>
          </div>

          {/* Balance due in the largest numeral on the card (design.md §7.7). It is the figure the
              Cashier reads out to the person in front of them. */}
          <div className="flex flex-col items-start gap-0.5 md:items-end">
            <span className="text-xs text-muted-foreground">{t("settlement.payments.balanceDue")}</span>
            <span className="fv-numeric text-2xl font-semibold" data-testid={`balance-${invoice.id}`}>
              {formatTzs(settlement.outstandingTzs, locale)}
            </span>
            <span className="fv-numeric text-xs text-muted-foreground">
              {t("settlement.payments.ofTotal", { total: formatTzs(settlement.totalTzs, locale) })}
            </span>
          </div>
        </div>

        {settlement.approvedCreditTzs > 0 ? (
          // Shown apart from the money, and labelled as what it is. §12.5: credit records no
          // payment, so an invoice can carry an approved balance and still read Unpaid.
          <StatusChip tone="neutral">
            {t("settlement.credit.approvedBalance", {
              amount: formatTzs(settlement.approvedCreditTzs, locale),
            })}
          </StatusChip>
        ) : null}

        {invoice.payments.length > 0 ? (
          <PaymentHistory
            invoice={invoice}
            canRequestReversal={canRequestReversal}
            canApproveReversal={canApproveReversal}
            idempotencyKey={idempotencyKey}
          />
        ) : null}

        {invoice.credit && invoice.credit.status === "pending" ? (
          <CreditDecision
            invoice={invoice}
            canDecide={canDecideCredit}
            exposureTzs={exposureTzs}
            idempotencyKey={idempotencyKey}
          />
        ) : null}

        {invoice.cancelledAt === null && invoice.settlementApprovedAt === null && canTakeMoney ? (
          <SettlementPanel invoice={invoice} idempotencyKey={idempotencyKey} />
        ) : null}
      </div>
    </Card>
  );
}

function PaymentHistory({
  invoice,
  canRequestReversal,
  canApproveReversal,
  idempotencyKey,
}: {
  invoice: SettlementInvoice;
  canRequestReversal: boolean;
  canApproveReversal: boolean;
  idempotencyKey: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [reversing, setReversing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [key] = useState(idempotencyKey);

  const action = useGuardedAction<"request" | "approve", SettlementActionState>({
    failureKey: "settlementErrors.generic",
  });
  const { pending, running, result } = action;

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <h3 className="text-xs font-semibold text-muted-foreground">
        {t("settlement.payments.history")}
      </h3>

      {result.error ? <FormError>{t(result.error)}</FormError> : null}
      <FormSuccess>{result.successKey ? t(result.successKey) : null}</FormSuccess>

      <ul className="flex flex-col gap-2 text-xs">
        {invoice.payments.map((payment) => (
          <li key={payment.id} className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {t(`settlement.methods.${payment.method}`)}
                {payment.reversesId ? (
                  <span className="ml-2 text-danger">{t("settlement.reversal.label")}</span>
                ) : null}
              </span>
              <span className="fv-numeric font-medium">
                {formatTzs(payment.amountTzs, locale)}
              </span>
            </span>
            <span className="text-muted-foreground">
              {t("settlement.payments.receivedBy", {
                who: payment.receivedByName,
                date: payment.businessDate,
              })}
            </span>

            {/* A reversal is a Director's decision whoever asks (§4.1, AC-21). A reversal row is
                not itself reversible, and one already reversed offers nothing. */}
            {payment.reversesId === null && !payment.reversed ? (
              payment.reversalPending ? (
                canApproveReversal ? (
                  <div>
                    <Button
                      type="button"
                      variant="danger"
                      size="small"
                      data-testid={`approve-reversal-${payment.id}`}
                      pending={running === "approve"}
                      pendingLabel={t("common.loading")}
                      disabled={pending}
                      onClick={() => {
                        const data = new FormData();
                        data.set("entityId", payment.id);
                        data.set("idempotencyKey", key);
                        action.run("approve", approvePaymentReversalAction, data);
                      }}
                    >
                      {t("settlement.reversal.approve")}
                    </Button>
                  </div>
                ) : (
                  <StatusChip tone="attention">{t("settlement.reversal.pending")}</StatusChip>
                )
              ) : canRequestReversal ? (
                reversing === payment.id ? (
                  <div className="flex flex-col gap-2">
                    <Field>
                      <Label htmlFor={`reversal-reason-${payment.id}`}>
                        {t("settlement.reversal.reason")}
                      </Label>
                      <Input
                        id={`reversal-reason-${payment.id}`}
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
                        pending={running === "request"}
                        pendingLabel={t("common.loading")}
                        disabled={pending}
                        onClick={() => {
                          const data = new FormData();
                          data.set("entityId", payment.id);
                          data.set("reason", reason);
                          data.set("idempotencyKey", key);
                          action.run("request", requestPaymentReversalAction, data);
                        }}
                      >
                        {t("settlement.reversal.submit")}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="small"
                        disabled={pending}
                        onClick={() => setReversing(null)}
                      >
                        {t("common.cancel")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="small"
                      data-testid={`reverse-${payment.id}`}
                      disabled={pending}
                      onClick={() => setReversing(payment.id)}
                    >
                      {t("settlement.reversal.request")}
                    </Button>
                  </div>
                )
              ) : null
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CreditDecision({
  invoice,
  canDecide,
  exposureTzs,
  idempotencyKey,
}: {
  invoice: SettlementInvoice;
  canDecide: boolean;
  exposureTzs: number;
  idempotencyKey: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [key] = useState(idempotencyKey);

  const action = useGuardedAction<"approve" | "reject", SettlementActionState>({
    failureKey: "settlementErrors.generic",
  });
  const { pending, running, result } = action;

  const credit = invoice.credit!;

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <h3 className="text-sm font-semibold">{t("settlement.credit.heading")}</h3>

      <p className="text-sm">
        {t("settlement.credit.requested", {
          amount: formatTzs(credit.amountTzs, locale),
          who: credit.requestedByName,
        })}
      </p>
      <p className="text-xs text-muted-foreground">{credit.reason}</p>

      {/* The limit is SHOWN, not merely enforced (design.md §7.8). §4: a Manager may approve up to
          TZS 500,000 on one invoice; beyond that it is a Director's. */}
      <StatusChip tone="attention">
        {credit.requiredRole === "director"
          ? t("settlement.credit.needsDirector")
          : t("settlement.credit.needsManager")}
      </StatusChip>

      {/* Third in §7.8's hierarchy, after the requested amount and the limit result: what this
          customer ALREADY owes on approved credit. The per-invoice limit of product.md §4 cannot
          see it, and somebody deciding a fourth unpaid balance should not have to remember the
          other three. */}
      <p className="text-xs text-muted-foreground" data-testid={`credit-exposure-${invoice.id}`}>
        {t("settlement.credit.exposure", {
          who: invoice.customerName,
          amount: formatTzs(exposureTzs, locale),
        })}
      </p>

      {result.error ? (
        <div className="flex flex-col gap-2">
          <FormError>
            {t(result.error)}
            {result.errorValues?.manager_limit_tzs !== undefined ? (
              <span className="fv-numeric mt-1 block font-normal">
                {t("settlementErrors.director_approval_required_detail", result.errorValues)}
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

      {/* Hidden from a Cashier and a Sales Representative: their role can never decide this
          (design.md §4.3, §4.4). */}
      {canDecide && !result.successKey ? (
        rejecting ? (
          <div className="flex flex-col gap-2">
            <Field>
              <Label htmlFor={`credit-reason-${credit.id}`}>
                {t("settlement.credit.rejectReason")}
              </Label>
              <Input
                id={`credit-reason-${credit.id}`}
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
                data-testid={`confirm-reject-credit-${invoice.id}`}
                pending={running === "reject"}
                pendingLabel={t("common.loading")}
                disabled={pending}
                onClick={() => {
                  const data = new FormData();
                  data.set("entityId", credit.id);
                  data.set("reason", reason);
                  data.set("idempotencyKey", key);
                  action.run("reject", rejectCreditAction, data);
                }}
              >
                {t("settlement.credit.confirmReject")}
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
              data-testid={`approve-credit-${invoice.id}`}
              pending={running === "approve"}
              pendingLabel={t("common.loading")}
              disabled={pending}
              onClick={() => {
                const data = new FormData();
                data.set("entityId", credit.id);
                data.set("idempotencyKey", key);
                action.run("approve", approveCreditAction, data);
              }}
            >
              {t("settlement.credit.approve")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="small"
              data-testid={`reject-credit-${invoice.id}`}
              disabled={pending}
              onClick={() => setRejecting(true)}
            >
              {t("settlement.credit.reject")}
            </Button>
          </div>
        )
      ) : null}

      <Help>{t("settlement.credit.recordsNoMoney")}</Help>
    </div>
  );
}

/**
 * Where the Cashier settles an invoice.
 *
 * Two panels, deliberately apart. The six tenders record money; Credit records an approved unpaid
 * balance and no payment at all (§12.5), and the panel changes its language accordingly — "amount
 * received" against "amount to be carried as credit". Presenting them as one control with seven
 * options is the mistake §12.5 exists to prevent.
 */
function SettlementPanel({
  invoice,
  idempotencyKey,
}: {
  invoice: SettlementInvoice;
  idempotencyKey: string;
}) {
  const t = useTranslations();
  const locale = useLocale();

  const [mode, setMode] = useState<"none" | "tender" | "credit">("none");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  // Pre-filled with the balance due: the common case is one tap plus confirm (design.md §7.7).
  const [amount, setAmount] = useState(String(invoice.settlement.outstandingTzs));
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(idempotencyKey);

  const action = useGuardedAction<"pay" | "credit" | "settle", SettlementActionState>({
    failureKey: "settlementErrors.generic",
    onSettled: (outcome) => {
      if (outcome.successKey) {
        setMode("none");
        setReason("");
        setKey(crypto.randomUUID());
      }
    },
  });
  const { pending, running, result } = action;

  const canSettle =
    invoice.settlement.amountPaidTzs + invoice.settlement.approvedCreditTzs >=
    invoice.settlement.totalTzs;

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      {result.error ? (
        <div className="flex flex-col gap-2">
          <FormError>
            {t(result.error)}
            {result.errorValues?.outstanding !== undefined ? (
              <span className="fv-numeric mt-1 block font-normal">
                {t("settlementErrors.balance_detail", result.errorValues)}
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

      {mode === "tender" ? (
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">{t("settlement.payments.recordHeading")}</h3>

          {/* Preset buttons, not a dropdown (product.md §5.1, design.md §10.1). */}
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("settlement.payments.method")}>
            {PAYMENT_METHODS.map((option) => (
              <Button
                key={option}
                type="button"
                variant={option === method ? "primary" : "secondary"}
                size="small"
                aria-pressed={option === method}
                data-testid={`method-${option}`}
                disabled={pending}
                onClick={() => setMethod(option)}
              >
                {t(`settlement.methods.${option}`)}
              </Button>
            ))}
          </div>
          <FieldError>{result.fieldErrors?.method ? t(result.fieldErrors.method) : null}</FieldError>

          <Field>
            <Label htmlFor={`amount-${invoice.id}`}>{t("settlement.payments.amountReceived")}</Label>
            <Input
              id={`amount-${invoice.id}`}
              type="text"
              inputMode="numeric"
              className="fv-numeric"
              value={amount}
              disabled={pending}
              onChange={(event) => setAmount(event.target.value)}
            />
            <Help>{t("settlement.payments.amountHelp")}</Help>
            <FieldError>
              {result.fieldErrors?.amount ? t(result.fieldErrors.amount) : null}
            </FieldError>
          </Field>

          <div className="flex flex-col gap-2 md:flex-row">
            <Button
              type="button"
              data-testid={`record-payment-${invoice.id}`}
              pending={running === "pay"}
              pendingLabel={t("common.loading")}
              disabled={pending}
              onClick={() => {
                const data = new FormData();
                data.set("invoiceId", invoice.id);
                data.set("method", method);
                data.set("amount", amount);
                data.set("idempotencyKey", key);
                action.run("pay", recordPaymentAction, data);
              }}
            >
              {t("settlement.payments.record")}
            </Button>
            <Button type="button" variant="secondary" disabled={pending} onClick={() => setMode("none")}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : mode === "credit" ? (
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">{t("settlement.credit.requestHeading")}</h3>
          {/* The panel's language changes with the decision, because the decision is a different
              kind of thing (§12.5). */}
          <Help>{t("settlement.credit.recordsNoMoney")}</Help>

          <Field>
            <Label htmlFor={`credit-amount-${invoice.id}`}>
              {t("settlement.credit.amountCarried")}
            </Label>
            <Input
              id={`credit-amount-${invoice.id}`}
              type="text"
              inputMode="numeric"
              className="fv-numeric"
              value={amount}
              disabled={pending}
              onChange={(event) => setAmount(event.target.value)}
            />
            <FieldError>
              {result.fieldErrors?.amount ? t(result.fieldErrors.amount) : null}
            </FieldError>
          </Field>

          <Field>
            <Label htmlFor={`credit-why-${invoice.id}`}>{t("settlement.credit.reason")}</Label>
            <Input
              id={`credit-why-${invoice.id}`}
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
              data-testid={`request-credit-${invoice.id}`}
              pending={running === "credit"}
              pendingLabel={t("common.loading")}
              disabled={pending}
              onClick={() => {
                const data = new FormData();
                data.set("invoiceId", invoice.id);
                data.set("amount", amount);
                data.set("reason", reason);
                data.set("idempotencyKey", key);
                action.run("credit", requestCreditAction, data);
              }}
            >
              {t("settlement.credit.submit")}
            </Button>
            <Button type="button" variant="secondary" disabled={pending} onClick={() => setMode("none")}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 md:flex-row">
            {invoice.settlement.outstandingTzs > 0 ? (
              <>
                <Button
                  type="button"
                  size="small"
                  data-testid={`take-payment-${invoice.id}`}
                  disabled={pending}
                  onClick={() => {
                    setAmount(String(invoice.settlement.outstandingTzs));
                    setMode("tender");
                  }}
                >
                  {t("settlement.payments.take")}
                </Button>
                {/* Visually apart from the tender action, because it is not one (§12.5). */}
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  data-testid={`carry-credit-${invoice.id}`}
                  disabled={pending || invoice.credit !== null}
                  onClick={() => {
                    setAmount(String(invoice.settlement.outstandingTzs));
                    setMode("credit");
                  }}
                >
                  {t("settlement.credit.carry")}
                </Button>
              </>
            ) : null}

            <Button
              type="button"
              variant={canSettle ? "primary" : "secondary"}
              size="small"
              data-testid={`settle-${invoice.id}`}
              pending={running === "settle"}
              pendingLabel={t("common.loading")}
              disabled={pending || !canSettle}
              onClick={() => {
                const data = new FormData();
                data.set("invoiceId", invoice.id);
                data.set("idempotencyKey", key);
                action.run("settle", approveSettlementAction, data);
              }}
            >
              {t("settlement.payments.approveSettlement")}
            </Button>
          </div>

          {/* A disabled control always says why (design.md §4.4). */}
          {!canSettle ? (
            <Help>
              {t("settlement.payments.cannotSettleYet", {
                outstanding: formatTzs(
                  invoice.settlement.totalTzs -
                    invoice.settlement.amountPaidTzs -
                    invoice.settlement.approvedCreditTzs,
                  locale,
                ),
              })}
            </Help>
          ) : (
            <Help>{t("settlement.payments.settleConsequence")}</Help>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The atomic walk-in sale (product.md §12.4, design.md §7A.3).
 *
 * ONE action with ONE confirmation, never four sequential saves. The screen says what will happen
 * before it happens, and if stock has gone in the meantime the whole thing fails cleanly and says
 * so — no invoice, no payment, no commitment (AC-89).
 */
function CashSaleCard({
  order,
  canTakeMoney,
  idempotencyKey,
}: {
  order: OrderSummary;
  canTakeMoney: boolean;
  idempotencyKey: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [key, setKey] = useState(idempotencyKey);

  const action = useGuardedAction<"pay", SettlementActionState>({
    failureKey: "settlementErrors.generic",
    onSettled: (outcome) => {
      if (outcome.successKey) setKey(crypto.randomUUID());
    },
  });
  const { pending, result } = action;

  return (
    <Card role="article" aria-label={order.orderNo}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div className="flex flex-col gap-1">
            <span className="fv-identifier font-medium">{order.orderNo}</span>
            <span className="text-sm text-muted-foreground">{order.customerName}</span>
          </div>
          <div className="flex flex-col items-start gap-0.5 md:items-end">
            <span className="text-xs text-muted-foreground">
              {t("settlement.payments.amountDue")}
            </span>
            <span className="fv-numeric text-2xl font-semibold">
              {formatTzs(order.totalTzs, locale)}
            </span>
          </div>
        </div>

        {result.error ? (
          <div className="flex flex-col gap-2">
            <FormError>
              {t(result.error)}
              {result.errorValues?.available !== undefined ? (
                <span className="fv-numeric mt-1 block font-normal">
                  {t("settlementErrors.insufficient_stock_detail", result.errorValues)}
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

        {canTakeMoney && !result.successKey ? (
          <>
            <div className="flex flex-wrap gap-2" role="group" aria-label={t("settlement.payments.method")}>
              {PAYMENT_METHODS.map((option) => (
                <Button
                  key={option}
                  type="button"
                  variant={option === method ? "primary" : "secondary"}
                  size="small"
                  aria-pressed={option === method}
                  data-testid={`cash-method-${option}`}
                  disabled={pending}
                  onClick={() => setMethod(option)}
                >
                  {t(`settlement.methods.${option}`)}
                </Button>
              ))}
            </div>

            <div>
              <Button
                type="button"
                data-testid={`cash-sale-${order.id}`}
                pending={pending}
                pendingLabel={t("common.loading")}
                onClick={() => {
                  const data = new FormData();
                  data.set("orderId", order.id);
                  data.set("method", method);
                  // Fully paid or not at all: §12.4 permits the walk-in path only for a fully paid
                  // sale (AC-16), so there is no amount field to get wrong.
                  data.set("amount", String(order.totalTzs));
                  data.set("idempotencyKey", key);
                  action.run("pay", takeCashPaymentAction, data);
                }}
              >
                {t("settlement.payments.completeCashSale")}
              </Button>
            </div>

            <Help>{t("settlement.payments.cashSaleConsequence")}</Help>
          </>
        ) : null}
      </div>
    </Card>
  );
}
