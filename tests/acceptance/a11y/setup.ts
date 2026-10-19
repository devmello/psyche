// jsdom lacks these browser APIs; Base UI, Streamdown and the theme provider touch them
// (same shims as packages/ui/test/setup.ts). Only runs under `@vitest-environment jsdom`.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/** `prefers-*` queries that `matchMedia` reports as matching; tests toggle it. */
export const mediaMatches = new Set<string>();

if (typeof window !== "undefined") {
  window.matchMedia = (query: string) =>
    ({
      matches: mediaMatches.has(query),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;

  class NoopObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  globalThis.ResizeObserver ??= NoopObserver as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= NoopObserver as unknown as typeof IntersectionObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.scrollTo ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.setPointerCapture ??= () => {};
}

afterEach(() => {
  cleanup();
  mediaMatches.clear();
});
