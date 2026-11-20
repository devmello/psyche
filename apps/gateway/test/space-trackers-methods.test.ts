import { createThread } from "@psyche/db";
import { describe, expect, it } from "vitest";
import { SpaceTrackers, spaceTrackerHandlers } from "../src/compose/space-trackers.ts";
import { spacesHandlers } from "../src/spaces/handlers.ts";
import { checkWidgetBindings } from "../src/widgets/bindings.ts";
import { WidgetStore } from "../src/widgets/store.ts";
import { adminClient, ik, startTestGateway } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON payloads read by the assertions
type J = Record<string, any>;

/** `spaces.open` and `spaces.trackers.*` through the real Gateway (docs/design/spaces-2026.md §4.2). */
describe("spaces.open and spaces.trackers.* through the real Gateway", () => {
  it("adds a template, opens, refreshes, reorders and removes", async () => {
    let engine: SpaceTrackers | undefined;
    // The handlers exist before the Gateway's database does, so they bind the engine late.
    const late = (name: string) => ({
      run: (call: never, params: never) =>
        (
          spaceTrackerHandlers(engine as SpaceTrackers)[name] as {
            run: (c: never, p: never) => unknown;
          }
        ).run(call, params),
    });
    const t = await startTestGateway({
      handlers: {
        ...spacesHandlers(),
        "spaces.trackers.add": late("spaces.trackers.add"),
        "spaces.trackers.remove": late("spaces.trackers.remove"),
        "spaces.trackers.reorder": late("spaces.trackers.reorder"),
        "spaces.trackers.refresh": late("spaces.trackers.refresh"),
        "spaces.open": late("spaces.open"),
      } as never,
    });
    const c = await adminClient(t.gateway);
    try {
      const db = t.gateway.context.db;
      createThread(db, { id: "main", kind: "main", sessionKey: "main:1" });
      const bindings = (root: unknown, threadId: string, spaceId?: string | null) =>
        checkWidgetBindings(db, root, threadId, spaceId);
      const widgets = new WidgetStore({ db, bindings, publish: () => {} });
      engine = new SpaceTrackers({ db, widgets, bindings, publish: () => {} });

      const sp = (await c.call<J>("spaces.create", { name: "Kitchen" }, ik())).space;
      const added = await c.call<J>("spaces.trackers.add", {
        spaceId: sp.id,
        template: "checklist",
      });
      expect(added.trackers).toHaveLength(1);
      expect(added.trackers[0]).toMatchObject({ kind: "query", addedBy: "template", taint: [] });
      const widgetId = added.trackers[0].widgetId as string;

      const opened = await c.call<J>("spaces.open", { spaceId: sp.id });
      expect(opened.trackers).toEqual([expect.objectContaining({ widgetId, stale: false })]);

      const second = await c.call<J>("spaces.trackers.add", {
        spaceId: sp.id,
        template: "checklist",
      });
      const ids = second.trackers.map((x: J) => x.widgetId);
      const re = await c.call<J>("spaces.trackers.reorder", {
        spaceId: sp.id,
        widgetIds: [ids[1], ids[0]],
      });
      expect(re.trackers.map((x: J) => x.widgetId)).toEqual([ids[1], ids[0]]);

      const refreshed = await c.call<J>(
        "spaces.trackers.refresh",
        { spaceId: sp.id, widgetId: ids[0] },
        ik(),
      );
      expect(refreshed.tracker.widgetId).toBe(ids[0]);

      const gone = await c.call<J>("spaces.trackers.remove", { spaceId: sp.id, widgetId: ids[0] });
      expect(gone.trackers).toHaveLength(1);
      await expect(c.call("spaces.trackers.add", { spaceId: sp.id })).rejects.toThrow(
        /widgetId or a template/,
      );
    } finally {
      c.close();
      await t.cleanup();
    }
  });
});
