import { systemTimers, type Timers } from "./worker.ts";

export interface WakeDetectorOptions {
  /**
   * Called when the wall clock ran ahead of the monotonic one: the Mac slept, or the clock was
   * set. `jumpMs` is the extra wall time that passed. Rejections are passed to `onError`.
   */
  onWake: (jumpMs: number) => void | Promise<void>;
  /** How often to look. Default 20 s. */
  intervalMs?: number;
  /** Drift (wall minus monotonic time) that counts as a jump. Default 30 s. */
  thresholdMs?: number;
  /** Wall clock. Default `Date.now`. */
  wallNow?: () => number;
  /**
   * Monotonic clock that stops while the Mac sleeps (libuv's hrtime does on macOS), so a sleep
   * shows up as drift against `wallNow`. Default `performance.now`.
   */
  monotonicNow?: () => number;
  timers?: Timers;
  onError?: (error: unknown) => void;
}

export interface WakeDetector {
  start(): void;
  stop(): void;
  /** Look now (tests, and a caller that has its own hint such as a helper event). */
  check(): void;
}

/**
 * Notices a sleep or a clock step without a platform hook. libuv timers do not advance while the
 * Mac sleeps but the wall clock does (leases, due times), so every part of the Gateway that
 * compares them must be told when they moved apart. One cheap, unref'd timer.
 */
export function createWakeDetector(options: WakeDetectorOptions): WakeDetector {
  const intervalMs = options.intervalMs ?? 20_000;
  const thresholdMs = options.thresholdMs ?? 30_000;
  const wallNow = options.wallNow ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const timers = options.timers ?? systemTimers;
  let handle: unknown;
  let running = false;
  let lastWall = wallNow();
  let lastMono = monotonicNow();

  const check = (): void => {
    const wall = wallNow();
    const mono = monotonicNow();
    const drift = wall - lastWall - (mono - lastMono);
    lastWall = wall;
    lastMono = mono;
    if (Math.abs(drift) <= thresholdMs) return;
    try {
      Promise.resolve(options.onWake(drift)).catch((e) => options.onError?.(e));
    } catch (e) {
      options.onError?.(e);
    }
  };
  const arm = (): void => {
    handle = timers.setTimeout(() => {
      check();
      if (running) arm();
    }, intervalMs);
  };
  return {
    start() {
      if (running) return;
      running = true;
      lastWall = wallNow();
      lastMono = monotonicNow();
      arm();
    },
    stop() {
      running = false;
      if (handle !== undefined) timers.clearTimeout(handle);
      handle = undefined;
    },
    check,
  };
}
