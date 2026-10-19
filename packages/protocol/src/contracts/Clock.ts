/**
 * Injectable time source. Every contract implementation that expires, leases or schedules
 * something takes a `Clock` so tests can drive time (`FakeClock` in `@psyche/testing`).
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

/** Options accepted by every cancellable call. */
export interface CallOptions {
  signal?: AbortSignal;
}

/** Returned by `subscribe` / `on*` registrations; calling it removes the listener. */
export type Unsubscribe = () => void;
