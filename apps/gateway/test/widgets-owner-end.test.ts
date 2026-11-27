import { getWidget, insertWidget, openDb } from "@psyche/db";
import { describe, expect, it } from "vitest";
import type { ComposeServices } from "../src/compose/services.ts";
import { composeWidgets } from "../src/compose/widgets.ts";
import type { Gateway } from "../src/server.ts";

describe("task end freezes its widgets (gateway wiring)", () => {
  it("listens to task.updated on the bus and freezes only on a terminal status", async () => {
    const db = openDb(":memory:");
    const published: unknown[] = [];
    const w = insertWidget(db, {
      threadId: "thr_1",
      messageId: "m",
      spec: { v: 1, title: "T", fallbackText: "t", root: { id: "root", type: "text", text: "hi" } },
      taint: [],
      owner: { kind: "task", taskId: "tsk_1" },
    });
    let listener: ((frame: string) => void) | undefined;
    const gw = {
      bus: {
        tap: (_e: unknown, fn: (event: string, payload: unknown) => void) => {
          listener = (frame: string) => {
            try {
              const f = JSON.parse(frame) as { event: string; payload: unknown };
              fn(f.event, f.payload);
            } catch {
              // not a frame
            }
          };
          return () => {
            listener = undefined;
          };
        },
      },
    } as unknown as Gateway;
    const part = composeWidgets({
      db,
      tools: { register: () => () => {} },
      publish: (...a: unknown[]) => published.push(a),
    } as unknown as ComposeServices);
    await part.start?.(gw);
    const send = (status: string) =>
      listener?.(
        JSON.stringify({ event: "task.updated", payload: { task: { id: "tsk_1", status } } }),
      );
    send("running");
    expect(getWidget(db, w.id)?.state).toBe("live");
    listener?.("not json");
    send("done");
    expect(getWidget(db, w.id)?.state).toBe("frozen");
    expect(published.length).toBe(1);
    await part.stop?.();
    expect(listener).toBeUndefined();
  });
});
