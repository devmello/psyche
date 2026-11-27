import { type DeviceScope, type EventName, type EventPayload, eventFrame } from "@psyche/protocol";
import type { Reader } from "./message-scrub.ts";
import { redactMcpServers } from "./redact.ts";

export type FrameSink = (frame: string) => void;

/**
 * An in-process listener (`EventBus.tap`). The payload is the object the publisher passed, read
 * as the least trusted reader would read it (see `tap`): treat it as read-only.
 */
export type TapListener = (event: EventName, payload: unknown, meta: TapMeta) => void;

export interface TapMeta {
  /** The thread the publish named, when it named one. */
  threadId?: string;
  stateVersion: number;
}

export interface TapOptions {
  /** Scopes the tap reads with, like `subscribe`'s; default `["operator.read"]`. */
  scopes?: readonly DeviceScope[];
}

interface Tap {
  names: Set<string>;
  prefixes: string[];
  all: boolean;
  scopes: readonly DeviceScope[];
  fn: TapListener;
}

const TAP_DEFAULT_SCOPES: readonly DeviceScope[] = ["operator.read"];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as object)) deepFreeze(v);
  }
  return value;
}

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
  // `promise.updated` is operator.read, like `promises.list` it mirrors: every subscriber gets the
  // promise as `promise-scrub.ts` personalises it (SCRUBBED_EVENTS below), and none for a hidden
  // one. It was operator.admin until that personaliser landed (promise ledger W5).
  "gateway.shutdown": null,
};

/**
 * Events whose payload names the owner's third-party text (a promise, a loop's quoted sentence).
 * They are never sent as the shared frame: each subscriber gets the personalizer's answer, and a
 * bus with no personalizer, or one that answers `undefined`, sends these to nobody (fail closed).
 */
export const SCRUBBED_EVENTS: ReadonlySet<EventName> = new Set<EventName>([
  "promise.updated",
  "memory.loop.updated",
  // Run-trace steps carry tool previews: the core scrub (`run-trace/viewer-scrub.ts`) answers.
  "run.step",
]);

/** A core per-subscriber scrub the Gateway itself installs (`EventBus.setCoreScrub`). */
export type CoreScrub = (payload: unknown, reader: Reader) => unknown;

/** What a personalizer returns to say: this subscriber gets no frame for this event. */
export const SKIP_EVENT = Symbol("skip-event");

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
  /** The thread the publish named (`publish`'s third argument), whatever the payload holds. */
  threadId?: string,
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
  readonly #taps: Tap[] = [];
  /** Event name -> the taps that want it; cleared whenever a tap is added or removed. */
  readonly #tapIndex = new Map<string, Tap[]>();
  readonly #freezeTaps: boolean;
  readonly #onTapError: ((event: string, err: unknown) => void) | undefined;

  constructor(
    initialStateVersion: number,
    persistVersion: (v: number) => void,
    options: {
      /** Hand taps a deep-frozen copy so a tap that mutates its payload fails (tests, dev). */
      freezeTaps?: boolean;
      onTapError?: (event: string, err: unknown) => void;
    } = {},
  ) {
    this.#stateVersion = initialStateVersion;
    this.#persistVersion = persistVersion;
    this.#freezeTaps = options.freezeTaps === true;
    this.#onTapError = options.onTapError;
  }

  /**
   * An in-process listener for a part of the Gateway: it gets the payload object itself, with no
   * serialization and no `seq`, and only for the event names it asked for (exact names, prefixes
   * ending in `*`, or `"*"`). Scope rules apply as for `subscribe`.
   *
   * It reads as a subscriber with no identity always did: the fork-hidden filter, the
   * personalizer and the core scrub run for the least trusted reader, once per event (not per
   * tap), and a `SCRUBBED_EVENTS` event nobody personalised for it is not delivered. The payload
   * is shared with the publisher and other taps: never mutate it. A tap that throws is skipped
   * and does not stop delivery to the others.
   */
  tap(events: readonly string[] | "*", fn: TapListener, options: TapOptions = {}): () => void {
    const names = new Set<string>();
    const prefixes: string[] = [];
    let all = events === "*";
    if (events !== "*") {
      for (const e of events) {
        if (e === "*") all = true;
        else if (e.endsWith("*")) prefixes.push(e.slice(0, -1));
        else names.add(e);
      }
    }
    const tap: Tap = { names, prefixes, all, scopes: options.scopes ?? TAP_DEFAULT_SCOPES, fn };
    this.#taps.push(tap);
    this.#tapIndex.clear();
    return () => {
      const i = this.#taps.indexOf(tap);
      if (i >= 0) this.#taps.splice(i, 1);
      this.#tapIndex.clear();
    };
  }

  #tapsFor(event: string): Tap[] {
    let list = this.#tapIndex.get(event);
    if (list === undefined) {
      list = this.#taps.filter(
        (t) => t.all || t.names.has(event) || t.prefixes.some((p) => event.startsWith(p)),
      );
      this.#tapIndex.set(event, list);
    }
    return list;
  }

  /** What a Gateway part (no identity) may read of this event, or `SKIP_EVENT`. */
  #payloadForReader(
    event: EventName,
    payload: unknown,
    scopes: readonly DeviceScope[],
    threadId: string | undefined,
  ): unknown {
    let own = this.#personalizer?.(
      event,
      payload,
      { deviceId: null, scopes, reader: NO_READER },
      threadId,
    );
    if (own === SKIP_EVENT) return SKIP_EVENT;
    if (own === undefined) {
      const core = this.#coreScrubs.get(event);
      if (core !== undefined) own = core(payload, NO_READER);
      if (own === SKIP_EVENT) return SKIP_EVENT;
    }
    if (own === undefined && SCRUBBED_EVENTS.has(event)) return SKIP_EVENT;
    return own === undefined ? payload : own;
  }

  #deliverToTaps(event: EventName, payload: unknown, threadId: string | undefined): void {
    const taps = this.#tapsFor(event);
    if (taps.length === 0) return;
    const requiredScope = eventScope(event);
    // One answer per distinct scope list, not per tap.
    const answers = new Map<readonly DeviceScope[], unknown>();
    for (const tap of taps) {
      if (requiredScope !== null && !tap.scopes.includes(requiredScope)) continue;
      let answer: unknown;
      if (answers.has(tap.scopes)) answer = answers.get(tap.scopes);
      else {
        try {
          answer = this.#payloadForReader(event, payload, tap.scopes, threadId);
        } catch (err) {
          // A scrub that throws delivers nothing (fail closed).
          this.#reportTapError(event, err);
          answer = SKIP_EVENT;
        }
        answers.set(tap.scopes, answer);
      }
      if (answer === SKIP_EVENT) continue;
      const meta: TapMeta = { stateVersion: this.#stateVersion };
      if (threadId !== undefined) meta.threadId = threadId;
      try {
        let given = answer;
        if (this.#freezeTaps) {
          try {
            given = deepFreeze(structuredClone(answer));
          } catch {
            given = answer;
          }
        }
        const out = tap.fn(event, given, meta) as unknown;
        if (out instanceof Promise) out.catch((err) => this.#reportTapError(event, err));
      } catch (err) {
        this.#reportTapError(event, err);
      }
    }
  }

  #reportTapError(event: string, err: unknown): void {
    try {
      this.#onTapError?.(event, err);
    } catch {
      // Reporting must not break delivery either.
    }
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
    this.#deliverToTaps(event, payload, threadId);
    const requiredScope = eventScope(event);
    // The frame around a payload is the same for every viewer except `seq`: serialize the shared
    // payload once and splice each viewer's own `seq` in. A personalised payload is serialized
    // once per distinct object the personalizer returns.
    const serialized = new Map<unknown, { head: string; tail: string } | null>();
    const stateVersion = this.#stateVersion;
    for (const [sink, sub] of this.#subscribers) {
      if (requiredScope !== null && !sub.scopes.includes(requiredScope)) continue;
      if (!matches(sub.filter, event, threadId)) continue;
      let own = this.#personalizer?.(
        event,
        payload,
        { deviceId: sub.deviceId, scopes: sub.scopes, reader: sub.reader },
        threadId,
      );
      // A skipped event leaves no gap in this subscriber's own `seq`.
      if (own === SKIP_EVENT) continue;
      // The composition root had nothing to add: the Gateway's own scrub for this event answers.
      if (own === undefined) {
        const core = this.#coreScrubs.get(event);
        if (core !== undefined) own = core(payload, sub.reader);
        if (own === SKIP_EVENT) continue;
      }
      if (own === undefined && SCRUBBED_EVENTS.has(event)) continue;
      sub.seq += 1;
      const body = own === undefined ? payload : (own as EventPayload<E>);
      let parts = serialized.get(body);
      if (parts === undefined) {
        const json = JSON.stringify(body === undefined ? null : body);
        parts =
          json === undefined
            ? null
            : {
                head: `{"type":"event","event":${JSON.stringify(event)},"payload":${json},"seq":`,
                tail: `,"stateVersion":${stateVersion}}`,
              };
        serialized.set(body, parts);
      }
      sink(
        parts === null
          ? JSON.stringify(eventFrame(event, body, sub.seq, stateVersion))
          : `${parts.head}${sub.seq}${parts.tail}`,
      );
    }
  }

  #personalizer: EventPersonalizer | null = null;
  readonly #coreScrubs = new Map<EventName, CoreScrub>();

  /**
   * Installs the Gateway's own scrub for a `SCRUBBED_EVENTS` event (`run.step`): it answers for
   * each subscriber the composition root's personalizer left alone. Without one, nobody gets it.
   */
  setCoreScrub(event: EventName, fn: CoreScrub): void {
    this.#coreScrubs.set(event, fn);
  }

  /** Installs the per-connection payload hook (the composition root's answer-token delivery). */
  setPersonalizer(fn: EventPersonalizer | null): void {
    this.#personalizer = fn;
  }

  /**
   * Delivers an event to one device's connections only (read-aloud audio, dictation segments:
   * they belong to the device that asked). Scope and `events.subscribe` filters still apply.
   */
  publishToDevice<E extends EventName>(deviceId: string, event: E, payload: EventPayload<E>): void {
    // These are personalised per subscriber in `publish`; a direct send would skip the scrub.
    if (SCRUBBED_EVENTS.has(event)) return;
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
