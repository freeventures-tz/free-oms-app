"use client";

import { useRef, useState, useTransition } from "react";

/**
 * The interaction feedback contract (design.md §12.7) for a mutation, in one hook.
 *
 * Stage 10 Part A established these rules by fixing them one control at a time. Re-deriving them
 * per screen is how they drift: the account row grew four guards over two reviews, and each one
 * was found by a test that a later screen would not have had. So the behaviour lives here once,
 * and a new write path gets it by using this rather than by remembering it.
 *
 * What it guarantees, per §12.7 and §12.5:
 *
 *   · **One operation per burst.** A ref is written synchronously inside the handler, before any
 *     await, so activations dispatched in the same tick — a fast double-tap, a stuck key, an
 *     assistive tool firing twice — cannot both get through. `disabled` alone does not do this:
 *     it closes the control only once React has committed the pending state.
 *   · **Pending belongs to the control that was pressed**, named by the caller, so a row of
 *     buttons does not all claim to be working.
 *   · **A thrown failure is reported, not swallowed.** A dropped connection never reaches a
 *     verdict; releasing the guard in `finally` without catching leaves the screen silent.
 *   · **Retry addresses the SAME command.** The original `FormData` is kept, so the idempotency
 *     key inside it is reused and a request that did reach the server is resumed rather than
 *     duplicated.
 *   · **Never a success the server did not give.** The result is whatever the action returned.
 *
 * What it deliberately does NOT do: decide what a success looks like, rotate idempotency keys, or
 * render anything. Those differ per screen, and `onSettled` is where they belong.
 */

/** Every server action in this application answers in this shape. */
export type ActionResult = {
  error?: string;
  successKey?: string;
};

export type GuardedAction<TResult> = (previous: TResult, data: FormData) => Promise<TResult>;

/** The shared message for a request that never reached a verdict. */
export const ACTION_FAILED_KEY = "common.actionFailed";

type Attempt<TName extends string, TResult> = {
  name: TName;
  action: GuardedAction<TResult>;
  data: FormData;
};

export type GuardedActionController<TName extends string, TResult> = {
  /** Start `action`, attributing the pending state to `name`. Refused if one is already running. */
  run: (name: TName, action: GuardedAction<TResult>, data: FormData) => void;
  /** Re-run the last attempt with the identical request. `null` when there is nothing to retry. */
  retry: (() => void) | null;
  /** The control currently working, or `null`. */
  running: TName | null;
  /** True while any attempt is in flight — for disabling siblings. */
  pending: boolean;
  /** Whatever the action last returned, or the thrown-failure result. */
  result: TResult;
  /** Clear the result, e.g. when the caller opens a fresh interaction. */
  clear: () => void;
};

export function useGuardedAction<TName extends string, TResult extends ActionResult>(options?: {
  /** Runs after every settled attempt, successful or not. Key rotation belongs here. */
  onSettled?: (outcome: TResult) => void;
  /** The message shown when the request never reached a verdict. */
  failureKey?: string;
}): GuardedActionController<TName, TResult> {
  const [pending, startTransition] = useTransition();
  const [running, setRunning] = useState<TName | null>(null);
  const [result, setResult] = useState<TResult>({} as TResult);
  const [attempt, setAttempt] = useState<Attempt<TName, TResult> | null>(null);

  const inFlight = useRef(false);
  const failureKey = options?.failureKey ?? ACTION_FAILED_KEY;

  function run(name: TName, action: GuardedAction<TResult>, data: FormData) {
    if (inFlight.current) return;
    inFlight.current = true;

    setRunning(name);
    setResult({} as TResult);
    setAttempt({ name, action, data });

    startTransition(async () => {
      try {
        const outcome = await action({} as TResult, data);
        setResult(outcome);
        // Nothing to retry once it worked; the next interaction is a new command, not a replay.
        if (!outcome.error) setAttempt(null);
        options?.onSettled?.(outcome);
      } catch {
        // Thrown, not returned: no verdict was reached. `attempt` is kept on purpose so the retry
        // carries the same request — and therefore the same idempotency key.
        setResult({ error: failureKey } as TResult);
      } finally {
        inFlight.current = false;
        setRunning(null);
      }
    });
  }

  return {
    run,
    retry:
      result.error && attempt ? () => run(attempt.name, attempt.action, attempt.data) : null,
    running,
    pending,
    result,
    clear: () => {
      setResult({} as TResult);
      setAttempt(null);
    },
  };
}
