import { type EventName, type EventPayload, eventFrame } from "@psyche/protocol";

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
  readonly #subscribers = new Set<FrameSink>();
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

  subscribe(sink: FrameSink): () => void {
    this.#subscribers.add(sink);
    return () => this.#subscribers.delete(sink);
  }

  publish<E extends EventName>(event: E, payload: EventPayload<E>): void {
    this.#seq += 1;
    const frame = JSON.stringify(eventFrame(event, payload, this.#seq, this.#stateVersion));
    for (const sink of this.#subscribers) sink(frame);
  }
}
