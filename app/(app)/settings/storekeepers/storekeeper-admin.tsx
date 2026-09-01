"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import {
  addStorekeeperAction,
  setStorekeeperActiveAction,
  type SettlementActionState,
} from "@/app/(app)/payments/actions";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FormError, FormSuccess, Help, Input, Label } from "@/components/ui/field";
import { Card, StatusChip } from "@/components/ui/surface";
import type { Storekeeper } from "@/lib/settlement/settlement";
import { useGuardedAction } from "@/lib/ui/use-guarded-action";

export function StorekeeperAdmin({
  storekeepers,
  canEdit,
  idempotencyKey,
}: {
  storekeepers: Storekeeper[];
  canEdit: boolean;
  idempotencyKey: string;
}) {
  const t = useTranslations("settlement.storekeepers");

  return (
    <div className="flex flex-col gap-4">
      {/* Hidden from a Manager, not disabled (design.md §4.3, §4.4). */}
      {canEdit ? <AddStorekeeperForm idempotencyKey={idempotencyKey} /> : null}

      {storekeepers.length === 0 ? (
        <Card>
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            {t("count", { count: storekeepers.length })}
          </p>
          {storekeepers.map((keeper) => (
            <StorekeeperRow key={keeper.id} keeper={keeper} canEdit={canEdit} />
          ))}
        </div>
      )}
    </div>
  );
}

function AddStorekeeperForm({ idempotencyKey }: { idempotencyKey: string }) {
  const t = useTranslations();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [startDate, setStartDate] = useState("");
  const [note, setNote] = useState("");
  const [key, setKey] = useState(idempotencyKey);

  const action = useGuardedAction<"add", SettlementActionState>({
    failureKey: "settlementErrors.generic",
    onSettled: (outcome) => {
      // Rotated only after a SUCCESS, so a corrected retry addresses the same intended record
      // rather than becoming a second person.
      if (outcome.successKey) {
        setFullName("");
        setPhone("");
        setStartDate("");
        setNote("");
        setKey(crypto.randomUUID());
      }
    },
  });
  const { pending, result } = action;

  return (
    <Card>
      <h2 className="text-sm font-semibold">{t("settlement.storekeepers.addHeading")}</h2>
      {/* Said plainly, because it is the surprising part: this record is not an account. */}
      <Help className="mt-1">{t("settlement.storekeepers.notAUser")}</Help>

      <div className="mt-4 flex flex-col gap-4">
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

        <FormSuccess>{result.successKey ? t(result.successKey) : null}</FormSuccess>

        <div className="grid gap-4 md:grid-cols-2">
          <Field>
            <Label htmlFor="keeper-name">{t("settlement.storekeepers.fullName")}</Label>
            <Input
              id="keeper-name"
              type="text"
              autoComplete="off"
              value={fullName}
              disabled={pending}
              onChange={(event) => setFullName(event.target.value)}
            />
            <FieldError>
              {result.fieldErrors?.fullName ? t(result.fieldErrors.fullName) : null}
            </FieldError>
          </Field>

          <Field>
            <Label htmlFor="keeper-start">{t("settlement.storekeepers.startDate")}</Label>
            <Input
              id="keeper-start"
              type="date"
              value={startDate}
              disabled={pending}
              onChange={(event) => setStartDate(event.target.value)}
            />
            <FieldError>
              {result.fieldErrors?.startDate ? t(result.fieldErrors.startDate) : null}
            </FieldError>
          </Field>

          <Field>
            <Label htmlFor="keeper-phone">{t("settlement.storekeepers.phone")}</Label>
            <Input
              id="keeper-phone"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              value={phone}
              disabled={pending}
              onChange={(event) => setPhone(event.target.value)}
            />
            {/* Optional, and not a login. §3.2 asks for a phone number, not a verified one, and
                §17.1 keeps the phone-as-identifier rule to accounts alone. */}
            <Help>{t("settlement.storekeepers.phoneHelp")}</Help>
            <FieldError>
              {result.fieldErrors?.phone ? t(result.fieldErrors.phone) : null}
            </FieldError>
          </Field>

          <Field>
            <Label htmlFor="keeper-note">{t("settlement.storekeepers.note")}</Label>
            <Input
              id="keeper-note"
              type="text"
              autoComplete="off"
              value={note}
              disabled={pending}
              onChange={(event) => setNote(event.target.value)}
            />
            <Help>{t("settlement.storekeepers.noteHelp")}</Help>
          </Field>
        </div>

        <div>
          <Button
            type="button"
            id="addStorekeeper"
            pending={pending}
            pendingLabel={t("common.loading")}
            onClick={() => {
              const data = new FormData();
              data.set("fullName", fullName);
              data.set("phone", phone);
              data.set("startDate", startDate);
              data.set("note", note);
              data.set("idempotencyKey", key);
              action.run("add", addStorekeeperAction, data);
            }}
          >
            {t("settlement.storekeepers.submit")}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function StorekeeperRow({ keeper, canEdit }: { keeper: Storekeeper; canEdit: boolean }) {
  const t = useTranslations();
  const [key, setKey] = useState(() => crypto.randomUUID());

  const action = useGuardedAction<"toggle", SettlementActionState>({
    failureKey: "settlementErrors.generic",
    onSettled: (outcome) => {
      if (outcome.successKey) setKey(crypto.randomUUID());
    },
  });
  const { pending, result } = action;

  return (
    <Card role="article" aria-label={keeper.fullName}>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-1">
          <p className="font-medium">
            {keeper.fullName}
            {/* Server-generated (§3.2), so there is nothing for a Director to mistype. */}
            <span className="fv-identifier ml-2 text-sm text-muted-foreground">{keeper.code}</span>
          </p>
          {keeper.phone ? (
            <p className="text-xs text-muted-foreground">{keeper.phone}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {t("settlement.storekeepers.since", { date: keeper.startDate })}
          </p>
          {keeper.note ? <p className="text-xs text-muted-foreground">{keeper.note}</p> : null}
          <StatusChip tone={keeper.isActive ? "success" : "neutral"}>
            {keeper.isActive
              ? t("settlement.storekeepers.active")
              : t("settlement.storekeepers.inactive")}
          </StatusChip>
        </div>

        {canEdit ? (
          <div className="flex flex-col items-start gap-2 md:items-end">
            <Button
              type="button"
              variant="secondary"
              size="small"
              data-testid={`keeper-toggle-${keeper.id}`}
              pending={pending}
              pendingLabel={t("common.loading")}
              onClick={() => {
                const data = new FormData();
                data.set("storekeeperId", keeper.id);
                data.set("isActive", keeper.isActive ? "false" : "true");
                data.set("idempotencyKey", key);
                action.run("toggle", setStorekeeperActiveAction, data);
              }}
            >
              {keeper.isActive
                ? t("settlement.storekeepers.deactivate")
                : t("settlement.storekeepers.reactivate")}
            </Button>
            {/* §3.2: deactivated, never deleted. Past dispatches keep naming them. */}
            <Help>{t("settlement.storekeepers.deactivateHelp")}</Help>
          </div>
        ) : null}
      </div>

      {result.error ? <FormError>{t(result.error)}</FormError> : null}
      <FormSuccess className="mt-3">
        {result.successKey ? t(result.successKey) : null}
      </FormSuccess>
    </Card>
  );
}
