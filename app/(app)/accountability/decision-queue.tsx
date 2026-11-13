"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { recordDecisionAction } from "@/app/(app)/accountability/actions";
import { Outcome, TOUCH_FLOOR, useFreshKey } from "@/app/(app)/imprest/funding-forms";
import { Button } from "@/components/ui/button";
import { Field, FieldError, Help, Label } from "@/components/ui/field";
import { Card, StatusChip } from "@/components/ui/surface";
import type { StaffOption, Undecided } from "@/lib/accountability/decisions";
import { formatTzs } from "@/lib/money";
import { formatBusinessDate, formatBusinessStamp } from "@/lib/time/business-date";

/**
 * The Directors' undecided list and its decision form (issue #84), on the feedback contract every
 * form here keeps (design.md §12.7): acknowledged at once, one activation at a time, a retry resends
 * the same key, nothing typed is cleared on a refusal, success only once the server confirms it.
 *
 * ONE CONTROLLER FOR THE LIST. A recorded decision refreshes the page and its subject leaves the
 * list, taking its form with it. The answer is shown above the list, so it stays on screen.
 */

const UNCONFIRMED_KEY = "accountabilityErrors.unconfirmed";

export function DecisionQueue({ undecided, staff }: { undecided: Undecided[]; staff: StaffOption[] }) {
  const t = useTranslations("accountability");
  const tAll = useTranslations();
  const locale = useLocale();
  const [open, setOpen] = useState<string | null>(null);
  const [key, controller, renewKey] = useFreshKey(() => setOpen(null), UNCONFIRMED_KEY);
  // An unconfirmed answer may already have committed under this key. Until Try again finds out, the
  // form keeps what was sent and nothing else can be opened, so a retry never records other words.
  const unconfirmed = Boolean(controller.retry) && controller.result.error === UNCONFIRMED_KEY;
  const locked = controller.pending || unconfirmed;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="undecided-heading" data-testid="undecided">
      <h2 id="undecided-heading" className="text-lg font-semibold">
        {t("undecided.title", { count: undecided.length })}
      </h2>
      <Outcome controller={controller} />
      {undecided.length === 0 ? (
        <Card>
          <p className="text-sm text-muted-foreground" data-testid="undecided-empty">
            {t("undecided.empty")}
          </p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {undecided.map((u) => (
            <li key={u.subjectId}>
              <Card className="flex flex-col gap-3" data-testid={`subject-${u.subjectType}`}>
                <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{t(`subject.${u.subjectType}`)}</span>
                      {u.replacement ? <StatusChip>{t("undecided.replacement")}</StatusChip> : null}
                      {u.fundRetired ? <StatusChip>{t("undecided.retiredFund")}</StatusChip> : null}
                    </div>
                    <p className="text-sm text-muted-foreground break-words">
                      {u.subjectType === "imprest_unexplained_loss" && u.disbursementId ? (
                        <>
                          <Link className="underline" href={`/imprest/disbursements/${u.disbursementId}`}>
                            {u.disbursementNo}
                          </Link>
                          {` · ${u.purpose ?? ""}`}
                          {u.proposedBy ? ` · ${t("undecided.proposedBy", { name: u.proposedBy })}` : null}
                        </>
                      ) : (
                        t("undecided.countedOn", {
                          date: u.businessDate ? formatBusinessDate(u.businessDate, locale) : "",
                          counted: u.countedBy ?? "",
                          confirmed: u.confirmedBy ?? "",
                        })
                      )}
                    </p>
                    {u.explanation ? (
                      <p className="text-sm break-words">
                        {u.subjectType === "imprest_count_shortage"
                          ? t("undecided.countExplanation", {
                              reason: tAll(`imprest.count.explanation.${u.explanation}`),
                              note: u.explanationNote ?? "",
                            })
                          : t("undecided.settlementExplanation", { text: u.explanation })}
                      </p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      {t("undecided.posted", { when: formatBusinessStamp(u.postedAt, locale) })}
                    </p>
                  </div>
                  <span className="fv-numeric shrink-0 font-semibold text-danger">{formatTzs(u.amount, locale)}</span>
                </div>

                {open === u.subjectId ? (
                  <DecisionForm
                    subject={u}
                    staff={staff}
                    controller={controller}
                    locked={locked}
                    idempotencyKey={key}
                    onCancel={() => {
                      controller.clear();
                      setOpen(null);
                    }}
                  />
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    className={`${TOUCH_FLOOR} self-start`}
                    disabled={locked}
                    data-testid="open-decision"
                    onClick={() => {
                      controller.clear();
                      renewKey();
                      setOpen(u.subjectId);
                    }}
                  >
                    {t("form.open")}
                  </Button>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DecisionForm({
  subject,
  staff,
  controller,
  locked,
  idempotencyKey,
  onCancel,
}: {
  subject: Undecided;
  staff: StaffOption[];
  controller: ReturnType<typeof useFreshKey>[1];
  /** True while a request runs or its outcome is unconfirmed: nothing on the form may change. */
  locked: boolean;
  idempotencyKey: string;
  onCancel: () => void;
}) {
  const t = useTranslations("accountability");
  const tAll = useTranslations();
  const [decision, setDecision] = useState("");
  const [responsibility, setResponsibility] = useState<"named" | "nobody" | "">("");
  const [named, setNamed] = useState<string[]>([]);
  const problems = controller.running === null ? controller.result.fieldErrors : undefined;
  const id = `decide-${subject.subjectId}`;

  return (
    <form
      className="flex flex-col gap-4 border-t border-border pt-4"
      noValidate
      data-testid="decision-form"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData();
        data.set("subjectType", subject.subjectType);
        data.set("subjectId", subject.subjectId);
        data.set("decision", decision);
        if (responsibility) data.set("responsibility", responsibility);
        if (responsibility === "named") for (const s of named) data.append("responsibleStaff", s);
        data.set("idempotencyKey", idempotencyKey);
        controller.run("record", recordDecisionAction, data);
      }}
    >
      <p
        className="rounded-sm border border-border bg-periwinkle/40 p-3 text-sm"
        role="note"
        data-testid="no-payroll-effect"
      >
        {t("form.noPayroll")}
      </p>

      <Field>
        <Label htmlFor={`${id}-decision`}>{t("form.decision")}</Label>
        <textarea
          id={`${id}-decision`}
          name="decision"
          rows={4}
          maxLength={2000}
          className="w-full rounded-sm border border-input bg-card p-3 text-sm text-foreground aria-[invalid=true]:border-danger"
          value={decision}
          readOnly={locked}
          aria-invalid={problems?.decision ? true : undefined}
          aria-describedby={`${id}-decision-help${problems?.decision ? ` ${id}-decision-error` : ""}`}
          onChange={(event) => setDecision(event.target.value)}
        />
        <Help id={`${id}-decision-help`}>{t("form.decisionHelp")}</Help>
        {problems?.decision ? (
          <span id={`${id}-decision-error`}>
            <FieldError>{tAll(problems.decision)}</FieldError>
          </span>
        ) : null}
      </Field>

      <fieldset className="flex flex-col gap-2" aria-describedby={`${id}-who-help`}>
        <legend className="text-[13px] font-medium">{t("form.who")}</legend>
        <Help id={`${id}-who-help`}>{t("form.whoHelp")}</Help>
        {(["named", "nobody"] as const).map((choice) => (
          <label key={choice} className={`flex items-center gap-2 text-sm ${TOUCH_FLOOR}`}>
            <input
              type="radio"
              name={`${id}-responsibility`}
              value={choice}
              checked={responsibility === choice}
              disabled={locked}
              onChange={() => setResponsibility(choice)}
              data-testid={`responsibility-${choice}`}
            />
            {t(`form.${choice}`)}
          </label>
        ))}
        {problems?.responsibility ? <FieldError>{tAll(problems.responsibility)}</FieldError> : null}

        {responsibility === "named" ? (
          <div
            className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-sm border border-border p-3"
            data-testid="staff-options"
          >
            {staff.map((s) => (
              <label key={s.id} className={`flex items-center gap-2 text-sm ${TOUCH_FLOOR}`}>
                <input
                  type="checkbox"
                  value={s.id}
                  checked={named.includes(s.id)}
                  disabled={locked}
                  onChange={(event) =>
                    setNamed((list) =>
                      event.target.checked ? [...list, s.id] : list.filter((x) => x !== s.id),
                    )
                  }
                />
                <span className="break-words">
                  {s.name}
                  <span className="text-muted-foreground">
                    {` · ${tAll(`admin.roles.${s.role}`)}`}
                    {s.active ? "" : ` · ${t("form.inactive")}`}
                  </span>
                </span>
              </label>
            ))}
          </div>
        ) : null}
        {problems?.responsibleStaff ? <FieldError>{tAll(problems.responsibleStaff)}</FieldError> : null}
      </fieldset>

      <Help>{t("form.permanent")}</Help>
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          className={TOUCH_FLOOR}
          pending={controller.running === "record"}
          pendingLabel={tAll("common.loading")}
          disabled={locked}
          data-testid="record-decision"
        >
          {t("form.submit")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          className={TOUCH_FLOOR}
          disabled={locked}
          onClick={onCancel}
        >
          {tAll("common.cancel")}
        </Button>
      </div>
    </form>
  );
}
