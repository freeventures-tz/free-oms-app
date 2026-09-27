"use client";

import { useLocale, useTranslations } from "next-intl";
import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import {
  handOutDisbursementAction,
  openReceiptAction,
  registerReceiptAction,
  settleDisbursementAction,
} from "@/app/(app)/imprest/actions";
import { ActionForm, Outcome, TOUCH_FLOOR, useFreshKey } from "@/app/(app)/imprest/funding-forms";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FormError, FormSuccess, Help, Input, Label } from "@/components/ui/field";
import { Card } from "@/components/ui/surface";
import { publicEnv } from "@/lib/env";
import type { ReceiptTicket } from "@/lib/imprest/commands";
import type { EarlierReceipt, SettlementCycle } from "@/lib/imprest/disbursements";
import { decryptReceipt, encryptReceipt } from "@/lib/imprest/receipt-crypto";
import { shrinkReceipt } from "@/lib/imprest/receipt-shrink";
import {
  LINE_PURPOSE_MAX,
  MAX_LINES,
  NO_RECEIPT_REASONS,
  REASONS_NEEDING_NOTE,
  RECEIPT_BUCKET,
  RECEIPT_MAX_BYTES,
  receiptType,
  settlementFigures,
  type NoReceiptReason,
} from "@/lib/imprest/spending";
import { formatTzs, parseTzs } from "@/lib/money";
import { createClient } from "@/lib/supabase/client";

/**
 * Hand-out and settlement (issue #62), on the feedback contract of design.md §12.7 like every
 * imprest form: acknowledged at once, one activation at a time, a retry resends the same key,
 * nothing typed is cleared on a refusal, success only after the server confirms it.
 *
 * Receipts go from the phone straight to the private bucket, encrypted first with a key the
 * database made for that receipt. The server never carries the file, so a large photo is not held
 * to a server's request limit, and the upload can show its progress. A photo is made smaller on the
 * phone first (issue #65), and what is registered and uploaded is that smaller file.
 */

const SPENDING_UNCONFIRMED_KEY = "spendingErrors.unconfirmed";

type Target = { id: string; version: number };

/** The Cashier records that the approved amount went out, and to whom. There is no amount field. */
function HandOutForm({
  disbursement,
  amount,
  onDone,
}: {
  disbursement: Target;
  amount: number;
  onDone: (successKey: string) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [key, controller] = useFreshKey(
    () => onDone("imprest.spending.success.handedOut"),
    SPENDING_UNCONFIRMED_KEY,
  );
  return (
    <div className="flex flex-col gap-3" data-testid="hand-out">
      <Help>{t("imprest.spending.handOut.help", { amount: formatTzs(amount, locale) })}</Help>
      <ActionForm
        id="hand-out"
        controller={controller}
        name="handOut"
        action={handOutDisbursementAction}
        hidden={{ disbursementId: disbursement.id, expectedVersion: String(disbursement.version) }}
        fields={[
          {
            name: "recipient",
            labelKey: "imprest.spending.handOut.recipient",
            kind: "text",
            helpKey: "imprest.spending.handOut.recipientHelp",
          },
        ]}
        submitKey="imprest.spending.handOut.submit"
        testId="hand-out-form"
        idempotencyKey={key}
      />
      {/* Success is shown by CashierStep, which outlives this form. */}
      {controller.result.successKey ? null : <Outcome controller={controller} />}
    </div>
  );
}

/** The return the Cashier is answering, as the page shows it above the form (issue #65). */
export type SentBackNotice = { reason: string; by: string; at: string };

/**
 * The step that is the proposing Cashier's to take: hand out an approved payment, then settle it,
 * and settle it again whenever the Manager sends it back (issue #65).
 *
 * The page renders this in the same place whatever the status, so it stays mounted when a success
 * refreshes the page and the status moves on. The form that succeeded goes, and its confirmation
 * stays until the Cashier leaves (design.md §12.7: success is shown once the server confirms it).
 */
export function CashierStep({
  status,
  disbursement,
  amount,
  sentBack = null,
  previous = null,
  earlier = [],
}: {
  status: string;
  disbursement: Target;
  amount: number;
  /** While sent back: why, from whom and when. */
  sentBack?: SentBackNotice | null;
  /** While sent back: the cycle that was returned, which the new one starts from. */
  previous?: SettlementCycle | null;
  /** While sent back: receipts earlier cycles cited, which may be cited again. */
  earlier?: EarlierReceipt[];
}) {
  const t = useTranslations();
  const [done, setDone] = useState<string | null>(null);

  const form =
    status === "approved" ? (
      <>
        <h2 className="text-lg font-semibold">{t("imprest.spending.handOut.title")}</h2>
        <HandOutForm disbursement={disbursement} amount={amount} onDone={setDone} />
      </>
    ) : status === "handed_out" ? (
      <>
        <h2 className="text-lg font-semibold">{t("imprest.spending.settle.title")}</h2>
        <SettleForm disbursement={disbursement} approved={amount} onDone={setDone} />
      </>
    ) : status === "sent_back" && sentBack ? (
      <>
        <h2 className="text-lg font-semibold">{t("imprest.spending.settleAgain.title")}</h2>
        <section
          className="flex flex-col gap-1 rounded-lg border border-danger/40 bg-danger/5 p-3"
          aria-labelledby="sent-back-heading"
          data-testid="sent-back-notice"
        >
          <h3 id="sent-back-heading" className="text-sm font-semibold">
            {t("imprest.spending.settleAgain.reasonHeading")}
          </h3>
          <p className="text-sm" data-testid="sent-back-notice-reason">
            {sentBack.reason}
          </p>
          <p className="text-xs text-muted-foreground">{sentBack.by} · {sentBack.at}</p>
        </section>
        <Help>{t("imprest.spending.settleAgain.help")}</Help>
        <SettleForm
          disbursement={disbursement}
          approved={amount}
          onDone={setDone}
          previous={previous}
          earlier={earlier}
        />
      </>
    ) : null;

  if (!form && !done) return null;
  return (
    <Card className="flex flex-col gap-3" data-testid="cashier-step">
      {/* The confirmation of the step just taken, above the next step's form. */}
      {done ? <FormSuccess role="status">{t(done)}</FormSuccess> : null}
      {form}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Receipt uploads
// ---------------------------------------------------------------------------

type Upload = {
  file: File;
  /** A local preview for an image the browser can show; HEIC and PDF show their name instead. */
  preview: string | null;
  status: "preparing" | "registering" | "uploading" | "done" | "failed";
  /** 0 to 100 while uploading. */
  progress: number;
  /** The same key on every Try again, so a lost answer replays the same receipt. */
  registerKey: string;
  ticket: ReceiptTicket | null;
  error: string | null;
};

type Line = {
  key: string;
  amount: string;
  purpose: string;
  mode: "receipt" | "none";
  reason: NoReceiptReason | "";
  note: string;
  upload: Upload | null;
  /** A receipt an earlier cycle cited, cited again instead of a new upload (issue #65). */
  earlier: string | null;
};

const newLine = (): Line => ({
  key: crypto.randomUUID(),
  amount: "",
  purpose: "",
  mode: "receipt",
  reason: "",
  note: "",
  upload: null,
  earlier: null,
});

/** The returned cycle's lines, as the starting point of the next one. */
const linesFrom = (cycle: SettlementCycle | null): Line[] =>
  (cycle?.lines ?? []).map((line) => ({
    ...newLine(),
    amount: String(line.amount),
    purpose: line.purpose,
    mode: line.receipt ? "receipt" : "none",
    reason: line.reason ?? "",
    note: line.note ?? "",
    earlier: line.receipt?.id ?? null,
  }));

const PREVIEWABLE = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Sends the encrypted bytes to the bucket as the signed-in Cashier. XHR rather than fetch, because
 * only XHR reports upload progress. Resolves with the HTTP status.
 */
function sendToBucket(
  path: string,
  body: Uint8Array<ArrayBuffer>,
  token: string,
  onProgress: (percent: number) => void,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${publicEnv.supabaseUrl}/storage/v1/object/${RECEIPT_BUCKET}/${path}`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("apikey", publicEnv.supabasePublishableKey);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => resolve({ status: 0, text: "" });
    xhr.ontimeout = () => resolve({ status: 0, text: "" });
    xhr.send(new Blob([body]));
  });
}

/**
 * Settles a handed-out disbursement in one submission (approved default 5): every line, the cash
 * that came back, and an explanation when something is unaccounted for. Settling again after a
 * send-back (issue #65) starts from the returned cycle, and may cite its receipts again.
 */
function SettleForm({
  disbursement,
  approved,
  onDone,
  previous = null,
  earlier = [],
}: {
  disbursement: Target;
  approved: number;
  onDone: (successKey: string) => void;
  previous?: SettlementCycle | null;
  earlier?: EarlierReceipt[];
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [lines, setLines] = useState<Line[]>(() => linesFrom(previous));
  const [returned, setReturned] = useState(previous ? String(previous.returned) : "");
  const [explanation, setExplanation] = useState(previous?.explanation ?? "");
  const [submitProblem, setSubmitProblem] = useState<string | null>(null);
  const [key, controller] = useFreshKey(() => onDone("imprest.spending.success.settled"), SPENDING_UNCONFIRMED_KEY);
  const locked = useDeferredValue(controller.pending);
  const problems = controller.running === null ? controller.result.fieldErrors : undefined;
  const previews = useRef(new Set<string>());
  /** The last file chosen on each line, by its register key. */
  const latestPick = useRef(new Map<string, string>());

  useEffect(() => {
    const urls = previews.current;
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const amounts = lines.map((line) => parseTzs(line.amount));
  const returnedValue = /^\s*0+\s*$/.test(returned) ? 0 : parseTzs(returned);
  const figures = settlementFigures(approved, amounts, returnedValue);

  const update = (lineKey: string, change: Partial<Line> | ((line: Line) => Partial<Line>)) =>
    setLines((current) =>
      current.map((line) =>
        line.key === lineKey ? { ...line, ...(typeof change === "function" ? change(line) : change) } : line,
      ),
    );
  /**
   * Updates the line's upload only while it is still the upload `registerKey` started. A Cashier
   * may pick a new file while an earlier one is in flight; without this check the earlier upload
   * would write its ticket and "done" onto the new file, and the line would cite the wrong receipt.
   */
  const updateUpload = (lineKey: string, registerKey: string, change: Partial<Upload>) =>
    update(lineKey, (line) =>
      line.upload?.registerKey === registerKey ? { upload: { ...line.upload, ...change } } : {},
    );

  async function upload(lineKey: string, pending: Upload) {
    let ticket = pending.ticket;
    if (!ticket) {
      updateUpload(lineKey, pending.registerKey, { status: "registering", error: null, progress: 0 });
      let registered;
      try {
        registered = await registerReceiptAction({
          disbursementId: disbursement.id,
          fileName: pending.file.name || "receipt",
          contentType: receiptType(pending.file) ?? "",
          byteSize: pending.file.size,
          idempotencyKey: pending.registerKey,
        });
      } catch {
        registered = { error: "spendingErrors.upload_failed" };
      }
      if (!registered.ticket) {
        updateUpload(lineKey, pending.registerKey, { status: "failed", error: registered.error ?? "spendingErrors.upload_failed" });
        return;
      }
      ticket = registered.ticket;
      updateUpload(lineKey, pending.registerKey, { ticket });
    }

    updateUpload(lineKey, pending.registerKey, { status: "uploading", error: null, progress: 0 });
    try {
      const { data } = await createClient().auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("no session");
      const sealed = await encryptReceipt(await pending.file.arrayBuffer(), ticket.key);
      const sent = await sendToBucket(ticket.objectPath, sealed, token, (progress) =>
        updateUpload(lineKey, pending.registerKey, { progress }),
      );
      // A duplicate means an earlier attempt landed and only its answer was lost. Only this
      // Cashier can put a file at this path, so the file there is theirs.
      const landed = sent.status === 200 || /duplicate|already exists/i.test(sent.text);
      updateUpload(
        lineKey,
        pending.registerKey,
        landed ? { status: "done", progress: 100 } : { status: "failed", error: "spendingErrors.upload_failed" },
      );
    } catch {
      updateUpload(lineKey, pending.registerKey, { status: "failed", error: "spendingErrors.upload_failed" });
    }
  }

  /**
   * A new file for the line. A photo is made smaller first (issue #65); the checks, the registration
   * and the upload all apply to what comes out, so the size and type the database records are those
   * of the bytes that go up.
   */
  function choose(lineKey: string, picked: File | undefined) {
    if (!picked) return;
    const registerKey = crypto.randomUUID();
    const preparing: Upload = {
      file: picked,
      preview: null,
      status: receiptType(picked) ? "preparing" : "failed",
      progress: 0,
      registerKey,
      ticket: null,
      error: receiptType(picked) ? null : "spendingErrors.receipt_type_invalid",
    };
    update(lineKey, { upload: preparing, earlier: null });
    latestPick.current.set(lineKey, registerKey);
    if (preparing.status === "failed") return;

    void (async () => {
      const file = await shrinkReceipt(picked);
      // Another file was chosen for this line while this one was being shrunk: this one is not
      // registered at all, so it leaves no receipt behind.
      if (latestPick.current.get(lineKey) !== registerKey) return;
      const type = receiptType(file);
      const error = !type
        ? "spendingErrors.receipt_type_invalid"
        : file.size > RECEIPT_MAX_BYTES || file.size === 0
          ? "spendingErrors.receipt_too_large"
          : null;
      const preview = type && PREVIEWABLE.has(type) ? URL.createObjectURL(file) : null;
      if (preview) previews.current.add(preview);
      const ready: Upload = { ...preparing, file, preview, status: error ? "failed" : "registering", error };
      updateUpload(lineKey, registerKey, ready);
      if (!error) void upload(lineKey, ready);
    })();
  }

  /** Cite a receipt an earlier cycle cited, instead of a new file (issue #65). */
  function pickEarlier(lineKey: string, receiptId: string | null) {
    latestPick.current.delete(lineKey);
    update(lineKey, { earlier: receiptId, upload: null });
  }

  function remove(lineKey: string) {
    latestPick.current.delete(lineKey);
    setLines((current) => current.filter((l) => l.key !== lineKey));
  }

  const busyUploading = lines.some(
    (line) =>
      line.mode === "receipt" &&
      !line.earlier &&
      line.upload &&
      ["preparing", "registering", "uploading"].includes(line.upload.status),
  );

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busyUploading) {
      setSubmitProblem("spendingErrors.receipt_pending");
      return;
    }
    if (lines.some((line) => line.mode === "receipt" && !line.earlier && line.upload && line.upload.status !== "done")) {
      setSubmitProblem("spendingErrors.receipt_not_uploaded_yet");
      return;
    }
    setSubmitProblem(null);
    const data = new FormData();
    data.set("disbursementId", disbursement.id);
    data.set("expectedVersion", String(disbursement.version));
    data.set("approved", String(approved));
    data.set(
      "lines",
      JSON.stringify(
        lines.map((line) => ({
          amount: line.amount,
          purpose: line.purpose,
          receiptId: line.mode === "receipt" ? (line.earlier ?? line.upload?.ticket?.id ?? null) : null,
          reason: line.mode === "none" ? line.reason || null : null,
          note: line.mode === "none" ? line.note : "",
        })),
      ),
    );
    data.set("returned", returned);
    // Only a remainder takes an explanation; a hidden, stale one is not sent.
    data.set("explanation", figures.unexplained > 0 ? explanation : "");
    data.set("idempotencyKey", key);
    controller.run("settle", settleDisbursementAction, data);
  }

  // The latest closures behind functions that never change, so a line re-renders only when its own
  // props do. Submitting then re-renders the form around the lines, not every line in it, which
  // keeps the tap acknowledged within a frame on a slow phone (issue #65).
  const live = useRef({ update, choose, uploadAgain, pickEarlier, remove });
  useEffect(() => {
    live.current = { update, choose, uploadAgain, pickEarlier, remove };
  });
  const handlers = useMemo<LineHandlers>(
    () => ({
      update: (lineKey, change) => live.current.update(lineKey, change),
      choose: (lineKey, file) => live.current.choose(lineKey, file),
      retry: (lineKey) => void live.current.uploadAgain(lineKey),
      pickEarlier: (lineKey, receiptId) => live.current.pickEarlier(lineKey, receiptId),
      remove: (lineKey) => live.current.remove(lineKey),
    }),
    [],
  );

  return (
    <div className="flex flex-col gap-4" data-testid="settle">
      <form className="flex flex-col gap-4" noValidate data-testid="settle-form" onSubmit={submit}>
        <Help>{t("imprest.spending.settle.help")}</Help>

        <ol className="flex flex-col gap-4" data-testid="settle-lines">
          {lines.map((line, index) => (
            <SettleLine
              key={line.key}
              line={line}
              index={index}
              locked={locked}
              earlier={earlier}
              on={handlers}
              amountError={problems?.[`lines.${index}.amount`]}
              purposeError={problems?.[`lines.${index}.purpose`]}
              noteError={problems?.[`lines.${index}.note`]}
              evidenceError={problems?.[`lines.${index}.evidence`]}
            />
          ))}
        </ol>

        {lines.length < MAX_LINES ? (
          <Button
            type="button"
            variant="secondary"
            className={`${TOUCH_FLOOR} self-start`}
            disabled={locked}
            data-testid="add-line"
            onClick={() => setLines((current) => [...current, newLine()])}
          >
            {t("imprest.spending.settle.addLine")}
          </Button>
        ) : (
          <Help>{t("imprest.spending.settle.maxLines", { max: MAX_LINES })}</Help>
        )}

        <Field>
          <Label htmlFor="settle-returned">{t("imprest.spending.settle.returned")}</Label>
          <Input
            id="settle-returned"
            inputMode="numeric"
            autoComplete="off"
            value={returned}
            readOnly={locked}
            aria-invalid={problems?.returned ? true : undefined}
            aria-describedby={problems?.returned ? "settle-returned-error" : "settle-returned-help"}
            onChange={(event) => setReturned(event.target.value)}
          />
          <Help id="settle-returned-help">{t("imprest.spending.settle.returnedHelp")}</Help>
          {problems?.returned ? (
            <span id="settle-returned-error">
              <FieldError>{t(problems.returned)}</FieldError>
            </span>
          ) : null}
        </Field>

        <dl className="grid grid-cols-2 gap-3 rounded-lg bg-muted/40 p-3 md:grid-cols-4" data-testid="settle-totals" aria-live="polite">
          <div className="flex flex-col gap-1">
            <dt className="text-xs text-muted-foreground">{t("imprest.spending.breakdown.approved")}</dt>
            <dd className="fv-numeric font-semibold">{formatTzs(approved, locale)}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-xs text-muted-foreground">{t("imprest.spending.breakdown.used")}</dt>
            <dd className="fv-numeric font-semibold" data-testid="total-used">
              {formatTzs(figures.used, locale)}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-xs text-muted-foreground">{t("imprest.spending.breakdown.returned")}</dt>
            <dd className="fv-numeric font-semibold" data-testid="total-returned">
              {formatTzs(figures.returned, locale)}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-xs text-muted-foreground">
              {t(figures.over > 0 ? "imprest.spending.settle.over" : "imprest.spending.settle.unexplained")}
            </dt>
            <dd
              className={`fv-numeric font-semibold ${figures.over > 0 ? "text-danger" : ""}`}
              data-testid={figures.over > 0 ? "total-over" : "total-unexplained"}
            >
              {formatTzs(figures.over > 0 ? figures.over : figures.unexplained, locale)}
            </dd>
          </div>
        </dl>
        {figures.over > 0 ? (
          <Help data-testid="over-approval">{t("imprest.spending.settle.overHelp")}</Help>
        ) : null}

        {figures.unexplained > 0 ? (
          <Field>
            <Label htmlFor="settle-explanation">{t("imprest.spending.settle.explanation")}</Label>
            <Input
              id="settle-explanation"
              autoComplete="off"
              value={explanation}
              readOnly={locked}
              aria-invalid={problems?.explanation ? true : undefined}
              aria-describedby={problems?.explanation ? "settle-explanation-error" : "settle-explanation-help"}
              onChange={(event) => setExplanation(event.target.value)}
            />
            <Help id="settle-explanation-help">
              {t("imprest.spending.settle.explanationHelp", { amount: formatTzs(figures.unexplained, locale) })}
            </Help>
            {problems?.explanation ? (
              <span id="settle-explanation-error">
                <FieldError>{t(problems.explanation)}</FieldError>
              </span>
            ) : null}
          </Field>
        ) : null}

        {submitProblem ? <FormError>{t(submitProblem)}</FormError> : null}

        <Button
          type="submit"
          className={`${TOUCH_FLOOR} self-start`}
          pending={controller.running === "settle"}
          pendingLabel={t("common.loading")}
          disabled={controller.pending}
          data-testid="settle-submit"
        >
          {t("imprest.spending.settle.submit")}
        </Button>
      </form>
      {controller.result.successKey ? null : <Outcome controller={controller} />}
    </div>
  );

  function uploadAgain(lineKey: string) {
    const line = lines.find((l) => l.key === lineKey);
    if (line?.upload) return upload(lineKey, line.upload);
  }
}

type LineHandlers = {
  update: (lineKey: string, change: Partial<Line>) => void;
  choose: (lineKey: string, file: File | undefined) => void;
  retry: (lineKey: string) => void;
  pickEarlier: (lineKey: string, receiptId: string | null) => void;
  remove: (lineKey: string) => void;
};

/** One settlement line: amount, purpose, and its receipt or No-receipt reason. */
const SettleLine = memo(function SettleLine({
  line,
  index,
  locked,
  earlier,
  on,
  amountError,
  purposeError,
  noteError,
  evidenceError,
}: {
  line: Line;
  index: number;
  locked: boolean;
  earlier: EarlierReceipt[];
  on: LineHandlers;
  amountError?: string;
  purposeError?: string;
  noteError?: string;
  evidenceError?: string;
}) {
  const t = useTranslations();
  const current = line.upload;
  const needsNote = line.reason !== "" && REASONS_NEEDING_NOTE.includes(line.reason);
  const fieldError = (field: string, message: string | undefined) =>
    message ? (
      <span id={`line-${index}-${field}-error`}>
        <FieldError>{t(message)}</FieldError>
      </span>
    ) : null;

  return (
    <li
                      className="flex flex-col gap-3 rounded-lg border border-border p-3"
      data-testid={`settle-line-${index + 1}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t("imprest.spending.settle.line", { number: index + 1 })}</span>
        <Button
          type="button"
          variant="secondary"
          size="small"
          className={TOUCH_FLOOR}
          disabled={locked}
          onClick={() => on.remove(line.key)}
        >
          {t("imprest.spending.settle.removeLine")}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field>
          <Label htmlFor={`line-${index}-amount`}>{t("imprest.spending.settle.amount")}</Label>
          <Input
            id={`line-${index}-amount`}
            inputMode="numeric"
            autoComplete="off"
            value={line.amount}
            readOnly={locked}
            aria-invalid={amountError ? true : undefined}
            aria-describedby={amountError ? `line-${index}-amount-error` : undefined}
            onChange={(event) => on.update(line.key, { amount: event.target.value })}
          />
          {fieldError("amount", amountError)}
        </Field>
        <Field>
          <Label htmlFor={`line-${index}-purpose`}>{t("imprest.spending.settle.purpose")}</Label>
          <Input
            id={`line-${index}-purpose`}
            autoComplete="off"
            maxLength={LINE_PURPOSE_MAX}
            value={line.purpose}
            readOnly={locked}
            placeholder={t("imprest.spending.settle.purposeExample")}
            aria-invalid={purposeError ? true : undefined}
            aria-describedby={purposeError ? `line-${index}-purpose-error` : undefined}
            onChange={(event) => on.update(line.key, { purpose: event.target.value })}
          />
          {fieldError("purpose", purposeError)}
        </Field>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">{t("imprest.spending.settle.evidence")}</legend>
        <div className="flex flex-wrap gap-2" role="radiogroup">
          {(["receipt", "none"] as const).map((mode) => (
            <label key={mode} className="inline-flex cursor-pointer">
              <input
                type="radio"
                name={`line-${index}-mode`}
                value={mode}
                className="peer sr-only"
                checked={line.mode === mode}
                disabled={locked}
                onChange={() => on.update(line.key, { mode })}
              />
              <span
                className={`${TOUCH_FLOOR} inline-flex items-center rounded-full border border-border px-3 py-1.5 text-sm peer-checked:border-foreground peer-checked:bg-foreground peer-checked:text-background peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2`}
              >
                {t(mode === "receipt" ? "imprest.spending.settle.hasReceipt" : "imprest.spending.settle.noReceipt")}
              </span>
            </label>
          ))}
        </div>

        {line.mode === "receipt" ? (
          <div className="flex flex-col gap-2" data-testid="receipt-upload">
            {earlier.length > 0 ? (
              <Field>
                <Label htmlFor={`line-${index}-earlier`}>{t("imprest.spending.settle.earlier")}</Label>
                <select
                  id={`line-${index}-earlier`}
                  className={`${TOUCH_FLOOR} rounded-md border border-border bg-background px-3 py-2 text-sm`}
                  value={line.earlier ?? ""}
                  disabled={locked}
                  data-testid="earlier-receipt"
                  onChange={(event) => on.pickEarlier(line.key, event.target.value || null)}
                >
                  <option value="">{t("imprest.spending.settle.chooseEarlier")}</option>
                  {earlier.map((receipt) => (
                    <option key={receipt.id} value={receipt.id}>
                      {t("imprest.spending.settle.earlierOption", { name: receipt.fileName, cycle: receipt.cycle })}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <label
                className={`${TOUCH_FLOOR} inline-flex cursor-pointer items-center rounded-md border border-border px-3 py-1.5 text-sm focus-within:outline-2 focus-within:outline-offset-2`}
              >
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="sr-only"
                  disabled={locked}
                  data-testid="take-photo"
                  onChange={(event) => {
                    on.choose(line.key, event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
                {t("imprest.spending.settle.takePhoto")}
              </label>
              <label
                className={`${TOUCH_FLOOR} inline-flex cursor-pointer items-center rounded-md border border-border px-3 py-1.5 text-sm focus-within:outline-2 focus-within:outline-offset-2`}
              >
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic,.heic,.heif,application/pdf"
                  className="sr-only"
                  disabled={locked}
                  data-testid="choose-file"
                  onChange={(event) => {
                    on.choose(line.key, event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
                {t("imprest.spending.settle.chooseFile")}
              </label>
            </div>
            {current && !line.earlier ? (
              <div
                className="flex items-center gap-3"
                data-testid="upload-status"
                data-status={current.status}
                data-type={current.file.type}
                data-bytes={current.file.size}
              >
                {current.preview ? (
                  // A local object URL of the chosen photo; next/image cannot optimise it.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={current.preview}
                    alt={t("imprest.spending.settle.thumbnailAlt", { name: current.file.name })}
                    className="size-14 rounded-md object-cover"
                    data-testid="receipt-thumbnail"
                  />
                ) : null}
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="truncate text-sm" data-testid="receipt-name">
                    {current.file.name}
                  </span>
                  {current.status === "uploading" || current.status === "registering" ? (
                    <progress
                      className="h-2 w-40"
                      max={100}
                      value={current.progress}
                      aria-label={t("imprest.spending.settle.uploading", { name: current.file.name })}
                    />
                  ) : null}
                  <span className="text-xs text-muted-foreground" aria-live="polite">
                    {current.status === "done"
                      ? t("imprest.spending.settle.uploaded")
                      : current.status === "failed"
                        ? null
                        : current.status === "preparing"
                          ? t("imprest.spending.settle.preparing")
                          : t("imprest.spending.settle.uploadProgress", { percent: current.progress })}
                  </span>
                  {current.status === "failed" && current.error ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <FieldError>{t(current.error)}</FieldError>
                      {current.error === "spendingErrors.upload_failed" ? (
                        <Button
                          type="button"
                          variant="secondary"
                          size="small"
                          className={TOUCH_FLOOR}
                          data-testid="upload-retry"
                          onClick={() => on.retry(line.key)}
                        >
                          {t("common.retry")}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3" data-testid="no-receipt">
            <Field>
              <Label htmlFor={`line-${index}-reason`}>{t("imprest.spending.settle.reason")}</Label>
              <select
                id={`line-${index}-reason`}
                className={`${TOUCH_FLOOR} rounded-md border border-border bg-background px-3 py-2 text-sm`}
                value={line.reason}
                disabled={locked}
                aria-invalid={evidenceError ? true : undefined}
                onChange={(event) => on.update(line.key, { reason: event.target.value as NoReceiptReason | "" })}
              >
                <option value="">{t("imprest.spending.settle.chooseReason")}</option>
                {NO_RECEIPT_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {t(`imprest.spending.noReceiptReason.${reason}`)}
                  </option>
                ))}
              </select>
            </Field>
            {needsNote ? (
              <Field>
                <Label htmlFor={`line-${index}-note`}>{t("imprest.spending.settle.note")}</Label>
                <Input
                  id={`line-${index}-note`}
                  autoComplete="off"
                  value={line.note}
                  readOnly={locked}
                  aria-invalid={noteError ? true : undefined}
                  aria-describedby={noteError ? `line-${index}-note-error` : undefined}
                  onChange={(event) => on.update(line.key, { note: event.target.value })}
                />
                {fieldError("note", noteError)}
              </Field>
            ) : null}
          </div>
        )}
        {fieldError("evidence", evidenceError)}
      </fieldset>
    </li>
  );
});

// ---------------------------------------------------------------------------
// Opening a receipt
// ---------------------------------------------------------------------------

/**
 * Fetches a receipt through a one-minute signed link and decrypts it in the browser with the key
 * the database hands this viewer. Images show inline; a PDF or HEIC opens or saves from a link.
 */
export function ReceiptView({ receipt }: { receipt: { id: string; fileName: string; contentType: string } }) {
  const t = useTranslations();
  const [state, setState] = useState<{ status: "idle" | "loading" | "open" | "failed"; url?: string; error?: string }>({
    status: "idle",
  });

  useEffect(() => {
    const url = state.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [state.url]);

  async function open() {
    setState({ status: "loading" });
    try {
      const opened = await openReceiptAction(receipt.id);
      if (!opened.ticket || !opened.url) {
        setState({ status: "failed", error: opened.error ?? "spendingErrors.receipt_unavailable" });
        return;
      }
      const response = await fetch(opened.url);
      if (!response.ok) throw new Error(String(response.status));
      const plain = await decryptReceipt(await response.arrayBuffer(), opened.ticket.key);
      const url = URL.createObjectURL(new Blob([plain], { type: opened.ticket.contentType }));
      setState({ status: "open", url });
    } catch {
      setState({ status: "failed", error: "spendingErrors.receipt_unavailable" });
    }
  }

  if (state.status === "open" && state.url) {
    return PREVIEWABLE.has(receipt.contentType) ? (
      // A decrypted object URL; next/image cannot optimise it.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={state.url}
        alt={t("imprest.spending.detail.receiptAlt", { name: receipt.fileName })}
        className="max-h-96 w-auto rounded-md border border-border"
        data-testid="receipt-image"
      />
    ) : (
      <a
        href={state.url}
        download={receipt.contentType === "image/heic" ? receipt.fileName : undefined}
        target="_blank"
        rel="noreferrer"
        className="text-sm underline underline-offset-4"
        data-testid="receipt-link"
      >
        {t(receipt.contentType === "application/pdf" ? "imprest.spending.detail.openPdf" : "imprest.spending.detail.saveFile", {
          name: receipt.fileName,
        })}
      </a>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="secondary"
        size="small"
        className={TOUCH_FLOOR}
        pending={state.status === "loading"}
        pendingLabel={t("common.loading")}
        disabled={state.status === "loading"}
        data-testid="view-receipt"
        onClick={() => void open()}
      >
        {t(state.status === "failed" ? "common.retry" : "imprest.spending.detail.viewReceipt")}
      </Button>
      {state.status === "failed" && state.error ? <FieldError>{t(state.error)}</FieldError> : null}
    </div>
  );
}
