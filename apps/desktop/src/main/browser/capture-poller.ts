/**
 * The owner-control login check ticks only while some tab needs it, so an idle browser host
 * (no tabs, or only agent-held ones) wakes the main process zero times a second.
 */
export class CapturePoller {
  #timer: ReturnType<typeof setInterval> | undefined;

  readonly #everyMs: number;
  readonly #tick: () => boolean;

  /** `tick` runs a check; it returns false when nothing needs polling any more. */
  constructor(everyMs: number, tick: () => boolean) {
    this.#everyMs = everyMs;
    this.#tick = tick;
  }

  get running(): boolean {
    return this.#timer !== undefined;
  }

  /** Call whenever a tab appears or its control changes. */
  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      if (!this.#tick()) this.stop();
    }, this.#everyMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
