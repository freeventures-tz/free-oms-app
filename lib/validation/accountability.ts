import { z } from "zod";

/**
 * The accountability decision form (issue #84). The database checks every rule again; these give
 * the Director the same answer before the round trip.
 *
 * The written decision keeps its line breaks: it is a paragraph the Director writes, not a label.
 */
export const recordDecisionSchema = z
  .object({
    subjectType: z.enum(["imprest_unexplained_loss", "imprest_count_shortage"], {
      message: "accountabilityErrors.no_subject",
    }),
    subjectId: z.string().uuid({ message: "accountabilityErrors.no_subject" }),
    decision: z
      .string()
      .transform((value) => value.trim())
      .refine((value) => value.length >= 3 && value.length <= 2000, {
        message: "accountabilityErrors.decision_required",
      }),
    responsibility: z.enum(["named", "nobody"], { message: "accountabilityErrors.responsible_required" }),
    responsibleStaff: z.array(z.string().uuid({ message: "accountabilityErrors.unknown_staff" })),
    idempotencyKey: z.string().uuid({ message: "accountabilityErrors.idempotency_key_conflict" }),
  })
  .superRefine((value, ctx) => {
    const named = new Set(value.responsibleStaff).size;
    if (value.responsibility === "named" && named === 0) {
      ctx.addIssue({ code: "custom", path: ["responsibleStaff"], message: "accountabilityErrors.responsible_required" });
    } else if (value.responsibility === "nobody" && named > 0) {
      ctx.addIssue({ code: "custom", path: ["responsibleStaff"], message: "accountabilityErrors.responsible_conflict" });
    } else if (named > 10) {
      ctx.addIssue({ code: "custom", path: ["responsibleStaff"], message: "accountabilityErrors.too_many_staff" });
    }
  });
