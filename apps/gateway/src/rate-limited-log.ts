import type { Logger } from "./log.ts";

/** Schedules `fn` after `ms`. The default timer is unref'd so it never keeps the Gateway alive. */
export type WindowScheduler = (fn: () => void, ms: number) => unknown;

export interface RateLimitedLogOptions {
  /** Length of one window: one line is logged per window, the repeats are counted. Default 60 s. */
  windowMs?: number;
  /** Clock in milliseconds. Injectable for tests. */
  now?: () => number;
  /** Timer that closes a window and emits its summary. Injectable for tests. */
  schedule?: WindowScheduler;
}

const defaultSchedule: WindowScheduler = (fn, ms) => {
  const timer = setTimeout(fn, ms) as unknown as { unref?: () => void };
  timer.unref?.();
  return timer;
};

/**
 * Logs the first occurrence of a message, then at most one summary line per window carrying how
 * many repeats were held back (`suppressed`). Metadata only, like every Gateway log line.
 */
export class RateLimitedLog {
  private windowStart: number | null = null;
  private suppressed = 0;

  private readonly logger: Logger;
  private readonly msg: string;
  private readonly options: RateLimitedLogOptions;

  constructor(logger: Logger, msg: string, options: RateLimitedLogOptions = {}) {
    this.logger = logger;
    this.msg = msg;
    this.options = options;
  }

  warn(fields: Record<string, string | number | boolean | null> = {}): void {
    const now = this.options.now ?? Date.now;
    const windowMs = this.options.windowMs ?? 60_000;
    const t = now();
    if (this.windowStart !== null && t - this.windowStart < windowMs) {
      this.suppressed += 1;
      return;
    }
    this.flush();
    this.windowStart = t;
    this.logger.log("warn", this.msg, fields);
    const schedule = this.options.schedule ?? defaultSchedule;
    schedule(() => {
      this.flush();
      this.windowStart = null;
    }, windowMs);
  }

  /** Emits the summary for the repeats held back in the current window, if there are any. */
  private flush(): void {
    if (this.suppressed === 0) return;
    this.logger.log("warn", `${this.msg} (repeats suppressed)`, { suppressed: this.suppressed });
    this.suppressed = 0;
  }
}
