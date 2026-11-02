import { insertWidget, openDb } from "@psyche/db";
import { describe, expect, it } from "vitest";
import type { ComposeServices } from "../src/compose/services.ts";
import { composeWidgets } from "../src/compose/widgets.ts";
import type { Call } from "../src/context.ts";

describe("widgets.get", () => {
  it("returns snapshots in request order and lists unknown ids as missing", () => {
    const db = openDb(":memory:");
    const w = insertWidget(db, {
      threadId: "t1",
      messageId: "m1",
      spec: {
        v: 1,
        title: "T",
        fallbackText: "fb",
        root: { id: "root", type: "text", text: "hi" },
      },
      taint: [],
      owner: { kind: "run", runId: "r1" },
    });
    const part = composeWidgets({ db } as unknown as ComposeServices);
    const run = part.handlers?.["widgets.get"]?.run as (c: Call, p: unknown) => unknown;
    expect(run({} as Call, { widgetIds: ["nope", w.id] })).toEqual({
      widgets: [w],
      missing: ["nope"],
    });
  });
});
