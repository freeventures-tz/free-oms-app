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
