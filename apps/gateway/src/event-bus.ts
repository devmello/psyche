import { type DeviceScope, type EventName, type EventPayload, eventFrame } from "@psyche/protocol";
import type { Reader } from "./message-scrub.ts";
import { redactMcpServers } from "./redact.ts";

export type FrameSink = (frame: string) => void;

/** A `settings.changed` payload with the tool-server setting redacted (`redactMcpServers`). */
export function redactSettingsPayload(payload: unknown): unknown {
  const entries = (payload as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return payload;
  return {
    ...(payload as object),
    entries: entries.map((e: unknown) =>
      (e as { key?: unknown } | null)?.key === "mcp.servers"
        ? { ...(e as object), value: redactMcpServers((e as { value?: unknown }).value) }
        : e,
    ),
  };
}

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
  // A shell on the Host: only an admin device ever receives its output.
  "terminal.output": "operator.admin",
  "terminal.exit": "operator.admin",
  "gateway.shutdown": null,
};

export function eventScope(event: EventName): DeviceScope | null {
  const scope = EVENT_SCOPE[event];
  return scope === undefined ? "operator.read" : scope;
}

/**
 * Adds per-connection fields to an event (the subscriber's own approval answer token, issue #50).
 * Returns the payload for this subscriber, or `undefined` to send the shared frame.
 */
export type EventPersonalizer = (
  event: EventName,
  payload: unknown,
  subscriber: { deviceId: string | null; scopes: readonly DeviceScope[]; reader: Reader },
) => unknown | undefined;

interface Subscriber {
  scopes: readonly DeviceScope[];
  filter: EventFilter | null;
  /** The paired device behind the sink, for events meant for one device (`publishToDevice`). */
  deviceId: string | null;
  /** Who is behind the sink; a part of the Gateway itself reads as the least trusted. */
  reader: Reader;
  /** The last `seq` sent to this subscriber: its own count, so filtered events leave no gap. */
  seq: number;
}

const NO_READER: Reader = { role: null, desktop: false };

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
 * `seq` is per subscriber: it counts the events that subscriber was sent, so an event it was not
 * meant to receive (scope, filter, device) never shows as a gap and a client refreshes only for
 * a real loss. `stateVersion` increases on every persisted
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

  subscribe(
    scopes: readonly DeviceScope[],
    sink: FrameSink,
    deviceId: string | null = null,
    reader: Reader = NO_READER,
  ): () => void {
    this.#subscribers.set(sink, { scopes, filter: null, deviceId, reader, seq: 0 });
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
  publish<E extends EventName>(event: E, rawPayload: EventPayload<E>, threadId?: string): void {
    // No subscriber, a part of the Gateway included, is told a tool server's secrets: parts that
    // act on `mcp.servers` read the stored value, not the event.
    const payload = (
      event === "settings.changed" ? redactSettingsPayload(rawPayload) : rawPayload
    ) as EventPayload<E>;
    this.#seq += 1;
    const requiredScope = eventScope(event);
    for (const [sink, sub] of this.#subscribers) {
      if (requiredScope !== null && !sub.scopes.includes(requiredScope)) continue;
      if (!matches(sub.filter, event, threadId)) continue;
      sub.seq += 1;
      const own = this.#personalizer?.(event, payload, {
        deviceId: sub.deviceId,
        scopes: sub.scopes,
        reader: sub.reader,
      });
      sink(
        JSON.stringify(
          eventFrame(
            event,
            own === undefined ? payload : (own as EventPayload<E>),
            sub.seq,
            this.#stateVersion,
          ),
        ),
      );
    }
  }

  #personalizer: EventPersonalizer | null = null;

  /** Installs the per-connection payload hook (the composition root's answer-token delivery). */
  setPersonalizer(fn: EventPersonalizer | null): void {
    this.#personalizer = fn;
  }

  /**
   * Delivers an event to one device's connections only (read-aloud audio, dictation segments:
   * they belong to the device that asked). Scope and `events.subscribe` filters still apply.
   */
  publishToDevice<E extends EventName>(deviceId: string, event: E, payload: EventPayload<E>): void {
    this.#seq += 1;
    const requiredScope = eventScope(event);
    for (const [sink, sub] of this.#subscribers) {
      if (sub.deviceId !== deviceId) continue;
      if (requiredScope !== null && !sub.scopes.includes(requiredScope)) continue;
      if (!matches(sub.filter, event, undefined)) continue;
      sub.seq += 1;
      sink(JSON.stringify(eventFrame(event, payload, sub.seq, this.#stateVersion)));
    }
  }
}
