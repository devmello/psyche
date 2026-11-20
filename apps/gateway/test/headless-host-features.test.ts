import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpBridgeDriver, type PlaywrightDriverOptions } from "@psyche/browser";
import { MockDesktop } from "@psyche/browser/testing";
import { insertDevice, openDb, type PsycheDb } from "@psyche/db";
import type { DeviceScope, ToolResult } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHROMIUM_PATHS,
  findChromium,
  findXauthority,
  type ServerDriver,
  serverBrowserEnv,
  serverBrowserWanted,
  serverDriverOptions,
  startServerScreen,
  type XauthFs,
} from "../src/compose/browser-server.ts";
import { execHostSrtSettings, linuxPsycheDenyRead } from "../src/compose/exec-host.ts";
import { headlessLinuxHost } from "../src/compose/headless-host.ts";
import {
  type ComposedBrowser,
  type ComposedGateway,
  type ComposeServices,
  composeBrowser,
  composeGateway,
} from "../src/compose/index.ts";
import { checkPaymentPresence, passkeyOnlyPayments } from "../src/compose/payment-presence.ts";
import { watchAccess } from "../src/compose/virtual-screen.ts";
import { silentLogger } from "../src/log.ts";

/**
 * B3, headless Host features (linux-helper-only design §7.4): the agent browser on the Host
 * helper's private screen through the Playwright driver, the watch pane for a paired desktop
 * Client, and passkey-only payment presence. Gateway side with mocks; the real Chromium on Xvfb
 * is checked in the Linux VM.
 */

const HEADLESS = { XDG_RUNTIME_DIR: "/run/user/1000", HOME: "/home/o", PATH: "/usr/bin" };

describe("headlessLinuxHost", () => {
  it.each([
    ["linux", HEADLESS, true],
    ["linux", { ...HEADLESS, DISPLAY: ":0" }, false],
    ["linux", { ...HEADLESS, WAYLAND_DISPLAY: "wayland-0" }, false],
    ["linux", { ...HEADLESS, DISPLAY: "  " }, true],
    // No user manager in the environment (tests, `env -i`): not a Host session at all.
    ["linux", {}, false],
    ["darwin", HEADLESS, false],
    ["win32", HEADLESS, false],
  ] as const)("%s %j -> %s", (platform, env, want) => {
    expect(headlessLinuxHost(platform, env as NodeJS.ProcessEnv)).toBe(want);
  });
});

describe("serverBrowserWanted", () => {
  it.each([
    ["linux", HEADLESS, true],
    ["linux", { ...HEADLESS, PSYCHE_BROWSER_DRIVER: "bridge" }, false],
    ["linux", { ...HEADLESS, DISPLAY: ":0" }, false],
    ["linux", { DISPLAY: ":0", PSYCHE_BROWSER_DRIVER: "server" }, true],
    // Only Linux has the helper's private screen.
    ["darwin", { PSYCHE_BROWSER_DRIVER: "server" }, false],
    ["win32", HEADLESS, false],
  ] as const)("%s %j -> %s", (platform, env, want) => {
    expect(serverBrowserWanted(platform, env as NodeJS.ProcessEnv)).toBe(want);
  });
});

describe("findChromium", () => {
  it("prefers PSYCHE_CHROMIUM, then the first installed path, else Playwright's own", () => {
    expect(findChromium({ PSYCHE_CHROMIUM: "/opt/c/chrome" }, () => true)).toBe("/opt/c/chrome");
    expect(findChromium({}, (p) => p === "/usr/bin/chromium-browser")).toBe(
      "/usr/bin/chromium-browser",
    );
    expect(findChromium({}, (p) => p === CHROMIUM_PATHS[0])).toBe("/usr/bin/chromium");
    expect(findChromium({}, () => false)).toBeUndefined();
  });
});

describe("findXauthority", () => {
  const UID = 1000;
  type Entry = { dir?: boolean; mode: number; uid: number; mtimeMs: number };
  const fsOf = (entries: Record<string, Entry>): XauthFs => ({
    readdir: (dir) =>
      Object.keys(entries)
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) => p.slice(dir.length + 1)),
    lstat: (path) => {
      const e = entries[path];
      if (e === undefined) throw new Error("ENOENT");
      return {
        isDirectory: () => e.dir === true,
        isFile: () => e.dir !== true,
        mode: e.mode,
        uid: e.uid,
        mtimeMs: e.mtimeMs,
      };
    },
  });
  const DIR = "/run/user/1000/psyche";
  const dir: Entry = { dir: true, mode: 0o40700, uid: UID, mtimeMs: 0 };
  const file = (mtimeMs: number, more: Partial<Entry> = {}): Entry => ({
    mode: 0o100600,
    uid: UID,
    mtimeMs,
    ...more,
  });

  it("finds the newest authority file the helper wrote for the display", () => {
    const fs = fsOf({
      [DIR]: dir,
      [`${DIR}/xauth-ab12-90-0123456789ab`]: file(10),
      [`${DIR}/xauth-ab12-90-ba9876543210`]: file(20),
      [`${DIR}/xauth-ab12-91-ffffffffffff`]: file(30),
      [`${DIR}/vs-ab12-0011`]: { dir: true, mode: 0o40700, uid: UID, mtimeMs: 40 },
    });
    expect(findXauthority(":90", "/run/user/1000", UID, fs)).toBe(
      `${DIR}/xauth-ab12-90-ba9876543210`,
    );
    expect(findXauthority(":91", "/run/user/1000", UID, fs)).toBe(
      `${DIR}/xauth-ab12-91-ffffffffffff`,
    );
  });

  it.each([
    ["another account's directory", { [DIR]: { ...dir, uid: 1001 } }],
    ["a directory others can enter", { [DIR]: { ...dir, mode: 0o40750 } }],
    ["a link for the directory", { [DIR]: { ...dir, dir: false } }],
  ])("refuses %s", (_what, override) => {
    const fs = fsOf({ [`${DIR}/xauth-ab12-90-0123456789ab`]: file(1), ...override });
    expect(findXauthority(":90", "/run/user/1000", UID, fs)).toBeNull();
  });

  it.each([
    ["another account's file", file(1, { uid: 1001 })],
    ["a file others can read", file(1, { mode: 0o100644 })],
    ["a directory in its place", file(1, { dir: true })],
  ])("skips %s", (_what, entry) => {
    const fs = fsOf({ [DIR]: dir, [`${DIR}/xauth-ab12-90-0123456789ab`]: entry });
    expect(findXauthority(":90", "/run/user/1000", UID, fs)).toBeNull();
  });

  it.each([
    ["a remote display", "host:90"],
    ["a screen suffix", ":90.0"],
    ["no display", ""],
  ])("refuses %s", (_what, display) => {
    const fs = fsOf({ [DIR]: dir, [`${DIR}/xauth-ab12-90-0123456789ab`]: file(1) });
    expect(findXauthority(display, "/run/user/1000", UID, fs)).toBeNull();
  });

  it("needs a runtime directory, never a guess in /tmp", () => {
    expect(findXauthority(":90", undefined, UID, fsOf({}))).toBeNull();
  });
});

describe("the server browser's process", () => {
  it("gets the private screen and none of the owner's display or session bus", () => {
    const env = serverBrowserEnv(
      { display: ":90", xauthority: "/run/user/1000/psyche/xauth-a-90-0123456789ab" },
      {
        ...HEADLESS,
        DISPLAY: ":0",
        WAYLAND_DISPLAY: "wayland-0",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        SSH_AUTH_SOCK: "/tmp/ssh-agent",
        ANTHROPIC_API_KEY: "sk-test",
      },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/o",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DISPLAY: ":90",
      XAUTHORITY: "/run/user/1000/psyche/xauth-a-90-0123456789ab",
    });
  });

  it("is headful Chromium with profiles under the Host's PSYCHE_HOME", () => {
    const o = serverDriverOptions(
      { display: ":90", xauthority: null },
      { library: {} as never },
      "/srv/psyche-home",
      "/usr/bin/chromium",
      HEADLESS,
    );
    expect(o).toMatchObject({
      mode: "launch",
      headless: false,
      psycheHome: "/srv/psyche-home",
      executablePath: "/usr/bin/chromium",
      env: { DISPLAY: ":90" },
    });
    expect(o.env).not.toHaveProperty("XAUTHORITY");
  });
});

describe("startServerScreen", () => {
  const STATUS = {
    state: "running",
    display: ":90",
    width: 1280,
    height: 800,
    apps: [],
    takenOver: false,
    frameSeq: 0,
    startedAt: null,
  };
  it("starts the helper's private screen and finds its authority file", async () => {
    const asked: string[] = [];
    const screen = await startServerScreen(
      {
        async invoke(capability) {
          asked.push(capability);
          return { ok: true, result: STATUS };
        },
      },
      HEADLESS,
      (display, rt) => `${rt}/psyche/xauth-x-${display.slice(1)}-0123456789ab`,
    );
    expect(asked).toEqual(["vscreen.start"]);
    expect(screen).toEqual({
      display: ":90",
      xauthority: "/run/user/1000/psyche/xauth-x-90-0123456789ab",
    });
  });

  it("fails unavailable without the Linux helper, and keeps the helper's own error", async () => {
    await expect(startServerScreen(undefined, HEADLESS)).rejects.toMatchObject({
      code: "unavailable",
      details: { reason: "no_linux_helper" },
    });
    await expect(
      startServerScreen(
        {
          invoke: async () => ({
            ok: false,
            error: { code: "unavailable", message: "no Xvfb", details: { reason: "no_xvfb" } },
          }),
        },
        HEADLESS,
      ),
    ).rejects.toMatchObject({ code: "unavailable", details: { reason: "no_xvfb" } });
  });

  it("refuses a status without a display", async () => {
    await expect(
      startServerScreen(
        { invoke: async () => ({ ok: true, result: { ...STATUS, display: null } }) },
        HEADLESS,
      ),
    ).rejects.toMatchObject({ code: "internal" });
  });
});

// --- composeBrowser with the server driver --------------------------------------------------

let home = "";
let composed: ComposedGateway | null = null;
let desktop: MockDesktop | undefined;
afterEach(async () => {
  desktop?.disconnect();
  desktop = undefined;
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

async function composeServer(setup: Parameters<typeof composeBrowser>[1]) {
  home = mkdtempSync(join(tmpdir(), "psyche-b3-"));
  const keyFile = join(home, "vault.key");
  writeFileSync(keyFile, Buffer.alloc(32, 9), { mode: 0o600 });
  let services: ComposeServices | undefined;
  let browser: ComposedBrowser | undefined;
  composed = await composeGateway({
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    vault: { keyFile, argon2: { memory: 64, passes: 1, parallelism: 1 } },
    parts: [
      (s) => {
        services = s;
        browser = composeBrowser(s, { socketPath: false, ...setup });
        return browser;
      },
    ],
  });
  if (services === undefined || browser === undefined) throw new Error("not composed");
  return { services, browser };
}

const unattended = (callId: string, signal = new AbortController().signal): never =>
  ({
    callId,
    threadId: "thr_b3",
    runId: "run_b3",
    permissionMode: "default",
    taint: false,
    mode: "unattended",
    signal,
    onUpdate: () => {},
  }) as never;

const runTool = async (s: ComposeServices, name: string, callId: string, params: unknown) => {
  const reg = s.tools.get(name) as { run?: (p: unknown, c: never) => Promise<ToolResult> };
  if (reg?.run === undefined) throw new Error(`${name} is not an in-process tool`);
  return reg.run(params, unattended(callId));
};

/** A server driver over the mock desktop's CDP, capturing the options it was made with. */
async function fakeServerDriver() {
  desktop = new MockDesktop({ quarantineDir: "" });
  const bridge = await desktop.connect();
  const made: PlaywrightDriverOptions[] = [];
  const drivers: ServerDriver[] = [];
  let disposed = 0;
  const createDriver = (o: PlaywrightDriverOptions): ServerDriver => {
    made.push(o);
    const d = new CdpBridgeDriver(bridge, { library: o.library });
    const base = d.dispose.bind(d);
    const server = Object.assign(d, {
      dispose: async () => {
        disposed += 1;
        base();
      },
    }) as unknown as ServerDriver;
    drivers.push(server);
    return server;
  };
  return { createDriver, made, drivers, disposed: () => disposed };
}

describe("the agent browser on a headless Host (server driver)", () => {
  it("offers the tools with no desktop, and starts Chromium on the private screen on first use", async () => {
    const fake = await fakeServerDriver();
    const screens: string[] = [];
    const { services, browser } = await composeServer({
      server: {
        screen: async () => {
          screens.push("start");
          return { display: ":90", xauthority: "/run/user/1000/psyche/xauth-a-90-0123456789ab" };
        },
        createDriver: fake.createDriver,
        executablePath: "/usr/bin/chromium",
      },
    });
    expect(services.tools.list().map((t) => t.name)).toEqual(
      expect.arrayContaining(["browser.open_tab", "browser.navigate", "browser.request_control"]),
    );
    expect(services.browserAvailability.check?.()).toEqual({ ok: true });
    expect(browser.driverKind).toBeNull();
    const [a, b] = await Promise.all([
      runTool(services, "browser.open_tab", "call_a", { url: "https://example.com/" }),
      runTool(services, "browser.open_tab", "call_b", { url: "https://example.com/" }),
    ]);
    // One screen, one Chromium, however many calls race for it.
    expect(screens).toEqual(["start"]);
    expect(fake.made).toHaveLength(1);
    expect(fake.made[0]).toMatchObject({
      mode: "launch",
      headless: false,
      psycheHome: home,
      executablePath: "/usr/bin/chromium",
      env: { DISPLAY: ":90", XAUTHORITY: "/run/user/1000/psyche/xauth-a-90-0123456789ab" },
    });
    expect(browser.driverKind).toBe("server");
    // Past the start the call met Psyche's own rules, as with the desktop's bridge: an
    // unattended run opening a new site waits for the owner's approval.
    for (const r of [a, b]) {
      expect(r.output).toMatchObject({ error: { code: "approval_required" } });
    }
  });

  it("routes the owner's tabs to the server driver and opens pages there", async () => {
    const fake = await fakeServerDriver();
    const { services, browser } = await composeServer({
      server: {
        screen: async () => ({ display: ":90", xauthority: null }),
        createDriver: fake.createDriver,
      },
    });
    // The first agent call starts the driver.
    await runTool(services, "browser.open_tab", "call_s", { url: "https://example.com/" });
    const url = desktop?.browser.url("a/") ?? "";
    // The owner's own tab goes to the server driver: refused by its origin policy (the mock's
    // sites are loopback), not "no desktop".
    const open = browser.handlers?.["browser.open"];
    await expect(open?.run({} as never, { url } as never)).rejects.toMatchObject({
      code: "policy_denied",
    });
    // A page opens on that driver (a dev-preview session admits the mock's loopback site).
    const driver = fake.drivers[0];
    if (driver === undefined) throw new Error("no server driver");
    const port = Number(new URL(url).port);
    const session = await driver.openSession({
      policy: { devPreview: true, loopbackPorts: [port], readWritable: [new URL(url).origin] },
    });
    const tab = await driver.openTab(session.id, url);
    expect(tab.url).toBe(url);
    expect(fake.made).toHaveLength(1);
  });

  it("says why when the private screen can't start", async () => {
    const { services } = await composeServer({
      server: {
        screen: async () => {
          throw new Error("Xvfb is not installed");
        },
        createDriver: () => {
          throw new Error("never made");
        },
      },
    });
    const r = await runTool(services, "browser.open_tab", "call_x", {
      url: "https://example.com/",
    });
    expect(r.output).toMatchObject({
      error: { code: "unavailable", details: { reason: "browser_unavailable" } },
    });
    expect(JSON.stringify(r.output)).toContain("Xvfb is not installed");
  });

  it("waits while the owner has taken the private screen over", async () => {
    const fake = await fakeServerDriver();
    const { services, browser } = await composeServer({
      server: {
        screen: async () => ({ display: ":90", xauthority: null }),
        createDriver: fake.createDriver,
      },
    });
    await runTool(services, "browser.open_tab", "call_1", { url: "https://example.com/" });
    let release: (() => void) | undefined;
    let held = true;
    browser.useTakeOver({
      isTakenOver: () => held,
      agentGate: () =>
        held
          ? new Promise<void>((r) => {
              release = () => {
                held = false;
                r();
              };
            })
          : Promise.resolve(),
    });
    let done = false;
    const pending = runTool(services, "browser.open_tab", "call_2", {
      url: "https://example.com/",
    }).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    release?.();
    expect((await pending).output).toMatchObject({ error: { code: "approval_required" } });
  });

  it("hands over to a desktop's bridge when one connects", async () => {
    const fake = await fakeServerDriver();
    const { services, browser } = await composeServer({
      server: {
        screen: async () => ({ display: ":90", xauthority: null }),
        createDriver: fake.createDriver,
      },
    });
    await runTool(services, "browser.open_tab", "call_h", { url: "https://example.com/" });
    expect(browser.driverKind).toBe("server");
    const other = new MockDesktop({ quarantineDir: "" });
    browser.attach(await other.connect());
    expect(browser.driverKind).toBe("bridge");
    expect(fake.disposed()).toBe(1);
    other.disconnect();
  });

  it("stays off when the setup says so (a desktop Host keeps the bridge only)", async () => {
    const { services, browser } = await composeServer({ server: false });
    expect(services.tools.list().filter((t) => t.name.startsWith("browser."))).toEqual([]);
    expect(browser.driverKind).toBeNull();
  });
});

// --- The watch pane for a paired desktop Client ---------------------------------------------

describe("watchAccess (computerWatch.* from a remote desktop Client)", () => {
  let db: PsycheDb;
  const device = (family: string | null, role: "client" | "node" = "client") =>
    insertDevice(db, {
      name: "d",
      platform: "macos",
      role,
      publicKey: Buffer.alloc(32, Math.floor(Math.random() * 255)),
      scopes: ["operator.read"],
      pairedAt: new Date().toISOString(),
      deviceFamily: family,
    }).id;
  const call = (
    deviceId: string,
    scopes: DeviceScope[],
    method: string,
    more: Record<string, unknown> = {},
  ) => ({
    ctx: { db } as never,
    identity: { deviceId, scopes, role: "client", ...more } as never,
    method,
  });
  const WRITE: DeviceScope[] = ["operator.read", "operator.write"];
  const ALL: DeviceScope[] = ["operator.read", "operator.write", "operator.approvals"];

  it("lets a paired desktop app watch with operator.write, and take over with approvals too", () => {
    db = openDb(":memory:");
    const mac = device("desktop");
    for (const m of ["computerWatch.status", "computerWatch.frame", "computerWatch.stop"]) {
      expect(() => watchAccess(call(mac, WRITE, m))).not.toThrow();
    }
    for (const m of ["computerWatch.takeOver", "computerWatch.input"]) {
      expect(() => watchAccess(call(mac, WRITE, m))).toThrow(/operator\.approvals/);
      expect(() => watchAccess(call(mac, ALL, m))).not.toThrow();
    }
    expect(() => watchAccess(call(mac, ["operator.read"], "computerWatch.status"))).toThrow(
      /operator\.write/,
    );
  });

  it.each([
    ["a phone", "ios"],
    ["a browser page", "web"],
    ["the CLI", "cli"],
    ["a Linux helper", "linux-helper"],
    ["a device with no family", null],
  ])("refuses %s, whatever its scopes", (_what, family) => {
    db = openDb(":memory:");
    const id = device(family);
    expect(() => watchAccess(call(id, ALL, "computerWatch.status"))).toThrow(/desktop app/);
  });

  it("refuses a node, a machine and the Host helper even with the desktop family", () => {
    db = openDb(":memory:");
    const id = device("desktop");
    for (const more of [{ role: "node" }, { machine: true }, { hostHelper: true }]) {
      expect(() => watchAccess(call(id, ALL, "computerWatch.status", more))).toThrow(/desktop app/);
    }
  });

  it("keeps the desktop shell on the Host as before, and only for computerWatch methods", () => {
    db = openDb(":memory:");
    const id = device("desktop");
    expect(() =>
      watchAccess(call(id, [], "computerWatch.input", { desktopShell: true })),
    ).not.toThrow();
    expect(() => watchAccess(call(id, ALL, "chat.send", { desktopShell: true }))).toThrow();
    expect(() => watchAccess(call(id, ALL, "computerWatchX.status"))).toThrow();
  });
});

// --- Passkey-only payment presence ----------------------------------------------------------

describe("passkey-only payment presence", () => {
  it.each([
    ["linux", HEADLESS, true],
    ["linux", { ...HEADLESS, DISPLAY: ":0" }, false],
    ["darwin", HEADLESS, false],
    ["darwin", { PSYCHE_PAYMENT_PRESENCE: "passkey" }, true],
    ["linux", {}, false],
  ] as const)("passkeyOnlyPayments(%s, %j) -> %s", (platform, env, want) => {
    expect(passkeyOnlyPayments(platform, env as NodeJS.ProcessEnv)).toBe(want);
  });

  const PAYMENTS = [
    { kind: "purchase", sideEffect: "financial" },
    { kind: "purchase", sideEffect: "write" },
    { kind: "tool_call", sideEffect: "financial" },
    { kind: "computer_action", sideEffect: "financial" },
  ] as const;
  const ORDINARY = [
    { kind: "tool_call", sideEffect: "write" },
    { kind: "tool_call", sideEffect: "destructive" },
    { kind: "policy_change", sideEffect: "destructive" },
    { kind: "computer_action", sideEffect: "write" },
    { kind: "exec_host", sideEffect: "destructive" },
  ] as const;
  const rule = (passkeyOnly: boolean, hasPasskey: boolean) => ({
    passkeyOnly: () => passkeyOnly,
    hasPasskey: () => hasPasskey,
  });

  it.each(PAYMENTS)("a payment (%j) with no passkey fails presence_required", (input) => {
    expect(() => checkPaymentPresence(input as never, rule(true, false))).toThrow(
      expect.objectContaining({
        code: "presence_required",
        details: { reason: "passkey_required" },
        message: expect.stringContaining("Set up a passkey to approve payments on this Psyche"),
      }),
    );
  });

  it.each(PAYMENTS)("a payment (%j) with a passkey raises its card", (input) => {
    expect(() => checkPaymentPresence(input as never, rule(true, true))).not.toThrow();
  });

  it.each(ORDINARY)("an ordinary approval (%j) stays a tap, passkey or not", (input) => {
    expect(() => checkPaymentPresence(input as never, rule(true, false))).not.toThrow();
  });

  it.each(PAYMENTS)("a Host with someone at it is unchanged (%j)", (input) => {
    expect(() => checkPaymentPresence(input as never, rule(false, false))).not.toThrow();
  });
});

// --- srt's deny profile on a Linux Host -----------------------------------------------------

describe("exec_host's srt profile on a Linux Host (B3: the deny paths, checked)", () => {
  const profile = (platform: NodeJS.Platform) =>
    (
      execHostSrtSettings({
        psycheHome: "/home/o/.psyche",
        userHome: "/home/o",
        scratch: "/home/o/.psyche/exec-host/s1",
        writable: [],
        allowedDomains: [],
        platform,
        linuxEnv: { XDG_RUNTIME_DIR: "/run/user/1000", XDG_STATE_HOME: "/home/o/.xdg-state" },
      }) as { filesystem: { denyRead: string[]; denyWrite: string[] } }
    ).filesystem;

  it("denies the Linux credential stores, rooted at the owner's home", () => {
    const deny = profile("linux").denyRead;
    for (const p of [
      ".config/google-chrome",
      ".config/chromium",
      ".mozilla",
      ".local/share/keyrings",
      ".local/share/kwalletd",
      ".password-store",
      ".var/app/org.chromium.Chromium",
      "snap/chromium",
    ]) {
      expect(deny).toContain(join("/home/o", p));
    }
    for (const p of [".ssh", ".gnupg", ".aws", ".netrc", ".docker", ".kube"]) {
      expect(deny).toContain(join("/home/o", p));
    }
  });

  it("denies Psyche's own Linux files: its home, browser profiles, helper state, screen cookies", () => {
    const fs = profile("linux");
    expect(fs.denyRead).toEqual(
      expect.arrayContaining([
        "/home/o/.psyche",
        "/home/o/.psyche/vault",
        "/home/o/.psyche/browser/profiles",
        "/home/o/.local/state/psyche-helper",
        "/home/o/.xdg-state/psyche-helper",
        "/run/user/1000/psyche",
        "/home/o/.config/Psyche",
      ]),
    );
    expect(fs.denyWrite).toContain("/home/o/.psyche");
  });

  it("ignores a relative XDG base, and adds none of it on macOS", () => {
    expect(linuxPsycheDenyRead("/home/o", { XDG_RUNTIME_DIR: "run", XDG_STATE_HOME: "" })).toEqual([
      "/home/o/.local/state/psyche-helper",
      "/home/o/.config/Psyche",
    ]);
    const mac = profile("darwin").denyRead;
    expect(mac).not.toContain("/run/user/1000/psyche");
    expect(mac).not.toContain(join("/home/o", ".config", "chromium"));
  });
});

describe("passkey-only payments through the composed broker", () => {
  async function broker(opts: { passkey: boolean }) {
    home = mkdtempSync(join(tmpdir(), "psyche-b3-pay-"));
    let services: ComposeServices | undefined;
    composed = await composeGateway({
      env: { PSYCHE_PAYMENT_PRESENCE: "passkey" },
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      // A caller-supplied verifier takes the passkey role (compose/index.ts).
      ...(opts.passkey ? { presence: { verify: async () => true } } : {}),
      parts: [
        (s) => {
          services = s;
          return {};
        },
      ],
    });
    if (services === undefined) throw new Error("not composed");
    return services.broker;
  }
  const request = (kind: string, sideEffect: string) =>
    ({
      kind,
      summary: "Pay Acme $12.00",
      details: {},
      bindingHash: `b-${kind}-${sideEffect}`,
      grantKey: `g-${kind}-${sideEffect}`,
      requestedBy: { runId: null, taskId: null, threadId: null },
      sideEffect,
      surfaces: ["desktop"],
      taint: false,
    }) as never;

  it("fails a payment presence_required with no passkey, before any card exists", async () => {
    const b = await broker({ passkey: false });
    await expect(b.requestApproval(request("purchase", "financial"))).rejects.toMatchObject({
      code: "presence_required",
      details: { reason: "passkey_required" },
    });
    expect(await b.list({ status: "pending" })).toEqual([]);
  });

  it("still raises an ordinary card as a tap", async () => {
    const b = await broker({ passkey: false });
    const issued = await b.requestApproval(request("tool_call", "write"));
    expect(issued.approval.requiresAuthentication).toBe(false);
  });

  it("raises the payment's card, needing presence, once a passkey can verify", async () => {
    const b = await broker({ passkey: true });
    const issued = await b.requestApproval(request("purchase", "financial"));
    expect(issued.approval.requiresAuthentication).toBe(true);
  });
});
