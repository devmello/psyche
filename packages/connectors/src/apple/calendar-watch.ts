import type { AppleHelper } from "./connector.ts";

/** One debounced `calendar.changed` event from the helper (`AppleCalendarChangedEvent`). */
export interface CalendarChange {
  at: string;
  coalesced: number;
}

export interface CalendarWatchOptions {
  /** The Host's helper (Mac, or Windows with classic Outlook), or undefined while it is away. */
  helper(): AppleHelper | undefined;
  onChange(change: CalendarChange): void;
  /** Whether anything listens (default: always). Nothing listening, nothing is subscribed. */
  wanted?: () => Promise<boolean>;
  /** Wait before (re)subscribing, after a stream ends or while no helper serves it (30 s). */
  retryMs?: number;
  /** The longest wait while streams keep ending right away (10 min). */
  maxRetryMs?: number;
  /** Injected in tests. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  onError?: (error: { code: string; message: string }) => void;
}

/** The longest a timer can wait: the stream is held open until the helper ends it. */
const OPEN = 2_147_483_647;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function changeOf(data: unknown): CalendarChange | undefined {
  const d = data as { type?: unknown; at?: unknown; coalesced?: unknown } | null;
  if (d === null || typeof d !== "object" || d.type !== "calendar.changed") return undefined;
  if (typeof d.at !== "string" || Number.isNaN(Date.parse(d.at))) return undefined;
  return { at: d.at, coalesced: typeof d.coalesced === "number" ? d.coalesced : 1 };
}

/**
 * Keeps one `calendar.watch` subscription open on the Host's helper and reports its debounced
 * changes. The stream ends when the helper goes away or, on Windows, when Outlook quits (the
 * watch hangs off Outlook's item events): then it subscribes again after `retryMs`, backing off
 * while streams keep ending at once, so a calendar automation keeps firing after Outlook or the
 * helper restarts.
 */
export class CalendarWatch {
  readonly #o: CalendarWatchOptions;
  #ctl: AbortController | undefined;
  #loop: Promise<void> | undefined;

  constructor(options: CalendarWatchOptions) {
    this.#o = options;
  }

  start(): void {
    if (this.#ctl !== undefined) return;
    const ctl = new AbortController();
    this.#ctl = ctl;
    this.#loop = this.#run(ctl.signal);
  }

  async stop(): Promise<void> {
    this.#ctl?.abort();
    await this.#loop;
    this.#ctl = undefined;
    this.#loop = undefined;
  }

  async #run(signal: AbortSignal): Promise<void> {
    const retry = this.#o.retryMs ?? 30_000;
    const max = this.#o.maxRetryMs ?? 600_000;
    const wait = this.#o.wait ?? sleep;
    const now = this.#o.now ?? Date.now;
    let delay = retry;
    while (!signal.aborted) {
      const h = this.#o.helper();
      const serves = h?.capabilities.includes("calendar.watch") === true;
      const wanted =
        serves && (await (this.#o.wanted?.() ?? Promise.resolve(true)).catch(() => false));
      if (h !== undefined && wanted) {
        const started = now();
        const res = await h
          .invoke(
            "calendar.watch",
            {},
            {
              signal,
              timeoutMs: OPEN,
              onEvent: (data) => {
                const change = changeOf(data);
                if (change !== undefined) this.#o.onChange(change);
              },
            },
          )
          .catch((err: unknown) => ({
            ok: false as const,
            error: { code: "internal", message: String(err) },
          }));
        if (signal.aborted) return;
        if (!res.ok && res.error !== undefined) this.#o.onError?.(res.error);
        // A stream that lasted resets the backoff; one that ended at once doubles it.
        delay = now() - started >= retry ? retry : Math.min(delay * 2, max);
      } else {
        delay = retry;
      }
      await wait(delay, signal);
    }
  }
}
