import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRegistration, ToolRegistry, ToolResult } from "@psyche/protocol";
import { FakeCredentialBroker, FakePermissionBroker } from "@psyche/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsQuarantineWriter } from "../src/downloads/library.ts";
import { CdpBridgeDriver } from "../src/drivers/cdp.ts";
import { PartitionChooser, type PartitionMode } from "../src/origin/partition.ts";
import { MockDesktop } from "../src/testing/mock-desktop.ts";
import type { CallContext } from "../src/tools/gate.ts";
import { registerBrowserTools } from "../src/tools/register.ts";

/**
 * Narrowing the sign-in mode or the signed-in sites reaches tabs opened later in a session that
 * is already open: the chooser reads both on every choice, the way it reads the detected sites.
 */

describe("PartitionChooser reads the mode and the sites on every choice", () => {
  it("profile narrowed to clean: a later tab is clean, and so is the session default", () => {
    let mode: PartitionMode = "profile";
    const c = new PartitionChooser({ mode: () => mode });
    expect(c.choose("https://a.example/").partition).toBe("profile");
    expect(c.defaultPartition).toBe("profile");
    mode = "clean";
    expect(c.choose("https://a.example/")).toMatchObject({
      partition: "clean",
      reason: "task_clean",
    });
    expect(c.defaultPartition).toBe("clean");
  });

  it("auto: a site removed from the list stops opening in the profile", () => {
    let sites = ["https://a.example", "https://b.example"];
    const c = new PartitionChooser({ mode: "auto", signedInOrigins: () => sites });
    expect(c.choose("https://a.example/").partition).toBe("profile");
    sites = ["https://b.example"];
    expect(c.choose("https://a.example/").partition).toBe("clean");
    expect(c.choose("https://b.example/").partition).toBe("profile");
    // A positive control for the widening direction.
    sites = ["https://a.example", "https://b.example"];
    expect(c.choose("https://a.example/").partition).toBe("profile");
  });

  it("a static policy still works", () => {
    const c = new PartitionChooser({ mode: "auto", signedInOrigins: ["https://a.example"] });
    expect(c.choose("https://a.example/").partition).toBe("profile");
    expect(c.choose("https://b.example/").partition).toBe("clean");
  });

  it.each(["https://a..b", "https://x.com..", "https://.x.com", "", "https://*."])(
    "skips the stored entry %j and keeps the others",
    (bad) => {
      const c = new PartitionChooser({
        mode: "auto",
        signedInOrigins: [bad, "https://good.example"],
      });
      expect(c.choose("https://good.example/").partition).toBe("profile");
      expect(c.choose("https://other.example/").partition).toBe("clean");
      expect(c.isSignedIn("https://a.b/")).toBe(false);
    },
  );
});

describe("an open session follows the getters", () => {
  let dir = "";
  let desktop: MockDesktop;
  let driver: CdpBridgeDriver;
  let mode: PartitionMode = "profile";
  let sites: string[] = [];
  let sessionId = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "psyche-partition-live-"));
    desktop = new MockDesktop({ quarantineDir: dir });
    driver = new CdpBridgeDriver(await desktop.connect(), {
      library: new FsQuarantineWriter(join(dir, "lib")),
    });
    sessionId = (
      await driver.openSession({
        taskId: "task_live",
        partition: () => mode,
        signedInOrigins: () => sites,
        policy: {
          devPreview: true,
          readWritable: [desktop.browser.origin("a"), desktop.browser.origin("b")],
        },
      })
    ).id;
  });
  afterAll(async () => {
    driver.dispose();
    desktop.disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("profile narrowed to clean: a new tab in the same session is clean", async () => {
    mode = "profile";
    expect((await driver.openTab(sessionId, desktop.browser.url("a/"))).partition).toBe("profile");
    mode = "clean";
    expect((await driver.openTab(sessionId, desktop.browser.url("a/"))).partition).toBe("clean");
  });

  it("auto: a site removed from the list opens clean in the same session", async () => {
    mode = "auto";
    sites = [desktop.browser.origin("a")];
    expect((await driver.openTab(sessionId, desktop.browser.url("a/"))).partition).toBe("profile");
    sites = [];
    expect((await driver.openTab(sessionId, desktop.browser.url("a/"))).partition).toBe("clean");
  });
});

class Registry implements ToolRegistry {
  readonly tools = new Map<string, ToolRegistration>();
  list() {
    return [...this.tools.values()].map((t) => t.spec);
  }
  get(name: string) {
    return this.tools.get(name);
  }
  register(r: ToolRegistration) {
    this.tools.set(r.spec.name, r);
    return () => this.tools.delete(r.spec.name);
  }
}

describe("tabs that were already open when the owner narrowed", () => {
  let dir = "";
  let desktop: MockDesktop;
  let driver: CdpBridgeDriver;
  let mode: PartitionMode = "profile";
  let sites: string[] = [];
  let sessionId = "";
  const registry = new Registry();
  const ctx: CallContext = {
    toolCallId: "call_1",
    threadId: "thr_1",
    runId: "run_1",
    taskId: "task_narrow",
    permissionMode: "balanced",
    taint: true,
  };
  const call = async (name: string, params: unknown): Promise<ToolResult> => {
    const t = registry.get(name);
    if (t === undefined) throw new Error(`no tool ${name}`);
    return t.execute("call_1", params, new AbortController().signal, () => {});
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "psyche-partition-narrow-"));
    desktop = new MockDesktop({ quarantineDir: dir });
    driver = new CdpBridgeDriver(await desktop.connect(), {
      library: new FsQuarantineWriter(join(dir, "lib")),
    });
    sessionId = (
      await driver.openSession({
        taskId: "task_narrow",
        partition: () => mode,
        signedInOrigins: () => sites,
        policy: {
          devPreview: true,
          readWritable: [desktop.browser.origin("a"), desktop.browser.origin("b")],
        },
      })
    ).id;
    registerBrowserTools(registry, {
      driver,
      broker: FakePermissionBroker.policy({ default: "allow" }),
      credentials: new FakeCredentialBroker(),
      context: () => ctx,
      session: async () => sessionId,
      containsSecret: () => false,
      requestControl: async () => () => undefined,
    });
  });
  afterAll(async () => {
    driver.dispose();
    desktop.disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("an old profile tab that navigates after narrowing to clean ends up clean", async () => {
    mode = "profile";
    const old = await driver.openTab(sessionId, desktop.browser.url("a/"));
    expect(old.partition).toBe("profile");
    mode = "clean";
    const nav = await call("browser.navigate", { tabId: old.id, url: desktop.browser.url("b/") });
    const out = nav.output as { tabId: string };
    expect(out.tabId).not.toBe(old.id);
    expect(driver.tabPartition(out.tabId)).toBe("clean");
    expect((await driver.listTabs(sessionId)).some((t) => t.id === old.id)).toBe(false);
  });

  it("positive control: a profile tab whose site is still listed keeps its sign-ins", async () => {
    mode = "auto";
    sites = [desktop.browser.origin("a"), desktop.browser.origin("b")];
    const tab = await driver.openTab(sessionId, desktop.browser.url("a/"));
    expect(tab.partition).toBe("profile");
    const nav = await call("browser.navigate", { tabId: tab.id, url: desktop.browser.url("b/") });
    expect((nav.output as { tabId?: string }).tabId ?? tab.id).toBe(tab.id);
    expect(driver.tabPartition(tab.id)).toBe("profile");
  });

  it("a site removed in auto: the old profile tab moves to clean on navigate", async () => {
    mode = "auto";
    sites = [desktop.browser.origin("a")];
    const tab = await driver.openTab(sessionId, desktop.browser.url("a/"));
    expect(tab.partition).toBe("profile");
    sites = [];
    const nav = await call("browser.navigate", { tabId: tab.id, url: desktop.browser.url("a/x") });
    expect(driver.tabPartition((nav.output as { tabId: string }).tabId)).toBe("clean");
  });

  it("closeTightenedTabs closes the profile tabs that are now clean and keeps the others", async () => {
    mode = "auto";
    sites = [desktop.browser.origin("a"), desktop.browser.origin("b")];
    const a = await driver.openTab(sessionId, desktop.browser.url("a/"));
    const b = await driver.openTab(sessionId, desktop.browser.url("b/"));
    expect([a.partition, b.partition]).toEqual(["profile", "profile"]);
    // Nothing tightened yet: nothing closes.
    expect(await driver.closeTightenedTabs()).toEqual([]);
    sites = [desktop.browser.origin("b")];
    expect(await driver.closeTightenedTabs()).toEqual([a.id]);
    const open = (await driver.listTabs(sessionId)).map((t) => t.id);
    expect(open).not.toContain(a.id);
    expect(open).toContain(b.id);
    await expect(async () => driver.navigate(a.id, desktop.browser.url("a/"))).rejects.toThrow(
      /sign-in settings were tightened/,
    );
  });

  it("narrowing to clean closes every profile tab", async () => {
    mode = "profile";
    const tab = await driver.openTab(sessionId, desktop.browser.url("a/"));
    mode = "clean";
    expect(await driver.closeTightenedTabs()).toContain(tab.id);
  });
});
