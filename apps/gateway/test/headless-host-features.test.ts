import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpBridgeDriver, type PlaywrightDriverOptions } from "@psyche/browser";
import { MockDesktop } from "@psyche/browser/testing";
import { insertDevice, openDb, type PsycheDb } from "@psyche/db";
import type { DeviceScope, PermissionBroker, ToolResult } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHROMIUM_PATHS,
  findChromium,
  preparePrivateDirs,
  type ServerBrowserSetup,
  type ServerDriver,
  serverBrowserDirs,
  serverBrowserEnv,
  serverBrowserSetupFor,
  serverDriverOptions,
} from "../src/compose/browser-server.ts";
import {
  execHostSrtSettings,
  type LinuxDenyFs,
  linuxPsycheDenyRead,
} from "../src/compose/exec-host.ts";
import { headlessLinuxHost } from "../src/compose/headless-host.ts";
import {
  type ComposedBrowser,
  type ComposedGateway,
  type ComposeServices,
  composeBrowser,
  composeGateway,
} from "../src/compose/index.ts";
import {
  checkPaymentPresence,
  passkeyPresenceForced,
  withPaymentPresence,
} from "../src/compose/payment-presence.ts";
import { checkoutNeedsDesktop, createPurchaseTool } from "../src/compose/purchase-tool.ts";
import { watchAccess } from "../src/compose/virtual-screen.ts";
import { silentLogger } from "../src/log.ts";

/**
 * B3, headless Host features (linux-helper-only design §7.4), after review r1: the agent browser
 * as headless Chromium through the Playwright driver (no display, never on the helper's private
 * screen), the watch pane for a paired desktop Client, and passkey-only payment presence. The
 * Gateway side with mocks; a real Chromium is checked on a Linux box.
 */

const graphical = (on: boolean) => async () => on;

describe("headlessLinuxHost (B0's logind answer, never psyched's env)", () => {
  it.each([
    ["linux", false, true],
    ["linux", true, false],
    ["darwin", false, false],
    ["win32", false, false],
  ] as const)("%s, graphical session %s -> %s", async (platform, session, want) => {
    expect(await headlessLinuxHost(platform, graphical(session))).toBe(want);
  });
});

describe("serverBrowserSetupFor (the service env, then logind)", () => {
  it("is off off Linux, whatever the env says", () => {
    expect(
      serverBrowserSetupFor("darwin", { PSYCHE_BROWSER_DRIVER: "server" }, graphical(false)),
    ).toBe(false);
    expect(serverBrowserSetupFor("win32", {}, graphical(false))).toBe(false);
  });

  it("is off with PSYCHE_BROWSER_DRIVER=bridge", () => {
    expect(
      serverBrowserSetupFor("linux", { PSYCHE_BROWSER_DRIVER: "bridge" }, graphical(false)),
    ).toBe(false);
  });

  it("serves exactly while logind reports no graphical session", async () => {
    let session = false;
    const s = serverBrowserSetupFor("linux", { PSYCHE_CHROMIUM: "/opt/c" }, async () => session);
    if (s === false) throw new Error("off");
    expect(await s.wanted?.()).toBe(true);
    session = true;
    expect(await s.wanted?.()).toBe(false);
    expect(s.executablePath).toBe("/opt/c");
  });

  it("PSYCHE_BROWSER_DRIVER=server forces it on Linux, and the env is a snapshot", async () => {
    const env: NodeJS.ProcessEnv = { PSYCHE_BROWSER_DRIVER: "server", PATH: "/usr/bin" };
    const s = serverBrowserSetupFor("linux", env, graphical(true));
    if (s === false) throw new Error("off");
    expect(await s.wanted?.()).toBe(true);
    env.PATH = "/evil";
    expect(s.env?.PATH).toBe("/usr/bin");
  });
});

describe("findChromium", () => {
  it("prefers PSYCHE_CHROMIUM, then the first installed path, else none", () => {
    expect(findChromium({ PSYCHE_CHROMIUM: "/opt/c/chrome" }, () => true)).toBe("/opt/c/chrome");
    expect(findChromium({}, (p) => p === "/usr/bin/chromium-browser")).toBe(
      "/usr/bin/chromium-browser",
    );
    expect(findChromium({}, (p) => p === CHROMIUM_PATHS[0])).toBe("/usr/bin/chromium");
    expect(findChromium({}, () => false)).toBeUndefined();
  });
});

describe("the server browser's process (review r1, finding 6 / probe P3)", () => {
  const OWNER = {
    PATH: "/usr/bin",
    HOME: "/home/o",
    LANG: "de_DE.UTF-8",
    TZ: "Europe/Berlin",
    XDG_RUNTIME_DIR: "/run/user/1000",
    XDG_CONFIG_HOME: "/home/o/.config",
    DISPLAY: ":0",
    WAYLAND_DISPLAY: "wayland-0",
    XAUTHORITY: "/home/o/.Xauthority",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    SSH_AUTH_SOCK: "/tmp/ssh-agent",
    ANTHROPIC_API_KEY: "sk-test",
  };

  it("gets exactly a private home, private XDG and runtime dirs, and no bus or display", () => {
    expect(serverBrowserEnv(serverBrowserDirs("/srv/ph"), OWNER)).toEqual({
      PATH: "/usr/bin",
      LANG: "de_DE.UTF-8",
      TZ: "Europe/Berlin",
      HOME: "/srv/ph/browser/home",
      XDG_CONFIG_HOME: "/srv/ph/browser/home/.config",
      XDG_CACHE_HOME: "/srv/ph/browser/home/.cache",
      XDG_DATA_HOME: "/srv/ph/browser/home/.local/share",
      XDG_RUNTIME_DIR: "/srv/ph/browser/run",
      DBUS_SESSION_BUS_ADDRESS: "disabled:",
    });
  });

  it("keeps a PATH even when the service has none", () => {
    expect(serverBrowserEnv(serverBrowserDirs("/srv/ph"), {}).PATH).toBe(
      "/usr/local/bin:/usr/bin:/bin",
    );
  });

  it("is headless Chromium with profiles under the Host's PSYCHE_HOME", () => {
    const o = serverDriverOptions({ library: {} as never }, "/srv/ph", "/usr/bin/chromium", OWNER);
    expect(o).toMatchObject({
      mode: "launch",
      headless: true,
      psycheHome: "/srv/ph",
      executablePath: "/usr/bin/chromium",
      chromiumSandbox: true,
    });
    expect(o.env).not.toHaveProperty("DISPLAY");
    expect(o.env).not.toHaveProperty("XAUTHORITY");
  });

  it("makes its private dirs 0700, narrowing a looser one", () => {
    const root = mkdtempSync(join(tmpdir(), "psyche-b3-dirs-"));
    try {
      const dirs = serverBrowserDirs(root);
      mkdirSync(dirs.home, { recursive: true, mode: 0o755 });
      chmodSync(dirs.home, 0o755);
      preparePrivateDirs(dirs);
      for (const d of Object.values(dirs)) expect(statSync(d).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    config: { home, port: 0, dbPath: join(home, "psyche.db") },
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

const serverSetup = (
  fake: Awaited<ReturnType<typeof fakeServerDriver>>,
  more: Partial<ServerBrowserSetup> = {},
): ServerBrowserSetup => ({
  createDriver: fake.createDriver,
  executablePath: "/usr/bin/chromium",
  env: { PATH: "/usr/bin", HOME: "/home/o", DISPLAY: ":0" },
  ...more,
});

describe("the agent browser on a headless Host (headless Chromium)", () => {
  it("offers the tools with no desktop and no helper, and starts Chromium once on first use", async () => {
    const fake = await fakeServerDriver();
    const { services, browser } = await composeServer({ server: serverSetup(fake) });
    expect(services.tools.list().map((t) => t.name)).toEqual(
      expect.arrayContaining(["browser.open_tab", "browser.navigate", "browser.request_control"]),
    );
    expect(services.browserAvailability.check?.()).toEqual({ ok: true });
    expect(browser.driverKind).toBeNull();
    const [a, b] = await Promise.all([
      runTool(services, "browser.open_tab", "call_a", { url: "https://example.com/" }),
      runTool(services, "browser.open_tab", "call_b", { url: "https://example.com/" }),
    ]);
    // One Chromium, however many calls race for it; headless, private env, no display.
    expect(fake.made).toHaveLength(1);
    expect(fake.made[0]).toMatchObject({
      mode: "launch",
      headless: true,
      psycheHome: home,
      executablePath: "/usr/bin/chromium",
      env: {
        HOME: join(home, "browser", "home"),
        XDG_RUNTIME_DIR: join(home, "browser", "run"),
        DBUS_SESSION_BUS_ADDRESS: "disabled:",
      },
    });
    expect(fake.made[0]?.env).not.toHaveProperty("DISPLAY");
    expect(statSync(join(home, "browser", "home")).mode & 0o777).toBe(0o700);
    expect(browser.driverKind).toBe("server");
    expect(browser.serverOnly).toBe(true);
    // Past the start the call met Psyche's own rules, as with the desktop's bridge: an
    // unattended run opening a new site waits for the owner's approval.
    for (const r of [a, b]) {
      expect(r.output).toMatchObject({ error: { code: "approval_required" } });
    }
  });

  it("says honestly that there is no Chromium, in the pre-flight and on the call", async () => {
    const fake = await fakeServerDriver();
    const setup = serverSetup(fake);
    delete setup.executablePath;
    const { services } = await composeServer({ server: setup });
    expect(services.browserAvailability.check?.()).toMatchObject({
      ok: false,
      reason: expect.stringContaining("needs Chromium"),
    });
    const r = await runTool(services, "browser.open_tab", "call_c", {
      url: "https://example.com/",
    });
    expect(r.output).toMatchObject({
      error: { code: "unavailable", details: { reason: "no_chromium" } },
    });
    expect(fake.made).toHaveLength(0);
  });

  it("stays off while logind reports a graphical session (a desktop can serve the bridge)", async () => {
    const fake = await fakeServerDriver();
    const { services, browser } = await composeServer({
      server: serverSetup(fake, { wanted: async () => false }),
    });
    const r = await runTool(services, "browser.open_tab", "call_g", {
      url: "https://example.com/",
    });
    expect(r.output).toMatchObject({ error: { code: "unavailable" } });
    expect(fake.made).toHaveLength(0);
    expect(browser.serverOnly).toBe(false);
  });

  it("routes the owner's tabs to the server driver and opens pages there", async () => {
    const fake = await fakeServerDriver();
    const { services, browser } = await composeServer({ server: serverSetup(fake) });
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

  it("refuses the driver's own take-over in flight: the owner's control stops the agent's actions", async () => {
    const fake = await fakeServerDriver();
    await composeServer({ server: serverSetup(fake) });
    const driver = fake.drivers[0];
    expect(driver).toBeUndefined();
    // The CDP take-over (`controlState: "user"`) is the driver's, per session, and every agent
    // action checks it (`assertAgent`), on the server driver as on the bridge.
    const { createDriver } = fake;
    const d = createDriver({} as PlaywrightDriverOptions);
    const url = desktop?.browser.url("a/") ?? "";
    const port = Number(new URL(url).port);
    const s = await d.openSession({
      policy: { devPreview: true, loopbackPorts: [port], readWritable: [new URL(url).origin] },
    });
    const tab = await d.openTab(s.id, url);
    await d.setControlState(s.id, "user");
    await expect(d.navigate(tab.id, url)).rejects.toMatchObject({
      details: { reason: "user_in_control" },
    });
  });

  it("has no pane to hand control in yet: browser.request_control says so (no_pane)", async () => {
    const fake = await fakeServerDriver();
    const { services } = await composeServer({ server: serverSetup(fake) });
    await runTool(services, "browser.open_tab", "call_r0", { url: "https://example.com/" });
    const r = await runTool(services, "browser.request_control", "call_r", {
      tabId: "t_missing",
      reason: "sign in",
    });
    expect(JSON.stringify(r.output)).not.toContain("computer-watch");
    expect(r.output).toMatchObject({ error: {} });
  });

  it("hands over to a desktop's bridge when one connects", async () => {
    const fake = await fakeServerDriver();
    const { services, browser } = await composeServer({ server: serverSetup(fake) });
    await runTool(services, "browser.open_tab", "call_h", { url: "https://example.com/" });
    expect(browser.driverKind).toBe("server");
    const other = new MockDesktop({ quarantineDir: "" });
    browser.attach(await other.connect());
    expect(browser.driverKind).toBe("bridge");
    expect(browser.serverOnly).toBe(false);
    expect(fake.disposed()).toBe(1);
    other.disconnect();
  });

  it("stays off when the setup says so (a desktop Host keeps the bridge only)", async () => {
    const { services, browser } = await composeServer({ server: false });
    expect(services.tools.list().filter((t) => t.name.startsWith("browser."))).toEqual([]);
    expect(browser.driverKind).toBeNull();
    expect(browser.serverOnly).toBe(false);
  });
});

describe("checkout on a headless Host (review r1, finding 9)", () => {
  it("refuses before any card while only the server driver could serve, and says why", () => {
    let serverOnly = true;
    const tool = createPurchaseTool({
      payments: {} as never,
      driver: () => undefined,
      unavailable: () => (serverOnly ? checkoutNeedsDesktop() : undefined),
      ownsTab: async () => undefined,
      calls: {} as never,
      approvals: { get: async () => undefined },
      redactor: {} as never,
    });
    const describe = (tool as { describeCall?: (p: unknown) => unknown }).describeCall;
    expect(() => describe?.({ tabId: "t1" })).toThrow(
      expect.objectContaining({
        code: "unavailable",
        details: { reason: "checkout_needs_desktop" },
      }),
    );
    serverOnly = false;
    expect(describe?.({ tabId: "t1" })).toMatchObject({
      kind: "purchase",
      sideEffect: "financial",
    });
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

  it("lets a paired desktop app watch with operator.write, and act for the owner with approvals too", () => {
    db = openDb(":memory:");
    const mac = device("desktop");
    for (const m of ["computerWatch.status", "computerWatch.frame"]) {
      expect(() => watchAccess(call(mac, WRITE, m))).not.toThrow();
    }
    for (const m of [
      "computerWatch.takeOver",
      "computerWatch.input",
      "computerWatch.stop",
      "computerWatch.resolveParked",
    ]) {
      expect(() => watchAccess(call(mac, WRITE, m))).toThrow(/operator\.approvals/);
      expect(() => watchAccess(call(mac, ALL, m))).not.toThrow();
    }
    expect(() => watchAccess(call(mac, ["operator.read"], "computerWatch.status"))).toThrow(
      /operator\.write/,
    );
  });

  it("P5: force-stop and Discard need operator.approvals", () => {
    db = openDb(":memory:");
    const id = insertDevice(db, {
      name: "d",
      platform: "macos",
      role: "client",
      publicKey: Buffer.alloc(32, 7),
      scopes: WRITE,
      pairedAt: new Date().toISOString(),
      deviceFamily: "desktop",
    }).id;
    for (const m of ["computerWatch.resolveParked", "computerWatch.stop"]) {
      expect(() =>
        watchAccess({
          ctx: { db } as never,
          identity: { deviceId: id, scopes: WRITE, role: "client" } as never,
          method: m,
        }),
      ).toThrow(/operator\.approvals/);
    }
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
    [{ PSYCHE_PAYMENT_PRESENCE: "passkey" }, true],
    [{ PSYCHE_PAYMENT_PRESENCE: " Passkey " }, true],
    [{ PSYCHE_PAYMENT_PRESENCE: "touchid" }, false],
    [{}, false],
  ] as const)("passkeyPresenceForced(%j) -> %s", (env, want) => {
    expect(passkeyPresenceForced(env as NodeJS.ProcessEnv)).toBe(want);
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
    passkeyOnly: async () => passkeyOnly,
    hasPasskey: () => hasPasskey,
  });

  it.each(PAYMENTS)("a payment (%j) with no passkey fails presence_required", async (input) => {
    await expect(checkPaymentPresence(input as never, rule(true, false))).rejects.toMatchObject({
      code: "presence_required",
      details: { reason: "passkey_required" },
      message: expect.stringContaining("Set up a passkey to approve payments on this Psyche"),
    });
  });

  it.each(PAYMENTS)("a payment (%j) with a passkey raises its card", async (input) => {
    await expect(checkPaymentPresence(input as never, rule(true, true))).resolves.toBeUndefined();
  });

  it.each(ORDINARY)("an ordinary approval (%j) stays a tap, passkey or not", async (input) => {
    await expect(checkPaymentPresence(input as never, rule(true, false))).resolves.toBeUndefined();
  });

  it.each(PAYMENTS)("a Host with someone at it is unchanged (%j)", async (input) => {
    await expect(checkPaymentPresence(input as never, rule(false, false))).resolves.toBeUndefined();
  });

  it("judges the class the broker decided, not the one the request declares", async () => {
    const raised: unknown[] = [];
    const inner = {
      decide: async () => ({
        decision: "ask",
        rule: "mode:balanced/financial",
        bindingHash: "b-floored",
        sideEffect: "financial",
      }),
      requestApproval: async (input: unknown) => {
        raised.push(input);
        return { approval: {} };
      },
    } as unknown as PermissionBroker;
    const b = withPaymentPresence(inner, rule(true, false));
    await b.decide({} as never, {} as never);
    const req = (bindingHash: string) =>
      ({ kind: "tool_call", sideEffect: "write", bindingHash }) as never;
    await expect(b.requestApproval(req("b-floored"))).rejects.toMatchObject({
      code: "presence_required",
    });
    expect(raised).toEqual([]);
    // Another binding the broker did not floor stays a tap.
    await b.requestApproval(req("b-other"));
    expect(raised).toHaveLength(1);
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

  it("denies Psyche's own Linux files: its home, browser dirs, helper state, screen cookies", () => {
    const fs = profile("linux");
    expect(fs.denyRead).toEqual(
      expect.arrayContaining([
        "/home/o/.psyche",
        "/home/o/.psyche/vault",
        "/home/o/.psyche/browser/profiles",
        "/home/o/.psyche/browser/home",
        "/home/o/.psyche/browser/run",
        "/home/o/.local/state/psyche-helper",
        "/home/o/.xdg-state/psyche-helper",
        "/run/user/1000/psyche",
        "/home/o/.config/Psyche",
      ]),
    );
    expect(fs.denyWrite).toContain("/home/o/.psyche");
  });

  it("ignores a relative XDG base, and adds none of it on macOS", () => {
    const none: LinuxDenyFs = {
      lstat: () => {
        throw new Error("ENOENT");
      },
      mkdir: () => undefined,
      readdir: () => [],
    };
    expect(
      linuxPsycheDenyRead("/home/o", { XDG_RUNTIME_DIR: "run", XDG_STATE_HOME: "" }, { fs: none }),
    ).toEqual(["/home/o/.local/state/psyche-helper", "/home/o/.config/Psyche"]);
    const mac = profile("darwin").denyRead;
    expect(mac).not.toContain("/run/user/1000/psyche");
    expect(mac).not.toContain(join("/home/o", ".config", "chromium"));
  });

  it("makes $XDG_RUNTIME_DIR/psyche before the helper does, so srt masks it from the start", () => {
    const made: [string, number][] = [];
    const fsWith = (parent: { uid: number; mode: number; dir?: boolean }): LinuxDenyFs => ({
      lstat: () => ({ isDirectory: () => parent.dir !== false, ...parent }),
      mkdir: (p, mode) => void made.push([p, mode]),
      readdir: () => [],
    });
    const env = { XDG_RUNTIME_DIR: "/run/user/1000" };
    expect(
      linuxPsycheDenyRead("/home/o", env, { fs: fsWith({ uid: 1000, mode: 0o40700 }), uid: 1000 }),
    ).toContain("/run/user/1000/psyche");
    expect(made).toEqual([["/run/user/1000/psyche", 0o700]]);
    // Never in another account's runtime dir, one others can write, or through a link.
    for (const parent of [
      { uid: 1001, mode: 0o40700 },
      { uid: 1000, mode: 0o40777 },
      { uid: 1000, mode: 0o120777, dir: false },
    ]) {
      made.length = 0;
      const deny = linuxPsycheDenyRead("/home/o", env, { fs: fsWith(parent), uid: 1000 });
      expect(made).toEqual([]);
      // Still listed: masked whenever it exists.
      expect(deny).toContain("/run/user/1000/psyche");
    }
  });

  it("lists the helper's temp-dir fallback screens (srt has no globs)", () => {
    const fs: LinuxDenyFs = {
      lstat: () => {
        throw new Error("ENOENT");
      },
      mkdir: () => undefined,
      readdir: (dir) =>
        dir === "/tmp"
          ? ["psyche-vscreen-f0000098.3e8.1a2b3c-Ab12Cd", "other", "psyche-vscreenX"]
          : dir === "/var/tmp/me"
            ? ["psyche-vscreen-1.2.3-XyZ987"]
            : [],
    };
    const deny = linuxPsycheDenyRead("/home/o", { TMPDIR: "/var/tmp/me" }, { fs });
    expect(deny).toEqual(
      expect.arrayContaining([
        "/tmp/psyche-vscreen-f0000098.3e8.1a2b3c-Ab12Cd",
        "/var/tmp/me/psyche-vscreen-1.2.3-XyZ987",
      ]),
    );
    expect(deny).not.toContain("/tmp/other");
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
      config: { home, port: 0, dbPath: join(home, "psyche.db") },
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
