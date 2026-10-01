"use client";

import { useLocale, useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";

import { ActionForm, Outcome, TOUCH_FLOOR, useFreshKey, type Controller } from "@/app/(app)/imprest/funding-forms";
import {
  confirmTillCountAction,
  enterLateTillCountAction,
  enterTillCountAction,
  sendBackTillCountAction,
} from "@/app/(app)/till/actions";
import { Button } from "@/components/ui/button";
import { Field, FieldError, Help, Input, Label } from "@/components/ui/field";
import { formatTzs } from "@/lib/money";
import { PAYMENT_METHODS } from "@/lib/settlement/methods";
import { REASONS_NEEDING_NOTE, VARIANCE_REASONS, type VarianceReason } from "@/lib/till/counting";

const UNCONFIRMED_KEY = "till.errors.unconfirmed";

/**
 * The till count's controls (issue #83), on the feedback contract of the imprest forms (design.md
 * §12.7): acknowledged at once, one activation at a time, a retry resends the same key, nothing
 * typed is cleared on a refusal, and success only after the server confirms it.
 */

/** Whole shillings typed so far, for the running total; anything unreadable counts as nothing yet. */
function typedShillings(value: string): number {
  const cleaned = value.replace(/[\s ,]/g, "");
  return /^\d+$/.test(cleaned) ? Number(cleaned) : 0;
}

/**
 * The Cashier's count (design.md §7.19): one field per payment method, in the order they are
 * listed, and an optional note. No expected figure is shown: the database calculates it and keeps it
 * with the count, and the count shows it once submitted.
 */
function EnterTillCountForm({
  businessDate,
  replaces,
  controller,
  idempotencyKey: key,
  late = false,
}: {
  businessDate: string;
  replaces: { id: string; reason: string } | null;
  controller: Controller;
  idempotencyKey: string;
  late?: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [counted, setCounted] = useState<Record<string, string>>(() =>
    Object.fromEntries(PAYMENT_METHODS.map((m) => [m, ""])),
  );
  const [note, setNote] = useState("");
  const [lateReason, setLateReason] = useState("");
  const problems = controller.running === null ? controller.result.fieldErrors : undefined;
  const locked = useDeferredValue(controller.pending);
  const id = (name: string) => (late ? `till-late-${businessDate}-${name}` : `till-${name}`);
  const total = PAYMENT_METHODS.reduce((sum, m) => sum + typedShillings(counted[m]), 0);

  const error = (name: string) =>
    problems?.[name] ? (
      <span id={`${id(name)}-error`}>
        <FieldError>{t(problems[name])}</FieldError>
      </span>
    ) : null;

  return (
    <div className="flex flex-col gap-3">
      {replaces ? (
        <p className="rounded-lg bg-danger/10 p-3 text-sm" data-testid="till-recount-reason">
          {t("till.enter.recountReason", { reason: replaces.reason })}
        </p>
      ) : null}
      <form
        className="flex flex-col gap-4"
        noValidate
        data-testid={late ? "till-late-form" : "till-enter-form"}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData();
          data.set("businessDate", businessDate);
          data.set("previousCountId", replaces?.id ?? "");
          for (const m of PAYMENT_METHODS) data.set(`counted.${m}`, counted[m]);
          data.set("note", note);
          if (late) data.set("lateReason", lateReason);
          data.set("idempotencyKey", key);
          controller.run("count", late ? enterLateTillCountAction : enterTillCountAction, data);
        }}
      >
        {late ? (
          <Field>
            <Label htmlFor={id("lateReason")}>{t("till.late.reason")}</Label>
            <Input
              id={id("lateReason")}
              name="lateReason"
              autoComplete="off"
              maxLength={500}
              value={lateReason}
              readOnly={locked}
              aria-invalid={problems?.lateReason ? true : undefined}
              aria-describedby={problems?.lateReason ? `${id("lateReason")}-error` : `${id("lateReason")}-help`}
              onChange={(event) => setLateReason(event.target.value)}
            />
            <Help id={`${id("lateReason")}-help`}>{t("till.late.reasonHelp")}</Help>
            {error("lateReason")}
          </Field>
        ) : null}

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 font-semibold">{t("till.enter.heading")}</legend>
          <Help>{t("till.enter.help")}</Help>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {PAYMENT_METHODS.map((m) => {
              const name = `counted.${m}`;
              return (
                <Field key={m}>
                  <Label htmlFor={id(m)}>{t(`settlement.methods.${m}`)}</Label>
                  <Input
                    id={id(m)}
                    name={name}
                    inputMode="numeric"
                    autoComplete="off"
                    value={counted[m]}
                    readOnly={locked}
                    data-testid={`till-counted-${m}`}
                    aria-invalid={problems?.[name] ? true : undefined}
                    aria-describedby={problems?.[name] ? `${id(name)}-error` : undefined}
                    onChange={(event) => setCounted((c) => ({ ...c, [m]: event.target.value }))}
                  />
                  {error(name)}
                </Field>
              );
            })}
          </div>
          <p className="fv-numeric text-sm font-medium" data-testid="till-running-total" aria-live="polite">
            {t("till.figures.total")}: {formatTzs(total, locale)}
          </p>
        </fieldset>

        <Field>
          <Label htmlFor={id("note")}>{t("till.enter.note")}</Label>
          <Input
            id={id("note")}
            name="note"
            autoComplete="off"
            maxLength={500}
            value={note}
            readOnly={locked}
            aria-invalid={problems?.note ? true : undefined}
            aria-describedby={problems?.note ? `${id("note")}-error` : undefined}
            onChange={(event) => setNote(event.target.value)}
          />
          {error("note")}
        </Field>
        <Button
          type="submit"
          className={`${TOUCH_FLOOR} self-start`}
          data-testid={late ? "till-submit-late" : "till-submit"}
          pending={controller.running === "count"}
          pendingLabel={t("common.loading")}
          disabled={controller.pending}
        >
          {t(late ? "till.late.submit" : replaces ? "till.enter.submitAgain" : "till.enter.submit")}
        </Button>
      </form>
    </div>
  );
}

export type TillCountToDecide = { id: string; version: number; short: number; over: number };

/**
 * The Manager's decision on a waiting count: confirm it as it stands, or send it back. There is no
 * field for a figure. A Shortage or Excess takes one of the seven reasons, three with a note.
 */
function TillDecision({
  count,
  controller,
  idempotencyKey: key,
  renewKey,
}: {
  count: TillCountToDecide;
  controller: Controller;
  idempotencyKey: string;
  renewKey: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<VarianceReason | "">("");
  const [note, setNote] = useState("");
  const problems = controller.running === null ? controller.result.fieldErrors : undefined;
  const locked = useDeferredValue(controller.pending);
  const hidden = { countId: count.id, expectedVersion: String(count.version) };
  const balanced = count.short === 0 && count.over === 0;
  const needsNote = reason !== "" && REASONS_NEEDING_NOTE.includes(reason);
  // After a request that got no answer, only Try again may use its key.
  const unconfirmed =
    controller.retry && controller.result.error === UNCONFIRMED_KEY ? controller.retryName : null;

  const confirmLabel = balanced
    ? t("till.confirm.balanced")
    : count.short > 0
      ? t("till.confirm.shortage", { amount: formatTzs(count.short, locale) })
      : t("till.confirm.excess", { amount: formatTzs(count.over, locale) });

  return (
    <section className="flex flex-col gap-3" aria-label={t("till.confirm.heading")}>
      <form
        className="flex flex-col gap-4 rounded-lg border border-border p-4"
        noValidate
        data-testid="till-confirm-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData();
          for (const [k, v] of Object.entries(hidden)) data.set(k, v);
          data.set("short", String(count.short));
          data.set("over", String(count.over));
          data.set("explanation", reason);
          data.set("note", note);
          data.set("idempotencyKey", key);
          setOpen(false);
          controller.run("confirm", confirmTillCountAction, data);
        }}
      >
        <h3 className="font-semibold">{t("till.confirm.title")}</h3>
        <Help>{t(balanced ? "till.confirm.helpBalanced" : "till.confirm.help")}</Help>

        {!balanced ? (
          <>
            <fieldset
              className="flex flex-col gap-2"
              aria-invalid={problems?.explanation ? true : undefined}
              aria-describedby={problems?.explanation ? "till-reason-error" : undefined}
            >
              <legend className="mb-2 text-sm font-medium">{t("till.confirm.reason")}</legend>
              <div className="flex flex-wrap gap-2">
                {VARIANCE_REASONS.map((r) => (
                  <label key={r} className="inline-flex cursor-pointer">
                    <input
                      type="radio"
                      name="explanation"
                      value={r}
                      className="peer sr-only"
                      checked={reason === r}
                      disabled={locked}
                      onChange={() => setReason(r)}
                    />
                    <span
                      className={`${TOUCH_FLOOR} inline-flex items-center rounded-full border border-border px-3 py-1.5 text-sm peer-checked:border-foreground peer-checked:bg-foreground peer-checked:text-background peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2`}
                    >
                      {t(`till.reason.${r}`)}
                    </span>
                  </label>
                ))}
              </div>
              {problems?.explanation ? (
                <span id="till-reason-error">
                  <FieldError>{t(problems.explanation)}</FieldError>
                </span>
              ) : null}
            </fieldset>
            <Field>
              <Label htmlFor="till-confirm-note">
                {t(needsNote ? "till.confirm.noteRequired" : "till.confirm.note")}
              </Label>
              <Input
                id="till-confirm-note"
                name="note"
                autoComplete="off"
                maxLength={500}
                value={note}
                readOnly={locked}
                aria-invalid={problems?.note ? true : undefined}
                aria-describedby={problems?.note ? "till-confirm-note-error" : undefined}
                onChange={(event) => setNote(event.target.value)}
              />
              {problems?.note ? (
                <span id="till-confirm-note-error">
                  <FieldError>{t(problems.note)}</FieldError>
                </span>
              ) : null}
            </Field>
          </>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            className={TOUCH_FLOOR}
            data-testid="till-confirm"
            pending={controller.running === "confirm"}
            pendingLabel={t("common.loading")}
            disabled={controller.pending || unconfirmed === "sendBack"}
          >
            {confirmLabel}
          </Button>
          <Button
            type="button"
            variant={open ? "secondary" : "danger"}
            size="small"
            className={TOUCH_FLOOR}
            disabled={controller.pending || unconfirmed === "confirm"}
            aria-expanded={open}
            data-testid="till-open-send-back"
            onClick={() => {
              if (!unconfirmed) {
                controller.clear();
                renewKey();
              }
              setOpen(!open);
            }}
          >
            {t("till.sendBack.open")}
          </Button>
        </div>
      </form>

      {open ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border p-4" data-testid="till-send-back">
          <h3 className="font-semibold">{t("till.sendBack.title")}</h3>
          <Help>{t("till.sendBack.help")}</Help>
          <ActionForm
            id="till-send-back"
            controller={controller}
            name="sendBack"
            action={sendBackTillCountAction}
            hidden={hidden}
            fields={[{ name: "reason", labelKey: "till.sendBack.reason", kind: "text" }]}
            submitKey="till.sendBack.confirm"
            variant="danger"
            testId="till-send-back-form"
            idempotencyKey={key}
          />
        </div>
      ) : null}
    </section>
  );
}

/**
 * The controls the viewer may use on one day's count now, and no others (design.md §4.3). They stay
 * mounted across the refresh after a success, so the server's answer stays on screen when the form
 * it came from has gone.
 */
export function TillCountControls({
  role,
  businessDate,
  mayCount,
  replaces,
  waiting,
}: {
  role: "cashier" | "manager";
  businessDate: string;
  /** The day has no count yet, or its latest was sent back. */
  mayCount: boolean;
  replaces: { id: string; reason: string } | null;
  /** The day's count while it waits for the Manager. */
  waiting: TillCountToDecide | null;
}) {
  const [key, controller, renewKey] = useFreshKey(undefined, UNCONFIRMED_KEY);

  let form: React.ReactNode = null;
  if (role === "cashier" && mayCount) {
    form = (
      <EnterTillCountForm
        key={replaces?.id ?? "first"}
        businessDate={businessDate}
        replaces={replaces}
        controller={controller}
        idempotencyKey={key}
      />
    );
  } else if (role === "manager" && waiting) {
    form = (
      <TillDecision
        key={`${waiting.id}-${waiting.version}`}
        count={waiting}
        controller={controller}
        idempotencyKey={key}
        renewKey={renewKey}
      />
    );
  }

  if (!form && !controller.result.successKey && !controller.result.error) return null;
  return (
    <div className="flex flex-col gap-3">
      {form}
      <Outcome controller={controller} />
    </div>
  );
}

/**
 * The Cashier's late count for one past Not counted day: closed until asked for, so a list of
 * missed days reads as a list. It stays mounted after a success, so the answer stays on screen.
 */
export function LateTillCountControl({
  businessDate,
  dateLabel,
  mayOpen,
  replaces,
}: {
  businessDate: string;
  dateLabel: string;
  /** The day is Not counted. */
  mayOpen: boolean;
  replaces: { id: string; reason: string } | null;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [key, controller] = useFreshKey(() => setOpen(false), UNCONFIRMED_KEY);

  if (!mayOpen && !controller.result.successKey && !controller.result.error) return null;
  return (
    <div className="flex flex-col gap-3">
      {open && mayOpen ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <Help>{t("till.late.help")}</Help>
          <EnterTillCountForm
            businessDate={businessDate}
            replaces={replaces}
            controller={controller}
            idempotencyKey={key}
            late
          />
        </div>
      ) : controller.result.successKey || !mayOpen ? null : (
        <Button
          type="button"
          variant="secondary"
          size="small"
          className={`${TOUCH_FLOOR} self-start`}
          data-testid={`till-open-late-${businessDate}`}
          aria-label={t("till.late.openFor", { date: dateLabel })}
          onClick={() => setOpen(true)}
        >
          {t("till.late.open")}
        </Button>
      )}
      <Outcome controller={controller} />
    </div>
  );
}
