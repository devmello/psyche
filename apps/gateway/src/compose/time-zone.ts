/**
 * The Mac's time zone, re-read while the Gateway runs. Node reads the zone once and keeps it, so
 * after the owner flies somewhere "today", the daily brief and new automations would keep the old
 * zone until a restart. Changing `process.env.TZ` (setting or deleting it) makes Node detect the
 * zone again from the system (`/etc/localtime`); `refresh()` does that and reports whether it moved.
 *
 * A zone the process was started with (`TZ` in its environment) is the owner's choice and is not
 * touched.
 */
export interface SystemZoneOptions {
  env?: Record<string, string | undefined>;
  /** The zone Node reports now. Default: `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
  current?: () => string;
}

export class SystemZone {
  readonly #env: Record<string, string | undefined>;
  readonly #current: () => string;
  readonly #pinned: boolean;
  #last: string;

  constructor(options: SystemZoneOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#current = options.current ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    this.#pinned = this.#env.TZ !== undefined && this.#env.TZ !== "";
    this.#last = this.#current();
  }

  /** The zone as of the last `refresh()`. */
  get zone(): string {
    return this.#last;
  }

  /** Re-detect the system zone. `changed` is true when it differs from the last one seen. */
  refresh(): { zone: string; previous: string; changed: boolean } {
    if (!this.#pinned) delete this.#env.TZ;
    const zone = this.#current();
    const previous = this.#last;
    this.#last = zone;
    return { zone, previous, changed: zone !== previous };
  }
}
