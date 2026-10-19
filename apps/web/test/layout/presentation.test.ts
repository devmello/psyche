import { describe, expect, it } from "vitest";
import { breakpointFor, emptyLayout, presentation } from "../../src/shell/layout/index.ts";
import { run, testEnv } from "./helpers.ts";

const twoGroups = () =>
  run([
    { type: "open", pane: "browser" },
    { type: "open", pane: "terminal" },
    { type: "open", pane: "files", placement: "split" },
  ]);

describe("presentation", () => {
  it("maps widths to breakpoints", () => {
    expect([500, 719, 720, 1079, 1080, 1439, 1440].map(breakpointFor)).toEqual([
      "compact",
      "compact",
      "medium",
      "medium",
      "wide",
      "wide",
      "xwide",
    ]);
  });

  it("shows nothing but the chat without panes", () => {
    const p = presentation(emptyLayout("t1"), 1600);
    expect(p).toMatchObject({ mode: "single", groups: [], visiblePaneId: null, chatVisible: true });
  });

  it("double: two groups side by side at ≥ 1440", () => {
    const p = presentation(twoGroups(), 1600);
    expect(p.mode).toBe("double");
    expect(p.groups.map((g) => g.paneIds)).toEqual([
      ["p_browser_1", "p_terminal_3"],
      ["p_files_4"],
    ]);
    expect(p.visiblePaneIds).toEqual(["p_terminal_3", "p_files_4"]);
    expect(p.visiblePaneId).toBe("p_files_4");
    expect(p.groups.map((g) => g.size)).toEqual([0.5, 0.5]);
  });

  it("single: one merged tab strip below 1440 even before fitToWidth", () => {
    const p = presentation(twoGroups(), 1200);
    expect(p.mode).toBe("single");
    expect(p.breakpoint).toBe("wide");
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0]?.paneIds).toEqual(["p_browser_1", "p_terminal_3", "p_files_4"]);
    expect(p.visiblePaneId).toBe("p_files_4");
    expect(presentation(twoGroups(), 900).breakpoint).toBe("medium");
  });

  it("single at ≥ 1440 with one group", () => {
    const s = run([{ type: "open", pane: "browser" }]);
    expect(presentation(s, 1600).mode).toBe("single");
  });

  it("compact: the focused pane full screen, or the chat", () => {
    const env = testEnv(600);
    let s = run([{ type: "open", pane: "browser" }], env);
    let p = presentation(s, 600);
    expect(p).toMatchObject({
      mode: "compact",
      visiblePaneId: "p_browser_1",
      visiblePaneIds: ["p_browser_1"],
      chatVisible: false,
    });
    s = run([{ type: "focus", paneId: null }], env, s);
    p = presentation(s, 600);
    expect(p).toMatchObject({ visiblePaneId: null, visiblePaneIds: [], chatVisible: true });
    s = run(
      [{ type: "closeFocused" }, { type: "focus", pane: "browser" }, { type: "closeFocused" }],
      env,
      s,
    );
    expect(presentation(s, 600).chatVisible).toBe(true);
  });

  it("lists popped panes separately", () => {
    const env = testEnv();
    const s = run(
      [
        { type: "open", pane: "browser" },
        { type: "popOut", paneId: "p_browser_1" },
      ],
      env,
    );
    const p = presentation(s, 1600);
    expect(p.popped).toEqual(["p_browser_1"]);
    expect(p.groups).toEqual([]);
  });
});
