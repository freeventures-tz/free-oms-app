"use client";

import { useLocale, useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";

import {
  confirmCountAction,
  enterCountAction,
  enterLateCountAction,
  sendBackCountAction,
} from "@/app/(app)/imprest/actions";
import { ActionForm, Outcome, TOUCH_FLOOR, useFreshKey, type Controller } from "@/app/(app)/imprest/funding-forms";
import { Button } from "@/components/ui/button";
import { Field, FieldError, Help, Input, Label } from "@/components/ui/field";
import { COUNT_EXPLANATIONS, EXPLANATIONS_NEEDING_NOTE, type CountExplanation } from "@/lib/imprest/counting";
import { formatTzs } from "@/lib/money";

const COUNT_UNCONFIRMED_KEY = "countErrors.unconfirmed";

/**
 * The daily count's controls (issue #68), on the feedback contract of the other imprest forms
 * (design.md §12.7): acknowledged at once, one activation at a time, a retry resends the same key,
 * nothing typed is cleared on a refusal, and success only after the server confirms it.
 */

/**
 * The Cashier's count (design.md §7B.9): one field for the cash in the tin, and an optional note.
 * Expected cash is not shown here. The database calculates it and keeps it with the count, and the
 * count shows it once entered.
 */
function EnterCountForm({
  businessDate,
  replaces,
  controller,
  idempotencyKey: key,
  late = false,
}: {
  businessDate: string;
  /** A recount names the sent-back count it replaces, with the Manager's reason. */
  replaces: { id: string; reason: string } | null;
  controller: Controller;
  idempotencyKey: string;
  /** A past Not counted day, counted late (issue #69): one more field, the reason, required. */
  late?: boolean;
}) {
  const t = useTranslations();
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [lateReason, setLateReason] = useState("");
  const problems = controller.running === null ? controller.result.fieldErrors : undefined;
  const locked = useDeferredValue(controller.pending);
  // Ids are per day, since several missed days can each have a form on one screen.
  const id = (name: string) => (late ? `late-${businessDate}-${name}` : `count-${name}`);

  const error = (name: string) =>
    problems?.[name] ? (
      <span id={`${id(name)}-error`}>
        <FieldError>{t(problems[name])}</FieldError>
      </span>
    ) : null;

  return (
    <div className="flex flex-col gap-3">
      {replaces ? (
        <p className="rounded-lg bg-danger/10 p-3 text-sm" data-testid="recount-reason">
          {t("imprest.count.enter.recountReason", { reason: replaces.reason })}
        </p>
      ) : null}
      <form
        className="flex flex-col gap-4"
        noValidate
        data-testid={late ? "late-count-form" : "enter-count-form"}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData();
          data.set("businessDate", businessDate);
          data.set("previousCountId", replaces?.id ?? "");
          data.set("counted", counted);
          data.set("note", note);
          if (late) data.set("lateReason", lateReason);
          data.set("idempotencyKey", key);
          controller.run("count", late ? enterLateCountAction : enterCountAction, data);
        }}
      >
        {late ? (
          <Field>
            <Label htmlFor={id("lateReason")}>{t("imprest.count.late.reason")}</Label>
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
            <Help id={`${id("lateReason")}-help`}>{t("imprest.count.late.reasonHelp")}</Help>
            {error("lateReason")}
          </Field>
        ) : null}
        <Field>
          <Label htmlFor={id("counted")}>{t("imprest.count.enter.counted")}</Label>
          <Input
            id={id("counted")}
            name="counted"
            inputMode="numeric"
            autoComplete="off"
            value={counted}
            readOnly={locked}
            aria-invalid={problems?.counted ? true : undefined}
            aria-describedby={problems?.counted ? `${id("counted")}-error` : `${id("counted")}-help`}
            onChange={(event) => setCounted(event.target.value)}
          />
          <Help id={`${id("counted")}-help`}>
            {t(late ? "imprest.count.late.countedHelp" : "imprest.count.enter.countedHelp")}
          </Help>
          {error("counted")}
        </Field>
        <Field>
          <Label htmlFor={id("note")}>{t("imprest.count.enter.note")}</Label>
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
          data-testid={late ? "submit-late-count" : "submit-count"}
          pending={controller.running === "count"}
          pendingLabel={t("common.loading")}
          disabled={controller.pending}
        >
          {t(
            late
              ? "imprest.count.late.submit"
              : replaces
                ? "imprest.count.enter.submitAgain"
                : "imprest.count.enter.submit",
          )}
        </Button>
      </form>
    </div>
  );
}

export type CountToDecide = { id: string; version: number; expected: number; counted: number; variance: number };

/**
 * The Manager's decision on a waiting count: confirm it as it stands, or send it back for a
 * recount. There is no field for a figure. A shortage or excess takes one of the seven preset
 * explanations (design.md §14.7), and three of them a written note.
 */
function CountDecision({
  count,
  controller,
  idempotencyKey: key,
  renewKey,
}: {
  count: CountToDecide;
  controller: Controller;
  idempotencyKey: string;
  renewKey: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [open, setOpen] = useState<"sendBack" | null>(null);
  const [explanation, setExplanation] = useState<CountExplanation | "">("");
  const [note, setNote] = useState("");
  const problems = controller.running === null ? controller.result.fieldErrors : undefined;
  const locked = useDeferredValue(controller.pending);
  const hidden = { countId: count.id, expectedVersion: String(count.version) };
  const amount = formatTzs(Math.abs(count.variance), locale);
  const needsNote = explanation !== "" && EXPLANATIONS_NEEDING_NOTE.includes(explanation);
  // After a request that got no answer, only Try again may use its key: the other action would be a
  // different command under the same key, and would hide whether the first one committed.
  const unconfirmed =
    controller.retry && controller.result.error === COUNT_UNCONFIRMED_KEY ? controller.retryName : null;

  const confirmLabel =
    count.variance === 0
      ? t("imprest.count.confirm.balanced")
      : t(count.variance < 0 ? "imprest.count.confirm.shortage" : "imprest.count.confirm.excess", { amount });

  return (
    <section className="flex flex-col gap-3" aria-label={t("imprest.count.confirm.heading")}>
      <form
        className="flex flex-col gap-4 rounded-lg border border-border p-4"
        noValidate
        data-testid="confirm-count-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData();
          for (const [k, v] of Object.entries(hidden)) data.set(k, v);
          data.set("variance", String(count.variance));
          data.set("explanation", explanation);
          data.set("note", note);
          data.set("idempotencyKey", key);
          setOpen(null);
          controller.run("confirm", confirmCountAction, data);
        }}
      >
        <h3 className="font-semibold">{t("imprest.count.confirm.title")}</h3>
        <Help>
          {t(count.variance === 0 ? "imprest.count.confirm.helpBalanced" : "imprest.count.confirm.help")}
        </Help>

        {count.variance !== 0 ? (
          <>
            <fieldset
              className="flex flex-col gap-2"
              aria-invalid={problems?.explanation ? true : undefined}
              aria-describedby={problems?.explanation ? "confirm-explanation-error" : undefined}
            >
              <legend className="mb-2 text-sm font-medium">{t("imprest.count.confirm.explanation")}</legend>
              <div className="flex flex-wrap gap-2">
                {COUNT_EXPLANATIONS.map((e) => (
                  <label key={e} className="inline-flex cursor-pointer">
                    <input
                      type="radio"
                      name="explanation"
                      value={e}
                      className="peer sr-only"
                      checked={explanation === e}
                      disabled={locked}
                      onChange={() => setExplanation(e)}
                    />
                    <span
                      className={`${TOUCH_FLOOR} inline-flex items-center rounded-full border border-border px-3 py-1.5 text-sm peer-checked:border-foreground peer-checked:bg-foreground peer-checked:text-background peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2`}
                    >
                      {t(`imprest.count.explanation.${e}`)}
                    </span>
                  </label>
                ))}
              </div>
              {problems?.explanation ? (
                <span id="confirm-explanation-error">
                  <FieldError>{t(problems.explanation)}</FieldError>
                </span>
              ) : null}
            </fieldset>
            <Field>
              <Label htmlFor="confirm-note">
                {t(needsNote ? "imprest.count.confirm.noteRequired" : "imprest.count.confirm.note")}
              </Label>
              <Input
                id="confirm-note"
                name="note"
                autoComplete="off"
                maxLength={500}
                value={note}
                readOnly={locked}
                aria-invalid={problems?.note ? true : undefined}
                aria-describedby={problems?.note ? "confirm-note-error" : undefined}
                onChange={(event) => setNote(event.target.value)}
              />
              {problems?.note ? (
                <span id="confirm-note-error">
                  <FieldError>{t(problems.note)}</FieldError>
                </span>
              ) : null}
            </Field>
            <p className="text-sm font-medium" data-testid="confirm-posts">
              {t(count.variance < 0 ? "imprest.count.confirm.postsShortage" : "imprest.count.confirm.postsExcess", {
                amount,
              })}
            </p>
          </>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            className={TOUCH_FLOOR}
            data-testid="confirm-count"
            pending={controller.running === "confirm"}
            pendingLabel={t("common.loading")}
            disabled={controller.pending || unconfirmed === "sendBack"}
          >
            {confirmLabel}
          </Button>
          <Button
            type="button"
            variant={open === "sendBack" ? "secondary" : "danger"}
            size="small"
            className={TOUCH_FLOOR}
            disabled={controller.pending || unconfirmed === "confirm"}
            aria-expanded={open === "sendBack"}
            data-testid="open-send-back-count"
            onClick={() => {
              // An unconfirmed send-back may already have committed: keep its key for Try again.
              if (!unconfirmed) {
                controller.clear();
                renewKey();
              }
              setOpen(open === "sendBack" ? null : "sendBack");
            }}
          >
            {t("imprest.count.sendBack.open")}
          </Button>
        </div>
      </form>

      {open === "sendBack" ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border p-4" data-testid="send-back-count">
          <h3 className="font-semibold">{t("imprest.count.sendBack.title")}</h3>
          <Help>{t("imprest.count.sendBack.help")}</Help>
          <ActionForm
            id="send-back-count"
            controller={controller}
            name="sendBack"
            action={sendBackCountAction}
            hidden={hidden}
            fields={[{ name: "reason", labelKey: "imprest.count.sendBack.reason", kind: "text" }]}
            submitKey="imprest.count.sendBack.confirm"
            variant="danger"
            testId="send-back-count-form"
            idempotencyKey={key}
          />
        </div>
      ) : null}
    </section>
  );
}

/**
 * The controls the viewer may use on today's count now, and no others (design.md §4.3). They stay
 * mounted across the page's refresh after a success, so the server's answer stays on screen when
 * the form it came from has gone: a count waits for the Manager, a confirmed day takes no more.
 */
export function CountControls({
  role,
  businessDate,
  mayCount,
  replaces,
  waiting,
}: {
  role: "cashier" | "manager";
  businessDate: string;
  /** Today has no count yet, or its latest was sent back. */
  mayCount: boolean;
  replaces: { id: string; reason: string } | null;
  /** Today's count while it waits for the Manager. */
  waiting: CountToDecide | null;
}) {
  const [key, controller, renewKey] = useFreshKey(undefined, COUNT_UNCONFIRMED_KEY);

  let form: React.ReactNode = null;
  if (role === "cashier" && mayCount) {
    // Keyed by the count it replaces, so a recount starts from empty fields.
    form = (
      <EnterCountForm
        key={replaces?.id ?? "first"}
        businessDate={businessDate}
        replaces={replaces}
        controller={controller}
        idempotencyKey={key}
      />
    );
  } else if (role === "manager" && waiting) {
    form = (
      <CountDecision
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
 * The Cashier's late count for one past Not counted day (issue #69): closed until asked for, so a
 * list of missed days reads as a list. It stays mounted after a success, so the answer stays on
 * screen when the day leaves the list for Awaiting Manager confirmation.
 */
export function LateCountControl({
  businessDate,
  dateLabel,
  mayOpen,
  replaces,
}: {
  businessDate: string;
  /** The day as the list writes it, for the button's accessible name. */
  dateLabel: string;
  /** The day is Not counted and no count waits in the fund. */
  mayOpen: boolean;
  replaces: { id: string; reason: string } | null;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [key, controller] = useFreshKey(() => setOpen(false), COUNT_UNCONFIRMED_KEY);

  if (!mayOpen && !open && !controller.result.successKey && !controller.result.error) return null;
  return (
    <div className="flex flex-col gap-3">
      {open ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <Help>{t("imprest.count.late.help")}</Help>
          <EnterCountForm
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
          data-testid={`open-late-count-${businessDate}`}
          aria-label={t("imprest.count.late.openFor", { date: dateLabel })}
          onClick={() => setOpen(true)}
        >
          {t("imprest.count.late.open")}
        </Button>
      )}
      <Outcome controller={controller} />
    </div>
  );
}
