import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRegistration, ToolRegistry, ToolResult } from "@psyche/protocol";
import { FakeCredentialBroker, FakePermissionBroker } from "@psyche/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FsQuarantineWriter } from "../src/downloads/library.ts";
import { CdpBridgeDriver } from "../src/drivers/cdp.ts";
import { PartitionChooser } from "../src/origin/partition.ts";
import { MockDesktop } from "../src/testing/mock-desktop.ts";
import type { CallContext } from "../src/tools/gate.ts";
import { registerBrowserTools } from "../src/tools/register.ts";

describe("PartitionChooser with detected sessions", () => {
  const profile = (domains: string[], on = true, signedInOrigins: string[] = []) =>
    new PartitionChooser({
      mode: "auto",
      signedInOrigins,
      detectedDomains: () => domains,
      useSignedInSessions: () => on,
    });

  it("uses the profile for the site and its SSO host when the profile has cookies for ucsc.edu", () => {
    const c = profile(["ucsc.edu"]);
    expect(c.choose("https://canvas.ucsc.edu/courses")).toMatchObject({
      partition: "profile",
      reason: "detected_session",
    });
    expect(c.choose("https://login.ucsc.edu/idp/profile/SAML2/Redirect/SSO").partition).toBe(
      "profile",
    );
  });

  it("stays clean with no cookies, for another site, and for a blank tab", () => {
    expect(profile([]).choose("https://canvas.ucsc.edu/").partition).toBe("clean");
    expect(profile(["ucsc.edu"]).choose("https://example.com/").partition).toBe("clean");
    expect(profile(["ucsc.edu"]).choose(undefined).partition).toBe("clean");
  });

  it("stays clean when the setting is off, but a Stay-signed-in origin still counts", () => {
    expect(profile(["ucsc.edu"], false).choose("https://canvas.ucsc.edu/").partition).toBe("clean");
    expect(
      profile(["ucsc.edu"], false, ["https://canvas.ucsc.edu"]).choose("https://canvas.ucsc.edu/")
        .reason,
    ).toBe("signed_in");
  });

  it("reads the cookie list and the setting on every choice", () => {
    const domains: string[] = [];
    let on = true;
    const c = new PartitionChooser({
      mode: "auto",
      detectedDomains: () => domains,
      useSignedInSessions: () => on,
    });
    expect(c.choose("https://canvas.ucsc.edu/").partition).toBe("clean");
    domains.push("ucsc.edu");
    expect(c.choose("https://canvas.ucsc.edu/").partition).toBe("profile");
    on = false;
    expect(c.choose("https://canvas.ucsc.edu/").partition).toBe("clean");
  });

  it("never lets a task's explicit clean mode use the profile", () => {
    const c = new PartitionChooser({ mode: "clean", detectedDomains: () => ["ucsc.edu"] });
    expect(c.choose("https://canvas.ucsc.edu/").partition).toBe("clean");
    expect(c.prefersProfile("https://canvas.ucsc.edu/")).toBe(false);
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

describe("agent tabs and the profile", () => {
  let dir: string;
  let desktop: MockDesktop;
  let driver: CdpBridgeDriver;
  // The mock sites are site-a.localhost and site-b.localhost: two sites to the chooser.
  const domains: string[] = [];
  let on = true;
  const registry = new Registry();
  const ctx: CallContext = {
    toolCallId: "call_1",
    threadId: "thr_1",
    runId: "run_1",
    taskId: "task_1",
    permissionMode: "balanced",
    taint: true,
  };
  let sessionId = "";
  const call = async (name: string, params: unknown): Promise<ToolResult> => {
    const t = registry.get(name);
    if (t === undefined) throw new Error(`no tool ${name}`);
    return t.execute("call_1", params, new AbortController().signal, () => {});
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "psyche-detected-"));
    desktop = new MockDesktop({ quarantineDir: dir });
    driver = new CdpBridgeDriver(await desktop.connect(), {
      library: new FsQuarantineWriter(join(dir, "lib")),
    });
    sessionId = (
      await driver.openSession({
        taskId: "task_1",
        partition: "auto",
        detectedDomains: () => domains,
        useSignedInSessions: () => on,
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

  it("opens a clean tab with no cookies and a profile tab once the profile has them", async () => {
    domains.length = 0;
    const clean = await driver.openTab(sessionId, desktop.browser.url("a/"));
    expect(clean.partition).toBe("clean");
    domains.push("site-a.localhost");
    const signedIn = await driver.openTab(sessionId, desktop.browser.url("a/"));
    expect(signedIn.partition).toBe("profile");
    on = false;
    expect((await driver.openTab(sessionId, desktop.browser.url("a/"))).partition).toBe("clean");
    on = true;
    // Site B has no session in the profile, so it stays clean.
    expect((await driver.openTab(sessionId, desktop.browser.url("b/"))).partition).toBe("clean");
  });

  it("keeps SSO hops in the profile", async () => {
    domains.length = 0;
    domains.push("site-a.localhost");
    const tab = await driver.openTab(sessionId, desktop.browser.url("a/"));
    await driver.navigate(tab.id, desktop.browser.url("b/landing"));
    expect(driver.tabPartition(tab.id)).toBe("profile");
  });

  it("moves a blank clean tab to the profile when it navigates to a signed-in site", async () => {
    domains.length = 0;
    const blank = await driver.openTab(sessionId);
    expect(blank.partition).toBe("clean");
    domains.push("site-a.localhost");
    const nav = await call("browser.navigate", {
      tabId: blank.id,
      url: desktop.browser.url("a/"),
    });
    const out = nav.output as { tabId: string };
    expect(out.tabId).not.toBe(blank.id);
    expect(driver.tabPartition(out.tabId)).toBe("profile");
    expect((await driver.listTabs(sessionId)).some((t) => t.id === blank.id)).toBe(false);
  });

  it("retries once in the profile after a 401 in a clean tab", async () => {
    domains.length = 0;
    const blank = await driver.openTab(sessionId);
    const spy = vi.spyOn(driver, "navigate").mockImplementationOnce(async (id, url) => {
      // The owner's session shows up while the page loads; the page answers 401.
      domains.push("site-a.localhost");
      return { url, title: "Unauthorized", status: 401 };
    });
    const nav = await call("browser.navigate", {
      tabId: blank.id,
      url: desktop.browser.url("a/"),
    });
    spy.mockRestore();
    const out = nav.output as { tabId: string };
    expect(out.tabId).not.toBe(blank.id);
    expect(driver.tabPartition(out.tabId)).toBe("profile");
  });

  it("does not retry a 401 when the setting is off", async () => {
    domains.length = 0;
    domains.push("site-a.localhost");
    on = false;
    const blank = await driver.openTab(sessionId);
    const spy = vi
      .spyOn(driver, "navigate")
      .mockResolvedValue({ url: desktop.browser.url("a/"), title: "Unauthorized", status: 401 });
    const nav = await call("browser.navigate", {
      tabId: blank.id,
      url: desktop.browser.url("a/"),
    });
    spy.mockRestore();
    on = true;
    expect((nav.output as { status: number }).status).toBe(401);
    expect(driver.tabPartition(blank.id)).toBe("clean");
  });
});
