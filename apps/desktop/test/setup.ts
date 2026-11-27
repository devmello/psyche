import { createI18n, setActiveI18n, setDefaultTimeZone } from "@psyche/ui";

// Stable formats for assertions: US English in UTC (the app follows the owner's region and clock).
setDefaultTimeZone("UTC");
setActiveI18n(createI18n({ locale: "en-US" }));

/**
 * happy-dom's `element.animate()` rejects `finished` with an unhandled AbortError when an
 * animation is cancelled (an exiting pane or sidebar unmounting). Without it Motion falls back to
 * its own animation loop, as in jsdom (packages/ui's tests).
 */
if (typeof Element !== "undefined") {
  delete (Element.prototype as { animate?: unknown }).animate;
}
