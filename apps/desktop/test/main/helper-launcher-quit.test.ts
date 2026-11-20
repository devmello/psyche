import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HelperLauncher } from "../../src/main/helper-launcher.ts";

// Quit path of the bundled macOS helper (stopForQuit). Everything is a fake: no process is
// signalled, no helper or app is started.

const dir = mkdtempSync(join(tmpdir(), "psy-helper-quit-"));
const appPath = join(dir, "PsycheHelper.app");
mkdirSync(appPath);
const exe = join(appPath, "Contents", "MacOS", "psyche-helper");

/** A little world: one helper process that SIGTERM ends (or not), a lock file with its pid. */
function world(
  opts: {
    lockPid?: number | undefined;
    /** What `ps -p <pid> -o comm=` prints for the lock's pid (undefined: no such process). */
    comm?: string | undefined;
    /** SIGTERM does not end it (a wedged helper). */
    ignoresTerm?: boolean;
    ignoresKill?: boolean;
    platform?: NodeJS.Platform;
    appPath?: string | undefined;
  } = {},
) {
  const pid = "lockPid" in opts ? opts.lockPid : 4242;
  let comm = "comm" in opts ? opts.comm : exe;
  let alive = comm !== undefined;
  const signals: Array<[number, string]> = [];
  const opened: string[][] = [];
  let paired = alive;
  let clock = 0;
  const states: string[] = [];
  const launcher = new HelperLauncher({
    appPath: "appPath" in opts ? opts.appPath : appPath,
    psycheHome: join(dir, "home"),
    platform: opts.platform ?? "darwin",
    run: async (file, args) => {
      if (file === "/usr/bin/open") {
        opened.push([file, ...args]);
        alive = true;
        comm = exe;
        paired = true;
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    isPaired: async () => paired,
    readPid: () => pid,
    runSync: (file, args) => {
      expect(file).toBe("/bin/ps");
      expect(args).toEqual(["-p", String(pid), "-o", "comm="]);
      return comm === undefined || !alive
        ? { code: 1, stdout: "" }
        : { code: 0, stdout: `${comm}\n` };
    },
    isAlive: () => alive,
    sleepSync: (ms) => {
      clock += ms;
    },
    kill: (p, signal) => {
      signals.push([p, signal]);
      if (signal === "SIGTERM" && !opts.ignoresTerm) alive = false;
      if (signal === "SIGKILL" && !opts.ignoresKill) alive = false;
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    onState: (s) => states.push(s.kind),
    pairTimeoutMs: 3_000,
    relaunchEveryMs: 0,
  });
  return {
    launcher,
    signals,
    opened,
    states,
    isAlive: () => alive,
    setPaired: (p: boolean) => (paired = p),
  };
}

describe("HelperLauncher.stopForQuit", () => {
  it("sends SIGTERM to the lock file's pid when it is the bundled helper, and leaves nothing running", () => {
    const w = world();
    expect(w.launcher.stopForQuit()).toBe("stopped");
    expect(w.signals).toEqual([[4242, "SIGTERM"]]);
    expect(w.isAlive()).toBe(false);
  });

  it("never signals a pid that is some other program (the lock file keeps a stale pid)", () => {
    for (const comm of [
      "/usr/bin/some-other",
      // Another copy's helper, or a lookalike path.
      "/Applications/Psyche.app/Contents/Resources/PsycheHelper.app/Contents/MacOS/psyche-helper",
      `${exe}-extra`,
      "psyche-helper",
    ]) {
      const w = world({ comm });
      expect(w.launcher.stopForQuit()).toBe("not-running");
      expect(w.signals).toEqual([]);
    }
  });

  it("does nothing when the helper is not running or there is no lock pid", () => {
    const gone = world({ comm: undefined });
    expect(gone.launcher.stopForQuit()).toBe("not-running");
    expect(gone.signals).toEqual([]);
    const noLock = world({ lockPid: undefined });
    expect(noLock.launcher.stopForQuit()).toBe("not-running");
    expect(noLock.signals).toEqual([]);
  });

  it("escalates to SIGKILL only after the grace period, and only for the same verified process", () => {
    const wedged = world({ ignoresTerm: true });
    expect(wedged.launcher.stopForQuit(300)).toBe("killed");
    expect(wedged.signals).toEqual([
      [4242, "SIGTERM"],
      [4242, "SIGKILL"],
    ]);
    const stuck = world({ ignoresTerm: true, ignoresKill: true });
    expect(stuck.launcher.stopForQuit(300)).toBe("still-running");
  });

  it("does not kill after the grace period if the pid became another program meanwhile", () => {
    const w = world({ ignoresTerm: true });
    let calls = 0;
    // First ps (before SIGTERM) says the helper; by the second the pid belongs to another program.
    const launcher = new HelperLauncher({
      appPath,
      psycheHome: join(dir, "home"),
      platform: "darwin",
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      isPaired: async () => true,
      readPid: () => 4242,
      runSync: () => ({ code: 0, stdout: `${calls++ === 0 ? exe : "/bin/other"}\n` }),
      isAlive: () => true,
      sleepSync: () => {},
      kill: (p, s) => w.signals.push([p, s]),
    });
    expect(launcher.stopForQuit(100)).toBe("stopped");
    expect(w.signals).toEqual([[4242, "SIGTERM"]]);
  });

  it("is a no-op without a bundled macOS helper (dev builds, Windows, remote Gateway)", () => {
    for (const o of [
      { appPath: undefined },
      { appPath: join(dir, "missing.app") },
      { platform: "win32" as const, appPath: join(dir, "psyche-helper.exe") },
      { platform: "linux" as const },
    ]) {
      const w = world(o);
      expect(w.launcher.stopForQuit()).toBe("not-applicable");
      expect(w.signals).toEqual([]);
    }
  });

  it("is idempotent: the second call (will-quit after before-quit) finds nothing", () => {
    const w = world();
    expect(w.launcher.stopForQuit()).toBe("stopped");
    expect(w.launcher.stopForQuit()).toBe("not-running");
    expect(w.signals).toEqual([[4242, "SIGTERM"]]);
  });

  it("an error from the signal (it exited in between) is not an error", () => {
    const launcher = new HelperLauncher({
      appPath,
      psycheHome: join(dir, "home"),
      platform: "darwin",
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      isPaired: async () => true,
      readPid: () => 4242,
      runSync: () => ({ code: 0, stdout: `${exe}\n` }),
      kill: () => {
        throw new Error("ESRCH");
      },
    });
    expect(launcher.stopForQuit()).toBe("not-running");
  });
});

describe("after a quit nothing starts the helper again", () => {
  it("the helper's own exit (node.updated, offline) does not relaunch it", async () => {
    const w = world();
    w.launcher.stopForQuit();
    w.setPaired(false);
    await w.launcher.onPresence(false);
    await w.launcher.onPresence(false);
    expect(w.opened).toEqual([]);
    expect(w.isAlive()).toBe(false);
  });

  it("launch() and restart() (a card's Start button, a late IPC) are refused", async () => {
    const w = world({ comm: undefined });
    w.launcher.stopForQuit();
    await w.launcher.launch();
    await w.launcher.restart();
    expect(w.opened).toEqual([]);
  });

  it("a launch that is waiting for the helper to pair gives up instead of opening it later", async () => {
    // `open` already ran and the loop is waiting for pairing when the quit comes.
    let stop: () => void = () => {};
    let polls = 0;
    const opened: string[] = [];
    const launcher = new HelperLauncher({
      appPath,
      psycheHome: join(dir, "home"),
      platform: "darwin",
      run: async (file) => {
        opened.push(file);
        return { code: 0, stdout: "", stderr: "" };
      },
      isPaired: async () => {
        if (++polls === 3) stop();
        return false;
      },
      readPid: () => undefined,
      sleep: async () => {},
      pairTimeoutMs: 1_000_000,
    });
    stop = () => launcher.stopForQuit();
    await launcher.launch();
    expect(opened).toEqual(["/usr/bin/open"]);
    expect(launcher.getState().kind).toBe("starting");
  });

  it("a launch that has not reached `open` yet does not open it", async () => {
    // The first isPaired (are we already paired?) is when the quit lands.
    const opened: string[] = [];
    let stop: () => void = () => {};
    const launcher = new HelperLauncher({
      appPath,
      psycheHome: join(dir, "home"),
      platform: "darwin",
      run: async (file) => {
        opened.push(file);
        return { code: 0, stdout: "", stderr: "" };
      },
      isPaired: async () => {
        stop();
        return false;
      },
      readPid: () => undefined,
      sleep: async () => {},
    });
    stop = () => launcher.stopForQuit();
    await launcher.launch();
    expect(opened).toEqual([]);
  });
});

describe("a new app instance (relaunch after an update or a restart) starts the helper again", () => {
  it("quit stops it; the next launcher opens it as on any start", async () => {
    const w = world();
    expect(w.launcher.stopForQuit()).toBe("stopped");
    w.setPaired(false);
    // The relaunched app builds a fresh launcher; once the Gateway answers it launches.
    let clock = 0;
    const next = new HelperLauncher({
      appPath,
      psycheHome: join(dir, "home"),
      platform: "darwin",
      run: async (file, args) => {
        w.opened.push([file, ...args]);
        w.setPaired(true);
        return { code: 0, stdout: "", stderr: "" };
      },
      isPaired: async () => false,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      pairTimeoutMs: 2_000,
    });
    // isPaired stays false in this fake; the point is that the open happens.
    await next.launch();
    expect(w.opened.map((c) => c[0])).toEqual(["/usr/bin/open"]);
  });
});
