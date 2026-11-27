import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";
import { clearAllDrafts } from "../src/chat/composer-drafts.ts";
import { resetAttachmentScopes } from "../src/chat/useAttachments.ts";
// Every language and platform table in memory: tests format in several, synchronously.
import "../src/i18n/register-all.ts";
import { createI18n, setActiveI18n, setDefaultTimeZone } from "../src/i18n/core.ts";

// findBy* and waitFor give up after 1 s by default; on a loaded CI runner widget and connector
// screens took longer and failed at random (2026-11-03). testTimeout is 30 s (vitest.config.ts).
configure({ asyncUtilTimeout: 5_000 });

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

// jsdom has no 2D canvas; the memory map checks for a missing context and draws nothing.
const nativeGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function getContext(
  this: HTMLCanvasElement,
  type: string,
  ...rest: unknown[]
) {
  if (type === "2d") return null;
  return (nativeGetContext as (...a: unknown[]) => unknown).call(this, type, ...rest);
} as typeof HTMLCanvasElement.prototype.getContext;

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
  // Composer drafts and chips are kept per thread for the session; a test starts clean.
  resetAttachmentScopes();
  clearAllDrafts();
});
