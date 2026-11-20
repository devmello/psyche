import { type Automation, PsycheError, type WorkflowEvent } from "@psyche/protocol";
import { spacesHandlers } from "../spaces/handlers.ts";
import { checkWidgetBindings } from "../widgets/bindings.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";
import { SpaceTrackers, spaceTrackerHandlers, toolReader } from "./space-trackers.ts";
import { widgetStoreFor } from "./widgets.ts";

/** The scheduler as Spaces uses it: pause and resume an automation, and read it back. */
export interface SpacesScheduler {
  update(id: string, patch: { enabled: boolean }): Promise<unknown>;
  get(id: string): Promise<Automation | undefined>;
  /** Taps published workflow events (mail, calendar, recording) for the trackers. No run starts. */
  onWorkflowEvent?(listener: (event: WorkflowEvent) => void): () => void;
  /** The owner's Refresh on an agent tracker: one run of its automation. */
  runNow?(id: string): Promise<unknown>;
}

/**
 * Late binding for the trackers: the mail poll, the calendar watch and the folder watcher are
 * composed before Spaces, and ask it whether anything listens.
 */
export interface SpaceTrackersRef {
  current?: SpaceTrackers | undefined;
}

type Lookup = Parameters<typeof toolReader>[0];

/**
 * Spaces (docs/design/spaces-2026.md): the `spaces.*` handlers over the Gateway's own database.
 * Archiving pauses a Space's automations through the scheduler, so their next run is recomputed
 * when the Space is restored. With `services`, also the shelf: `spaces.trackers.*`, `spaces.open`
 * and the free signals that keep query trackers current (no model call, section 6.3).
 */
export function composeSpaces(deps: {
  scheduler: SpacesScheduler;
  services?: ComposeServices;
  trackers?: SpaceTrackersRef;
  /** The connector tools the calendar, reminders and mail queries read (read-only ones only). */
  tools?: Lookup | undefined;
}): ComposedPart {
  const { scheduler, services } = deps;
  const base = spacesHandlers({
    automations: {
      setEnabled: (id, enabled) => scheduler.update(id, { enabled }),
      get: (id) => scheduler.get(id),
    },
  });
  if (services === undefined) return { handlers: base };

  const read =
    deps.tools === undefined
      ? undefined
      : toolReader(deps.tools, (callId, signal) => ({
          callId,
          threadId: "system:space-trackers",
          runId: "space-trackers",
          taint: true,
          permissionMode: "balanced",
          mode: "unattended",
          signal,
          onUpdate: () => {},
        }));
  const engine = new SpaceTrackers({
    db: services.db,
    widgets: widgetStoreFor(services),
    publish: (event, payload, threadId) => services.publish(event, payload, threadId),
    // The same check a chat widget gets; a template or a shelved widget passes its Space.
    bindings: (root, threadId, spaceId) =>
      checkWidgetBindings(services.db, root, threadId, spaceId),
    read,
    now: () => services.clock.now(),
    onError: (err) =>
      services.logger?.log("warn", "a Space tracker refresh failed", {
        code: PsycheError.from(err).code,
      }),
    ...(scheduler.runNow === undefined
      ? {}
      : { runAgent: (id: string) => (scheduler.runNow as (id: string) => Promise<unknown>)(id) }),
  });
  if (deps.trackers !== undefined) deps.trackers.current = engine;
  let unsubscribe: Array<() => void> = [];
  return {
    handlers: { ...base, ...spaceTrackerHandlers(engine) },
    start: (gw) => {
      unsubscribe.push(
        gw.bus.subscribe(["operator.read"], (frame) => {
          let f: {
            event?: string;
            payload?: { id?: string; spaceId?: string; changed?: string[] };
          };
          try {
            f = JSON.parse(frame);
          } catch {
            return;
          }
          if (f.event === "memory.entity.updated" && typeof f.payload?.id === "string") {
            engine.signal({ kind: "memory", entityId: f.payload.id });
          } else if (
            f.event === "space.updated" &&
            f.payload?.changed?.includes("archived") === true &&
            typeof f.payload.spaceId === "string"
          ) {
            const row = services.db.sqlite
              .prepare("SELECT archived_at FROM spaces WHERE id = ?")
              .get(f.payload.spaceId) as { archived_at: string | null } | undefined;
            if (row?.archived_at != null) engine.freezeShelf(f.payload.spaceId);
          }
        }),
      );
      unsubscribe.push(widgetStoreFor(services).onPatched((w) => engine.notePatched(w.id)));
      const off = scheduler.onWorkflowEvent?.((event) => engine.signal({ kind: "event", event }));
      if (off !== undefined) unsubscribe.push(off);
    },
    stop: () => {
      for (const u of unsubscribe) u();
      unsubscribe = [];
      engine.dispose();
      if (deps.trackers?.current === engine) deps.trackers.current = undefined;
    },
  };
}
