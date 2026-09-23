import "@testing-library/jest-dom/vitest";

/**
 * jsdom has no `matchMedia`, and never will: it implements the DOM, not a layout engine, so there
 * is no viewport for a media query to be true or false about.
 *
 * The report screen asks one media query, for one reason — to tell a screen reader whether a
 * section that CSS has opened is open (`app/(app)/reports/[id]/report-view.tsx`). Without a stub
 * every render of that screen throws inside an effect, which would push the project towards
 * guarding the browser API in production code to keep a test environment happy. The stub belongs
 * here instead.
 *
 * It answers `false` to everything, which is the narrow phone tier — the tier where the collapsing
 * this project cares about actually happens, and the same answer the server renders with.
 *
 * Only where there IS a window. The release-controller suites run under `@vitest-environment node`,
 * where this setup file still loads and `window` does not exist.
 */
if (typeof window !== "undefined") Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList,
});
