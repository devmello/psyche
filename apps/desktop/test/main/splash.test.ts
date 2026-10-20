import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createSplash,
  SPLASH_TEXT,
  type SplashStatus,
  type SplashView,
  shouldShowSplash,
  splashStatus,
} from "../../src/main/splash.ts";
import { type GatewayRunState, GatewaySupervisor, type Runner } from "../../src/main/supervisor.ts";

const dir = mkdtempSync(join(tmpdir(), "psy-splash-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A splash window that records what it shows. */
function fakeView() {
  const shown: SplashStatus[] = [];
  let action: ((a: "retry" | "logs") => void) | null = null;
  const view: SplashView & { closed: boolean } = {
    closed: false,
    render: (s) => void shown.push(s),
    close() {
      this.closed = true;
    },
    onAction: (cb) => {
      action = cb;
    },
  };
  return { view, shown, click: (a: "retry" | "logs") => action?.(a) };
}

/** Manual timers: `tick(ms)` runs whatever is due. */
function clock() {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id: unknown) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    tick(ms: number) {
      now += ms;
      for (const t of [...timers].filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
  };
}

const run = (s: GatewayRunState) => s;

describe("splash status", () => {
  const base = { helper: "unbundled" as const, healthy: false, painted: false };
  it("names each step of the launch", () => {
    expect(splashStatus({ ...base, run: { kind: "unknown" } }).text).toBe(SPLASH_TEXT.starting);
    expect(splashStatus({ ...base, run: run({ kind: "starting", mode: "dev" }) }).text).toBe(
      SPLASH_TEXT.starting,
    );
    expect(
      splashStatus({ ...base, run: { kind: "starting", mode: "launchd", step: "installing" } })
        .text,
    ).toBe("Installing the launch agent…");
    expect(
      splashStatus({ ...base, run: { kind: "starting", mode: "launchd", step: "waiting" } }).text,
    ).toBe("Waiting for the Gateway…");
    expect(splashStatus({ ...base, run: { kind: "running", mode: "dev", pid: 3 } }).text).toBe(
      "Waiting for the Gateway…",
    );
    expect(
      splashStatus({
        run: { kind: "running", mode: "launchd" },
        helper: "starting",
        healthy: true,
        painted: false,
      }).text,
    ).toBe("Launching the helper…");
    expect(
      splashStatus({
        run: { kind: "running", mode: "launchd" },
        ...base,
        healthy: true,
        painted: true,
      }),
    ).toEqual({ tone: "ready", text: "Ready" });
  });

  it("shows the supervisor's reason on failure, not on quit", () => {
    expect(
      splashStatus({
        ...base,
        run: { kind: "stopped", mode: "launchd", reason: "launchctl could not load", logs: "/l" },
      }),
    ).toEqual({
      tone: "error",
      text: SPLASH_TEXT.failed,
      reason: "launchctl could not load",
      canShowLogs: true,
    });
    expect(
      splashStatus({ ...base, run: { kind: "stopped", mode: "dev", reason: "quit" } }).tone,
    ).toBe("progress");
  });
});

describe("when the splash shows", () => {
  it("skips in dev with PSYCHE_NO_SPLASH=1, in attach mode, for an external Gateway and the probe", () => {
    const show = (o: Partial<Parameters<typeof shouldShowSplash>[0]>) =>
      shouldShowSplash({ packaged: true, env: {}, mode: "launchd", healthyAtLaunch: false, ...o });
    expect(show({})).toBe(true);
    expect(show({ packaged: false, env: { PSYCHE_NO_SPLASH: "1" }, mode: "dev" })).toBe(false);
    // The variable is a dev switch: a packaged build ignores it.
    expect(show({ env: { PSYCHE_NO_SPLASH: "1" } })).toBe(true);
    expect(show({ healthyAtLaunch: true })).toBe(false);
    expect(show({ mode: "external" })).toBe(false);
    expect(show({ probing: true })).toBe(false);
  });
});

describe("splash controller", () => {
  it("closes shortly after the main window painted and the Gateway is healthy", () => {
    const c = clock();
    const { view, shown } = fakeView();
    const s = createSplash({ view, retry: () => {}, showLogs: () => {}, ...c });
    s.update({ run: { kind: "starting", mode: "launchd", step: "waiting" } });
    s.update({ painted: true });
    expect(view.closed).toBe(false);
    s.update({ healthy: true });
    expect(shown.at(-1)).toEqual({ tone: "ready", text: "Ready" });
    c.tick(299);
    expect(view.closed).toBe(false);
    c.tick(1);
    expect(view.closed).toBe(true);
  });

  it("hands over to the connection banner after a few seconds of waiting", () => {
    const c = clock();
    const { view } = fakeView();
    const s = createSplash({ view, retry: () => {}, showLogs: () => {}, ...c });
    s.update({ run: { kind: "starting", mode: "launchd", step: "installing" } });
    c.tick(3_000);
    // A new line does not restart the clock: the splash never blocks for long.
    s.update({ run: { kind: "starting", mode: "launchd", step: "waiting" } });
    c.tick(2_999);
    expect(view.closed).toBe(false);
    c.tick(1);
    expect(view.closed).toBe(true);
    s.update({ healthy: true, painted: true });
    expect(s.closed).toBe(true);
  });

  it("offers Show logs and Retry on failure, then hands over", () => {
    const c = clock();
    const { view, shown, click } = fakeView();
    const retry = vi.fn();
    const showLogs = vi.fn();
    const s = createSplash({ view, retry, showLogs, ...c });
    s.update({ run: { kind: "stopped", mode: "launchd", reason: "psyched is not bundled" } });
    expect(shown.at(-1)).toMatchObject({ tone: "error", reason: "psyched is not bundled" });
    click("logs");
    expect(showLogs).toHaveBeenCalledOnce();
    click("retry");
    expect(retry).toHaveBeenCalledOnce();
    expect(shown.at(-1)).toEqual({ tone: "progress", text: SPLASH_TEXT.starting });
    s.update({ run: { kind: "stopped", mode: "launchd", reason: "still broken" } });
    c.tick(11_999);
    expect(view.closed).toBe(false);
    c.tick(1);
    expect(view.closed).toBe(true);
  });
});

describe("splash with a supervisor", () => {
  /** launchctl and /healthz as the supervisor tests fake them: healthy once kickstarted. */
  function launchd() {
    let loaded = false;
    let started = false;
    const runner: Runner = async (_file, args) => {
      if (args[0] === "bootstrap") loaded = true;
      if (args[0] === "kickstart") started = true;
      if (args[0] === "print")
        return loaded
          ? { code: 0, stdout: "\tstate = running\n\tpid = 7\n", stderr: "" }
          : { code: 113, stdout: "", stderr: "not found" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const fetchFn: typeof fetch = () =>
      started && loaded
        ? Promise.resolve(new Response("", { status: 200 }))
        : Promise.reject(new Error("down"));
    return { runner, fetchFn };
  }

  it("walks through installing, waiting and ready as the supervisor reports them", async () => {
    const program = join(dir, "psyched");
    const template = join(dir, "template.plist");
    mkdirSync(dir, { recursive: true });
    writeFileSync(program, "#!/bin/sh\n");
    writeFileSync(template, "<plist>{{PSYCHED}} {{PSYCHE_HOME}}</plist>");
    const c = clock();
    const { view, shown } = fakeView();
    const splash = createSplash({ view, retry: () => {}, showLogs: () => {}, ...c });
    const fake = launchd();
    const sup = new GatewaySupervisor({
      mode: "launchd",
      psycheHome: join(dir, "home"),
      healthUrl: "http://127.0.0.1:1/healthz",
      bundledProgram: program,
      bundledPlist: template,
      launchAgentsDir: join(dir, "LaunchAgents"),
      uid: 501,
      run: fake.runner,
      fetch: fake.fetchFn,
      sleep: async () => undefined,
      onState: (s) => splash.update({ run: s }),
    });
    splash.update({ painted: true });
    await sup.ensureRunning();
    splash.update({ healthy: true });
    expect(shown.map((s) => s.text)).toEqual([
      "Starting the Gateway…",
      "Starting the Gateway…",
      "Installing the launch agent…",
      "Waiting for the Gateway…",
      "Waiting for the Gateway…",
      "Ready",
    ]);
    c.tick(300);
    expect(view.closed).toBe(true);
  });
});

describe("splash page", () => {
  it("is self-contained, respects reduced motion and never injects HTML", async () => {
    const { splashHtml, iconDataUrl } = await import("../../src/main/splash-window.ts");
    expect(iconDataUrl(join(dir, "missing.png"))).toBeNull();
    const page = splashHtml(null);
    expect(page).toContain("default-src 'none'");
    expect(page).toContain("prefers-reduced-motion: reduce");
    expect(page).toContain("prefers-color-scheme: dark");
    // Without the icon file (packaged builds), the Psyche mark stands in.
    expect(page).toContain('viewBox="0 0 32 32"');
    // Status and reason are set as text, never as markup.
    expect(page).not.toContain("innerHTML");
    expect(page).toContain('role="status"');
  });
});
