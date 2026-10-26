import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { createI18n, setActiveI18n, setDefaultTimeZone } from "../src/i18n/core.ts";

// Stable formats for assertions: US English in UTC (the app follows the owner's region and clock).
setDefaultTimeZone("UTC");
setActiveI18n(createI18n({ locale: "en-US" }));

// jsdom lacks these browser APIs; Base UI, Streamdown and the theme provider touch them.
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

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
// Sonner captures the pointer when a toast is pressed.
Element.prototype.setPointerCapture ??= () => {};

afterEach(() => {
  cleanup();
});
