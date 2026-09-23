import { Suspense, startTransition, use, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { ErrorBoundaryHandler } from "next/dist/client/components/error-boundary";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AppError from "@/app/(app)/error";
import en from "@/messages/en.json";

/**
 * The failed-read retry, held open (issue #19, F4; design.md §12.7).
 *
 * Next's own `ErrorBoundaryHandler` renders the real `AppError`, and its real `retry` runs: a
 * transition that calls the router's `refresh` and resets the boundary. Only the router is stood
 * in for, and it does what Next's action queue does. `refresh` sets the router state to a promise
 * inside a transition, and the tree above the boundary reads that state with `use`, so the whole
 * refresh is held until the promise resolves. The test decides when it resolves, and whether the
 * refreshed read then succeeds or fails again.
 */

type Outcome = "recovered" | "failed";
type Held = { promise: Promise<Outcome>; resolve: (outcome: Outcome) => void };

let refreshes: Held[] = [];
const refresh = vi.fn();

function hold(): Held {
  let resolve!: (outcome: Outcome) => void;
  const promise = new Promise<Outcome>((r) => (resolve = r));
  return { promise, resolve };
}

function Read({ outcome }: { outcome: Outcome }) {
  if (outcome === "failed") throw new Error("data_unavailable: reports.failureAlerts");
  return <p>the refreshed page</p>;
}

function Router() {
  const [state, setState] = useState<Outcome | Promise<Outcome>>("failed");
  const outcome = typeof state === "string" ? state : use(state);

  refresh.mockImplementation(() => {
    const held = hold();
    refreshes.push(held);
    startTransition(() => setState(held.promise));
  });

  return (
    <AppRouterContext.Provider value={{ refresh } as never}>
      <ErrorBoundaryHandler pathname="/reports" errorComponent={AppError as never}>
        <Suspense fallback={<p>loading skeleton</p>}>
          <Read outcome={outcome} />
        </Suspense>
      </ErrorBoundaryHandler>
    </AppRouterContext.Provider>
  );
}

function renderFailedPage() {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <Suspense fallback={<p>root loading</p>}>
        <Router />
      </Suspense>
    </NextIntlClientProvider>,
  );
  return screen.getByRole("button", { name: en.unavailable.retry });
}

async function settle(index: number, outcome: Outcome) {
  await act(async () => refreshes[index]!.resolve(outcome));
}

beforeEach(() => {
  refreshes = [];
  refresh.mockReset();
  // React reports the boundary's caught error; the assertions are about the screen, not the log.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the failed-read retry while the refresh is held", () => {
  it("is pending at once: disabled, busy, and named for what it is doing", async () => {
    const retry = renderFailedPage();

    await act(async () => fireEvent.click(retry));

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(retry).toBeDisabled();
    expect(retry).toHaveAttribute("aria-busy", "true");
    // The word as well as the spinner. jsdom loads no stylesheet, so the browser tests check the
    // accessible name the reader actually hears; this checks the word is there to be heard.
    expect(retry).toHaveTextContent(en.common.loading);
    // The failure message is still what the reader sees; nothing claims the page is back.
    expect(screen.getByText(en.unavailable.body)).toBeVisible();
    expect(screen.queryByText("the refreshed page")).toBeNull();
  });

  it("keeps its label in the layout, so the control does not change size", async () => {
    const retry = renderFailedPage();

    await act(async () => fireEvent.click(retry));

    const label = screen.getByText(en.unavailable.retry);
    expect(retry).toContainElement(label);
    expect(label).toHaveClass("invisible");
  });

  it("sends one refresh however often it is pressed while the first is held", async () => {
    const retry = renderFailedPage();

    await act(async () => fireEvent.click(retry));
    await act(async () => {
      fireEvent.click(retry);
      fireEvent.click(retry);
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("sends one refresh for two activations in the same tick", async () => {
    const retry = renderFailedPage();

    await act(async () => {
      retry.click();
      retry.click();
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stays pending after retry() has returned, until the refresh itself settles", async () => {
    const retry = renderFailedPage();

    await act(async () => fireEvent.click(retry));
    // Several turns of the event loop, none of which resolves the held refresh.
    for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));

    expect(retry).toBeDisabled();
    expect(retry).toHaveAttribute("aria-busy", "true");
  });
});

describe("when the held refresh settles", () => {
  it("replaces the failure with the refreshed page when the read recovers", async () => {
    const retry = renderFailedPage();

    await act(async () => fireEvent.click(retry));
    await settle(0, "recovered");

    expect(screen.getByText("the refreshed page")).toBeVisible();
    expect(screen.queryByRole("button", { name: en.unavailable.retry })).toBeNull();
  });

  it("offers a fresh retry after the refreshed read fails again, and that one is guarded too", async () => {
    renderFailedPage();

    await act(async () => fireEvent.click(screen.getByRole("button")));
    await settle(0, "failed");

    const again = screen.getByRole("button", { name: en.unavailable.retry });
    expect(again).toBeEnabled();
    expect(again).not.toHaveAttribute("aria-busy");
    expect(screen.getByText(en.unavailable.body)).toBeVisible();

    await act(async () => fireEvent.click(again));
    await act(async () => fireEvent.click(again));

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(again).toBeDisabled();
    expect(again).toHaveAttribute("aria-busy", "true");

    await settle(1, "recovered");
    expect(screen.getByText("the refreshed page")).toBeVisible();
  });
});
