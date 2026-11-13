import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { queueFrom } from "@/lib/accountability/decisions";
import { roleMayAccess } from "@/lib/auth/landing";
import { navItemsFor } from "@/lib/nav";
import { recordDecisionSchema } from "@/lib/validation/accountability";
import en from "@/messages/en.json";
import sw from "@/messages/sw.json";

/** Issue #84: the Directors' accountability screen, its form rules and what it reads. */

describe("who reaches the accountability screen", () => {
  it("is a Director's alone, in the route and in the navigation", () => {
    expect(roleMayAccess("director", "/accountability")).toBe(true);
    expect(navItemsFor("director").some((item) => item.href === "/accountability")).toBe(true);
    for (const role of ["manager", "cashier", "sales_rep"] as const) {
      expect(roleMayAccess(role, "/accountability"), role).toBe(false);
      expect(navItemsFor(role).some((item) => item.href === "/accountability"), role).toBe(false);
    }
  });
});

describe("the decision form", () => {
  const base = {
    subjectType: "imprest_unexplained_loss",
    subjectId: randomUUID(),
    decision: "  The driver repays the change.  ",
    responsibility: "nobody",
    responsibleStaff: [] as string[],
    idempotencyKey: randomUUID(),
  };
  const problem = (input: Record<string, unknown>) => {
    const parsed = recordDecisionSchema.safeParse({ ...base, ...input });
    return parsed.success ? null : parsed.error.issues[0].message;
  };

  it("keeps the written decision as written, trimmed at its ends", () => {
    const parsed = recordDecisionSchema.parse({ ...base, decision: " Line one.\nLine two. " });
    expect(parsed.decision).toBe("Line one.\nLine two.");
  });

  it("requires a decision of 3 to 2,000 characters", () => {
    expect(problem({ decision: "  " })).toBe("accountabilityErrors.decision_required");
    expect(problem({ decision: "x".repeat(2001) })).toBe("accountabilityErrors.decision_required");
    expect(problem({ decision: "x".repeat(2000) })).toBeNull();
  });

  it("asks who is responsible: named staff, or nobody identified, never both or neither", () => {
    expect(problem({ responsibility: undefined })).toBe("accountabilityErrors.responsible_required");
    expect(problem({ responsibility: "named" })).toBe("accountabilityErrors.responsible_required");
    expect(problem({ responsibility: "nobody", responsibleStaff: [randomUUID()] })).toBe(
      "accountabilityErrors.responsible_conflict",
    );
    expect(problem({ responsibility: "named", responsibleStaff: [randomUUID()] })).toBeNull();
    expect(
      problem({ responsibility: "named", responsibleStaff: Array.from({ length: 11 }, () => randomUUID()) }),
    ).toBe("accountabilityErrors.too_many_staff");
  });

  it("offers only the two subjects built so far", () => {
    expect(problem({ subjectType: "till_variance" })).toBe("accountabilityErrors.no_subject");
    expect(problem({ subjectType: "imprest_count_shortage" })).toBeNull();
  });

  it("has words for every refusal, in English and Swahili", () => {
    const keys = Object.keys(en.accountabilityErrors).sort();
    expect(Object.keys(sw.accountabilityErrors).sort()).toEqual(keys);
    for (const reason of ["director_only", "already_decided", "subject_reversed", "unconfirmed", "generic"]) {
      expect(keys).toContain(reason);
    }
    expect(en.accountability.form.noPayroll).toMatch(/no payroll effect/);
    expect(sw.accountability.form.noPayroll).toMatch(/hauathiri mishahara/);
  });
});

describe("what the screen reads", () => {
  it("maps each subject, decision and member of staff from the database's answer", () => {
    const queue = queueFrom({
      undecided: [
        {
          subject_type: "imprest_unexplained_loss",
          subject_id: "p1",
          amount_tzs: "500",
          posted_at: "2026-11-13T07:00:00Z",
          fund_retired: false,
          entry: "replacement",
          disbursement_id: "d1",
          disbursement_no: "FV-IMP-1",
          purpose: "Trip",
          proposed_by_name: "Asha",
          explanation: "Change lost",
        },
        {
          subject_type: "imprest_count_shortage",
          subject_id: "c1",
          amount_tzs: 300,
          posted_at: "2026-11-13T08:00:00Z",
          fund_retired: true,
          business_date: "2026-11-13",
          counted_by_name: "Juma",
          confirmed_by_name: "Neema",
          explanation: "counting_error",
          explanation_note: null,
        },
      ],
      decided: [
        {
          id: "a1",
          subject_type: "imprest_count_shortage",
          subject_id: "c0",
          decision: "Nobody could explain it.",
          nobody_identified: true,
          responsible: [],
          decided_by_name: "Director",
          decided_at: "2026-11-12T10:00:00Z",
        },
      ],
      staff: [{ id: "s1", full_name: "Asha", role: "cashier", is_active: true }],
    });
    expect(queue.undecided[0]).toMatchObject({ amount: 500, replacement: true, disbursementNo: "FV-IMP-1" });
    expect(queue.undecided[1]).toMatchObject({ amount: 300, fundRetired: true, businessDate: "2026-11-13", explanationNote: null });
    expect(queue.decided[0]).toMatchObject({ nobodyIdentified: true, responsible: [], decidedBy: "Director" });
    expect(queue.staff).toEqual([{ id: "s1", name: "Asha", role: "cashier", active: true }]);
  });

  it("reads a missing list as empty, never as something waiting", () => {
    expect(queueFrom({})).toEqual({ undecided: [], decided: [], staff: [] });
  });
});
