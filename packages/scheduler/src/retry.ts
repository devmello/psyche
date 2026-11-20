/**
 * Transient model-provider errors and the retry schedule for scheduled runs. A run that fails
 * with one of these (HTTP 429, 500, 502, 503, 504, 529 or the provider's "overloaded" error) waits
 * 1, 5 and 15 minutes and tries again, up to three times. A run that already took a side-effecting
 * step is never retried, and neither is an auth or request error.
 */

/** The backoff before retry 1, 2 and 3. */
export const RETRY_BACKOFF_MS = [60_000, 300_000, 900_000] as const;
export const MAX_RETRIES = RETRY_BACKOFF_MS.length;
/** Jitter adds up to this share of the backoff, so runs that failed together do not retry together. */
export const RETRY_JITTER = 0.2;

const NON_TRANSIENT =
  /^\s*(400|401|403|404)\b|authentication_error|permission_error|invalid_request_error|not_found_error|invalid api key|unauthorized/i;
const TRANSIENT_STATUS =
  /(?:^|\b(?:http|status(?:\s*code)?)\b["']?\s*[:=]?\s*)(429|500|502|503|504|529)\b/i;
const TRANSIENT_TYPE = /overloaded|rate_limit_error/i;

/** True when the message is a provider error worth retrying later (never an auth or 400 error). */
export function isTransientModelError(message: string): boolean {
  if (NON_TRANSIENT.test(message)) return false;
  return TRANSIENT_STATUS.test(message) || TRANSIENT_TYPE.test(message);
}

/**
 * The wait before retry number `retry` (1-based): its backoff plus up to `RETRY_JITTER` of it.
 * `random` returns a number in [0, 1) and is injected for tests.
 */
export function retryDelayMs(retry: number, random: () => number = Math.random): number {
  const base = RETRY_BACKOFF_MS[retry - 1];
  if (base === undefined) throw new RangeError(`no retry number ${retry}`);
  return base + Math.floor(random() * base * RETRY_JITTER);
}
