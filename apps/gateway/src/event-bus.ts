import { type DeviceScope, type EventName, type EventPayload, eventFrame } from "@psyche/protocol";

export type FrameSink = (frame: string) => void;

/**
 * Event bus with `seq` and `stateVersion` (architecture §11, data model §11).
 * `seq` orders events within one Gateway process; `stateVersion` increases on every persisted
 * mutation and survives restarts (seeded from the database). Events are not replayed: a client
 * that sees a gap refreshes using `stateVersion`.
 */
export class EventBus {
  #seq = 0;
  #stateVersion: number;
  readonly #subscribers = new Map<FrameSink, readonly DeviceScope[]>();
  readonly #persistVersion: (v: number) => void;

  constructor(initialStateVersion: number, persistVersion: (v: number) => void) {
    this.#stateVersion = initialStateVersion;
    this.#persistVersion = persistVersion;
  }

  get stateVersion(): number {
    return this.#stateVersion;
  }

  get seq(): number {
    return this.#seq;
  }

  /** Call inside the same transaction as a persisted mutation; returns the new version. */
  bumpStateVersion(): number {
    this.#stateVersion += 1;
    this.#persistVersion(this.#stateVersion);
    return this.#stateVersion;
  }

  /** Delivers events whose required scope the subscriber holds (`null` = every paired connection). */
  subscribe(scopes: readonly DeviceScope[], sink: FrameSink): () => void {
    this.#subscribers.set(sink, scopes);
    return () => this.#subscribers.delete(sink);
  }

  publish<E extends EventName>(
    event: E,
    payload: EventPayload<E>,
    requiredScope: DeviceScope | null,
  ): void {
    this.#seq += 1;
    const frame = JSON.stringify(eventFrame(event, payload, this.#seq, this.#stateVersion));
    for (const [sink, scopes] of this.#subscribers) {
      if (requiredScope === null || scopes.includes(requiredScope)) sink(frame);
    }
  }
}
