/**
 * The difference between "there is nothing" and "we could not find out".
 *
 * PostgREST answers every read with `{ data, error }` and never throws. So `data ?? []` reads as
 * ordinary defensive code while quietly turning an outage into an empty screen: the account list
 * would have rendered "No accounts yet" during a database failure, which is not a slow page or a
 * broken page — it is a page telling a Director something false about their own business.
 *
 * An empty result and a failed result are different answers and must reach the reader differently
 * (design.md §12.3 for the first, §12.5 for the third kind of error).
 */

/** Marks a read that failed, so the shell's error boundary can be told apart from a crash. */
export const DATA_UNAVAILABLE = "data_unavailable";

export type QueryResult<T> = { data: T[] | null; error: { message: string } | null };

/**
 * Rows, or a thrown failure that the nearest `error.tsx` turns into the page-level retry state.
 *
 * `what` names the read for the server log only. The provider's own message is never put on the
 * thrown error: it names tables, columns and sometimes values, and while Next replaces a thrown
 * message with an opaque digest in production, relying on that is relying on a framework default
 * to keep a secret.
 */
export function requireRows<T>(result: QueryResult<T>, what: string): T[] {
  if (result.error) {
    console.error(`[data] ${what} failed: ${result.error.message}`);
    throw new Error(`${DATA_UNAVAILABLE}: ${what}`);
  }
  return result.data ?? [];
}

export type ScalarResult = { data: unknown; error: { message: string } | null };

/**
 * One piece of text that the caller has already established MUST exist, or the same thrown failure.
 *
 * `requireRows` has an empty answer to return, because "no orders yet" is a real state. This has
 * none. It is for a scalar the caller only asks for once it knows the record is there and readable
 * — the name of the person who wrote an order it has just read — where there is no such thing as
 * "no answer". A null, an empty string or anything that is not text means the read did not work,
 * whatever the provider said about it, and the page must say so rather than render a sentence with
 * a hole in it. That hole is the exact shape of the defect this replaced: a missing name became
 * "Created by  (Sales Representative)".
 *
 * The provider's own message never reaches the thrown error, for the reason above. Neither does the
 * VALUE when it is the wrong shape: only what shape it was, which is what a log needs and all it
 * needs.
 */
export function requireText(result: ScalarResult, what: string): string {
  if (result.error) {
    console.error(`[data] ${what} failed: ${result.error.message}`);
    throw new Error(`${DATA_UNAVAILABLE}: ${what}`);
  }

  if (typeof result.data !== "string" || result.data.trim().length === 0) {
    const shape =
      result.data === null
        ? "null"
        : typeof result.data === "string"
          ? "blank text"
          : typeof result.data;
    console.error(`[data] ${what} returned ${shape} where text was expected`);
    throw new Error(`${DATA_UNAVAILABLE}: ${what}`);
  }

  return result.data;
}
