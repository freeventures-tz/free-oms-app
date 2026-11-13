"use server";

import { revalidatePath } from "next/cache";

import type { ImprestActionState } from "@/app/(app)/imprest/actions";
import { recordDecision } from "@/lib/accountability/decisions";
import { requireRole } from "@/lib/auth/guard";
import { fieldErrors } from "@/lib/validation/auth";
import { recordDecisionSchema } from "@/lib/validation/accountability";

/** Every reason the database gives that has its own words; anything else reads as `generic`. */
const KNOWN = new Set([
  "director_only",
  "no_subject",
  "decision_required",
  "responsible_required",
  "responsible_conflict",
  "too_many_staff",
  "unknown_staff",
  "already_decided",
  "subject_reversed",
  "idempotency_key_conflict",
  "unconfirmed",
]);

/** A Director records the accountability decision on one subject (issue #84). */
export async function recordDecisionAction(
  _previous: ImprestActionState,
  data: FormData,
): Promise<ImprestActionState> {
  await requireRole(["director"]);
  const parsed = recordDecisionSchema.safeParse({
    subjectType: data.get("subjectType"),
    subjectId: data.get("subjectId"),
    decision: data.get("decision") ?? "",
    responsibility: data.get("responsibility") ?? undefined,
    responsibleStaff: data.getAll("responsibleStaff").map(String),
    idempotencyKey: data.get("idempotencyKey"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const input = parsed.data;
  const result = await recordDecision({
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    decision: input.decision,
    nobodyIdentified: input.responsibility === "nobody",
    responsibleStaff: input.responsibility === "nobody" ? [] : [...new Set(input.responsibleStaff)],
    idempotencyKey: input.idempotencyKey,
  });
  if (!result.ok) {
    return { error: `accountabilityErrors.${KNOWN.has(result.reason) ? result.reason : "generic"}` };
  }

  revalidatePath("/accountability");
  revalidatePath("/imprest", "layout");
  return { successKey: "accountability.success" };
}
