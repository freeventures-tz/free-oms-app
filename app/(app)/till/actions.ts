"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import type { z } from "zod";

import { requireRole } from "@/lib/auth/guard";
import type { AppRole } from "@/lib/auth/roles";
import { formatTzs } from "@/lib/money";
import { PAYMENT_METHODS } from "@/lib/settlement/methods";
import { formatBusinessDate } from "@/lib/time/business-date";
import { confirmTillCount, enterTillCount, sendBackTillCount, type TillResult } from "@/lib/till/commands";
import { fieldErrors } from "@/lib/validation/auth";
import {
  confirmTillCountSchema,
  enterLateTillCountSchema,
  enterTillCountSchema,
  sendBackTillCountSchema,
} from "@/lib/validation/till";

/**
 * Till count writes (issue #83). `requireRole` gives the right screen and refuses early; it is not
 * what authorises the change. Every `api` function derives the actor from the same session,
 * re-checks the live role, and refuses a version the caller was not shown.
 */

/** Every refusal the screen has words for. Anything else reads as the generic message. */
const KNOWN = new Set([
  "not_permitted",
  "generic",
  "unconfirmed",
  "idempotency_key_conflict",
  "day_changed",
  "already_confirmed",
  "count_awaiting_confirmation",
  "stale",
  "amount_invalid",
  "note_invalid",
  "no_count",
  "not_awaiting_confirmation",
  "reason_required",
  "explanation_required",
  "explanation_invalid",
  "explanation_note_required",
  "explanation_not_needed",
  "same_person",
  "figures_moved",
  "late_reason_required",
  "late_reason_invalid",
  "late_reason_not_needed",
  "day_not_countable",
]);

/** The same shape the imprest controls use, so the shared form pieces render it. */
export type TillActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  successKey?: string;
  errorValues?: Record<string, string | number>;
};

async function fromRefusal(refusal: Extract<TillResult, { ok: false }>): Promise<TillActionState> {
  const locale = await getLocale();
  const values = refusal.context
    ? Object.fromEntries(
        Object.entries(refusal.context).map(([key, value]) => [
          key,
          key.endsWith("_tzs") && typeof value === "number"
            ? formatTzs(value, locale)
            : key === "business_date" && typeof value === "string"
              ? formatBusinessDate(value, locale)
              : value,
        ]),
      )
    : undefined;
  return {
    error: `till.errors.${KNOWN.has(refusal.reason) ? refusal.reason : "generic"}`,
    errorValues: values,
  };
}

async function run<S extends z.ZodTypeAny>(
  roles: AppRole[],
  schema: S,
  raw: Record<string, unknown>,
  command: (input: z.output<S>) => Promise<TillResult>,
  successKey: string,
): Promise<TillActionState> {
  await requireRole(roles);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const result = await command(parsed.data);
  if (!result.ok) return await fromRefusal(result);

  revalidatePath("/till");
  return { successKey };
}

/** The six figures as typed, one field per payment method (`counted.cash`, ...). */
const countedFrom = (data: FormData) =>
  Object.fromEntries(PAYMENT_METHODS.map((m) => [m, data.get(`counted.${m}`) ?? ""]));

const entry = (data: FormData) => ({
  businessDate: data.get("businessDate") ?? "",
  previousCountId: data.get("previousCountId") ?? "",
  counted: countedFrom(data),
  note: data.get("note") ?? "",
  idempotencyKey: data.get("idempotencyKey"),
});

export async function enterTillCountAction(_p: TillActionState, data: FormData) {
  return run(
    ["cashier"],
    enterTillCountSchema,
    entry(data),
    (input) => enterTillCount({ ...input, lateReason: null }),
    "till.success.counted",
  );
}

/** A past Not counted day, counted late with a reason. The same confirm path follows. */
export async function enterLateTillCountAction(_p: TillActionState, data: FormData) {
  return run(
    ["cashier"],
    enterLateTillCountSchema,
    { ...entry(data), lateReason: data.get("lateReason") ?? "" },
    enterTillCount,
    "till.success.countedLate",
  );
}

const target = (data: FormData) => ({
  countId: data.get("countId"),
  expectedVersion: data.get("expectedVersion"),
  idempotencyKey: data.get("idempotencyKey"),
});

export async function confirmTillCountAction(_p: TillActionState, data: FormData) {
  return run(
    ["manager"],
    confirmTillCountSchema,
    {
      ...target(data),
      short: data.get("short") ?? "0",
      over: data.get("over") ?? "0",
      explanation: data.get("explanation") ?? "",
      note: data.get("note") ?? "",
    },
    confirmTillCount,
    "till.success.confirmed",
  );
}

export async function sendBackTillCountAction(_p: TillActionState, data: FormData) {
  return run(
    ["manager"],
    sendBackTillCountSchema,
    { ...target(data), reason: data.get("reason") ?? "" },
    sendBackTillCount,
    "till.success.sentBack",
  );
}
