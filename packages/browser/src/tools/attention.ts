import { PsycheError } from "@psyche/protocol";

/**
 * Pause-when-unwatched for the browser (security §7.2 item 5, #272): on sensitive-category
 * origins (banking, brokerage, government, health, password managers, identity providers, mail
 * web UIs; the owner-editable list in the permissions policy), the agent acts only while the
 * browser pane is visible and the owner gave input in the last 5 minutes. Otherwise the call
 * fails `presence_required {reason: "awaiting_attention"}`, the same answer the Mac helper gives
 * for computer use, which the Gateway turns into parking the Task until the owner is back.
 *
 * The desktop reports visibility and input (`attention.report`); the Gateway keeps the state
 * and hands it to the browser part as `state()`.
 */
export const ATTENTION_WINDOW_MS = 5 * 60_000;

export interface AttentionState {
  /**
   * Whether the browser pane is on screen. Undefined while the desktop has not reported it
   * (server mode, an older desktop): then only the input check applies, as for computer use.
   */
  visible?: boolean;
  /** When the owner last gave input (epoch ms): keys or clicks in the app, a message, an answer. */
  lastInputAt?: number;
}

export interface AttentionGate {
  /** The tab's or target's origin is in a sensitive category. */
  isSensitive(origin: string): boolean;
  /** Undefined while nothing is known: no input, so unwatched. */
  state(): AttentionState | undefined;
  now?(): number;
  windowMs?: number;
}

/** Tools that never act on a page, or that are how the owner gets called back. */
const EXEMPT = new Set([
  "browser.tabs",
  "browser.close_tab",
  "browser.wait",
  "browser.request_control",
  "browser.stop_real_chrome",
]);

export function attentionExempt(tool: string): boolean {
  return EXEMPT.has(tool);
}

/** Throws `presence_required/awaiting_attention` when `origin` is sensitive and nobody watches. */
export function assertWatched(gate: AttentionGate, origin: string): void {
  if (!gate.isSensitive(origin)) return;
  const state = gate.state();
  const now = gate.now?.() ?? Date.now();
  const windowMs = gate.windowMs ?? ATTENTION_WINDOW_MS;
  const hidden = state?.visible === false;
  const recent = state?.lastInputAt !== undefined && now - state.lastInputAt <= windowMs;
  if (!hidden && recent) return;
  const host = (() => {
    try {
      return new URL(origin).host;
    } catch {
      return origin;
    }
  })();
  throw new PsycheError(
    "presence_required",
    `${host} is a sensitive site, so the agent acts there only while you watch the browser pane; the task waits until you are back`,
    {
      details: {
        reason: "awaiting_attention",
        origin,
        paneVisible: state?.visible ?? null,
        lastInputAt: state?.lastInputAt ?? null,
      },
      retryable: true,
    },
  );
}
