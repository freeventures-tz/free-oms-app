"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import {
  addSupplierAction,
  setSupplierActiveAction,
  type InventoryActionState,
} from "@/app/(app)/inventory/actions";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FormError, FormSuccess, Help, Input, Label } from "@/components/ui/field";
import { Card, StatusChip } from "@/components/ui/surface";
import type { Supplier } from "@/lib/inventory/inventory";
import { useGuardedAction } from "@/lib/ui/use-guarded-action";

export function SupplierAdmin({
  suppliers,
  canEdit,
}: {
  suppliers: Supplier[];
  canEdit: boolean;
}) {
  const t = useTranslations("inventory.suppliers");

  return (
    <div className="flex flex-col gap-4">
      {/* Hidden from a Manager, not disabled (design.md §4.3, §4.4). */}
      {canEdit ? <AddSupplierForm /> : null}

      {suppliers.length === 0 ? (
        <Card>
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            {t("count", { count: suppliers.length })}
          </p>
          {suppliers.map((supplier) => (
            <SupplierRow key={supplier.id} supplier={supplier} canEdit={canEdit} />
          ))}
        </div>
      )}
    </div>
  );
}

function AddSupplierForm() {
  const t = useTranslations();
  const [name, setName] = useState("");

  /**
   * ONE key per interaction, rotated only after a SUCCESS. A refusal leaves it in place so a
   * corrected retry addresses the same intended supplier rather than becoming a second one, and a
   * request that reached the server but never answered is resumed rather than duplicated.
   */
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const action = useGuardedAction<"add", InventoryActionState>({
    failureKey: "inventoryErrors.generic",
    onSettled: (outcome) => {
      if (outcome.successKey) {
        setName("");
        setIdempotencyKey(crypto.randomUUID());
      }
    },
  });
  const { pending, result } = action;

  return (
    <Card>
      <h2 className="text-sm font-semibold">{t("inventory.suppliers.addHeading")}</h2>

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

        <Field>
          <Label htmlFor="supplier-name">{t("inventory.suppliers.name")}</Label>
          <Input
            id="supplier-name"
            type="text"
            autoComplete="off"
            value={name}
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
          />
          <Help>{t("inventory.suppliers.nameHelp")}</Help>
          <FieldError>{result.fieldErrors?.name ? t(result.fieldErrors.name) : null}</FieldError>
        </Field>

        <div>
          <Button
            type="button"
            id="addSupplier"
            pending={pending}
            pendingLabel={t("common.loading")}
            onClick={() => {
              const data = new FormData();
              data.set("name", name);
              data.set("idempotencyKey", idempotencyKey);
              action.run("add", addSupplierAction, data);
            }}
          >
            {t("inventory.suppliers.submit")}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function SupplierRow({ supplier, canEdit }: { supplier: Supplier; canEdit: boolean }) {
  const t = useTranslations();
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const action = useGuardedAction<"toggle", InventoryActionState>({
    failureKey: "inventoryErrors.generic",
    onSettled: (outcome) => {
      if (outcome.successKey) setIdempotencyKey(crypto.randomUUID());
    },
  });
  const { pending, result } = action;

  return (
    <Card role="article" aria-label={supplier.name}>
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-1">
          <p className="font-medium">{supplier.name}</p>
          {/* Never colour alone (design.md §11.5): the state is a word first. */}
          <StatusChip tone={supplier.isActive ? "success" : "neutral"}>
            {supplier.isActive
              ? t("inventory.suppliers.active")
              : t("inventory.suppliers.inactive")}
          </StatusChip>
        </div>

        {canEdit ? (
          <div className="flex flex-col items-start gap-2 md:items-end">
            <Button
              type="button"
              variant="secondary"
              size="small"
              data-testid={`supplier-toggle-${supplier.id}`}
              pending={pending}
              pendingLabel={t("common.loading")}
              onClick={() => {
                const data = new FormData();
                data.set("supplierId", supplier.id);
                data.set("isActive", supplier.isActive ? "false" : "true");
                data.set("idempotencyKey", idempotencyKey);
                action.run("toggle", setSupplierActiveAction, data);
              }}
            >
              {supplier.isActive
                ? t("inventory.suppliers.deactivate")
                : t("inventory.suppliers.reactivate")}
            </Button>
            {/* Deactivating is reversible and takes nothing away that already happened — past
                receipts keep naming this supplier — so the consequence is stated rather than
                confirmed in a dialog (design.md §11.8). */}
            <Help>{t("inventory.suppliers.deactivateHelp")}</Help>
          </div>
        ) : null}
      </div>

      {result.error ? (
        <div className="mt-3 flex flex-col gap-2">
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

      <FormSuccess className="mt-3">
        {result.successKey ? t(result.successKey) : null}
      </FormSuccess>
    </Card>
  );
}
