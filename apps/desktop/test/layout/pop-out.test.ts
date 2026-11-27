import { describe, expect, it, vi } from "vitest";
import {
  type LayoutAction,
  parsePopOutRoute,
  popOutRoute,
  showBrowser,
} from "../../src/shell/layout/index.ts";
import { run, testEnv } from "./helpers.ts";

describe("pop-out routes", () => {
  it("round-trips a pane route", () => {
    expect(parsePopOutRoute(popOutRoute("t1", "p_browser_1"))).toEqual({
      threadId: "t1",
      paneId: "p_browser_1",
    });
    expect(parsePopOutRoute("/chat/t1")).toBeNull();
  });
});

describe("closing a pop-out (popOutClosed → popIn)", () => {
  it("docks the popped pane again", () => {
    const env = testEnv();
    const opened = run([{ type: "open", pane: "browser" }], env);
    const paneId = opened.panes[0]?.paneId ?? "";
    const popped = run([{ type: "popOut", paneId }], env, opened);
    expect(popped.popped).toEqual([paneId]);
    expect(popped.groups).toHaveLength(0);

    const closed = run([{ type: "popIn", paneId }], env, popped);
    expect(closed.popped).toEqual([]);
    expect(closed.groups[0]?.paneIds).toEqual([paneId]);
    expect(closed.focusedPaneId).toBe(paneId);
  });
  it("ignores a window that was not popped any more", () => {
    const env = testEnv();
    const opened = run([{ type: "open", pane: "browser" }], env);
    const paneId = opened.panes[0]?.paneId ?? "";
    expect(run([{ type: "popIn", paneId }], env, opened)).toEqual(opened);
  });
});

describe("showBrowser", () => {
  const poppedState = () => {
    const env = testEnv();
    const opened = run([{ type: "open", pane: "browser" }], env);
    const paneId = opened.panes[0]?.paneId ?? "";
    return { state: run([{ type: "popOut", paneId }], env, opened), paneId };
  };

  it("opens the browser pane when there is none", async () => {
    const dispatch = vi.fn<(a: LayoutAction) => void>();
    await showBrowser({ threadId: "t1", state: run([]), dispatch });
    expect(dispatch).toHaveBeenCalledWith({ type: "open", pane: "browser" });
  });
  it("raises a pop-out window that still exists", async () => {
    const { state, paneId } = poppedState();
    const dispatch = vi.fn();
    const focusPopOut = vi.fn(async () => true);
    await showBrowser({ threadId: "t1", state, dispatch, focusPopOut });
    expect(focusPopOut).toHaveBeenCalledWith(popOutRoute("t1", paneId));
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("docks the browser again when its window is gone", async () => {
    const { state, paneId } = poppedState();
    const dispatch = vi.fn();
    await showBrowser({ threadId: "t1", state, dispatch, focusPopOut: async () => false });
    expect(dispatch).toHaveBeenCalledWith({ type: "popIn", paneId });
  });
  it("docks it when the host cannot raise windows", async () => {
    const { state, paneId } = poppedState();
    const dispatch = vi.fn();
    await showBrowser({ threadId: "t1", state, dispatch });
    expect(dispatch).toHaveBeenCalledWith({ type: "popIn", paneId });
  });
});
