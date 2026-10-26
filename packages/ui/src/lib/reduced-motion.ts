/**
 * The one non-React reduced-motion read (smoothness-2026 C20). `ThemeProvider` resolves the app's
 * Reduce motion setting against the OS preference and writes the result to
 * `data-reduce-motion` on the root; this reads that, and falls back to the OS media query only
 * before a provider has run.
 */
export function documentPrefersReducedMotion(
  doc: Document | undefined = globalThis.document,
): boolean {
  if (!doc) return false;
  const setting = doc.documentElement.getAttribute("data-reduce-motion");
  if (setting === "true") return true;
  if (setting === "false") return false;
  return doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** `behavior` for `scrollIntoView` / `scrollTo`: smooth, instant under reduced motion. */
export function smoothScrollBehavior(
  doc: Document | undefined = globalThis.document,
): "auto" | "smooth" {
  return documentPrefersReducedMotion(doc) ? "auto" : "smooth";
}
