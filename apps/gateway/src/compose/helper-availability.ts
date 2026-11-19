import { PsycheError } from "@psyche/protocol";

/**
 * Whether the Host's Psyche helper (the Mac or PC helper the desktop launches) is connected, as one
 * shared state for the Gateway. Helper-backed sources and proactive jobs ask it before they run:
 * while the helper is offline they skip quietly, and each attempt that fails with "needs the
 * helper" pushes the next attempt further out (exponential back-off, capped). A connection resets
 * the back-off at once, so they resume on reconnect. The log gets one line per state change, never
 * one per skipped cycle.
 */

export interface HelperAvailabilityStatus {
  connected: boolean;
  /** Failed attempts since the helper last connected. */
  failures: number;
  /** Epoch ms of the next allowed attempt while offline (0 when connected or not backing off). */
  retryAt: number;
  /** The helper answered the Contacts read with a missing-permission refusal (System Settings). */
  contactsDenied: boolean;
  /**
   * Two or more Host helpers are connected and none is pinned: Host features are off because
   * Psyche will not guess between them (not because no helper is running). Empty otherwise. The
   * app names them and offers "use this one" (`devices.hostHelperDeviceId`).
   */
  ambiguous: HelperCandidate[];
}

/** A Host helper the Gateway will not choose between, with what it knows to tell it apart. */
export interface HelperCandidate {
  deviceId: string;
  /** What the helper calls itself: a claim, the same for every Mac helper. */
  name: string;
  /** When the Gateway paired this device (ISO), or null. */
  pairedAt: string | null;
}

export interface HelperAvailabilityOptions {
  now?: () => number;
  log?: (level: "info" | "warn", msg: string, fields: Record<string, string | number>) => void;
  /** First back-off step after a failed attempt (default 1 minute). */
  baseMs?: number;
  /** Longest back-off (default 30 minutes). */
  maxMs?: number;
  /** Called after every change of the status (the Gateway publishes it to the app). */
  onChange?: (status: HelperAvailabilityStatus) => void;
}

const MINUTE = 60_000;

/** The setting the Gateway keeps the status in, for the app (`settings.get`). */
export const HELPER_AVAILABILITY_SETTING = "devices.helper.availability";

/** True for the error a helper-backed call throws when no Host helper offers the capability. */
export function isNeedsHelper(err: unknown): boolean {
  if (err instanceof PsycheError) {
    const reason = (err.details as { reason?: unknown } | null | undefined)?.reason;
    if (reason === "needs_helper") return true;
  }
  return err instanceof Error && /needs the Psyche helper/.test(err.message);
}

export class HelperAvailability {
  #connected: boolean;
  #failures = 0;
  #retryAt = 0;
  #contactsDenied = false;
  #ambiguous: HelperCandidate[] = [];
  readonly #now: () => number;
  readonly #log: NonNullable<HelperAvailabilityOptions["log"]>;
  readonly #baseMs: number;
  readonly #maxMs: number;
  readonly #onChange: HelperAvailabilityOptions["onChange"];

  constructor(initiallyConnected: boolean, opts: HelperAvailabilityOptions = {}) {
    this.#connected = initiallyConnected;
    this.#now = opts.now ?? Date.now;
    this.#log = opts.log ?? (() => undefined);
    this.#baseMs = opts.baseMs ?? MINUTE;
    this.#maxMs = opts.maxMs ?? 30 * MINUTE;
    this.#onChange = opts.onChange;
  }

  status(): HelperAvailabilityStatus {
    return {
      connected: this.#connected,
      failures: this.#failures,
      retryAt: this.#retryAt,
      contactsDenied: this.#contactsDenied,
      ambiguous: this.#ambiguous.map((a) => ({ ...a })),
    };
  }

  /** Whether a helper-backed read or job may run now: connected, or its back-off has passed. */
  shouldAttempt(): boolean {
    return this.#connected || this.#now() >= this.#retryAt;
  }

  /**
   * The helper's presence as the Gateway sees it now. A change logs one line; a reconnect resets
   * the back-off so the paused sources and jobs run again at their next cycle.
   */
  observe(connected: boolean): void {
    if (connected === this.#connected) return;
    this.#connected = connected;
    if (connected) {
      this.#failures = 0;
      this.#retryAt = 0;
      this.#log("info", "helper connected: helper-backed sources and jobs resume", {});
    } else {
      // The first step of back-off, so an offline helper is not probed on every cycle.
      this.#retryAt = Math.max(this.#retryAt, this.#now() + this.#baseMs);
      this.#log("warn", "helper offline: helper-backed sources and jobs are paused", {});
    }
    this.#changed();
  }

  /**
   * Records a failed helper-backed attempt. Any other error is ignored here (the caller logs it).
   * Returns true when this failure is what took the helper offline.
   */
  noteFailure(err: unknown): boolean {
    if (!isNeedsHelper(err)) return false;
    const wasConnected = this.#connected;
    this.#connected = false;
    this.#failures += 1;
    const step = Math.min(this.#maxMs, this.#baseMs * 2 ** (this.#failures - 1));
    this.#retryAt = this.#now() + step;
    if (wasConnected) {
      this.#log("warn", "helper offline: helper-backed sources and jobs are paused", {
        retryInSeconds: Math.round(step / 1000),
      });
    }
    this.#changed();
    return wasConnected;
  }

  /** The Contacts read was refused for lack of permission (or granted again). */
  setContactsDenied(denied: boolean): void {
    if (denied === this.#contactsDenied) return;
    this.#contactsDenied = denied;
    this.#changed();
  }

  /** The helpers Psyche refuses to choose between (empty when there is no such conflict). */
  setAmbiguous(helpers: HelperCandidate[]): void {
    const same =
      helpers.length === this.#ambiguous.length &&
      helpers.every((h, i) => h.deviceId === this.#ambiguous[i]?.deviceId);
    if (same) return;
    this.#ambiguous = helpers.map((h) => ({
      deviceId: h.deviceId,
      name: h.name,
      pairedAt: h.pairedAt,
    }));
    this.#changed();
  }

  #changed(): void {
    this.#onChange?.(this.status());
  }
}
