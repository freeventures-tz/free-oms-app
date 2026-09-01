"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import {
  approveBatchAction,
  enterBatchAction,
  inspectLotAction,
  rejectBatchAction,
  type ProductionActionState,
} from "@/app/(app)/production/actions";
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
import { Pager } from "@/components/ui/pager";
import { Card, StatusChip } from "@/components/ui/surface";
import type { Unit } from "@/lib/catalogue/catalogue";
import { unitLabel } from "@/lib/catalogue/unit-label";
import type { InventoryLocation } from "@/lib/inventory/inventory";
import type {
  BatchLot,
  CuringLot,
  ProductionBatch,
  RecipeInput,
  YieldRange,
} from "@/lib/production/production";
import type { Page } from "@/lib/settlement/settlement";
import { businessDateTimeLocal, formatBusinessStamp } from "@/lib/time/business-date";
import { BRICK_REJECT_REASONS } from "@/lib/validation/production";
import { useGuardedAction } from "@/lib/ui/use-guarded-action";

/**
 * Brick production (product.md §11, design.md §7.16–§7.18).
 *
 * Three things happen on this screen and they are deliberately different shapes:
 *
 *   RECORDING a batch is a form that is already filled in. §11.1 makes the recipe the expected
 *   standard, so the actual quantities start AT the standard and a Manager who used exactly that
 *   types nothing. Changing one is the exception, and the variance appears beside it as they type.
 *
 *   APPROVING is the moment the yard is consumed (AC-38), and the control says so before it is
 *   pressed. Nothing is deducted until then, however complete the record looks.
 *
 *   INSPECTING is the only way a brick becomes sellable (AC-45). Before 72 hours the control is
 *   disabled with its reason shown, and when the countdown ends the screen says READY FOR
 *   INSPECTION — never "ready to sell", because §11.4 and AC-44 are explicit that the countdown
 *   grants nothing on its own.
 */

/**
 * The 44×44 floor on a touch tier (design.md §9.9), restored where `size="small"` steps below it.
 *
 * The small variant is 44px on a phone and 40px on a tablet, and a tablet has a touch screen. This
 * lifts the tablet tier back to the floor and lets the desktop tier keep the compact control it was
 * measured for.
 */
const TOUCH_FLOOR = "min-h-11 md:min-h-11 xl:min-h-0";

const PRODUCTION_PATH = "/production";

/** A line as the person is typing it — strings, because a half-typed number is not a number. */
type DraftInput = { productId: string; standard: number; name: string; unit: string; actual: string };
type DraftOutput = {
  productId: string;
  name: string;
  min: number;
  max: number;
  moulded: string;
  rejected: string;
  reason: string;
};

function inputsFrom(recipe: RecipeInput[]): DraftInput[] {
  return recipe.map((line) => ({
    productId: line.productId,
    standard: line.standardQuantity,
    name: line.productName,
    unit: line.unitCode,
    // Pre-filled with the standard, which is the whole point: §11.1 makes confirming the recipe the
    // normal case, and a form that started empty would make the exception the default.
    actual: String(line.standardQuantity),
  }));
}

function outputsFrom(yields: YieldRange[]): DraftOutput[] {
  return yields.map((range) => ({
    productId: range.productId,
    name: range.productName,
    min: range.minPerBatch,
    max: range.maxPerBatch,
    moulded: "",
    rejected: "0",
    reason: "",
  }));
}

function whole(value: string): number | null {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && String(parsed) === value.trim() ? parsed : null;
}

/**
 * The yard's clock, for a page that is left open across a deadline.
 *
 * §11.4 makes readiness a comparison against a stored instant, and the server answers it once, when
 * the page is rendered. A Manager who opens the board twenty minutes before a lot is due and waits
 * would otherwise be looking at a permanently disabled control with "the 72 hours are not up yet"
 * under it, on a lot that is ready — until they thought to reload.
 *
 * So the client watches the same deadlines: a coarse thirty-second tick for the countdown, and one
 * exact timeout at the nearest deadline so the moment itself is not missed by up to half a minute.
 * NOTHING IS RE-FETCHED and no state is replaced, so anything half-typed into an inspection is
 * still there afterwards. The server remains the authority: it refuses an early inspection whatever
 * this clock believes.
 *
 * `null` until the first tick lands, so the server-rendered HTML and the first client render agree
 * and readiness starts as exactly what the database said. The device clock is not a value a render
 * may read either — it changes on its own — which is the same reason the countdown appears a moment
 * after the page rather than inside it.
 */
function useYardClock(deadlineKey: string): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setNow(Date.now());

    // The first reading is SCHEDULED rather than taken here, so the effect itself sets no state.
    const first = window.setTimeout(tick, 0);

    const upcoming = deadlineKey
      .split("|")
      .map((iso) => Date.parse(iso))
      .filter((at) => Number.isFinite(at) && at > Date.now());

    if (upcoming.length === 0) return () => window.clearTimeout(first);

    const interval = window.setInterval(tick, 30_000);
    const deadline = window.setTimeout(
      tick,
      Math.max(0, Math.min(...upcoming) - Date.now() + 1_000),
    );

    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
      window.clearTimeout(deadline);
    };
  }, [deadlineKey]);

  return now;
}

export function ProductionBoard({
  drafts,
  curing,
  history,
  recipe,
  yields,
  locations,
  units,
  canRun,
  idempotencyKey,
  businessNow,
}: {
  drafts: Page<ProductionBatch>;
  curing: Page<CuringLot>;
  history: Page<ProductionBatch>;
  recipe: RecipeInput[];
  yields: YieldRange[];
  locations: InventoryLocation[];
  units: Unit[];
  canRun: boolean;
  idempotencyKey: string;
  /** The yard's wall clock at render, so the form does not pre-fill from the reader's device. */
  businessNow: string;
}) {
  const t = useTranslations("production");

  const clock = useYardClock(curing.rows.map((lot) => lot.readyAt).join("|"));

  return (
    <div className="flex flex-col gap-6">
      {canRun ? (
        <NewBatchForm
          recipe={recipe}
          yields={yields}
          locations={locations}
          units={units}
          initialKey={idempotencyKey}
          businessNow={businessNow}
        />
      ) : null}

      {/* WAITING FOR APPROVAL, read on its own. However much history exists, a batch nobody has
          decided is still here and still reachable — which is the difference between a work queue
          and a list of recent activity. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">{t("drafts.heading", { count: drafts.total })}</h2>
        <Pager
          page={drafts.page}
          pageSize={drafts.pageSize}
          total={drafts.total}
          param="drafts"
          basePath={PRODUCTION_PATH}
          otherParams={{ curing: curing.page, history: history.page }}
          label={t("drafts.heading", { count: drafts.total })}
        />
        {drafts.rows.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">{t("drafts.none")}</p>
          </Card>
        ) : (
          drafts.rows.map((batch) => (
            <BatchCard key={batch.id} batch={batch} canDecide={canRun} />
          ))
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">{t("curing.heading", { count: curing.total })}</h2>
        <Help>{t("curing.explanation")}</Help>
        <Pager
          page={curing.page}
          pageSize={curing.pageSize}
          total={curing.total}
          param="curing"
          basePath={PRODUCTION_PATH}
          otherParams={{ drafts: drafts.page, history: history.page }}
          label={t("curing.heading", { count: curing.total })}
        />
        {curing.rows.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">{t("curing.none")}</p>
          </Card>
        ) : (
          curing.rows.map((lot) => (
            <CuringLotCard key={lot.lotId} lot={lot} canInspect={canRun} clock={clock} />
          ))
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">{t("settled.heading")}</h2>
        <Pager
          page={history.page}
          pageSize={history.pageSize}
          total={history.total}
          param="history"
          basePath={PRODUCTION_PATH}
          otherParams={{ drafts: drafts.page, curing: curing.page }}
          label={t("settled.heading")}
        />
        {history.rows.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">{t("settled.none")}</p>
          </Card>
        ) : (
          history.rows.map((batch) => (
            <BatchCard key={batch.id} batch={batch} canDecide={false} />
          ))
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recording a batch
// ---------------------------------------------------------------------------
function NewBatchForm({
  recipe,
  yields,
  locations,
  units,
  initialKey,
  businessNow,
}: {
  recipe: RecipeInput[];
  yields: YieldRange[];
  locations: InventoryLocation[];
  units: Unit[];
  initialKey: string;
  businessNow: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const unitsByCode = new Map(units.map((unit) => [unit.code, unit]));
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(initialKey);

  // product.md §7 puts production in the yard, so that is where the form starts. It is still a
  // choice rather than a constant: §10's transfer is what gets materials to a location, and the
  // business may run a mixer elsewhere.
  const [location, setLocation] = useState(
    locations.some((one) => one.code === "yard") ? "yard" : (locations[0]?.code ?? ""),
  );
  // Seeded from the server's answer so the first render matches the HTML, and refreshed from the
  // same function whenever the form is opened. Both compute the wall clock in Africa/Dar_es_Salaam
  // rather than in the device's zone (§15.3).
  const [mouldedAt, setMouldedAt] = useState(businessNow);
  const [inputs, setInputs] = useState<DraftInput[]>(() => inputsFrom(recipe));
  const [outputs, setOutputs] = useState<DraftOutput[]>(() => outputsFrom(yields));
  const [yieldNote, setYieldNote] = useState("");

  const action = useGuardedAction<"enter", ProductionActionState>({
    onSettled: (outcome) => {
      if (!outcome.successKey) return;
      // A fresh key for a fresh batch, and the form returns to the standard recipe rather than to
      // whatever the last batch happened to use. NOTHING IS CLEARED ON A REFUSAL: everything typed
      // is still here, and the retry sends the same request with the same key.
      setKey(crypto.randomUUID());
      setInputs(inputsFrom(recipe));
      setOutputs(outputsFrom(yields));
      setYieldNote("");
      setMouldedAt(businessDateTimeLocal());
      setOpen(false);
    },
  });
  const { pending, result } = action;

  /**
   * Whether any lot fell outside its approved range (§11.2).
   *
   * This decides whether the explanation field is SHOWN and required. The database decides it
   * again, from the same ranges, and refuses an explanation nobody needed — so the screen asking
   * for one it does not need is a bug the server catches rather than a rule stated twice.
   */
  const outsideRange = outputs.some((line) => {
    const moulded = whole(line.moulded);
    return moulded !== null && moulded > 0 && (moulded < line.min || moulded > line.max);
  });

  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        <div>
          <Button
            type="button"
            id="openBatchForm"
            onClick={() => {
              setMouldedAt(businessDateTimeLocal());
              setOpen(true);
            }}
          >
            {t("production.enter.open")}
          </Button>
        </div>
        <FormSuccess>{result.successKey ? t(result.successKey) : null}</FormSuccess>
      </div>
    );
  }

  return (
    <Card>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();

          const data = new FormData();
          data.set("locationCode", location);
          data.set("mouldedAt", mouldedAt);
          data.set("yieldNote", yieldNote);
          data.set("idempotencyKey", key);
          data.set(
            "inputs",
            JSON.stringify(
              // EVERY recipe line, always. §11.1 and AC-39 make the actual usage a confirmation of
              // the whole recipe, and a line left out would be silence about that material rather
              // than an answer — which the database refuses.
              inputs.map((line) => ({
                productId: line.productId,
                actualQuantity: line.actual,
              })),
            ),
          );
          data.set(
            "outputs",
            JSON.stringify(
              // A size the Manager did not mould is not a lot. §11.2 names two sizes; a batch that
              // made only one of them makes one lot, and sending a zero would create a second.
              outputs
                .filter((line) => line.moulded.trim() !== "")
                .map((line) => ({
                  productId: line.productId,
                  quantityMoulded: line.moulded,
                  rejectedQuantity: line.rejected.trim() === "" ? "0" : line.rejected,
                  rejectReason: line.reason,
                })),
            ),
          );

          action.run("enter", enterBatchAction, data);
        }}
      >
        <h2 className="text-sm font-semibold">{t("production.enter.heading")}</h2>

        <div className="grid gap-4 md:grid-cols-2">
          <Field>
            <Label htmlFor="locationCode">{t("production.enter.location")}</Label>
            <Select
              id="locationCode"
              value={location}
              disabled={pending}
              onChange={(event) => setLocation(event.target.value)}
            >
              {locations.map((one) => (
                <option key={one.code} value={one.code}>
                  {t(`inventory.stock.locations.${one.code}`)}
                </option>
              ))}
            </Select>
          </Field>

          <Field>
            <Label htmlFor="mouldedAt">{t("production.enter.mouldedAt")}</Label>
            <Input
              id="mouldedAt"
              type="datetime-local"
              value={mouldedAt}
              disabled={pending}
              onChange={(event) => setMouldedAt(event.target.value)}
            />
            {/* §11.4: curing starts when moulding finished, not when the form was filled in — and
                §15.3: the time is the yard's, whatever the device's clock is set to. */}
            <Help>{t("production.enter.mouldedAtHelp")}</Help>
          </Field>
        </div>

        {/* MATERIALS. Already filled in with the standard recipe (§11.1). */}
        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">{t("production.enter.materials")}</legend>
          <Help>{t("production.enter.materialsHelp")}</Help>

          <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[520px] text-left text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {t("production.enter.material")}
                  </th>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {t("production.enter.standard")}
                  </th>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {t("production.enter.actual")}
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    {t("production.enter.variance")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {inputs.map((line, index) => {
                  const actual = whole(line.actual);
                  const variance = actual === null ? null : actual - line.standard;

                  return (
                    <tr key={line.productId} className="border-t border-border">
                      <td className="py-2 pr-3">
                        {line.name}
                        {unitsByCode.has(line.unit) ? (
                          <span className="ml-1 text-muted-foreground">
                            ({unitLabel(unitsByCode.get(line.unit)!, locale)})
                          </span>
                        ) : null}
                      </td>
                      <td className="fv-numeric py-2 pr-3 text-muted-foreground">
                        {line.standard}
                      </td>
                      <td className="py-2 pr-3">
                        <Input
                          aria-label={t("production.enter.actualFor", { material: line.name })}
                          inputMode="numeric"
                          className="w-24"
                          value={line.actual}
                          disabled={pending}
                          onChange={(event) => {
                            const next = [...inputs];
                            next[index] = { ...line, actual: event.target.value };
                            setInputs(next);
                          }}
                        />
                      </td>
                      {/* Shown live so the Manager sees what they are recording. NEVER SENT: it is
                          a generated column, and §5.2 forbids asking anyone to type one. */}
                      <td className="fv-numeric py-2 font-medium">
                        {variance === null ? (
                          "—"
                        ) : variance === 0 ? (
                          <span className="text-muted-foreground">0</span>
                        ) : (
                          <span className="text-danger">
                            {variance > 0 ? `+${variance}` : variance}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </fieldset>

        {/* OUTPUT, per brick size. §11.4 makes each one its own curing lot. */}
        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">{t("production.enter.output")}</legend>

          {outputs.map((line, index) => {
            const moulded = whole(line.moulded);
            const outside = moulded !== null && moulded > 0 && (moulded < line.min || moulded > line.max);
            const rejected = whole(line.rejected) ?? 0;

            return (
              // Named as a group, so "the six-inch figures" is a thing a screen reader and a test
              // can both ask for. §11.2 puts two sizes on this form and every field inside is
              // otherwise labelled identically.
              <div
                key={line.productId}
                role="group"
                aria-label={line.name}
                className="flex flex-col gap-3 rounded-md border border-border p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">{line.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("production.enter.expectedRange", { min: line.min, max: line.max })}
                  </span>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <Field>
                    <Label htmlFor={`moulded-${line.productId}`}>
                      {t("production.enter.moulded")}
                    </Label>
                    <Input
                      id={`moulded-${line.productId}`}
                      inputMode="numeric"
                      value={line.moulded}
                      disabled={pending}
                      onChange={(event) => {
                        const next = [...outputs];
                        next[index] = { ...line, moulded: event.target.value };
                        setOutputs(next);
                      }}
                    />
                    {/* AC-41: flagged and explained, never blocked. The words say which. */}
                    {outside ? (
                      <Help>
                        <span className="text-danger">{t("production.enter.outsideRange")}</span>
                      </Help>
                    ) : null}
                  </Field>

                  <Field>
                    <Label htmlFor={`rejected-${line.productId}`}>
                      {t("production.enter.rejectedAtMoulding")}
                    </Label>
                    <Input
                      id={`rejected-${line.productId}`}
                      inputMode="numeric"
                      value={line.rejected}
                      disabled={pending}
                      onChange={(event) => {
                        const next = [...outputs];
                        next[index] = { ...line, rejected: event.target.value };
                        setOutputs(next);
                      }}
                    />
                  </Field>
                </div>

                {/* §11.5 and AC-3: the reason is CHOSEN from four presets, never typed. The buttons
                    appear only once there is something to explain. */}
                {rejected > 0 ? (
                  <Field>
                    <Label>{t("production.enter.rejectReason")}</Label>
                    <div
                      className="flex flex-wrap gap-2"
                      role="group"
                      aria-label={t("production.enter.rejectReason")}
                    >
                      {BRICK_REJECT_REASONS.map((reason) => (
                        <Button
                          key={reason}
                          type="button"
                          size="small"
                          className={TOUCH_FLOOR}
                          variant={line.reason === reason ? "primary" : "secondary"}
                          aria-pressed={line.reason === reason}
                          data-testid={`moulding-reject-${line.productId}-${reason}`}
                          disabled={pending}
                          onClick={() => {
                            const next = [...outputs];
                            next[index] = { ...line, reason };
                            setOutputs(next);
                          }}
                        >
                          {t(`production.rejectReasons.${reason}`)}
                        </Button>
                      ))}
                    </div>
                  </Field>
                ) : null}
              </div>
            );
          })}
        </fieldset>

        {/* §11.2, AC-41: the explanation appears when there is something to explain, and not before
            — an explanation for a normal batch is refused, so offering the field always would be
            offering a field that cannot be used. */}
        {outsideRange ? (
          <Field>
            <Label htmlFor="yieldNote">{t("production.enter.yieldNote")}</Label>
            <Input
              id="yieldNote"
              value={yieldNote}
              disabled={pending}
              onChange={(event) => setYieldNote(event.target.value)}
            />
            <Help>{t("production.enter.yieldNoteHelp")}</Help>
          </Field>
        ) : null}

        <FieldError>
          {action.result.fieldErrors
            ? Object.values(action.result.fieldErrors).map((message) => t(message)).join(" ")
            : null}
        </FieldError>

        {result.error ? (
          <div className="flex flex-col gap-2">
            <FormError>
              {t(result.error)}
              {result.errorValues?.expected !== undefined ? (
                <span className="fv-numeric mt-1 block font-normal">
                  {t("productionErrors.incomplete_recipe_inputs_detail", result.errorValues)}
                </span>
              ) : null}
            </FormError>
            {action.retry ? (
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  className={TOUCH_FLOOR}
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

        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            id="submitBatch"
            pending={pending}
            pendingLabel={t("common.loading")}
          >
            {t("production.enter.submit")}
          </Button>
          <Button type="button" variant="secondary" disabled={pending} onClick={() => setOpen(false)}>
            {t("common.cancel")}
          </Button>
        </div>

        {/* Recording is not approving, and the form says so before it is submitted (§11.1). */}
        <Help>{t("production.enter.consequence")}</Help>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A batch, and the decision on it
// ---------------------------------------------------------------------------
function BatchCard({ batch, canDecide }: { batch: ProductionBatch; canDecide: boolean }) {
  const t = useTranslations();
  const locale = useLocale();

  return (
    <Card role="article" aria-label={batch.batchNo}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="fv-identifier font-medium">{batch.batchNo}</span>
              <BatchStatusChip status={batch.status} />
            </span>
            <p className="text-xs text-muted-foreground">
              {t(`inventory.stock.locations.${batch.locationCode}`)} ·{" "}
              <time dateTime={batch.mouldedAt}>{formatBusinessStamp(batch.mouldedAt, locale)}</time>
            </p>
            <p className="text-xs text-muted-foreground">
              {t("production.batch.enteredBy", {
                who: batch.enteredByName,
                role: t(`admin.roles.${batch.enteredRole}`),
              })}
            </p>
            {/* Who decided, in what role, and when — three separate facts, as every other decision
                record in this application keeps them (§4.2, design.md §7.14). */}
            {batch.decidedByName && batch.decidedRole ? (
              <p
                className="text-xs text-muted-foreground"
                data-testid={`batch-decision-${batch.id}`}
                data-decided-role={batch.decidedRole}
                data-decided-at={batch.decidedAt ?? undefined}
              >
                {t("production.batch.decidedByRole", {
                  who: batch.decidedByName,
                  role: t(`admin.roles.${batch.decidedRole}`),
                })}
                {batch.decidedAt ? (
                  <>
                    {" · "}
                    <time dateTime={batch.decidedAt}>
                      {formatBusinessStamp(batch.decidedAt, locale)}
                    </time>
                  </>
                ) : null}
              </p>
            ) : null}
            {batch.decisionReason ? (
              <p className="text-xs text-muted-foreground">
                {t("production.batch.reasonGiven", { reason: batch.decisionReason })}
              </p>
            ) : null}
            {batch.yieldNote ? (
              <p className="text-xs text-muted-foreground">
                {t("production.batch.yieldNote", { note: batch.yieldNote })}
              </p>
            ) : null}
          </div>

          {canDecide && batch.status === "draft" ? (
            <div className="shrink-0">
              <BatchDecision batchId={batch.id} />
            </div>
          ) : null}
        </div>

        <div className="-mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[480px] text-left text-xs">
            <thead>
              <tr className="text-muted-foreground">
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t("production.enter.material")}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t("production.enter.standard")}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t("production.enter.actual")}
                </th>
                <th scope="col" className="py-1 font-medium">
                  {t("production.enter.variance")}
                </th>
              </tr>
            </thead>
            <tbody>
              {batch.inputs.map((line) => (
                <tr key={line.productId} className="border-t border-border">
                  <td className="py-2 pr-3">{line.productName}</td>
                  <td className="fv-numeric py-2 pr-3 text-muted-foreground">
                    {line.standardQuantity}
                  </td>
                  <td className="fv-numeric py-2 pr-3 font-medium">{line.actualQuantity}</td>
                  {/* §15.1: recorded whatever it says, and never suppressed at any size. */}
                  <td className="fv-numeric py-2">
                    {line.varianceQuantity === 0 ? (
                      <span className="text-muted-foreground">0</span>
                    ) : (
                      <span className="font-medium text-danger">
                        {line.varianceQuantity > 0
                          ? `+${line.varianceQuantity}`
                          : line.varianceQuantity}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {batch.lots.map((lot) => (
            <li key={lot.id}>
              <span>
                {t("production.batch.lotLine", {
                  product: lot.productName,
                  moulded: lot.quantityMoulded,
                  rejected: lot.rejectedAtMoulding,
                })}
                {lot.mouldingRejectReason
                  ? ` (${t(`production.rejectReasons.${lot.mouldingRejectReason}`)})`
                  : ""}
              </span>
              <LotOutcome lot={lot} />
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

/**
 * What an inspection decided, kept on the batch permanently.
 *
 * This is the DURABLE evidence that an inspection happened: the lot leaving the curing queue proves
 * only that something removed a card. Accepted and rejected are rendered as text and repeated as
 * data attributes, so a person and a test read the same two numbers.
 */
function LotOutcome({ lot }: { lot: BatchLot }) {
  const t = useTranslations();
  const locale = useLocale();

  if (lot.inspectedAt === null || lot.acceptedQuantity === null) return null;

  return (
    <span
      className="ml-1 font-medium text-foreground"
      data-testid={`lot-inspection-${lot.id}`}
      data-accepted={lot.acceptedQuantity}
      data-rejected={lot.rejectedAtInspection ?? 0}
    >
      {t("production.batch.inspectionOutcome", {
        accepted: lot.acceptedQuantity,
        rejected: lot.rejectedAtInspection ?? 0,
        when: formatBusinessStamp(lot.inspectedAt, locale),
      })}
      {lot.inspectionRejectReason
        ? ` (${t(`production.rejectReasons.${lot.inspectionRejectReason}`)})`
        : ""}
    </span>
  );
}

function BatchStatusChip({ status }: { status: ProductionBatch["status"] }) {
  const t = useTranslations("production.status");

  if (status === "approved") return <StatusChip tone="success">{t("approved")}</StatusChip>;
  if (status === "draft") return <StatusChip tone="attention">{t("draft")}</StatusChip>;
  // Rejected and cancelled share one treatment because they share one meaning: settled, and
  // nothing was approved (§4.3).
  return <StatusChip tone="danger">{t(status)}</StatusChip>;
}

/**
 * Approve or reject a batch.
 *
 * Approve and Reject are siblings: while either is working the other is disabled, so a burst across
 * both cannot send two decisions about one batch (design.md §12.7).
 */
function BatchDecision({ batchId }: { batchId: string }) {
  const t = useTranslations();
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const action = useGuardedAction<"approve" | "reject", ProductionActionState>({
    onSettled: (outcome) => {
      if (outcome.successKey) setKey(crypto.randomUUID());
    },
  });
  const { pending, result } = action;

  return (
    <div className="flex flex-col items-stretch gap-2 md:items-end">
      {result.error ? (
        <div className="flex flex-col gap-2">
          <FormError>
            {t(result.error)}
            {result.errorValues?.available !== undefined ? (
              <span className="fv-numeric mt-1 block font-normal">
                {t("productionErrors.insufficient_stock_detail", result.errorValues)}
              </span>
            ) : null}
          </FormError>
          {action.retry ? (
            <Button
              type="button"
              variant="secondary"
              size="small"
              className={TOUCH_FLOOR}
              pending={pending}
              pendingLabel={t("common.loading")}
              onClick={action.retry}
            >
              {t("common.retry")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {rejecting ? (
        <div className="flex flex-col gap-2">
          <Field>
            <Label htmlFor={`reason-${batchId}`}>{t("production.batch.rejectReason")}</Label>
            <Input
              id={`reason-${batchId}`}
              value={reason}
              disabled={pending}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="danger"
              size="small"
              className={TOUCH_FLOOR}
              data-testid={`confirm-reject-${batchId}`}
              pending={action.running === "reject"}
              pendingLabel={t("common.loading")}
              disabled={pending}
              onClick={() => {
                const data = new FormData();
                data.set("batchId", batchId);
                data.set("reason", reason);
                data.set("idempotencyKey", key);
                action.run("reject", rejectBatchAction, data);
              }}
            >
              {t("production.batch.confirmReject")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="small"
              className={TOUCH_FLOOR}
              disabled={pending}
              onClick={() => setRejecting(false)}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="small"
            className={TOUCH_FLOOR}
            data-testid={`approve-batch-${batchId}`}
            pending={action.running === "approve"}
            pendingLabel={t("common.loading")}
            disabled={pending}
            onClick={() => {
              const data = new FormData();
              data.set("batchId", batchId);
              data.set("idempotencyKey", key);
              action.run("approve", approveBatchAction, data);
            }}
          >
            {t("production.batch.approve")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="small"
            className={TOUCH_FLOOR}
            disabled={pending}
            onClick={() => setRejecting(true)}
          >
            {t("production.batch.reject")}
          </Button>
        </div>
      )}

      {/* AC-38: approval is what consumes the yard, and it says so before it is pressed. */}
      <Help>{t("production.batch.approveConsequence")}</Help>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A curing lot, and its inspection
// ---------------------------------------------------------------------------
function CuringLotCard({
  lot,
  canInspect,
  clock,
}: {
  lot: CuringLot;
  canInspect: boolean;
  /** Milliseconds since the epoch on the reader's device, or null before the first tick. */
  clock: number | null;
}) {
  const t = useTranslations();
  const locale = useLocale();

  const [key, setKey] = useState(() => crypto.randomUUID());
  const [accepted, setAccepted] = useState("");
  const [rejected, setRejected] = useState("0");
  const [reason, setReason] = useState("");

  const action = useGuardedAction<"inspect", ProductionActionState>({
    onSettled: (outcome) => {
      if (outcome.successKey) setKey(crypto.randomUUID());
    },
  });
  const { pending, result } = action;

  const readyAtMs = Date.parse(lot.readyAt);
  // What the database said, then what the deadline says once this page has a clock. Only ever
  // widens: a lot the server called ready stays ready.
  const ready = lot.readyForInspection || (clock !== null && clock >= readyAtMs);
  const remainingMs = clock === null ? null : readyAtMs - clock;

  const acceptedNumber = whole(accepted);
  const rejectedNumber = whole(rejected) ?? 0;
  const accountedFor = acceptedNumber === null ? null : acceptedNumber + rejectedNumber;

  return (
    <Card role="article" aria-label={`${lot.batchNo} ${lot.productName}`}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{lot.productName}</span>
              {/* READY FOR INSPECTION, in those words. AC-44: reaching 72 hours grants nothing, and
                  a chip reading "Ready" would say otherwise. */}
              {ready ? (
                <StatusChip tone="attention">{t("production.curing.readyForInspection")}</StatusChip>
              ) : (
                <StatusChip tone="neutral">{t("production.curing.stillCuring")}</StatusChip>
              )}
            </span>
            <p className="text-xs text-muted-foreground">
              <span className="fv-identifier">{lot.batchNo}</span> ·{" "}
              {t(`inventory.stock.locations.${lot.locationCode}`)}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("production.curing.startedAt", {
                when: formatBusinessStamp(lot.curingStartedAt, locale),
              })}
            </p>
            <p className="text-xs text-muted-foreground" data-testid={`lot-ready-at-${lot.lotId}`}>
              {t("production.curing.readyAt", {
                when: formatBusinessStamp(lot.readyAt, locale),
              })}
            </p>
            {/* How long is left, in words, and only while there IS any. Text rather than a moving
                bar, so it reads the same under `prefers-reduced-motion` (design.md §12.7 rule 6). */}
            {!ready && remainingMs !== null && remainingMs > 0 ? (
              <p
                className="fv-numeric text-xs text-muted-foreground"
                data-testid={`lot-remaining-${lot.lotId}`}
              >
                {t("production.curing.timeRemaining", {
                  hours: Math.floor(remainingMs / 3_600_000),
                  minutes: Math.floor((remainingMs % 3_600_000) / 60_000),
                })}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col items-start gap-0.5 md:items-end">
            <span className="text-xs text-muted-foreground">{t("production.curing.inCuring")}</span>
            <span
              className="fv-numeric text-2xl font-semibold"
              data-testid={`lot-curing-${lot.lotId}`}
              data-quantity={lot.quantityCuring}
            >
              {lot.quantityCuring}
            </span>
          </div>
        </div>

        {canInspect ? (
          <div className="flex flex-col gap-3 border-t border-border pt-3">
            <div className="grid gap-3 md:grid-cols-2">
              <Field>
                <Label htmlFor={`accepted-${lot.lotId}`}>{t("production.curing.accepted")}</Label>
                <Input
                  id={`accepted-${lot.lotId}`}
                  inputMode="numeric"
                  value={accepted}
                  disabled={pending || !ready}
                  onChange={(event) => setAccepted(event.target.value)}
                />
              </Field>

              <Field>
                <Label htmlFor={`lot-rejected-${lot.lotId}`}>
                  {t("production.curing.rejected")}
                </Label>
                <Input
                  id={`lot-rejected-${lot.lotId}`}
                  inputMode="numeric"
                  value={rejected}
                  disabled={pending || !ready}
                  onChange={(event) => setRejected(event.target.value)}
                />
              </Field>
            </div>

            {/* Everything that cured must be accounted for. Shown while typing so the refusal is
                rare rather than routine — the database still enforces it. */}
            {accountedFor !== null && accountedFor !== lot.quantityCuring ? (
              <Help>
                <span className="text-danger">
                  {t("production.curing.mustAccountForAll", {
                    curing: lot.quantityCuring,
                    offered: accountedFor,
                  })}
                </span>
              </Help>
            ) : null}

            {rejectedNumber > 0 ? (
              <Field>
                <Label>{t("production.enter.rejectReason")}</Label>
                <div
                  className="flex flex-wrap gap-2"
                  role="group"
                  aria-label={t("production.enter.rejectReason")}
                >
                  {BRICK_REJECT_REASONS.map((option) => (
                    <Button
                      key={option}
                      type="button"
                      size="small"
                      className={TOUCH_FLOOR}
                      variant={reason === option ? "primary" : "secondary"}
                      aria-pressed={reason === option}
                      data-testid={`lot-reject-${lot.lotId}-${option}`}
                      disabled={pending || !ready}
                      onClick={() => setReason(option)}
                    >
                      {t(`production.rejectReasons.${option}`)}
                    </Button>
                  ))}
                </div>
              </Field>
            ) : null}

            {result.error ? (
              <div className="flex flex-col gap-2">
                <FormError>
                  {t(result.error)}
                  {result.errorValues?.ready_at !== undefined ? (
                    <span className="mt-1 block font-normal">
                      {t("production.curing.readyAt", {
                        when: formatBusinessStamp(String(result.errorValues.ready_at), locale),
                      })}
                    </span>
                  ) : null}
                </FormError>
                {action.retry ? (
                  <div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="small"
                      className={TOUCH_FLOOR}
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

            <div>
              <Button
                type="button"
                data-testid={`inspect-${lot.lotId}`}
                pending={pending}
                pendingLabel={t("common.loading")}
                // §11.4: refused before 72 hours. The control is disabled AND its reason is shown,
                // rather than being offered and then refused after a round trip. The server is what
                // decides: this only saves the round trip.
                disabled={!ready}
                onClick={() => {
                  const data = new FormData();
                  data.set("lotId", lot.lotId);
                  data.set("acceptedQuantity", accepted);
                  data.set("rejectedQuantity", rejected.trim() === "" ? "0" : rejected);
                  data.set("rejectReason", reason);
                  data.set("idempotencyKey", key);
                  action.run("inspect", inspectLotAction, data);
                }}
              >
                {t("production.curing.recordInspection")}
              </Button>
            </div>

            <Help>
              {ready
                ? t("production.curing.acceptedConsequence")
                : t("production.curing.notYetReason")}
            </Help>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
