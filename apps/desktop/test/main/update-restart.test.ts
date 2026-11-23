import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abandonRestart,
  RESTART_GIVE_UP_MS,
  type RestartDeps,
  resetRestartForTests,
  restartToUpdate,
} from "../../src/main/update-restart.ts";
import type { UpdateStatus } from "../../src/main/update-status.ts";

const ready: UpdateStatus = { state: "ready", release: "0.4.0", mandatory: false };

/** Mocked autoUpdater and windows; `calls` records the order the restart touches them in. */
function harness(status: UpdateStatus = ready, platform = "darwin") {
  const calls: string[] = [];
  const deps: RestartDeps = {
    platform,
    status,
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
    expect(calls).toEqual(["beginQuit", "quitAndInstall"]);
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
    expect(calls).toEqual(["beginQuit", "quitAndInstall", "cancelQuit"]);
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
});
