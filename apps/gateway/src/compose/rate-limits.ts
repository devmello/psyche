import type { HashChainAuditLog } from "@psyche/audit";
import type { Clock } from "@psyche/protocol";
import type { Logger } from "../log.ts";
import { RateLimiter } from "../rate-limit.ts";

/** `gateway.rateLimits` in config.json (security §10 "Rate limits"). Per minute; at least 1. */
export interface RateLimitSettings {
  /** Inbound chat messages per sender (channel + sender id), before any policy runs. */
  inboundChatPerMinute: number;
  /** `web_fetch` calls per Task (per thread for interactive turns). */
  fetchPerMinute: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitSettings = {
  inboundChatPerMinute: 30,
  fetchPerMinute: 60,
};

const WINDOW_MS = 60_000;
/** Sweep idle keys after this many admissions, so one-off senders do not pile up. */
const SWEEP_EVERY = 1024;

/**
 * One sliding-window limit with an audit trail: the first refusal per key and window is
 * appended as `rate_limit.exceeded`; later refusals in the same window are only counted, so a
 * flood cannot flood the audit log as well.
 */
export class AuditedLimit {
  readonly name: string;
  readonly perMinute: number;
  readonly #limiter: RateLimiter;
  readonly #audit: Pick<HashChainAuditLog, "append">;
  readonly #now: () => number;
  readonly #logger: Logger | undefined;
  /** key → end of the window its refusal was audited in. */
  readonly #audited = new Map<string, number>();
  #admissions = 0;

  constructor(
    name: string,
    perMinute: number,
    deps: { audit: Pick<HashChainAuditLog, "append">; clock: Clock; logger?: Logger },
  ) {
    this.name = name;
    this.perMinute = perMinute;
    this.#now = () => deps.clock.now();
    this.#limiter = new RateLimiter(perMinute, WINDOW_MS, this.#now);
    this.#audit = deps.audit;
    this.#logger = deps.logger;
  }

  /** Records and admits one event for `key`, or refuses it (and audits the first refusal). */
  admit(key: string, data: Record<string, string> = {}): boolean {
    if (++this.#admissions % SWEEP_EVERY === 0) this.#sweep();
    if (this.#limiter.allowed(key)) {
      this.#limiter.record(key);
      return true;
    }
    const now = this.#now();
    const until = this.#audited.get(key);
    if (until === undefined || until <= now) {
      this.#audited.set(key, now + WINDOW_MS);
      this.#logger?.log("warn", "rate_limit.exceeded", {
        limit: this.name,
        perMinute: this.perMinute,
      });
      void this.#audit
        .append({
          kind: "rate_limit.exceeded",
          actor: { type: "system" },
          data: { limit: this.name, perMinute: this.perMinute, ...data },
        })
        .catch(() => undefined);
    }
    return false;
  }

  #sweep(): void {
    this.#limiter.sweep();
    const now = this.#now();
    for (const [key, until] of this.#audited) if (until <= now) this.#audited.delete(key);
  }
}

export interface ComposeRateLimits {
  readonly inboundChat: AuditedLimit;
  readonly fetch: AuditedLimit;
}

export function createRateLimits(
  settings: Partial<RateLimitSettings> | undefined,
  deps: { audit: Pick<HashChainAuditLog, "append">; clock: Clock; logger?: Logger },
): ComposeRateLimits {
  const s = { ...DEFAULT_RATE_LIMITS, ...settings };
  return {
    inboundChat: new AuditedLimit("inbound_chat", s.inboundChatPerMinute, deps),
    fetch: new AuditedLimit("fetch", s.fetchPerMinute, deps),
  };
}
