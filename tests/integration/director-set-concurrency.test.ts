import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createLiveStaff, ensureDirector, type Fixture } from "@/tests/integration/helpers";

/**
 * At least one active Director must exist after every committed administrative operation.
 *
 * The previous guards read the Director set without holding anything: two transactions each saw the
 * other Director as still active, each concluded it was safe to proceed, and both committed. The
 * system was left with no Director and no in-app way back.
 *
 * Every test below fires genuinely concurrent requests — separate sessions, separate PostgREST
 * connections, separate database transactions — and asserts the invariant on the COMMITTED result
 * rather than on either call's return value.
 *
 * The file owns the whole Director set for its duration. The shared bootstrap Director is stood
 * down at the start and restored at the end, because "both demotions succeeded" is only observable
 * when the two Directors under test are the only ones there are.
 */

let bootstrap: Fixture;
let alpha: Fixture;
let beta: Fixture;

/**
 * A Manager who takes part in nothing and is never changed.
 *
 * Counting through a participant's own session does not work, and finding that out was instructive:
 * once a Director is deactivated their session reads NOTHING, so the count came back as zero and
 * looked exactly like the invariant failing. That is deactivation working — RLS denying a
 * deactivated user immediately — but it makes the measurement useless. A Manager retains oversight
 * reads and no stake in the outcome.
 */
let observer: Fixture;

async function activeDirectorCount(): Promise<number> {
  const { data: directors } = await observer.read
    .from("user_roles")
    .select("user_id")
    .eq("role", "director");

  const ids = (directors ?? []).map((row) => row.user_id as string);
  if (ids.length === 0) return 0;

  const { count } = await observer.read
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .in("id", ids)
    .eq("is_active", true);

  return count ?? 0;
}

/**
 * Whichever of the two still holds authority. The invariant guarantees at least one active Director
 * survives every test, so one of them can always put the other back.
 */
async function workingDirector(): Promise<Fixture> {
  for (const candidate of [alpha, beta]) {
    const { error } = await candidate.api.rpc("admin_set_account_active", {
      p_target_user_id: candidate.userId,
      p_is_active: true,
    });
    if (error === null) return candidate;
  }
  throw new Error("no Director retained authority — the invariant has been violated");
}

/** Puts both back to active Directors, whatever the previous test did to them. */
async function restorePair(): Promise<void> {
  const actor = await workingDirector();
  const other = actor === alpha ? beta : alpha;

  await actor.api.rpc("admin_set_account_active", {
    p_target_user_id: other.userId,
    p_is_active: true,
  });
  await actor.api.rpc("admin_change_user_role", {
    p_target_user_id: other.userId,
    p_role: "director",
  });
}

beforeAll(async () => {
  bootstrap = await ensureDirector();
  observer = await createLiveStaff(bootstrap, "manager");
  alpha = await createLiveStaff(bootstrap, "director");
  beta = await createLiveStaff(bootstrap, "director");

  // Stand down every other Director — the shared fixture, plus any left behind by an earlier file —
  // so alpha and beta are the entire Director set. "Both demotions succeeded" is only observable
  // when the two under test are the only ones there are.
  const { data: others } = await alpha.read
    .from("user_roles")
    .select("user_id")
    .eq("role", "director");

  for (const row of others ?? []) {
    const id = row.user_id as string;
    if (id === alpha.userId || id === beta.userId) continue;
    const { data } = await alpha.api.rpc("admin_change_user_role", {
      p_target_user_id: id,
      p_role: "manager",
    });
    expect(data?.ok, `standing down ${id}`).toBe(true);
  }

  expect(await activeDirectorCount()).toBe(2);
});

afterEach(async () => {
  await restorePair();
});

afterAll(async () => {
  // Hand the shared Director back, so later files still have the fixture they expect.
  const actor = await workingDirector();
  await actor.api.rpc("admin_set_account_active", {
    p_target_user_id: bootstrap.userId,
    p_is_active: true,
  });
  await actor.api.rpc("admin_change_user_role", {
    p_target_user_id: bootstrap.userId,
    p_role: "director",
  });
});

describe("two Directors acting at the same time", () => {
  it("does not let them demote each other into an empty Director set", async () => {
    expect(await activeDirectorCount()).toBe(2);

    const [a, b] = await Promise.all([
      alpha.api.rpc("admin_change_user_role", {
        p_target_user_id: beta.userId,
        p_role: "manager",
      }),
      beta.api.rpc("admin_change_user_role", {
        p_target_user_id: alpha.userId,
        p_role: "manager",
      }),
    ]);

    // One may succeed. BOTH succeeding is the defect, and it is what left zero Directors.
    const succeeded = [a, b].filter((r) => r.error === null && r.data?.ok === true);
    expect(succeeded.length).toBeLessThanOrEqual(1);
    expect(await activeDirectorCount()).toBeGreaterThanOrEqual(1);
  });

  it("does not let them deactivate each other into an empty Director set", async () => {
    expect(await activeDirectorCount()).toBe(2);

    const [a, b] = await Promise.all([
      alpha.api.rpc("admin_set_account_active", {
        p_target_user_id: beta.userId,
        p_is_active: false,
      }),
      beta.api.rpc("admin_set_account_active", {
        p_target_user_id: alpha.userId,
        p_is_active: false,
      }),
    ]);

    const succeeded = [a, b].filter((r) => r.error === null && r.data?.ok === true);
    expect(succeeded.length).toBeLessThanOrEqual(1);
    expect(await activeDirectorCount()).toBeGreaterThanOrEqual(1);
  });

  it("does not let a demotion and a deactivation combine to empty the set", async () => {
    expect(await activeDirectorCount()).toBe(2);

    const [a, b] = await Promise.all([
      alpha.api.rpc("admin_change_user_role", {
        p_target_user_id: beta.userId,
        p_role: "cashier",
      }),
      beta.api.rpc("admin_set_account_active", {
        p_target_user_id: alpha.userId,
        p_is_active: false,
      }),
    ]);

    expect(
      [a, b].filter((r) => r.error === null && r.data?.ok === true).length,
    ).toBeLessThanOrEqual(1);
    expect(await activeDirectorCount()).toBeGreaterThanOrEqual(1);
  });

  it("survives a burst of concurrent attempts from both sides", async () => {
    expect(await activeDirectorCount()).toBe(2);

    await Promise.all([
      ...Array.from({ length: 4 }, () =>
        alpha.api.rpc("admin_change_user_role", {
          p_target_user_id: beta.userId,
          p_role: "manager",
        }),
      ),
      ...Array.from({ length: 4 }, () =>
        beta.api.rpc("admin_change_user_role", {
          p_target_user_id: alpha.userId,
          p_role: "manager",
        }),
      ),
    ]);

    expect(await activeDirectorCount()).toBeGreaterThanOrEqual(1);
  });
});

describe("the last Director", () => {
  it("cannot demote themselves", async () => {
    // Leave alpha as the only Director.
    await alpha.api.rpc("admin_change_user_role", {
      p_target_user_id: beta.userId,
      p_role: "manager",
    });
    expect(await activeDirectorCount()).toBe(1);

    const { data, error } = await alpha.api.rpc("admin_change_user_role", {
      p_target_user_id: alpha.userId,
      p_role: "manager",
    });

    // Refused by the post-change recheck, which raises rather than returning a soft failure.
    expect(error).not.toBeNull();
    expect(data).toBeNull();
    expect(error?.message ?? "").toMatch(/no active Director/i);
    expect(await activeDirectorCount()).toBe(1);
  });

  it("cannot deactivate themselves", async () => {
    await alpha.api.rpc("admin_change_user_role", {
      p_target_user_id: beta.userId,
      p_role: "manager",
    });
    expect(await activeDirectorCount()).toBe(1);

    const { data } = await alpha.api.rpc("admin_set_account_active", {
      p_target_user_id: alpha.userId,
      p_is_active: false,
    });

    // Named refusal, because the message has to tell a Director what they did wrong.
    expect(data.ok).toBe(false);
    expect(data.reason).toBe("cannot_deactivate_self");
    expect(await activeDirectorCount()).toBe(1);
  });

  it("keeps the invariant under a burst of concurrent self-demotions", async () => {
    await alpha.api.rpc("admin_change_user_role", {
      p_target_user_id: beta.userId,
      p_role: "manager",
    });

    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        alpha.api.rpc("admin_change_user_role", {
          p_target_user_id: alpha.userId,
          p_role: "cashier",
        }),
      ),
    );

    expect(attempts.every((r) => (r.data?.ok ?? false) === false)).toBe(true);
    expect(await activeDirectorCount()).toBe(1);
  });
});
