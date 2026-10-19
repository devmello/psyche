import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRegistration, ToolRegistry, ToolResult } from "@psyche/protocol";
import { assertNoSecrets, FakeCredentialBroker, FakePermissionBroker } from "@psyche/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsQuarantineWriter } from "../src/downloads/library.ts";
import { CdpBridgeDriver } from "../src/drivers/cdp.ts";
import { MockDesktop } from "../src/testing/mock-desktop.ts";
import type { CallContext } from "../src/tools/gate.ts";
import { registerBrowserTools } from "../src/tools/register.ts";

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

describe("browser.* tools", () => {
  let dir: string;
  let desktop: MockDesktop;
  let driver: CdpBridgeDriver;
  const registry = new Registry();
  const broker = FakePermissionBroker.policy({
    default: "allow",
    byTool: { "browser.download": "deny" },
  });
  const creds = new FakeCredentialBroker();
  let sessionId = "";
  const ctx: CallContext = {
    toolCallId: "call_1",
    threadId: "thr_1",
    runId: "run_1",
    taskId: "task_1",
    permissionMode: "balanced",
    taint: true,
  };
  const call = async (name: string, params: unknown): Promise<ToolResult> => {
    const t = registry.get(name);
    if (t === undefined) throw new Error(`no tool ${name}`);
    return t.execute("call_1", params, new AbortController().signal, () => {});
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "psyche-s08-tools-"));
    desktop = new MockDesktop({ quarantineDir: dir });
    driver = new CdpBridgeDriver(await desktop.connect(), {
      library: new FsQuarantineWriter(join(dir, "lib")),
    });
    sessionId = (
      await driver.openSession({
        taskId: "task_1",
        policy: { devPreview: true, readWritable: [desktop.browser.origin("a")] },
      })
    ).id;
    registerBrowserTools(registry, {
      driver,
      broker,
      credentials: creds,
      context: () => ctx,
      session: async () => sessionId,
    });
  });
  afterAll(async () => {
    driver.dispose();
    desktop.disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("registers untrusted browser tools with origin targets", () => {
    const names = registry.list().map((s) => s.name);
    for (const n of [
      "browser.navigate",
      "browser.snapshot",
      "browser.click",
      "browser.fill_credential",
    ]) {
      expect(names).toContain(n);
    }
    expect(registry.get("browser.snapshot")?.spec.provenanceOut).toBe("untrusted");
    expect(registry.get("browser.click")?.spec.sideEffect).toBe("read");
  });

  it("navigates, asks the broker for a new origin, and widens the policy on approval", async () => {
    const open = await call("browser.open_tab", { url: desktop.browser.url("a/") });
    expect(open.isError).toBeUndefined();
    expect(open.provenance).toBe("untrusted");
    const tabId = (open.output as { tab: { id: string } }).tab.id;
    const nav = await call("browser.navigate", { tabId, url: desktop.browser.url("b/landing") });
    expect(nav.isError).toBeUndefined();
    expect(driver.policy(sessionId).describe().readOnly).toContain(desktop.browser.origin("b"));
    const bad = await call("browser.navigate", { tabId, url: "file:///etc/passwd" });
    expect(bad).toMatchObject({ isError: true, output: { error: { code: "policy_denied" } } });
    const invalid = await call("browser.navigate", { tabId });
    expect(invalid).toMatchObject({ isError: true, output: { error: { code: "invalid_params" } } });
  });

  it("classifies clicks per element through describeCall", async () => {
    const open = await call("browser.open_tab", { url: desktop.browser.url("a/checkout") });
    const tabId = (open.output as { tab: { id: string } }).tab.id;
    const snap = await driver.snapshot(tabId);
    const refOf = (name: string) => snap.refs.find((r) => r.name === name)?.ref ?? "";
    const click = registry.get("browser.click");
    const order = click?.describeCall?.({ tabId, target: { ref: refOf("Place order") } });
    expect(order).toMatchObject({ sideEffect: "financial", kind: "purchase" });
    await driver.navigate(tabId, desktop.browser.url("a/login"));
    const login = await driver.snapshot(tabId);
    const signIn = login.refs.find((r) => r.name === "Sign in")?.ref ?? "";
    expect(click?.describeCall?.({ tabId, target: { ref: signIn } })).toMatchObject({
      sideEffect: "write",
      kind: "browser_submit",
      target: { kind: "origin", value: desktop.browser.origin("a") },
      bindingFields: { path: "/submit/login", submitRef: signIn },
    });
    await driver.navigate(tabId, desktop.browser.url("a/cookies"));
    const cookies = await driver.snapshot(tabId);
    const accept = cookies.refs.find((r) => r.name === "Accept all")?.ref ?? "";
    const reject = cookies.refs.find((r) => r.name === "Reject non-essential")?.ref ?? "";
    expect(click?.describeCall?.({ tabId, target: { ref: accept } })?.sideEffect).toBe(
      "destructive",
    );
    expect(click?.describeCall?.({ tabId, target: { ref: reject } })?.sideEffect).toBe("read");
  });

  it("refuses what the broker denies", async () => {
    const open = await call("browser.open_tab", { url: desktop.browser.url("a/downloads") });
    const tabId = (open.output as { tab: { id: string } }).tab.id;
    // The loop applies the broker before dispatch; the executor itself only gates mid-run
    // approvals. A denied new origin surfaces as policy_denied.
    broker.policy({ default: "deny" });
    const r = await call("browser.navigate", { tabId, url: desktop.browser.url("evil/landing") });
    expect(r).toMatchObject({ isError: true, output: { error: { code: "policy_denied" } } });
    broker.policy({ default: "allow" });
  });

  it("fills a credential through the vault without exposing it", async () => {
    creds.add({
      slug: "site-a-login",
      bindings: [{ origin: desktop.browser.origin("a") }],
      secret: "correct horse battery",
    });
    const open = await call("browser.open_tab", { url: desktop.browser.url("a/login") });
    const tabId = (open.output as { tab: { id: string } }).tab.id;
    const snap = await driver.snapshot(tabId);
    const pass = snap.refs.find((r) => r.name === "Password")?.ref ?? "";
    creds.approve("appr_fill", { slug: "site-a-login", origin: desktop.browser.origin("a") });
    ctx.approvalId = "appr_fill";
    const r = await call("browser.fill_credential", {
      tabId,
      ref: pass,
      placeholder: "{{cred:site-a-login}}",
    });
    ctx.approvalId = undefined;
    expect(r.isError).toBeUndefined();
    expect(desktop.tab(tabId).fieldValue("password")).toBe("correct horse battery");
    const after = await call("browser.snapshot", { tabId });
    assertNoSecrets(after.output, "snapshot after fill");
    assertNoSecrets(r.output, "fill result");
    expect(await call("browser.screenshot", { tabId })).toMatchObject({ isError: true });
    // A password never goes into a non-password field, even on its own origin (S23 design-01).
    const user = snap.refs.find((r) => r.name === "Username")?.ref ?? "";
    creds.approve("appr_fill2", { slug: "site-a-login", origin: desktop.browser.origin("a") });
    ctx.approvalId = "appr_fill2";
    const wrong = await call("browser.fill_credential", {
      tabId,
      ref: user,
      placeholder: "{{cred:site-a-login}}",
    });
    ctx.approvalId = undefined;
    expect(wrong).toMatchObject({ isError: true, output: { error: { code: "policy_denied" } } });
    expect(desktop.tab(tabId).fieldValue("username")).toBe("");
  });
});
