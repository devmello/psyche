/**
 * The client's answer to the Gateway's per-device request budget. A `rate_limited` reply carries
 * `details.retryAfterSec`: until that time (plus a little jitter, so clients do not come back
 * together) the client holds its non-urgent reads, and retries the one it was answering. Settings,
 * security and approvals calls, and every cancel or stop, are urgent and are never held, so the
 * owner can always reach their own settings and stop the agent while a chat is busy. Audit reads
 * are background reads and wait like any other.
 */

/** Methods that keep going while the device is rate limited. */
const URGENT_PREFIXES = ["settings.", "security.", "approvals."] as const;
/** A user's Stop or Cancel (`chat.cancel`, `tasks.cancel`, `voice.stop`…) is never held. */
const URGENT_SUFFIXES = [".cancel", ".stop"] as const;

/** Used when a `rate_limited` reply carries no usable `retryAfterSec`. */
export const DEFAULT_RETRY_AFTER_SEC = 5;
/** The jitter added to every pause, in ms: up to one second. */
export const MAX_JITTER_MS = 1000;

export function isUrgentMethod(method: string): boolean {
  return (
    URGENT_PREFIXES.some((prefix) => method.startsWith(prefix)) ||
    URGENT_SUFFIXES.some((suffix) => method.endsWith(suffix))
  );
}

/** `details.retryAfterSec` from a `rate_limited` reply, or the default when it is missing. */
export function retryAfterSecOf(details: unknown): number {
  const raw = (details as { retryAfterSec?: unknown } | null | undefined)?.retryAfterSec;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETRY_AFTER_SEC;
}

export class RequestGate {
  /** Epoch ms before which non-urgent requests are held. */
  private until = 0;
  private readonly clock: () => number;
  private readonly random: () => number;

  constructor(clock: () => number = Date.now, random: () => number = Math.random) {
    this.clock = clock;
    this.random = random;
  }

  /** Holds a non-urgent request until the pause (if any) is over. Urgent methods pass at once. */
  async admit(method: string): Promise<void> {
    if (isUrgentMethod(method)) return;
    await this.waitUntil(this.until);
  }

  /**
   * Records a `rate_limited` reply: non-urgent requests wait until the returned time, which is at
   * least `retryAfterSec` from now. A later reply can only push it out.
   */
  pause(retryAfterSec: number): number {
    const jitter = Math.floor(this.random() * MAX_JITTER_MS);
    const at = this.clock() + Math.round(retryAfterSec * 1000) + jitter;
    this.until = Math.max(this.until, at);
    return this.until;
  }

  /** Sleeps until `at` (epoch ms). One timer per wait; no polling. */
  async waitUntil(at: number): Promise<void> {
    for (let wait = at - this.clock(); wait > 0; wait = at - this.clock()) {
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
  }
}
