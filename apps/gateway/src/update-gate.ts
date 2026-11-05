/**
 * The Gateway's door for an app update (`gateway.prepareUpdate`; updates design §2.2).
 *
 * Before the desktop swaps the app, the Gateway stops taking on new work, lets what is running
 * finish or reach a checkpoint, and says so. The gate is the "stops taking on new work" part:
 *
 * - `open`: normal service.
 * - `draining`: no new chat turn and no new task is started. Messages sent to a chat that is
 *   already busy still queue (they run after the restart); steering a running turn, answering
 *   approvals and cancelling all still work.
 * - `ready`: draining, and the wait is over; the desktop may stop the Gateway now.
 *
 * It never stays closed on its own account: if no update follows within the timeout (the owner
 * changed their mind, the desktop crashed), the gate opens again and service resumes. Asking
 * again moves the deadline.
 */

export type UpdateGateState = "open" | "draining" | "ready";

export interface UpdateGateOptions {
  now?: () => number;
  /** Test hook; defaults to an unref'd `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const DEFAULT_UPDATE_TIMEOUT_MS = 120_000;
export const MIN_UPDATE_TIMEOUT_MS = 5_000;
export const MAX_UPDATE_TIMEOUT_MS = 600_000;
/** However often it is asked again, the gate is never held shut longer than this in one go. */
export const MAX_CLOSED_TOTAL_MS = 900_000;

export class UpdateGate {
  #state: UpdateGateState = "open";
  #deadline: number | null = null;
  /** When the gate first closed in this stretch; extensions are capped from here. */
  #since: number | null = null;
  #timer: unknown;
  readonly #now: () => number;
  readonly #set: (fn: () => void, ms: number) => unknown;
  readonly #clear: (handle: unknown) => void;
  readonly #reopened = new Set<(why: "cancelled" | "timeout") => void>();

  constructor(options: UpdateGateOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#set =
      options.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref();
        return t;
      });
    this.#clear = options.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  get state(): UpdateGateState {
    return this.#state;
  }

  /** When the gate opens by itself if nothing follows, epoch ms; null while open. */
  get deadline(): number | null {
    return this.#deadline;
  }

  /** Whether new chat turns and tasks may start. */
  accepting(): boolean {
    return this.#state === "open";
  }

  /** Stops accepting new work for `timeoutMs`; calling it again moves the deadline. */
  close(timeoutMs: number): void {
    const ms = Math.min(MAX_UPDATE_TIMEOUT_MS, Math.max(MIN_UPDATE_TIMEOUT_MS, timeoutMs));
    const now = this.#now();
    if (this.#timer !== undefined) this.#clear(this.#timer);
    if (this.#state === "open") {
      this.#state = "draining";
      this.#since = now;
    }
    // Asking again moves the deadline, but a caller that keeps asking cannot hold the door shut
    // forever: the total is capped from the first time it closed.
    const cap = (this.#since ?? now) + MAX_CLOSED_TOTAL_MS;
    this.#deadline = Math.min(now + ms, cap);
    this.#timer = this.#set(() => this.#open("timeout"), Math.max(0, this.#deadline - now));
  }

  /** The wait is over and the Gateway can be stopped. Only from `draining`. */
  markReady(): boolean {
    if (this.#state !== "draining") return false;
    this.#state = "ready";
    return true;
  }

  /** Opens the gate now (the owner cancelled, or the update failed). */
  cancel(): boolean {
    return this.#open("cancelled");
  }

  /** Called when service resumes, by cancel or timeout (queued work starts again). */
  onReopen(fn: (why: "cancelled" | "timeout") => void): () => void {
    this.#reopened.add(fn);
    return () => this.#reopened.delete(fn);
  }

  #open(why: "cancelled" | "timeout"): boolean {
    if (this.#timer !== undefined) this.#clear(this.#timer);
    this.#timer = undefined;
    this.#deadline = null;
    this.#since = null;
    if (this.#state === "open") return false;
    this.#state = "open";
    for (const fn of this.#reopened) {
      try {
        fn(why);
      } catch {
        // Resuming work never fails because one listener did.
      }
    }
    return true;
  }
}

/**
 * Counts of work the Gateway cannot see in its own tables, supplied by the parts that own it
 * (`recordings`: a Mac app being recorded for teach-by-showing).
 */
export class BusySources {
  readonly #sources = new Map<string, Set<() => number>>();

  add(name: "recordings", count: () => number): () => void {
    let set = this.#sources.get(name);
    if (set === undefined) {
      set = new Set();
      this.#sources.set(name, set);
    }
    set.add(count);
    return () => set.delete(count);
  }

  count(name: "recordings"): number {
    let total = 0;
    for (const fn of this.#sources.get(name) ?? []) {
      try {
        total += Math.max(0, Math.trunc(fn()));
      } catch {
        // A source that cannot answer counts as nothing.
      }
    }
    return total;
  }
}
