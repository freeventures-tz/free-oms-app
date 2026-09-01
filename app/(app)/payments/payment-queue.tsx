"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";

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
import { ConfirmSheet } from "@/components/ui/confirm-sheet";
import { Field, FieldError, FormError, FormSuccess, Help, Input, Label } from "@/components/ui/field";
import { Pager } from "@/components/ui/pager";
import { Card, StatusChip } from "@/components/ui/surface";
import { formatTzs } from "@/lib/money";
import { PAYMENT_METHODS, type PaymentMethod } from "@/lib/settlement/methods";
import type { CashSale, SettlementInvoice, SettlementQueue } from "@/lib/settlement/settlement";
import type { AppRole } from "@/lib/auth/roles";
import { useGuardedAction } from "@/lib/ui/use-guarded-action";

const STATUS_TONE: Record<string, "neutral" | "success" | "attention" | "danger"> = {
  unpaid: "attention",
  partially_paid: "attention",
  paid: "success",
  cancelled: "danger",
};

const PAYMENTS_PATH = "/payments";

/**
 * A fresh idempotency key, owned by ONE form and ONE command.
 *
 * Every actionable card on this screen calls this for itself. A key shared between cards is a
 * conflict waiting for the second Cashier action of the session: the database claims a key for the
 * exact operation and request it first saw, so an invoice settled with the key its neighbour
 * already spent is refused with `idempotency_key_conflict` — a refusal that reads, to the person
 * at the till, as the system breaking for no reason.
 *
 * It is generated in a `useState` initialiser rather than on the server, and that is deliberate:
 * the value is never rendered, so there is nothing for hydration to disagree about, and a card
 * that mounts gets a key nothing else has ever held.
 */
function newKey(): string {
  return crypto.randomUUID();
}

export function PaymentQueue({
  queue,
  awaitingCashSale,
  role,
}: {
  queue: SettlementQueue;
  awaitingCashSale: CashSale[];
  role: AppRole;
}) {
  const t = useTranslations("settlement.payments");

  const { awaiting, settled, exposureByCustomer } = queue;

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
            <CashSaleCard key={order.id} order={order} canTakeMoney={role === "cashier"} />
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">{t("awaitingHeading", { count: awaiting.total })}</h2>
        <Pager
          page={awaiting.page}
          pageSize={awaiting.pageSize}
          total={awaiting.total}
          param="awaiting"
          basePath={PAYMENTS_PATH}
          otherParams={{ settled: settled.page }}
          label={t("awaitingHeading", { count: awaiting.total })}
        />
        {awaiting.rows.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">{t("nothingWaiting")}</p>
          </Card>
        ) : (
          awaiting.rows.map((invoice) => (
            <InvoiceCard
              key={invoice.id}
              invoice={invoice}
              role={role}
              exposureTzs={exposureByCustomer[invoice.customerId] ?? 0}
            />
          ))
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">{t("settledHeading")}</h2>
        <Pager
          page={settled.page}
          pageSize={settled.pageSize}
          total={settled.total}
          param="settled"
          basePath={PAYMENTS_PATH}
          otherParams={{ awaiting: awaiting.page }}
          label={t("settledHeading")}
        />
        {settled.rows.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">{t("noneSettled")}</p>
          </Card>
        ) : (
          settled.rows.map((invoice) => (
            <InvoiceCard
              key={invoice.id}
              invoice={invoice}
              role={role}
              exposureTzs={exposureByCustomer[invoice.customerId] ?? 0}
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
}: {
  invoice: SettlementInvoice;
  role: AppRole;
  /** What this customer already owes on approved credit, across every invoice (design.md §7.8). */
  exposureTzs: number;
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
          />
        ) : null}

        {invoice.credit && invoice.credit.status === "pending" ? (
          <CreditDecision
            invoice={invoice}
            canDecide={canDecideCredit}
            role={role}
            exposureTzs={exposureTzs}
          />
        ) : null}

        {invoice.cancelledAt === null && invoice.settlementApprovedAt === null && canTakeMoney ? (
          <SettlementPanel invoice={invoice} />
        ) : null}
      </div>
    </Card>
  );
}

function PaymentHistory({
  invoice,
  canRequestReversal,
  canApproveReversal,
}: {
  invoice: SettlementInvoice;
  canRequestReversal: boolean;
  canApproveReversal: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [reversing, setReversing] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  /**
   * A key per payment and per decision, minted on demand and kept until that decision succeeds.
   *
   * A reversal request on one payment and a Director's approval of another are two commands with
   * two request bodies. One key between them is the conflict this map exists to prevent, and a key
   * that rotated on every render would break retry identity instead.
   */
  const [keys, setKeys] = useState<Record<string, string>>({});
  function keyFor(scope: string): string {
    const existing = keys[scope];
    if (existing) return existing;
    const minted = newKey();
    setKeys((current) => ({ ...current, [scope]: minted }));
    return minted;
  }
  function rotate(scope: string) {
    setKeys((current) => ({ ...current, [scope]: newKey() }));
  }

  // A ref rather than state, and the difference matters: `onSettled` runs inside the transition
  // `run` started, so it sees the render closure from BEFORE the click. A state value set in the
  // same handler would not be there yet, and the wrong key would rotate.
  const lastScope = useRef<string | null>(null);

  const action = useGuardedAction<"request" | "approve", SettlementActionState>({
    failureKey: "settlementErrors.generic",
    onSettled: (outcome) => {
      // Only a server-confirmed success retires a key. A refusal keeps it, so the retry that
      // follows addresses the same command rather than issuing a second one.
      if (!outcome.successKey) return;
      if (lastScope.current) rotate(lastScope.current);
      setReversing(null);
      setReason("");
    },
  });
  const { pending, running, result } = action;

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <h3 className="text-xs font-semibold text-muted-foreground">
        {t("settlement.payments.history")}
      </h3>

      {result.error ? (
        <div className="flex flex-col gap-2">
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
                        const scope = `approve:${payment.id}`;
                        lastScope.current = scope;
                        const data = new FormData();
                        data.set("entityId", payment.id);
                        data.set("idempotencyKey", keyFor(scope));
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
                        data-testid={`submit-reversal-${payment.id}`}
                        pending={running === "request"}
                        pendingLabel={t("common.loading")}
                        disabled={pending}
                        onClick={() => {
                          const scope = `request:${payment.id}`;
                          lastScope.current = scope;
                          const data = new FormData();
                          data.set("entityId", payment.id);
                          data.set("reason", reason);
                          data.set("idempotencyKey", keyFor(scope));
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
  role,
  exposureTzs,
}: {
  invoice: SettlementInvoice;
  canDecide: boolean;
  role: AppRole;
  exposureTzs: number;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [rejecting, setRejecting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [approveKey, setApproveKey] = useState(newKey);
  const [rejectKey, setRejectKey] = useState(newKey);

  const action = useGuardedAction<"approve" | "reject", SettlementActionState>({
    failureKey: "settlementErrors.generic",
    onSettled: (outcome) => {
      if (!outcome.successKey) return;
      setConfirming(false);
      setRejecting(false);
      setReason("");
      setApproveKey(newKey());
      setRejectKey(newKey());
    },
  });
  const { pending, running, result } = action;

  const credit = invoice.credit!;

  /**
   * A Manager looking at a balance only a Director may decide.
   *
   * product.md §4 caps a Manager at TZS 500,000 on one invoice, and §4.3 makes a rejection a
   * COMPLETED DECISION — so a Manager who could refuse this would be deciding it either way: the
   * customer gets nothing, the request is settled, and no Director ever sees it. Both controls are
   * therefore unavailable, with the reason stated where the decision would have been made
   * (design.md §4.4, §7.8). The database refuses the same thing independently.
   */
  const beyondManagerLimit = credit.requiredRole === "director" && role === "manager";

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
                  data.set("idempotencyKey", rejectKey);
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
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-2 md:flex-row">
              <Button
                type="button"
                size="small"
                data-testid={`approve-credit-${invoice.id}`}
                disabled={pending || beyondManagerLimit}
                onClick={() => setConfirming(true)}
              >
                {t("settlement.credit.approve")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="small"
                data-testid={`reject-credit-${invoice.id}`}
                disabled={pending || beyondManagerLimit}
                onClick={() => setRejecting(true)}
              >
                {t("settlement.credit.reject")}
              </Button>
            </div>

            {/* A disabled control always carries its reason (design.md §4.4). */}
            {beyondManagerLimit ? (
              <Help data-testid={`credit-blocked-${invoice.id}`}>
                {t("settlement.credit.beyondManagerLimit")}
              </Help>
            ) : null}
          </div>
        )
      ) : null}

      {/* Approving credit is an authority decision that changes what the business is owed, so it
          names its consequence and takes a second, separate press (design.md §10.8, §11.8). */}
      <ConfirmSheet
        open={confirming}
        onOpenChange={(next) => {
          setConfirming(next);
          if (!next) action.clear();
        }}
        title={t("settlement.credit.approveTitle")}
        consequence={t("settlement.credit.approveConsequence", {
          amount: formatTzs(credit.amountTzs, locale),
          who: invoice.customerName,
        })}
        confirmLabel={t("settlement.credit.confirmApprove")}
        confirmId={`confirm-approve-credit-${invoice.id}`}
        cancelLabel={t("common.cancel")}
        pending={running === "approve"}
        pendingLabel={t("common.loading")}
        onConfirm={() => {
          const data = new FormData();
          data.set("entityId", credit.id);
          data.set("idempotencyKey", approveKey);
          action.run("approve", approveCreditAction, data);
        }}
      >
        {/* The refusal renders INSIDE the dialog, because the dialog traps focus and a message
            behind it is a message nobody sees. */}
        {result.error ? (
          <div className="flex flex-col gap-2">
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
      </ConfirmSheet>
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
 *
 * THREE COMMANDS, THREE KEYS. Recording money, asking for credit and confirming settlement are
 * different operations against the same invoice. One key across them is claimed by whichever runs
 * first and refused to the other two.
 */
function SettlementPanel({ invoice }: { invoice: SettlementInvoice }) {
  const t = useTranslations();
  const locale = useLocale();

  const [mode, setMode] = useState<"none" | "tender" | "credit">("none");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  // Pre-filled with the balance due: the common case is one tap plus confirm (design.md §7.7).
  const [amount, setAmount] = useState(String(invoice.settlement.outstandingTzs));
  const [reason, setReason] = useState("");
  const [payKey, setPayKey] = useState(newKey);
  const [creditKey, setCreditKey] = useState(newKey);
  const [settleKey, setSettleKey] = useState(newKey);

  // Which of the three commands is in flight, recorded where `onSettled` can actually read it.
  const lastRan = useRef<"pay" | "credit" | "settle" | null>(null);

  const action = useGuardedAction<"pay" | "credit" | "settle", SettlementActionState>({
    failureKey: "settlementErrors.generic",
    onSettled: (outcome) => {
      // A refusal keeps every key, so a retry re-addresses the same command. Only the key of the
      // command the server confirmed is retired.
      if (!outcome.successKey) return;
      setMode("none");
      setReason("");
      if (lastRan.current === "pay") setPayKey(newKey());
      else if (lastRan.current === "credit") setCreditKey(newKey());
      else if (lastRan.current === "settle") setSettleKey(newKey());
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
                data.set("idempotencyKey", payKey);
                lastRan.current = "pay";
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
                data.set("idempotencyKey", creditKey);
                lastRan.current = "credit";
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
                data.set("idempotencyKey", settleKey);
                lastRan.current = "settle";
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
 * ONE action with ONE confirmation, never four sequential saves. The confirmation names what will
 * happen before it happens, and if stock has gone in the meantime the whole thing fails cleanly
 * and says so — no invoice, no payment, no commitment (AC-89).
 */
function CashSaleCard({ order, canTakeMoney }: { order: CashSale; canTakeMoney: boolean }) {
  const t = useTranslations();
  const locale = useLocale();
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [confirming, setConfirming] = useState(false);
  const [key, setKey] = useState(newKey);

  const action = useGuardedAction<"pay", SettlementActionState>({
    failureKey: "settlementErrors.generic",
    onSettled: (outcome) => {
      if (outcome.successKey) {
        setConfirming(false);
        setKey(newKey());
      }
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
                data-testid={`complete-cash-sale-${order.id}`}
                disabled={pending}
                onClick={() => setConfirming(true)}
              >
                {t("settlement.payments.completeCashSale")}
              </Button>
            </div>

            <Help>{t("settlement.payments.cashSaleConsequence")}</Help>
          </>
        ) : null}
      </div>

      <ConfirmSheet
        open={confirming}
        onOpenChange={(next) => {
          setConfirming(next);
          if (!next) action.clear();
        }}
        title={t("settlement.payments.cashSaleTitle")}
        consequence={t("settlement.payments.cashSaleConfirmConsequence", {
          amount: formatTzs(order.totalTzs, locale),
          method: t(`settlement.methods.${method}`),
        })}
        confirmLabel={t("settlement.payments.confirmCashSale")}
        confirmId={`confirm-cash-sale-${order.id}`}
        cancelLabel={t("common.cancel")}
        pending={pending}
        pendingLabel={t("common.loading")}
        onConfirm={() => {
          const data = new FormData();
          data.set("orderId", order.id);
          data.set("method", method);
          // §12.4: a walk-in sale accepts full tender and nothing else, so the amount is the bill.
          data.set("amount", String(order.totalTzs));
          data.set("idempotencyKey", key);
          action.run("pay", takeCashPaymentAction, data);
        }}
      >
        {/* Inside the dialog, because the dialog traps focus: a stock refusal rendered on the card
            underneath is a refusal nobody reads. */}
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

        {/* A refusal that arrives as a FIELD error has nowhere else to go on this card: there is
            no field on it. Rendering it here is what stops a schema refusal from looking like a
            button that does nothing, which is exactly how a missing amount presented itself. */}
        {result.fieldErrors
          ? Object.values(result.fieldErrors).map((key) => (
              <FieldError key={key}>{t(key)}</FieldError>
            ))
          : null}
      </ConfirmSheet>
    </Card>
  );
}
