import { act, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";

import { type ActionResult, type GuardedAction, useGuardedAction } from "@/lib/ui/use-guarded-action";

/**
 * The verdict and the end of pending arrive in one commit (design.md §12.7).
 *
 * State set after an `await` inside a transition commits on its own, while the transition is still
 * pending. The hook used to do that, so for a moment the screen showed the failure beside a Try again
 * or Go back that was still disabled and still named "Loading…". A tap in that moment was lost, and
 * the unit tests that pressed those controls straight after the message appeared failed under load
 * (`imprest-raised-approval`, `order-confirmation-refusal`). Every commit is recorded here, so the
 * window is caught without any load.
 */

type Commit = { pending: boolean; error: string | undefined; successKey: string | undefined; settled: string | null };

function record(action: GuardedAction<ActionResult>) {
  const commits: Commit[] = [];
  let start: () => void = () => {};
  function Probe() {
    const [settled, setSettled] = useState<string | null>(null);
    const controller = useGuardedAction<"go", ActionResult>({
      onSettled: (outcome) => setSettled(outcome.successKey ?? outcome.error ?? null),
    });
    useEffect(() => {
      commits.push({
        pending: controller.pending,
        error: controller.result.error,
        successKey: controller.result.successKey,
        settled,
      });
    });
    start = () => controller.run("go", action, new FormData());
    return null;
  }
  return { commits, Probe, start: () => start() };
}

async function settle(action: GuardedAction<ActionResult>) {
  const { commits, Probe, start } = record(action);
  render(<Probe />);
  await act(async () => start());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return commits;
}

describe("a settled attempt", () => {
  it("never shows a thrown failure while still pending", async () => {
    const commits = await settle(async () => {
      throw new Error("connection dropped");
    });
    expect(commits.some((c) => c.error)).toBe(true);
    expect(commits.filter((c) => c.pending && c.error)).toEqual([]);
    expect(commits.at(-1)).toMatchObject({ pending: false, error: "common.actionFailed", settled: null });
  });

  it("never shows a returned refusal while still pending, and settles it in the same commit", async () => {
    const commits = await settle(async () => ({ error: "salesErrors.generic" }));
    expect(commits.filter((c) => c.pending && (c.error || c.settled))).toEqual([]);
    const first = commits.find((c) => c.error);
    expect(first).toEqual({ pending: false, error: "salesErrors.generic", successKey: undefined, settled: "salesErrors.generic" });
  });

  it("never shows a success while still pending, and settles it in the same commit", async () => {
    const commits = await settle(async () => ({ successKey: "common.saved" }));
    expect(commits.filter((c) => c.pending && (c.successKey || c.settled))).toEqual([]);
    const first = commits.find((c) => c.successKey);
    expect(first).toEqual({ pending: false, error: undefined, successKey: "common.saved", settled: "common.saved" });
  });
});
