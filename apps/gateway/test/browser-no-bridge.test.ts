import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockDesktop } from "@psyche/browser/testing";
import { setSetting } from "@psyche/db";
import type { ToolResult } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ComposedBrowser,
  type ComposedGateway,
  type ComposeServices,
  composeBrowser,
  composeGateway,
} from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";

/**
 * Background browser for unattended runs: tools stay registered with no window, the Gateway
 * starts the app and waits for the bridge, and a failure is clear. Earlier: #556: with no desktop app (no browser bridge) an approved `browser.open_tab` hung for minutes.
 * The tools are now offered only while a desktop is connected (or real-Chrome mode is on), and a
 * call that races a disconnect fails at once with `unavailable`.
 */
let home = "";
let composed: ComposedGateway | null = null;
let desktop: MockDesktop | undefined;
afterEach(async () => {
  desktop?.disconnect();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function compose(): Promise<{ services: ComposeServices; browser: ComposedBrowser }> {
  home = mkdtempSync(join(tmpdir(), "psyche-nobridge-"));
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
        browser = composeBrowser(s, { socketPath: false });
        return browser;
      },
    ],
  });
  if (services === undefined || browser === undefined) throw new Error("not composed");
  return { services, browser };
}

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function composeWith(setup: Parameters<typeof composeBrowser>[1]) {
  home = mkdtempSync(join(tmpdir(), "psyche-bgbrowser-"));
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

/** An unattended run's context for one tool call. */
const unattended = (callId: string): never =>
  ({
    callId,
    threadId: "thr_bg",
    runId: "run_bg",
    permissionMode: "default",
    taint: false,
    mode: "unattended",
    signal: new AbortController().signal,
    onUpdate: () => {},
  }) as never;

const runTool = async (s: ComposeServices, name: string, callId: string, params: unknown) => {
  const reg = s.tools.get(name) as { run?: (p: unknown, c: never) => Promise<ToolResult> };
  if (reg?.run === undefined) throw new Error(`${name} is not an in-process tool`);
  return reg.run(params, unattended(callId));
};

const names = (s: ComposeServices) =>
  s.tools
    .list()
    .map((t) => t.name)
    .filter((n) => n.startsWith("browser."));

describe("browser for unattended runs", () => {
  it("keeps the tools registered with no desktop connected when the app can be launched", async () => {
    const { services } = await composeWith({ launchDesktop: async () => {} });
    expect(names(services)).toEqual(expect.arrayContaining(["browser.open_tab"]));
  });

  it("launches the app and waits for the bridge, then runs the tool end to end", async () => {
    let launches = 0;
    let browserRef: ComposedBrowser | undefined;
    desktop = new MockDesktop({ quarantineDir: "" });
    const { services, browser } = await composeWith({
      launchDesktop: async () => {
        launches += 1;
        // The app starts and its bridge connects a moment later.
        setTimeout(() => {
          void desktop?.connect().then((b) => browserRef?.attach(b));
        }, 30);
      },
    });
    browserRef = browser;
    expect(browser.driver).toBeUndefined();
    const [a, b] = await Promise.all([
      runTool(services, "browser.open_tab", "call_a", { url: "https://example.com/" }),
      runTool(services, "browser.open_tab", "call_b", { url: "https://example.com/" }),
    ]);
    expect(launches).toBe(1);
    expect(browser.driver).toBeDefined();
    // Past the launch the call reached the driver and Psyche's own rules: an unattended run
    // opening a new site waits for the owner's approval; it is not "no browser".
    for (const r of [a, b]) {
      expect(r.output).toMatchObject({ error: { code: "approval_required" } });
    }
  });

  it("fails clearly when the app does not connect in time", async () => {
    const { services } = await composeWith({ launchDesktop: async () => {}, desktopWaitMs: 50 });
    const r = await runTool(services, "browser.open_tab", "call_t", {
      url: "https://example.com/",
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.output)).toContain("Psyche's browser couldn't start");
    expect(r.output).toMatchObject({
      error: { code: "unavailable", details: { reason: "browser_unavailable" } },
    });
  });

  it("fails with the launcher's reason when the app cannot be started", async () => {
    const { services } = await composeWith({
      launchDesktop: async () => {
        throw new Error("Unable to find application named 'Psyche'");
      },
    });
    const r = await runTool(services, "browser.open_tab", "call_l", {
      url: "https://example.com/",
    });
    expect(JSON.stringify(r.output)).toContain(
      "Psyche's browser couldn't start: Unable to find application named",
    );
  });
});

const browserTools = (s: ComposeServices) =>
  s.tools
    .list()
    .map((t) => t.name)
    .filter((n) => n.startsWith("browser."));

describe("browser tools without the desktop app (#556)", () => {
  it("are not offered until a desktop connects, and go away when it does", async () => {
    const { services, browser } = await compose();
    expect(browserTools(services)).toEqual([]);
    desktop = new MockDesktop({ quarantineDir: home });
    const bridge = await desktop.connect();
    browser.attach(bridge);
    expect(browserTools(services)).toEqual(
      expect.arrayContaining(["browser.open_tab", "browser.navigate"]),
    );
    // The desktop quits: its socket closes.
    bridge.close();
    await until(() => browserTools(services).length === 0);
  });

  it("fail within seconds, saying the desktop app must be open, if a call races a disconnect", async () => {
    const { services, browser } = await compose();
    desktop = new MockDesktop({ quarantineDir: home });
    const bridge = await desktop.connect();
    browser.attach(bridge);
    // What the loop held before the desktop quit.
    const openTab = services.tools.get("browser.open_tab");
    expect(openTab).toBeDefined();
    bridge.close();
    await until(() => browser.driver === undefined);
    const t0 = Date.now();
    const r = (await openTab?.execute(
      "call_nobridge",
      { url: "https://example.com/" },
      new AbortController().signal,
      () => {},
    )) as ToolResult;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r).toMatchObject({
      isError: true,
      output: { error: { code: "unavailable", details: { reason: "no_desktop" } } },
    });
    expect(JSON.stringify(r.output)).toContain("desktop app");
  });

  it("are offered without a desktop while real-Chrome mode is on", async () => {
    const { services } = await compose();
    expect(browserTools(services)).toEqual([]);
    const entry = setSetting(composed?.db as never, "browser.realChrome", { enabled: true });
    services.publish("settings.changed", { entries: [entry] });
    await until(() => browserTools(services).includes("browser.use_real_chrome"));
    const off = setSetting(composed?.db as never, "browser.realChrome", { enabled: false });
    services.publish("settings.changed", { entries: [off] });
    await until(() => browserTools(services).length === 0);
  });
});
