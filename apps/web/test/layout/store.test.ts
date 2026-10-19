import { describe, expect, it, vi } from "vitest";
import type { KeyValueStore } from "../../src/shell/index.ts";
import {
  createLayoutStore,
  emptyLayout,
  layoutStorageKey,
  parseLayout,
} from "../../src/shell/layout/index.ts";
import { sum, testEnv } from "./helpers.ts";

function memoryStorage(seed: Record<string, string> = {}): KeyValueStore & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(seed));
  return {
    data,
    get: (key) => data.get(key) ?? null,
    set: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("LayoutStore", () => {
  it("starts empty and returns a stable reference until something changes", () => {
    const store = createLayoutStore(memoryStorage());
    const a = store.forThread("t1");
    expect(a).toEqual(emptyLayout("t1"));
    expect(store.forThread("t1")).toBe(a);
  });

  it("persists per thread under psyche.layout.v1.<threadId> and round-trips", () => {
    const storage = memoryStorage();
    const store = createLayoutStore(storage, { restorePopped: true });
    const env = testEnv();
    store.dispatch("t1", { type: "open", pane: "browser", target: "tab-1" }, env);
    store.dispatch("t1", { type: "open", pane: "terminal", placement: "split" }, env);
    store.dispatch("t1", { type: "resize", boundary: 1, delta: 40 }, env);
    store.dispatch("t1", { type: "open", pane: "files" }, env);
    store.dispatch("t1", { type: "popOut", paneId: "p_files_5" }, env);
    store.dispatch("t2", { type: "open", pane: "plan" }, env);
    expect([...storage.data.keys()].sort()).toEqual([
      layoutStorageKey("t1"),
      layoutStorageKey("t2"),
    ]);
    expect(layoutStorageKey("t1")).toBe("psyche.layout.v1.t1");

    const reloaded = createLayoutStore(storage, { restorePopped: true });
    expect(reloaded.forThread("t1")).toEqual(store.forThread("t1"));
    expect(reloaded.forThread("t2").panes.map((p) => p.pane)).toEqual(["plan"]);
  });

  it("docks popped panes again on reload by default", () => {
    const storage = memoryStorage();
    const env = testEnv();
    const store = createLayoutStore(storage);
    store.dispatch("t1", { type: "open", pane: "browser" }, env);
    store.dispatch("t1", { type: "popOut", paneId: "p_browser_1" }, env);
    expect(store.forThread("t1").popped).toEqual(["p_browser_1"]);
    const reloaded = createLayoutStore(storage).forThread("t1");
    expect(reloaded.popped).toEqual([]);
    expect(reloaded.groups.flatMap((g) => g.paneIds)).toEqual(["p_browser_1"]);
  });

  it("notifies subscribers only on change, per thread", () => {
    const store = createLayoutStore(memoryStorage());
    const env = testEnv();
    const all = vi.fn();
    const t1 = vi.fn();
    const off = store.subscribe(all);
    store.subscribeThread("t1", t1);
    store.dispatch("t1", { type: "open", pane: "browser" }, env);
    store.dispatch("t1", { type: "open", pane: "browser" }, env); // reveal: no change
    store.dispatch("t2", { type: "open", pane: "browser" }, env);
    expect(all.mock.calls).toEqual([["t1"], ["t2"]]);
    expect(t1).toHaveBeenCalledTimes(1);
    off();
    store.dispatch("t2", { type: "closeFocused" }, env);
    expect(all).toHaveBeenCalledTimes(2);
  });

  it("survives a throwing listener and a throwing storage", () => {
    const storage: KeyValueStore = {
      get: () => {
        throw new Error("blocked");
      },
      set: () => {
        throw new Error("quota");
      },
    };
    const store = createLayoutStore(storage);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const later = vi.fn();
    store.subscribe(() => {
      throw new Error("boom");
    });
    store.subscribe(later);
    const s = store.dispatch("t1", { type: "open", pane: "browser" }, testEnv());
    expect(s.panes).toHaveLength(1);
    expect(store.forThread("t1")).toBe(s);
    expect(later).toHaveBeenCalledOnce();
    err.mockRestore();
  });

  it("routes view.command to args.threadId, else the fallback thread", () => {
    const store = createLayoutStore(memoryStorage());
    const env = testEnv();
    const a = store.applyViewCommand(
      { command: "open", args: { pane: "browser", threadId: "t9" } },
      "t1",
      env,
    );
    expect(a).toMatchObject({ ok: true, threadId: "t9", paneId: "p_browser_1" });
    expect(store.forThread("t9").panes[0]?.threadId).toBe("t9");
    const b = store.applyViewCommand({ command: "close", args: { pane: "browser" } }, "t1", env);
    expect(b).toMatchObject({ ok: false, threadId: "t1", error: { code: "not_found" } });
  });

  it("replace stores a normalized copy", () => {
    const store = createLayoutStore(memoryStorage());
    store.replace("t1", { ...emptyLayout("other"), chatFraction: 7 });
    expect(store.forThread("t1")).toMatchObject({ threadId: "t1", chatFraction: 0.5 });
  });
});

describe("parseLayout", () => {
  it("falls back to an empty layout for corrupt or old JSON", () => {
    for (const json of [
      null,
      "",
      "{",
      "null",
      "[]",
      '"layout"',
      JSON.stringify({ version: 0, panes: [] }),
      JSON.stringify({ version: 1, panes: "nope" }),
      JSON.stringify({ groups: [] }),
    ]) {
      expect(parseLayout(json, "t1"), String(json)).toEqual(emptyLayout("t1"));
    }
  });

  it("drops bad panes and groups and repairs the rest", () => {
    const json = JSON.stringify({
      version: 1,
      threadId: "elsewhere",
      panes: [
        { paneId: "a", pane: "browser", target: "x", createdAt: "2026-01-01T00:00:00.000Z" },
        { paneId: "a", pane: "terminal" }, // duplicate id
        { paneId: "c", pane: "chat" }, // the chat is never a pane
        { paneId: "d", pane: "hologram" },
        { pane: "files" },
        "garbage",
        { paneId: "e", pane: "files", title: 3, taskId: "" },
        { paneId: "f", pane: "diff" },
      ],
      groups: [
        { groupId: "g1", paneIds: ["a", "ghost", "a"], activePaneId: "ghost" },
        { groupId: "g1", paneIds: ["e"], activePaneId: "e" },
        { groupId: "g3", paneIds: [] },
        42,
      ],
      sizes: [Number.NaN, "big", 1],
      focusedPaneId: "ghost",
      popped: ["f", "zzz"],
      chatFraction: -2,
    });
    const s = parseLayout(json, "t1");
    expect(s.threadId).toBe("t1");
    expect(s.panes.map((p) => p.paneId)).toEqual(["a", "e", "f"]);
    expect(s.panes[1]).toEqual({
      paneId: "e",
      pane: "files",
      target: null,
      threadId: null,
      openerPaneId: null,
      createdAt: "1970-01-01T00:00:00.000Z",
    });
    expect(s.groups.map((g) => g.paneIds)).toEqual([["a"], ["e", "f"]]);
    expect(s.groups.map((g) => g.activePaneId)).toEqual(["a", "e"]);
    expect(new Set(s.groups.map((g) => g.groupId)).size).toBe(2);
    expect(sum(s.sizes)).toBeCloseTo(1);
    expect(s.popped).toEqual([]);
    expect(s.focusedPaneId).toBeNull();
    expect(s.chatFraction).toBe(0.5);
  });

  it("keeps valid popped panes when asked", () => {
    const json = JSON.stringify({
      version: 1,
      panes: [{ paneId: "f", pane: "diff" }],
      groups: [],
      popped: ["f", "zzz"],
      chatFraction: 0.6,
    });
    const s = parseLayout(json, "t1", { restorePopped: true });
    expect(s.popped).toEqual(["f"]);
    expect(s.groups).toEqual([]);
    expect(s.chatFraction).toBe(0.6);
  });
});
