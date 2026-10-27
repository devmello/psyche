/**
 * Freeing the main window's app renderer while Psyche sits in the menu bar (owner decision
 * 2026-10-26, docs/design/lightweight-2026.md item 2). Measured: the hidden renderer holds about
 * 90 MB, and up to 110 MB more of GPU surfaces; rebuilding it on reopen takes about 0.5 s, so it
 * happens only after ten minutes hidden and a quick close and reopen stays instant.
 */
export const RELEASE_HIDDEN_AFTER_MS = 10 * 60_000;

/** The delay; dev and test runs may set PSYCHE_RELEASE_HIDDEN_MS (0 turns it off). */
export function releaseHiddenAfterMs(packaged: boolean, env: NodeJS.ProcessEnv): number {
  const raw = packaged ? undefined : env.PSYCHE_RELEASE_HIDDEN_MS;
  if (raw === undefined || raw === "") return RELEASE_HIDDEN_AFTER_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : RELEASE_HIDDEN_AFTER_MS;
}

/**
 * Runs in the app page before a release: true when any text field still holds something unsent
 * (the composer, an edit box), which a rebuilt page would lose. The renderer keeps drafts only in
 * memory. Hidden helpers (the autosizing composer's aria-hidden measuring textarea) do not count.
 */
export const HAS_UNSENT_TEXT = `[...document.querySelectorAll("textarea, input:not([type]), input[type=text], input[type=search], [contenteditable=true], [contenteditable='']")].some((e) => !e.closest("[aria-hidden=true]") && !e.disabled && !e.readOnly && ((e.value ?? e.textContent) || "").trim() !== "")`;
