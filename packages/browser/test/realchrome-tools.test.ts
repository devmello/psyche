import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverSession, ToolRegistration, ToolRegistry, ToolResult } from "@psyche/protocol";
import { FakePermissionBroker } from "@psyche/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsQuarantineWriter } from "../src/downloads/library.ts";
import { CdpBridgeDriver } from "../src/drivers/cdp.ts";
import { createRoutingDriver, type RoutingDriver } from "../src/drivers/routing.ts";
import { OriginPolicy } from "../src/origin/policy.ts";
import { MockDesktop } from "../src/testing/mock-desktop.ts";
import type { CallContext } from "../src/tools/gate.ts";
import { registerBrowserTools } from "../src/tools/register.ts";
import type { DriverEventEx } from "../src/types.ts";

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

describe("real-Chrome mode over the routing driver (I13)", () => {
  let dir: string;
  let pane: MockDesktop;
  let chrome: MockDesktop;
  let paneDriver: CdpBridgeDriver;
  let chromeDriver: CdpBridgeDriver;
  let router: RoutingDriver;
  const registry = new Registry();
  const broker = FakePermissionBroker.policy({ default: "allow" }, { armDelayMs: 0 });
  /** The owner on their device: approves every card as it is issued, and we count them. */
  const cards: { kind: string; deviceOnly?: boolean; scopesOffered?: string[] }[] = [];
  const issue = broker.requestApproval.bind(broker);
  broker.requestApproval = async (input) => {
    const issued = await issue(input);
    cards.push(issued.approval);
    const surface = (Object.keys(issued.answerTokens)[0] ?? "desktop") as "desktop";
    setTimeout(
      () =>
        void broker
          .answer({
            approvalId: issued.approval.id,
            answerToken: issued.answerTokens[surface] ?? "",
            decision: "approve",
            scope: "once",
            decidedBy: { deviceId: "dev_owner", surface },
          })
          .catch(() => undefined),
      5,
    );
    return issued;
  };
  const policy = new OriginPolicy({ devPreview: true });
  let webSession = "";
  let realSession: DriverSession | undefined;
  const events: DriverEventEx[] = [];
  const ctx: CallContext = {
    toolCallId: "call_1",
    threadId: "thr_1",
    runId: "run_1",
    taskId: "task_rc",
    permissionMode: "balanced",
    taint: false,
  };
  const call = async (name: string, params: unknown): Promise<ToolResult> => {
    const t = registry.get(name);
    if (t === undefined) throw new Error(`no tool ${name}`);
    return t.execute("call_1", params, new AbortController().signal, () => {});
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "psyche-s08-rc-"));
    pane = new MockDesktop({ quarantineDir: dir });
    chrome = new MockDesktop({ quarantineDir: dir });
    const library = new FsQuarantineWriter(join(dir, "lib"));
    paneDriver = new CdpBridgeDriver(await pane.connect(), { library });
    chromeDriver = new CdpBridgeDriver(await chrome.connect(), { library, downloads: "deny" });
    router = createRoutingDriver(() => paneDriver);
    router.onEventEx((e) => events.push(e));
    webSession = (await router.openSession({ taskId: "task_rc", policy })).id;
    registerBrowserTools(registry, {
      driver: router,
      broker,
      context: () => ctx,
      session: async () => webSession,
      openSessions: async () => [
        webSession,
        ...(realSession === undefined ? [] : [realSession.id]),
      ],
      taskPolicy: () => policy,
      realChrome: {
        attached: () => realSession?.id,
        async attach() {
          router.attach("real_chrome", chromeDriver);
          realSession = await router.openSessionOn("real_chrome", {
            taskId: "task_rc",
            partition: "profile",
            policy,
          });
          return realSession.id;
        },
        async detach() {
          if (realSession === undefined) return false;
          await router.closeSession(realSession.id);
          realSession = undefined;
          router.detach("real_chrome");
          return true;
        },
        owns: (tabId) => router.ownerOf(tabId) === "real_chrome",
      },
    });
  });
  afterAll(async () => {
    paneDriver.dispose();
    chromeDriver.dispose();
    pane.disconnect();
    chrome.disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("asks once per session as a device-only policy change, then opens the tab in real Chrome", async () => {
    const asked = () =>
      broker.decisions.filter(
        (d) => d.call.tool === "browser.use_real_chrome" && d.call.kind === "policy_change",
      );
    const desc = registry.get("browser.use_real_chrome")?.describeCall?.({
      url: chrome.browser.url("a/login"),
      reason: "1Password signs you in there",
    });
    expect(desc).toMatchObject({
      sideEffect: "destructive",
      kind: "policy_change",
      target: { kind: "app", value: "chrome" },
    });
    expect(desc?.summary).toContain("1Password signs you in there");

    const first = await call("browser.use_real_chrome", {
      url: chrome.browser.url("a/login"),
      reason: "1Password signs you in there",
    });
    expect(first.isError).toBeUndefined();
    const tabId = (first.output as { tab: { id: string } }).tab.id;
    expect(asked()).toHaveLength(1);
    expect(asked()[0]?.call).toMatchObject({ kind: "policy_change", sideEffect: "destructive" });
    // One consent card, device-only, never a standing grant (the real broker narrows
    // policy_change to once; the integration test checks that).
    const consent = cards.filter((c) => c.kind === "policy_change");
    expect(consent).toHaveLength(1);
    expect(consent[0]?.deviceOnly).toBe(true);
    for (const standing of ["site", "session", "always"]) {
      expect(consent[0]?.scopesOffered).not.toContain(standing);
    }
    // The tab lives in "real Chrome" (the second desktop), not in the pane.
    expect(router.ownerOf(tabId)).toBe("real_chrome");
    expect(() => chrome.tab(tabId)).not.toThrow();
    expect(() => pane.tab(tabId)).toThrow();
    expect((await router.listTabs(realSession?.id ?? "")).map((t) => t.id)).toEqual([tabId]);
    expect(events.some((e) => e.type === "tab_opened" && e.tabId === tabId)).toBe(true);

    // The ordinary tools work on it through the router.
    const snap = await call("browser.snapshot", { tabId });
    expect(snap.isError).toBeUndefined();
    expect(String((snap.output as { snapshot: string }).snapshot)).toContain("Sign in");

    // A second open in the same session does not ask again.
    await call("browser.use_real_chrome", { url: chrome.browser.url("a/"), reason: "again" });
    expect(asked()).toHaveLength(1);

    // Origin sets are unchanged: the policy is the task's, so a new origin still asks.
    const before = broker.decisions.filter((d) => d.call.kind === "new_origin").length;
    await call("browser.navigate", { tabId, url: chrome.browser.url("b/") });
    expect(broker.decisions.filter((d) => d.call.kind === "new_origin").length).toBe(before + 1);
    expect(policy.describe().readOnly).toContain(chrome.browser.origin("b"));

    // Downloads would skip the Library quarantine there: refused, nothing saved.
    await call("browser.navigate", { tabId, url: chrome.browser.url("a/downloads") });
    const dl = await call("browser.download", {
      tabId,
      source: { url: chrome.browser.url("a/files/data.csv") },
    });
    expect(dl).toMatchObject({
      isError: true,
      output: { error: { code: "policy_denied", details: { reason: "downloads_denied" } } },
    });

    // Hand-offs make no sense in the owner's own window.
    expect(await call("browser.request_control", { tabId, reason: "2FA" })).toMatchObject({
      isError: true,
      output: { error: { code: "unavailable", details: { reason: "real_chrome" } } },
    });

    // Stopping detaches; its tabs are no longer this task's.
    expect((await call("browser.stop_real_chrome", {})).output).toEqual({ stopped: true });
    expect(router.ownerOf(tabId)).toBe("primary");
    expect(await call("browser.snapshot", { tabId })).toMatchObject({
      isError: true,
      output: { error: { code: "not_found" } },
    });
    expect((await call("browser.stop_real_chrome", {})).output).toEqual({ stopped: false });
  });

  it("routes peeks safely when nothing owns the id and the pane is gone", async () => {
    const lonely = createRoutingDriver(() => {
      throw new Error("no desktop");
    });
    expect(lonely.peek("t1", "ref_1")).toBeUndefined();
    expect(lonely.tabOrigin("t1")).toBeUndefined();
    // Anything else needs a driver, and says so.
    expect(() => lonely.snapshot("t1")).toThrow("no desktop");
    expect(() => lonely.attach("primary", chromeDriver)).toThrow();
    await expect(lonely.openSessionOn("real_chrome", {})).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});

describe("real-Chrome mode off", () => {
  it("is unavailable without a real-Chrome attachment", async () => {
    const registry = new Registry();
    const dir = await mkdtemp(join(tmpdir(), "psyche-s08-rc-off-"));
    const desktop = new MockDesktop({ quarantineDir: dir });
    const driver = new CdpBridgeDriver(await desktop.connect(), {
      library: new FsQuarantineWriter(join(dir, "lib")),
    });
    const s = await driver.openSession({});
    registerBrowserTools(registry, {
      driver,
      broker: FakePermissionBroker.policy({ default: "allow" }),
      context: () => ({
        toolCallId: "c",
        threadId: "t",
        runId: "r",
        permissionMode: "balanced",
        taint: false,
      }),
      session: async () => s.id,
    });
    const r = await registry
      .get("browser.use_real_chrome")
      ?.execute(
        "c",
        { url: "https://example.com/", reason: "x" },
        new AbortController().signal,
        () => {},
      );
    expect(r).toMatchObject({
      isError: true,
      output: { error: { code: "unavailable", details: { reason: "no_real_chrome" } } },
    });
    driver.dispose();
    desktop.disconnect();
    await rm(dir, { recursive: true, force: true });
  });
});
