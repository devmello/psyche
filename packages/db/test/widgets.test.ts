import { describe, expect, it } from "vitest";
import {
  countPinnedWidgets,
  getWidget,
  getWidgets,
  insertWidget,
  listThreadWidgets,
  updateWidget,
} from "../src/index.ts";
import { memoryDb } from "./helpers.ts";

const spec = (title = "T") => ({
  v: 1 as const,
  title,
  fallbackText: "fb",
  root: { id: "root", type: "text", text: "hi" },
});

describe("widgets repo", () => {
  it("inserts at rev 1, live, unpinned and reads back", () => {
    const db = memoryDb();
    const w = insertWidget(db, {
      threadId: "t1",
      messageId: "m1",
      spec: spec(),
      taint: [{ sourceKind: "web" }],
      owner: { kind: "run", runId: "r1" },
    });
    expect(w).toMatchObject({
      rev: 1,
      state: "live",
      pinned: false,
      taint: [{ sourceKind: "web" }],
    });
    expect(getWidget(db, w.id)).toEqual(w);
    expect(getWidgets(db, ["nope", w.id])).toEqual([w]);
  });

  it("updates compare-and-set on rev and bumps it only for spec changes", () => {
    const db = memoryDb();
    const w = insertWidget(db, {
      threadId: "t1",
      messageId: "m1",
      spec: spec(),
      taint: [],
      owner: { kind: "run", runId: "r1" },
    });
    const w2 = updateWidget(db, w.id, 1, { spec: spec("T2") });
    expect(w2?.rev).toBe(2);
    expect(updateWidget(db, w.id, 1, { spec: spec("stale") })).toBeNull();
    const frozen = updateWidget(db, w.id, 2, { state: "frozen" });
    expect(frozen).toMatchObject({ rev: 2, state: "frozen" });
    expect(listThreadWidgets(db, "t1", { state: "live" })).toEqual([]);
    const pinned = updateWidget(db, w.id, 2, { pinned: true });
    expect(pinned?.pinned).toBe(true);
    expect(countPinnedWidgets(db)).toBe(1);
  });
});
