/**
 * happy-dom's `element.animate()` rejects `finished` with an unhandled AbortError when an
 * animation is cancelled (an exiting pane or sidebar unmounting). Without it Motion falls back to
 * its own animation loop, as in jsdom (packages/ui's tests).
 */
if (typeof Element !== "undefined") {
  delete (Element.prototype as { animate?: unknown }).animate;
}
