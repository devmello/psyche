import { type DeviceScope, type EventName, type EventPayload, eventFrame } from "@psyche/protocol";

export type FrameSink = (frame: string) => void;

/** `events.subscribe` filters (data model §11); absent fields match everything. */
export interface EventFilter {
  /** Event names or prefix patterns ending in `*`, e.g. `chat.*`. */
  events?: string[];
  threadIds?: string[];
}

/**
 * Scope a device needs to receive each event. Pairing and device events are admin-only;
 * `gateway.shutdown` reaches every paired connection (`null`). Everything else needs
 * `operator.read`, so node-only devices receive nothing but the shutdown notice.
 */
const EVENT_SCOPE: Partial<Record<EventName, DeviceScope | null>> = {
  "device.updated": "operator.admin",
  "pairing.requested": "operator.admin",
  "gateway.shutdown": null,
};

export function eventScope(event: EventName): DeviceScope | null {
  const scope = EVENT_SCOPE[event];
  return scope === undefined ? "operator.read" : scope;
}

interface Subscriber {
  scopes: readonly DeviceScope[];
  filter: EventFilter | null;
}

function matches(filter: EventFilter | null, event: string, threadId: string | undefined): boolean {
  if (filter === null) return true;
  if (filter.events !== undefined) {
    const ok = filter.events.some((p) =>
      p.endsWith("*") ? event.startsWith(p.slice(0, -1)) : p === event,
    );
    if (!ok) return false;
  }
  if (filter.threadIds !== undefined && threadId !== undefined) {
    return filter.threadIds.includes(threadId);
  }
  return true;
}

/**
 * Event bus with `seq` and `stateVersion` (architecture §11, data model §11).
 * `seq` orders events within one Gateway process; `stateVersion` increases on every persisted
 * mutation and survives restarts (seeded from the database). Events are not replayed: a client
 * that sees a gap refreshes using `stateVersion`.
 */
export class EventBus {
  #seq = 0;
  #stateVersion: number;
  readonly #subscribers = new Map<FrameSink, Subscriber>();
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

  subscribe(scopes: readonly DeviceScope[], sink: FrameSink): () => void {
    this.#subscribers.set(sink, { scopes, filter: null });
    return () => this.#subscribers.delete(sink);
  }

  /** Updates a subscriber's scopes (the owner changed or narrowed them). */
  setScopes(sink: FrameSink, scopes: readonly DeviceScope[]): void {
    const sub = this.#subscribers.get(sink);
    if (sub) sub.scopes = scopes;
  }

  /** Replaces a subscriber's filter (`events.subscribe`); `null` = everything its scopes allow. */
  setFilter(sink: FrameSink, filter: EventFilter | null): void {
    const sub = this.#subscribers.get(sink);
    if (sub) sub.filter = filter;
  }

  /**
   * Publishes to every subscriber holding the event's scope whose filter matches. `threadId`
   * is the thread the event belongs to, for `threadIds` filters.
   */
  publish<E extends EventName>(event: E, payload: EventPayload<E>, threadId?: string): void {
    this.#seq += 1;
    const requiredScope = eventScope(event);
    const frame = JSON.stringify(eventFrame(event, payload, this.#seq, this.#stateVersion));
    for (const [sink, sub] of this.#subscribers) {
      if (requiredScope !== null && !sub.scopes.includes(requiredScope)) continue;
      if (!matches(sub.filter, event, threadId)) continue;
      sink(frame);
    }
  }
}
