import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRegistration, ToolRegistry, ToolResult } from "@psyche/protocol";
import { FakeCredentialBroker, FakePermissionBroker } from "@psyche/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsQuarantineWriter } from "../src/downloads/library.ts";
import { CdpBridgeDriver } from "../src/drivers/cdp.ts";
import { MockDesktop } from "../src/testing/mock-desktop.ts";
import type { CallContext } from "../src/tools/gate.ts";
import { registerBrowserTools } from "../src/tools/register.ts";

/**
 * #291 (M3 hardening review, TM-28 and TM-29): vault fills are judged on the element as it is
 * when the value is typed, and screenshots stay suppressed on a document a secret was typed into,
 * even after back / forward.
 */
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

const SECRET = "correct horse battery";

describe("fill checks on the live element (#291)", () => {
  let dir: string;
  let desktop: MockDesktop;
  let driver: CdpBridgeDriver;
  let sessionId = "";
  const registry = new Registry();
  const creds = new FakeCredentialBroker();
  const ctx: CallContext = {
    toolCallId: "call_1",
    threadId: "thr_1",
    runId: "run_1",
    taskId: "task_1",
    permissionMode: "balanced",
    taint: false,
  };
  let approvals = 0;
  const call = (name: string, params: unknown): Promise<ToolResult> => {
    const t = registry.get(name);
    if (t === undefined) throw new Error(`no tool ${name}`);
    return t.execute("call_1", params, new AbortController().signal, () => {});
  };
  /** Open the login page and return the tab and the password field's ref. */
  const loginPage = async () => {
    const open = await call("browser.open_tab", { url: desktop.browser.url("a/login") });
    const tabId = (open.output as { tab: { id: string } }).tab.id;
    const snap = await driver.snapshot(tabId);
    const pass = snap.refs.find((r) => r.name === "Password")?.ref ?? "";
    return { tabId, pass };
  };
  const fill = async (tabId: string, ref: string) => {
    approvals += 1;
    const id = `appr_${approvals}`;
    creds.approve(id, { slug: "site-a-login", origin: desktop.browser.origin("a") });
    ctx.approvalId = id;
    try {
      return await call("browser.fill_credential", {
        tabId,
        ref,
        placeholder: "{{cred:site-a-login}}",
      });
    } finally {
      ctx.approvalId = undefined;
    }
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "psyche-s08-fill-"));
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
    creds.add({
      slug: "site-a-login",
      bindings: [{ origin: desktop.browser.origin("a") }],
      secret: SECRET,
    });
    registerBrowserTools(registry, {
      driver,
      broker: FakePermissionBroker.policy({ default: "allow" }),
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

  it("TM-28: a field switched from password to text after the snapshot is refused", async () => {
    const { tabId, pass } = await loginPage();
    // The snapshot said password; the page flips it before the fill is described.
    expect(driver.peek(tabId, pass)?.inputType).toBe("password");
    desktop.tab(tabId).setFieldType("password", "text");
    expect((await driver.describe(tabId, pass)).inputType).toBe("text");
    const r = await fill(tabId, pass);
    expect(r).toMatchObject({
      isError: true,
      output: { error: { code: "policy_denied", details: { reason: "not_password_field" } } },
    });
    expect(desktop.tab(tabId).fieldValue("password")).toBe("");
  });

  it("TM-28: a field switched while the fill is under way gets no keystrokes", async () => {
    const { tabId, pass } = await loginPage();
    const tab = desktop.tab(tabId);
    // The page waits for focus, then turns the field into a visible text box.
    tab.beforeCommand = (method) => {
      if (method === "DOM.focus") tab.setFieldType("password", "text");
    };
    try {
      const r = await fill(tabId, pass);
      expect(r).toMatchObject({
        isError: true,
        output: { error: { code: "policy_denied", details: { reason: "not_password_field" } } },
      });
    } finally {
      tab.beforeCommand = undefined;
    }
    expect(tab.fieldValue("password")).toBe("");
    expect(tab.calls).not.toContain("Input.insertText");
  });

  it("TM-28: focus moved right before the keystrokes is refused, and nothing is typed", async () => {
    const { tabId, pass } = await loginPage();
    const tab = desktop.tab(tabId);
    let checks = 0;
    // Let the first focus check pass, then steal focus before the last look inside use().
    tab.beforeCommand = (method, params) => {
      if (
        method === "Runtime.callFunctionOn" &&
        String(params.functionDeclaration).includes("psyche:field")
      ) {
        checks += 1;
        if (checks === 2) tab.focusField("username");
      }
    };
    try {
      const r = await fill(tabId, pass);
      expect(r).toMatchObject({
        isError: true,
        output: { error: { code: "policy_denied", details: { reason: "focus_moved" } } },
      });
    } finally {
      tab.beforeCommand = undefined;
    }
    expect(tab.fieldValue("password")).toBe("");
    expect(tab.fieldValue("username")).toBe("");
  });

  it("still fills an unchanged password field", async () => {
    const { tabId, pass } = await loginPage();
    const r = await fill(tabId, pass);
    expect(r.isError).toBeUndefined();
    expect(desktop.tab(tabId).fieldValue("password")).toBe(SECRET);
  });

  it("TM-29: screenshots stay suppressed after navigating away and back", async () => {
    const { tabId, pass } = await loginPage();
    expect((await fill(tabId, pass)).isError).toBeUndefined();
    const refused = {
      isError: true,
      output: { error: { code: "policy_denied", details: { reason: "secure_field" } } },
    };
    expect(await call("browser.screenshot", { tabId })).toMatchObject(refused);
    // Another document: screenshots are fine there.
    await call("browser.navigate", { tabId, url: desktop.browser.url("a/") });
    expect((await call("browser.screenshot", { tabId })).isError).toBeUndefined();
    // Back to the filled form (a bfcache restore would bring the value back).
    expect((await call("browser.back", { tabId })).isError).toBeUndefined();
    await driver.wait(tabId, { kind: "load" }, { timeoutMs: 5000 });
    expect(await call("browser.screenshot", { tabId })).toMatchObject(refused);
  });
});
