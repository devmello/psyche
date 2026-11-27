import { createValidator, ViewLayout } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  applyViewCommand,
  emptyLayout,
  type LayoutState,
  toViewLayout,
  viewCommandToAction,
} from "../../src/shell/layout/index.ts";
import { run, testEnv } from "./helpers.ts";

const NOW = "2026-10-19T10:00:00.000Z";
const layoutValidator = createValidator(ViewLayout);

function apply(state: LayoutState, payload: unknown) {
  return applyViewCommand(state, payload, testEnv());
}

describe("viewCommandToAction", () => {
  it("maps view.open args onto an open action", () => {
    const m = viewCommandToAction({
      commandId: "c1",
      command: "open",
      args: { pane: "browser", placement: "split", target: "tab-1", threadId: "t9", taskId: "k1" },
    });
    expect(m).toEqual({
      ok: true,
      commandId: "c1",
      command: "open",
      threadId: "t9",
      action: {
        type: "open",
        pane: "browser",
        placement: "split",
        target: "tab-1",
        threadId: "t9",
        taskId: "k1",
      },
    });
  });

  it("maps close / focus by id or kind", () => {
    expect(viewCommandToAction({ command: "close", args: { paneId: "p1" } })).toMatchObject({
      ok: true,
      commandId: null,
      action: { type: "close", paneId: "p1" },
    });
    expect(viewCommandToAction({ command: "focus", args: { pane: "terminal" } })).toMatchObject({
      ok: true,
      action: { type: "focus", pane: "terminal" },
    });
  });

  it("returns invalid_params for bad args instead of throwing", () => {
    const cases: unknown[] = [
      { commandId: "c2", command: "open", args: { pane: "nope" } },
      { command: "open", args: {} },
      { command: "open", args: { pane: "browser", placement: "floating" } },
      { command: "open", args: { pane: "browser", target: "x".repeat(5000) } },
      { command: "close", args: { paneId: "" } },
      { command: "close", args: {} },
      { command: "focus", args: { paneId: 7 } },
      { command: "teleport", args: {} },
      { command: "open", args: "browser" },
      null,
      "open",
    ];
    for (const payload of cases) {
      const m = viewCommandToAction(payload);
      expect(m.ok, JSON.stringify(payload)).toBe(false);
      if (!m.ok) expect(m.error.code).toBe("invalid_params");
    }
    const m = viewCommandToAction(cases[0]);
    expect(m).toMatchObject({ ok: false, commandId: "c2" });
  });

  it("treats the chat as the fixed column: open / focus focus it, close is an error", () => {
    for (const payload of [
      { command: "open", args: { pane: "chat" } },
      { command: "focus", args: { pane: "chat" } },
      { command: "focus", args: { paneId: "chat" } },
    ]) {
      expect(viewCommandToAction(payload)).toMatchObject({
        ok: true,
        action: { type: "focus", paneId: null },
      });
    }
    for (const payload of [
      { command: "close", args: { pane: "chat" } },
      { command: "close", args: { paneId: "chat" } },
    ]) {
      const m = viewCommandToAction(payload);
      expect(m).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    }
  });

  it("with a state, close / focus of a missing pane is not_found", () => {
    const s = run([{ type: "open", pane: "browser" }]);
    expect(viewCommandToAction({ command: "close", args: { pane: "terminal" } }, s)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(viewCommandToAction({ command: "focus", args: { paneId: "p_x" } }, s)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(viewCommandToAction({ command: "close", args: { pane: "browser" } }, s).ok).toBe(true);
  });
});

describe("applyViewCommand", () => {
  it("opens, reveals, focuses and closes panes", () => {
    let s = emptyLayout("t1");
    let out = apply(s, { commandId: "c1", command: "open", args: { pane: "browser" } });
    expect(out).toMatchObject({ ok: true, commandId: "c1", paneId: "p_browser_1", changed: true });
    if (!out.ok) throw new Error("unreachable");
    s = out.state;
    out = apply(s, { command: "open", args: { pane: "browser" } });
    expect(out).toMatchObject({ ok: true, paneId: "p_browser_1", changed: false });
    out = apply(s, { command: "focus", args: { pane: "chat" } });
    expect(out).toMatchObject({ ok: true, paneId: null, changed: true });
    if (!out.ok) throw new Error("unreachable");
    expect(out.state.focusedPaneId).toBeNull();
    out = apply(s, { command: "close", args: { pane: "browser" } });
    expect(out).toMatchObject({ ok: true, paneId: "p_browser_1" });
    if (!out.ok) throw new Error("unreachable");
    expect(out.state.panes).toEqual([]);
  });

  it("errors leave the state untouched", () => {
    const s = run([{ type: "open", pane: "browser" }]);
    const out = apply(s, { command: "close", args: { pane: "chat" } });
    expect(out.ok).toBe(false);
    expect(s.panes).toHaveLength(1);
  });
});

describe("toViewLayout", () => {
  it("validates against the protocol ViewLayout schema", () => {
    const states: LayoutState[] = [
      emptyLayout("t1"),
      emptyLayout(null),
      run([
        { type: "open", pane: "browser", target: "tab-1" },
        { type: "open", pane: "terminal", placement: "split" },
        { type: "open", pane: "files" },
        { type: "open", pane: "artifact", artifactId: "a1" },
        { type: "popOut", paneId: "p_artifact_6" },
      ]),
    ];
    for (const s of states) {
      const layout = toViewLayout(s, NOW);
      expect(layoutValidator.errors(layout)).toEqual([]);
      expect(layoutValidator.check(layout)).toBe(true);
    }
  });

  it("lists the chat, first group as side, later groups as split, popped panes as main", () => {
    const s = run([
      { type: "open", pane: "browser", target: "tab-1" },
      { type: "open", pane: "terminal", placement: "split" },
      { type: "open", pane: "files" },
      { type: "popOut", paneId: "p_files_5" },
    ]);
    const layout = toViewLayout(s, () => NOW);
    expect(layout).toEqual({
      panes: [
        { paneId: "chat", pane: "chat", placement: "main", threadId: "t1", target: null },
        {
          paneId: "p_browser_1",
          pane: "browser",
          placement: "side",
          threadId: "t1",
          target: "tab-1",
        },
        {
          paneId: "p_terminal_3",
          pane: "terminal",
          placement: "split",
          threadId: "t1",
          target: null,
        },
        { paneId: "p_files_5", pane: "files", placement: "main", threadId: "t1", target: null },
      ],
      focusedPaneId: "p_terminal_3",
      updatedAt: NOW,
    });
    const chatFocused = run([{ type: "focus", paneId: null }], testEnv(), s);
    expect(toViewLayout(chatFocused, NOW).focusedPaneId).toBe("chat");
  });
});
