import { describe, expect, it } from "vitest";
import {
  applyLayoutAction,
  clampSizes,
  dockedPaneIds,
  emptyLayout,
  type LayoutState,
  maxGroupsFor,
  reduceLayout,
} from "../../src/shell/layout/index.ts";
import { run, sum, testEnv } from "./helpers.ts";

describe("open", () => {
  it("creates a pane with a stable generated id in the first group and focuses it", () => {
    const s = run([{ type: "open", pane: "browser" }]);
    expect(s.panes).toHaveLength(1);
    const pane = s.panes[0];
    expect(pane).toMatchObject({
      paneId: "p_browser_1",
      pane: "browser",
      target: null,
      threadId: "t1",
      openerPaneId: null,
      createdAt: "2026-10-19T09:00:00.000Z",
    });
    expect(s.groups).toEqual([
      { groupId: "g_2", paneIds: ["p_browser_1"], activePaneId: "p_browser_1" },
    ]);
    expect(s.sizes).toEqual([1]);
    expect(s.focusedPaneId).toBe("p_browser_1");
  });

  it("reveals an existing pane of the same kind and target instead of duplicating", () => {
    const env = testEnv();
    let s = run(
      [
        { type: "open", pane: "browser", target: "tab-1" },
        { type: "open", pane: "terminal" },
      ],
      env,
    );
    expect(s.groups[0]?.activePaneId).toBe("p_terminal_3");
    s = reduceLayout(s, { type: "open", pane: "browser", target: "tab-1", title: "acme" }, env);
    expect(s.panes).toHaveLength(2);
    expect(s.groups[0]?.activePaneId).toBe("p_browser_1");
    expect(s.focusedPaneId).toBe("p_browser_1");
    expect(s.panes[0]?.title).toBe("acme");
    // A different target is a different pane.
    s = reduceLayout(s, { type: "open", pane: "browser", target: "tab-2" }, env);
    expect(s.panes).toHaveLength(3);
  });

  it("returns the same state object when an action changes nothing", () => {
    const env = testEnv();
    const s = run([{ type: "open", pane: "files" }], env);
    expect(reduceLayout(s, { type: "open", pane: "files" }, env)).toBe(s);
    expect(reduceLayout(s, { type: "focus", paneId: "nope" }, env)).toBe(s);
    expect(reduceLayout(s, { type: "fitToWidth" }, env)).toBe(s);
  });

  it("accepts caller-supplied ids and reveals by id", () => {
    const env = testEnv();
    let s = run([{ type: "open", pane: "editor", paneId: "soul", target: "SOUL.md" }], env);
    expect(s.panes[0]?.paneId).toBe("soul");
    s = reduceLayout(s, { type: "open", pane: "terminal" }, env);
    s = reduceLayout(s, { type: "open", pane: "editor", paneId: "soul" }, env);
    expect(s.panes).toHaveLength(2);
    expect(s.focusedPaneId).toBe("soul");
  });

  it("never reuses the reserved chat id or a taken id", () => {
    const env = testEnv();
    env.newId = () => "1";
    let s = run([{ type: "open", pane: "browser", paneId: "chat" }], env);
    expect(s.panes[0]?.paneId).toBe("p_browser_1");
    let n = 0;
    const ids = ["1", "1", "2"];
    env.newId = () => ids[n++] ?? "z";
    s = reduceLayout(s, { type: "open", pane: "browser", target: "x" }, env);
    expect(new Set(s.panes.map((p) => p.paneId)).size).toBe(2);
  });

  it("uses artifactId as the artifact pane's target", () => {
    const env = testEnv();
    let s = run([{ type: "open", pane: "artifact", artifactId: "a1" }], env);
    s = reduceLayout(s, { type: "open", pane: "artifact", artifactId: "a2" }, env);
    s = reduceLayout(s, { type: "open", pane: "artifact", artifactId: "a1" }, env);
    expect(s.panes.map((p) => p.target)).toEqual(["a1", "a2"]);
    expect(s.focusedPaneId).toBe(s.panes[0]?.paneId);
  });

  it("open chat focuses the chat column and never creates a pane", () => {
    const env = testEnv();
    let s = run([{ type: "open", pane: "browser" }], env);
    s = reduceLayout(s, { type: "open", pane: "chat" }, env);
    expect(s.panes).toHaveLength(1);
    expect(s.focusedPaneId).toBeNull();
  });

  it("records the focused pane as the opener; focus:false leaves focus alone", () => {
    const env = testEnv();
    let s = run([{ type: "open", pane: "browser" }], env);
    s = reduceLayout(s, { type: "open", pane: "terminal" }, env);
    expect(s.panes[1]?.openerPaneId).toBe("p_browser_1");
    s = reduceLayout(s, { type: "open", pane: "files", focus: false }, env);
    expect(s.focusedPaneId).toBe("p_terminal_3");
    expect(s.groups[0]?.activePaneId).toBe("p_files_4");
  });
});

describe("split placement", () => {
  it("makes a second group at ≥ 1440 px", () => {
    const s = run([
      { type: "open", pane: "browser" },
      { type: "open", pane: "terminal", placement: "split" },
    ]);
    expect(s.groups.map((g) => g.paneIds)).toEqual([["p_browser_1"], ["p_terminal_3"]]);
    expect(s.sizes).toEqual([0.5, 0.5]);
    expect(s.focusedPaneId).toBe("p_terminal_3");
  });

  it("adds a tab instead below 1440 px", () => {
    for (const width of [1439, 1200, 800, 500]) {
      const s = run(
        [
          { type: "open", pane: "browser" },
          { type: "open", pane: "terminal", placement: "split" },
        ],
        testEnv(width),
      );
      expect(s.groups).toHaveLength(1);
      expect(s.groups[0]?.paneIds).toEqual(["p_browser_1", "p_terminal_3"]);
    }
  });

  it("adds a tab when the content area cannot fit chat + two 360 px panes", () => {
    expect(maxGroupsFor(1600, 1199)).toBe(1);
    expect(maxGroupsFor(1600, 1200)).toBe(2);
    const s = run(
      [
        { type: "open", pane: "browser" },
        { type: "open", pane: "terminal", placement: "split" },
      ],
      testEnv(1600, 1100),
    );
    expect(s.groups).toHaveLength(1);
  });

  it("never makes more than two groups", () => {
    const s = run([
      { type: "open", pane: "browser" },
      { type: "open", pane: "terminal", placement: "split" },
      { type: "open", pane: "files", placement: "split" },
    ]);
    expect(s.groups).toHaveLength(2);
    expect(s.groups[1]?.paneIds).toEqual(["p_terminal_3", "p_files_5"]);
  });

  it("side / main go to the first group; no placement follows the focused group", () => {
    const env = testEnv();
    let s = run(
      [
        { type: "open", pane: "browser" },
        { type: "open", pane: "terminal", placement: "split" },
      ],
      env,
    );
    s = reduceLayout(s, { type: "open", pane: "files" }, env);
    expect(s.groups[1]?.paneIds).toContain("p_files_5");
    s = reduceLayout(s, { type: "open", pane: "plan", placement: "side" }, env);
    s = reduceLayout(s, { type: "open", pane: "diff", placement: "main" }, env);
    expect(s.groups[0]?.paneIds).toEqual(["p_browser_1", "p_plan_6", "p_diff_7"]);
  });
});

describe("split / moveToGroup", () => {
  const twoTabs = () =>
    run([
      { type: "open", pane: "browser" },
      { type: "open", pane: "terminal" },
    ]);

  it("split moves a tab into a new group after its own", () => {
    const env = testEnv();
    const s = reduceLayout(twoTabs(), { type: "split", paneId: "p_browser_1" }, env);
    expect(s.groups.map((g) => g.paneIds)).toEqual([["p_terminal_3"], ["p_browser_1"]]);
    expect(s.focusedPaneId).toBe("p_browser_1");
  });

  it("split is a no-op for a lone tab or below 1440 px", () => {
    const one = run([{ type: "open", pane: "browser" }]);
    expect(reduceLayout(one, { type: "split", paneId: "p_browser_1" }, testEnv())).toBe(one);
    const s = twoTabs();
    expect(reduceLayout(s, { type: "split", paneId: "p_browser_1" }, testEnv(1300))).toBe(s);
  });

  it("moveToGroup drags a tab across groups and drops the emptied group", () => {
    const env = testEnv();
    let s = reduceLayout(twoTabs(), { type: "split", paneId: "p_terminal_3" }, env);
    const [g0, g1] = s.groups;
    s = reduceLayout(
      s,
      { type: "moveToGroup", paneId: "p_browser_1", groupId: g1?.groupId ?? "", index: 0 },
      env,
    );
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]?.groupId).toBe(g1?.groupId);
    expect(s.groups[0]?.paneIds).toEqual(["p_browser_1", "p_terminal_3"]);
    expect(s.sizes).toEqual([1]);
    expect(g0).toBeDefined();
  });

  it("moveToGroup reorders within a group", () => {
    const env = testEnv();
    let s = run(
      [
        { type: "open", pane: "browser" },
        { type: "open", pane: "terminal" },
        { type: "open", pane: "files" },
      ],
      env,
    );
    const groupId = s.groups[0]?.groupId ?? "";
    s = reduceLayout(s, { type: "moveToGroup", paneId: "p_files_4", groupId, index: 0 }, env);
    expect(s.groups[0]?.paneIds).toEqual(["p_files_4", "p_browser_1", "p_terminal_3"]);
    s = reduceLayout(s, { type: "moveToGroup", paneId: "p_files_4", groupId }, env);
    expect(s.groups[0]?.paneIds).toEqual(["p_browser_1", "p_terminal_3", "p_files_4"]);
  });

  it("moveToGroup to an unknown group is a no-op", () => {
    const s = twoTabs();
    const next = reduceLayout(
      s,
      { type: "moveToGroup", paneId: "p_browser_1", groupId: "g_nope" },
      testEnv(),
    );
    expect(next).toBe(s);
  });
});

describe("fitting to width", () => {
  const split = () =>
    run([
      { type: "open", pane: "browser" },
      { type: "open", pane: "terminal" },
      { type: "open", pane: "files", placement: "split" },
      { type: "open", pane: "diff" },
    ]);

  it("merges groups into one tab strip in order when narrowing below 1440", () => {
    const s = split();
    expect(s.groups).toHaveLength(2);
    const narrow = reduceLayout(s, { type: "fitToWidth" }, testEnv(1200));
    expect(narrow.groups).toHaveLength(1);
    expect(narrow.groups[0]?.paneIds).toEqual([
      "p_browser_1",
      "p_terminal_3",
      "p_files_4",
      "p_diff_6",
    ]);
    expect(narrow.groups[0]?.activePaneId).toBe("p_diff_6"); // the focused pane stays visible
    expect(narrow.focusedPaneId).toBe("p_diff_6");
    expect(narrow.sizes).toEqual([1]);
    expect(dockedPaneIds(narrow)).toEqual(dockedPaneIds(s));
  });

  it("merges below 720 too, and never re-splits on widening", () => {
    const narrow = reduceLayout(split(), { type: "fitToWidth" }, testEnv(600));
    expect(narrow.groups).toHaveLength(1);
    const wide = reduceLayout(narrow, { type: "fitToWidth" }, testEnv(1600));
    expect(wide.groups).toHaveLength(1);
  });

  it("any action fits: a resize at a narrow width also merges", () => {
    const s = reduceLayout(split(), { type: "focus", paneId: "p_browser_1" }, testEnv(900));
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]?.activePaneId).toBe("p_browser_1");
  });
});

describe("resize", () => {
  const twoGroups = (env = testEnv(1600)) =>
    run(
      [
        { type: "open", pane: "browser" },
        { type: "open", pane: "terminal", placement: "split" },
      ],
      env,
    );

  it("moves the chat / pane boundary, clamped by chat ≥ 480 and panes ≥ 360", () => {
    const env = testEnv(1600);
    let s = twoGroups(env);
    expect(s.chatFraction).toBe(0.5);
    s = reduceLayout(s, { type: "resize", boundary: 0, delta: 80 }, env);
    expect(s.chatFraction).toBeCloseTo(0.55);
    s = reduceLayout(s, { type: "resize", boundary: 0, delta: 5000 }, env);
    expect(s.chatFraction * 1600).toBeCloseTo(1600 - 2 * 360);
    s = reduceLayout(s, { type: "resize", boundary: 0, delta: -5000 }, env);
    expect(s.chatFraction * 1600).toBeCloseTo(480);
  });

  it("moves the boundary between groups, keeping each ≥ 360 px", () => {
    const env = testEnv(1600);
    let s = twoGroups(env);
    s = reduceLayout(s, { type: "resize", boundary: 0, delta: -320 }, env); // pane area 1120
    expect(sum(s.sizes)).toBeCloseTo(1);
    const area = 1600 * (1 - s.chatFraction);
    s = reduceLayout(s, { type: "resize", boundary: 1, delta: 112 }, env);
    expect(s.sizes[0]).toBeCloseTo(0.6);
    s = reduceLayout(s, { type: "resize", boundary: 1, delta: 9999 }, env);
    expect((s.sizes[1] ?? 0) * area).toBeCloseTo(360);
    s = reduceLayout(s, { type: "resize", boundary: 1, delta: -9999 }, env);
    expect((s.sizes[0] ?? 0) * area).toBeCloseTo(360);
    expect(sum(s.sizes)).toBeCloseTo(1);
  });

  it("ignores resizes without panes, out-of-range boundaries and narrow widths", () => {
    const empty = emptyLayout("t1");
    expect(reduceLayout(empty, { type: "resize", boundary: 0, delta: 50 }, testEnv())).toBe(empty);
    const s = twoGroups();
    expect(reduceLayout(s, { type: "resize", boundary: 2, delta: 50 }, testEnv())).toBe(s);
    const one = run([{ type: "open", pane: "browser" }], testEnv(1000));
    expect(reduceLayout(one, { type: "resize", boundary: 0, delta: 50 }, testEnv(1000))).toBe(one);
  });

  it("re-clamps stored sizes when the window narrows", () => {
    const env = testEnv(2400);
    let s = twoGroups(env);
    s = reduceLayout(s, { type: "resize", boundary: 0, delta: 1000 }, env);
    expect(s.chatFraction * 2400).toBeCloseTo(2400 - 720);
    s = reduceLayout(s, { type: "fitToWidth" }, testEnv(1500));
    expect(s.chatFraction * 1500).toBeCloseTo(1500 - 720);
  });

  it("clampSizes keeps fractions ≥ min and summing to 1", () => {
    expect(clampSizes([0.9, 0.1], 0.3)).toEqual([0.7, 0.3]);
    expect(clampSizes([1, 1, 1], 0.5)).toEqual([0.333333, 0.333333, 0.333334]);
    expect(clampSizes([Number.NaN, -1], 0.1)).toEqual([0.5, 0.5]);
    expect(clampSizes([3, 1], 0)).toEqual([0.75, 0.25]);
  });
});

describe("close and focus return", () => {
  it("returns focus to the opener when it is still open", () => {
    const env = testEnv();
    let s = run(
      [
        { type: "open", pane: "browser" },
        { type: "open", pane: "terminal" },
        { type: "open", pane: "files", openerPaneId: "p_browser_1" },
      ],
      env,
    );
    s = reduceLayout(s, { type: "close", paneId: "p_files_4" }, env);
    expect(s.focusedPaneId).toBe("p_browser_1");
    expect(s.groups[0]?.activePaneId).toBe("p_browser_1");
  });

  it("falls back to the neighbour when the opener is gone, then to the chat", () => {
    const env = testEnv();
    let s = run(
      [
        { type: "open", pane: "browser" },
        { type: "open", pane: "terminal" },
        { type: "open", pane: "files" },
      ],
      env,
    );
    // files was opened from terminal; close terminal (unfocused) first.
    s = reduceLayout(s, { type: "close", paneId: "p_terminal_3" }, env);
    expect(s.focusedPaneId).toBe("p_files_4");
    s = reduceLayout(s, { type: "close", paneId: "p_files_4" }, env);
    expect(s.focusedPaneId).toBe("p_browser_1");
    s = reduceLayout(s, { type: "close", paneId: "p_browser_1" }, env);
    expect(s.focusedPaneId).toBeNull();
    expect(s.groups).toEqual([]);
    expect(s.sizes).toEqual([]);
  });

  it("a pane opened from the chat returns focus to the chat", () => {
    const env = testEnv();
    let s = run(
      [
        { type: "open", pane: "browser" },
        { type: "focus", paneId: null },
        { type: "open", pane: "terminal" },
      ],
      env,
    );
    s = reduceLayout(s, { type: "close", paneId: "p_terminal_3" }, env);
    expect(s.focusedPaneId).toBeNull();
    expect(s.groups[0]?.activePaneId).toBe("p_browser_1");
  });

  it("closing an unfocused pane leaves focus alone", () => {
    const env = testEnv();
    let s = run(
      [
        { type: "open", pane: "browser" },
        { type: "open", pane: "terminal" },
      ],
      env,
    );
    s = reduceLayout(s, { type: "close", paneId: "p_browser_1" }, env);
    expect(s.focusedPaneId).toBe("p_terminal_3");
  });

  it("closes the most recent pane of a kind; closing the chat is a no-op", () => {
    const env = testEnv();
    let s = run(
      [
        { type: "open", pane: "browser", target: "a" },
        { type: "open", pane: "browser", target: "b" },
      ],
      env,
    );
    s = reduceLayout(s, { type: "close", pane: "browser" }, env);
    expect(s.panes.map((p) => p.target)).toEqual(["a"]);
    expect(reduceLayout(s, { type: "close", pane: "chat" }, env)).toBe(s);
    expect(reduceLayout(s, { type: "close", pane: "terminal" }, env)).toBe(s);
  });

  it("closing the last pane of a group removes the group and gives back its space", () => {
    const env = testEnv();
    let s = run(
      [
        { type: "open", pane: "browser" },
        { type: "open", pane: "terminal", placement: "split" },
      ],
      env,
    );
    s = reduceLayout(s, { type: "close", paneId: "p_terminal_3" }, env);
    expect(s.groups).toHaveLength(1);
    expect(s.sizes).toEqual([1]);
    expect(s.focusedPaneId).toBe("p_browser_1"); // the opener
  });

  it("focus by kind picks the most recent; focus chat clears focus", () => {
    const env = testEnv();
    let s = run(
      [
        { type: "open", pane: "browser", target: "a" },
        { type: "open", pane: "browser", target: "b" },
        { type: "open", pane: "terminal" },
      ],
      env,
    );
    s = reduceLayout(s, { type: "focus", pane: "browser" }, env);
    expect(s.focusedPaneId).toBe("p_browser_3");
    s = reduceLayout(s, { type: "focus", paneId: "chat" }, env);
    expect(s.focusedPaneId).toBeNull();
    s = reduceLayout(s, { type: "activateTab", paneId: "p_browser_1" }, env);
    expect(s.focusedPaneId).toBe("p_browser_1");
    expect(s.groups[0]?.activePaneId).toBe("p_browser_1");
  });
});

describe("closeFocused (⌘\\)", () => {
  it("closes the focused pane and walks back through openers", () => {
    const env = testEnv();
    let s = run(
      [
        { type: "open", pane: "browser" },
        { type: "open", pane: "terminal" },
        { type: "open", pane: "files" },
      ],
      env,
    );
    s = reduceLayout(s, { type: "closeFocused" }, env);
    expect(s.focusedPaneId).toBe("p_terminal_3");
    s = reduceLayout(s, { type: "closeFocused" }, env);
    expect(s.focusedPaneId).toBe("p_browser_1");
    s = reduceLayout(s, { type: "closeFocused" }, env);
    expect(s.focusedPaneId).toBeNull();
    expect(s.panes).toEqual([]);
  });

  it("does nothing while the chat has focus", () => {
    const env = testEnv();
    const s = run(
      [
        { type: "open", pane: "browser" },
        { type: "focus", paneId: null },
      ],
      env,
    );
    expect(reduceLayout(s, { type: "closeFocused" }, env)).toBe(s);
  });

  it("reports the pane it closed", () => {
    const env = testEnv();
    const s = run([{ type: "open", pane: "browser" }], env);
    const out = applyLayoutAction(s, { type: "closeFocused" }, env);
    expect(out).toMatchObject({ paneId: "p_browser_1", changed: true });
  });
});

describe("pop-out / pop-in", () => {
  const base = (env = testEnv()) =>
    run(
      [
        { type: "open", pane: "browser" },
        { type: "open", pane: "terminal" },
      ],
      env,
    );

  it("pops a pane into its own window and returns main-window focus", () => {
    const env = testEnv();
    const s = reduceLayout(base(env), { type: "popOut", paneId: "p_terminal_3" }, env);
    expect(s.popped).toEqual(["p_terminal_3"]);
    expect(dockedPaneIds(s)).toEqual(["p_browser_1"]);
    expect(s.panes).toHaveLength(2);
    expect(s.focusedPaneId).toBe("p_browser_1");
  });

  it("popped panes are revealed in place, not duplicated, and cannot take main focus", () => {
    const env = testEnv();
    let s = reduceLayout(base(env), { type: "popOut", paneId: "p_terminal_3" }, env);
    const out = applyLayoutAction(s, { type: "open", pane: "terminal" }, env);
    expect(out.paneId).toBe("p_terminal_3");
    expect(out.state).toBe(s);
    s = reduceLayout(s, { type: "focus", paneId: "p_terminal_3" }, env);
    expect(s.focusedPaneId).toBe("p_browser_1");
    expect(reduceLayout(s, { type: "popOut", paneId: "p_terminal_3" }, env)).toBe(s);
  });

  it("pops back in to the first group (or a given one) and focuses it", () => {
    const env = testEnv();
    let s = reduceLayout(base(env), { type: "popOut", paneId: "p_browser_1" }, env);
    s = reduceLayout(s, { type: "popIn", paneId: "p_browser_1" }, env);
    expect(s.popped).toEqual([]);
    expect(s.groups[0]?.paneIds).toEqual(["p_terminal_3", "p_browser_1"]);
    expect(s.focusedPaneId).toBe("p_browser_1");
  });

  it("popping out the only pane leaves no groups; popping in recreates one", () => {
    const env = testEnv();
    let s = run([{ type: "open", pane: "vm" }], env);
    s = reduceLayout(s, { type: "popOut", paneId: "p_vm_1" }, env);
    expect(s.groups).toEqual([]);
    expect(s.focusedPaneId).toBeNull();
    s = reduceLayout(s, { type: "popIn", paneId: "p_vm_1" }, env);
    expect(dockedPaneIds(s)).toEqual(["p_vm_1"]);
  });

  it("closing a popped pane removes it", () => {
    const env = testEnv();
    let s = reduceLayout(base(env), { type: "popOut", paneId: "p_terminal_3" }, env);
    s = reduceLayout(s, { type: "close", pane: "terminal" }, env);
    expect(s.popped).toEqual([]);
    expect(s.panes.map((p) => p.paneId)).toEqual(["p_browser_1"]);
  });

  it("setTitle updates docked and popped panes", () => {
    const env = testEnv();
    let s = reduceLayout(
      base(env),
      { type: "setTitle", paneId: "p_browser_1", title: "Acme" },
      env,
    );
    expect(s.panes[0]?.title).toBe("Acme");
    s = reduceLayout(s, { type: "setTitle", paneId: "missing", title: "x" }, env);
    expect(s.panes).toHaveLength(2);
  });
});

describe("purity", () => {
  it("never mutates its input", () => {
    const env = testEnv();
    const s: LayoutState = run(
      [
        { type: "open", pane: "browser" },
        { type: "open", pane: "terminal", placement: "split" },
      ],
      env,
    );
    const snapshot = JSON.stringify(s);
    reduceLayout(s, { type: "close", paneId: "p_browser_1" }, env);
    reduceLayout(s, { type: "resize", boundary: 1, delta: 50 }, env);
    reduceLayout(s, { type: "fitToWidth" }, testEnv(800));
    expect(JSON.stringify(s)).toBe(snapshot);
  });
});
