import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abandonRestart,
  commitRestart,
  KEEP_EDITING_REFUSAL,
  RESTART_GIVE_UP_MS,
  type RestartDeps,
  resetRestartForTests,
  restartToUpdate,
} from "../../src/main/update-restart.ts";
import type { UpdateStatus } from "../../src/main/update-status.ts";

const ready: UpdateStatus = { state: "ready", release: "0.4.0", mandatory: false };

/** Mocked autoUpdater and windows; `calls` records the order the restart touches them in. */
function harness(status: UpdateStatus = ready, platform = "darwin", confirm = true) {
  const calls: string[] = [];
  const deps: RestartDeps = {
    platform,
    status,
    confirmQuit: vi.fn(() => {
      calls.push("confirmQuit");
      return confirm;
    }),
    beginQuit: vi.fn(() => calls.push("beginQuit")),
    cancelQuit: vi.fn(() => calls.push("cancelQuit")),
    quitAndInstall: vi.fn(() => calls.push("quitAndInstall")),
  };
  return { deps, calls };
}

beforeEach(() => {
  resetRestartForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  resetRestartForTests();
  vi.useRealTimers();
});

describe("Restart to update", () => {
  it("marks the app quitting before quitAndInstall runs, so the windows close for real", () => {
    const { deps, calls } = harness();
    expect(restartToUpdate(deps)).toBeUndefined();
    expect(calls).toEqual(["confirmQuit", "beginQuit", "quitAndInstall"]);
    expect(deps.cancelQuit).not.toHaveBeenCalled();
  });

  it("refuses without touching the windows or the updater when nothing is ready", () => {
    for (const status of [
      { state: "idle" },
      { state: "checking" },
      { state: "none" },
      { state: "refused", reason: "bad signature" },
    ] as UpdateStatus[]) {
      const { deps, calls } = harness(status);
      expect(restartToUpdate(deps)).toBe("no verified update is ready to install");
      expect(calls).toEqual([]);
    }
  });

  it("refuses on other platforms even with a ready update", () => {
    const { deps, calls } = harness(ready, "linux");
    expect(restartToUpdate(deps)).toBe("Restart to update is only available on macOS");
    expect(calls).toEqual([]);
  });

  it("ignores a second click while the restart is in progress", () => {
    const { deps } = harness();
    restartToUpdate(deps);
    expect(restartToUpdate(deps)).toBeUndefined();
    expect(deps.quitAndInstall).toHaveBeenCalledOnce();
    expect(deps.beginQuit).toHaveBeenCalledOnce();
  });

  it("undoes the quitting mark and shows the window when the install fails", () => {
    const { deps, calls } = harness();
    restartToUpdate(deps);
    expect(abandonRestart(deps.cancelQuit)).toBe(true);
    expect(calls).toEqual(["confirmQuit", "beginQuit", "quitAndInstall", "cancelQuit"]);
    // Nothing is in progress any more, so the owner can try again.
    expect(abandonRestart(deps.cancelQuit)).toBe(false);
    const second = harness();
    expect(restartToUpdate(second.deps)).toBeUndefined();
    expect(second.deps.quitAndInstall).toHaveBeenCalledOnce();
  });

  it("undoes the mark when quitAndInstall throws, and reports the error", () => {
    const { deps } = harness();
    deps.quitAndInstall = vi.fn(() => {
      throw new Error("boom");
    });
    expect(() => restartToUpdate(deps)).toThrow("boom");
    expect(deps.cancelQuit).toHaveBeenCalledOnce();
  });

  it("gives up after a while when the quit never went ahead (an unsaved-edit prompt kept the app open)", () => {
    const { deps } = harness();
    restartToUpdate(deps);
    vi.advanceTimersByTime(RESTART_GIVE_UP_MS - 1);
    expect(deps.cancelQuit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(deps.cancelQuit).toHaveBeenCalledOnce();
    // Clicking again starts a new restart.
    expect(restartToUpdate(deps)).toBeUndefined();
    expect(deps.quitAndInstall).toHaveBeenCalledTimes(2);
  });

  it("asks about unsaved edits first, before any window is touched", () => {
    const { deps, calls } = harness();
    restartToUpdate(deps);
    expect(calls).toEqual(["confirmQuit", "beginQuit", "quitAndInstall"]);
  });

  it("with unsaved edits and Keep editing: no quitting mark, no quitAndInstall, nothing in progress", () => {
    const { deps, calls } = harness(ready, "darwin", false);
    expect(restartToUpdate(deps)).toBe(KEEP_EDITING_REFUSAL);
    expect(calls).toEqual(["confirmQuit"]);
    expect(deps.beginQuit).not.toHaveBeenCalled();
    expect(deps.quitAndInstall).not.toHaveBeenCalled();
    // The status stays ready (the caller never changed it), and the restart can be tried again.
    const again = harness();
    expect(restartToUpdate(again.deps)).toBeUndefined();
    expect(again.deps.quitAndInstall).toHaveBeenCalledOnce();
  });

  it("with unsaved edits and Discard: the restart goes ahead", () => {
    const { deps, calls } = harness(ready, "darwin", true);
    expect(restartToUpdate(deps)).toBeUndefined();
    expect(calls).toEqual(["confirmQuit", "beginQuit", "quitAndInstall"]);
  });

  it("once committed by before-quit, a late error does not un-quit or show a window", () => {
    const { deps } = harness();
    restartToUpdate(deps);
    commitRestart();
    expect(abandonRestart(deps.cancelQuit)).toBe(false);
    expect(deps.cancelQuit).not.toHaveBeenCalled();
  });

  it("once committed, the give-up timer does nothing", () => {
    const { deps } = harness();
    restartToUpdate(deps);
    commitRestart();
    vi.advanceTimersByTime(RESTART_GIVE_UP_MS * 2);
    expect(deps.cancelQuit).not.toHaveBeenCalled();
  });

  it("commit before any restart is a no-op", () => {
    const { deps } = harness();
    commitRestart();
    expect(abandonRestart(deps.cancelQuit)).toBe(false);
    expect(restartToUpdate(deps)).toBeUndefined();
    expect(deps.quitAndInstall).toHaveBeenCalledOnce();
  });
});
