import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRegistration, ToolRegistry, ToolResult } from "@psyche/protocol";
import { FakeCredentialBroker, FakePermissionBroker } from "@psyche/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsQuarantineWriter } from "../src/downloads/library.ts";
import { CdpBridgeDriver } from "../src/drivers/cdp.ts";
import { matchRecordedTarget } from "../src/teach/match.ts";
import { MockDesktop } from "../src/testing/mock-desktop.ts";
import { registerBrowserTools } from "../src/tools/register.ts";

/**
 * Replay stops and asks when the page changed (teach by showing, design doc §6): a recorded
 * step's target is looked up by role and name, and anything but exactly one match says `stop`.
 */

const ORIGIN = "https://billing.example.com";

describe("matchRecordedTarget", () => {
  const els = [
    { ref: "ref_1", role: "button", name: "Export" },
    { ref: "ref_2", role: "link", name: "Export" },
    { ref: "ref_3", role: "button", name: "Export  all" },
    { ref: "ref_4", role: "textbox", name: "From" },
  ];
  it("finds exactly one element by role and name, ignoring case and spacing", () => {
    expect(
      matchRecordedTarget(els, { role: "button", name: "export", origin: ORIGIN }, ORIGIN),
    ).toEqual({
      status: "found",
      stop: false,
      ref: "ref_1",
      role: "button",
      name: "Export",
    });
    expect(
      matchRecordedTarget(els, { role: "button", name: " export   ALL ", origin: ORIGIN }, ORIGIN),
    ).toMatchObject({
      status: "found",
      ref: "ref_3",
    });
  });
  it("stops when the element is gone, even if a similar one is there", () => {
    expect(
      matchRecordedTarget(els, { role: "button", name: "Download", origin: ORIGIN }, ORIGIN),
    ).toEqual({
      status: "missing",
      stop: true,
    });
    // Same name, other role: not the same element.
    expect(
      matchRecordedTarget(els, { role: "checkbox", name: "Export", origin: ORIGIN }, ORIGIN),
    ).toMatchObject({
      status: "missing",
      stop: true,
    });
    // A longer or shorter name is not the same name.
    expect(
      matchRecordedTarget(els, { role: "textbox", name: "From date", origin: ORIGIN }, ORIGIN),
    ).toMatchObject({
      status: "missing",
    });
  });
  it("stops when two elements match, rather than picking one", () => {
    const r = matchRecordedTarget(els, { name: "Export", origin: ORIGIN }, ORIGIN);
    expect(r.status).toBe("ambiguous");
    expect(r.stop).toBe(true);
    if (r.status === "ambiguous")
      expect(r.candidates.map((c) => c.ref)).toEqual(["ref_1", "ref_2"]);
  });
  it("stops when the tab's origin is unknown: unknown is not the same page", () => {
    expect(
      matchRecordedTarget(els, { name: "From", origin: "https://billing.example.com" }),
    ).toEqual({
      status: "wrong_page",
      stop: true,
      expected: "https://billing.example.com",
      actual: "",
    });
  });
  it("stops on another site", () => {
    expect(
      matchRecordedTarget(
        els,
        { name: "From", origin: "https://billing.example.com" },
        "https://evil.example",
      ),
    ).toEqual({
      status: "wrong_page",
      stop: true,
      expected: "https://billing.example.com",
      actual: "https://evil.example",
    });
    expect(
      matchRecordedTarget(
        els,
        { name: "From", origin: "https://billing.example.com" },
        "https://billing.example.com",
      ).status,
    ).toBe("found");
  });
});

describe("browser.check_target on a live page", () => {
  let dir: string;
  let desktop: MockDesktop;
  let driver: CdpBridgeDriver;
  const tools = new Map<string, ToolRegistration>();
  let sessionId = "";
  let tabId = "";

  const call = async (name: string, params: unknown): Promise<ToolResult> => {
    const t = tools.get(name);
    if (t === undefined) throw new Error(`no tool ${name}`);
    return t.execute("call_1", params, new AbortController().signal, () => {});
  };
  const check = async (params: Record<string, unknown>) => {
    const out = await call("browser.check_target", { tabId, ...params });
    return (out.output as { check: { status: string; stop: boolean; ref?: string } }).check;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "psyche-teach-replay-"));
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
    const registry: ToolRegistry = {
      list: () => [...tools.values()].map((t) => t.spec),
      get: (n) => tools.get(n),
      register: (r) => {
        tools.set(r.spec.name, r);
        return () => tools.delete(r.spec.name);
      },
    };
    registerBrowserTools(registry, {
      driver,
      broker: FakePermissionBroker.policy({ default: "allow" }),
      credentials: new FakeCredentialBroker(),
      context: () => ({
        toolCallId: "call_1",
        threadId: "thr_1",
        runId: "run_1",
        taskId: "task_1",
        permissionMode: "balanced",
        taint: true,
      }),
      session: async () => sessionId,
    });
    const open = await call("browser.open_tab", { url: desktop.browser.url("a/login") });
    if (open.isError) throw new Error(JSON.stringify(open.output));
    tabId = (open.output as { tab: { id: string } }).tab.id;
  });
  afterAll(async () => {
    driver.dispose();
    desktop.disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("is a read, and finds what was recorded when the page is the same", async () => {
    expect(tools.get("browser.check_target")?.spec.sideEffect).toBe("read");
    const found = await check({
      role: "button",
      name: "Sign in",
      origin: desktop.browser.origin("a"),
    });
    expect(found).toMatchObject({ status: "found", stop: false });
    expect(found.ref).toMatch(/^ref_\d+$/);
  });

  it("stops when the page changed: the recorded button is gone", async () => {
    const origin = desktop.browser.origin("a");
    expect(await check({ role: "button", name: "Export", origin })).toEqual({
      status: "missing",
      stop: true,
    });
    expect(await check({ role: "textbox", name: "Recipient", origin })).toMatchObject({
      stop: true,
    });
  });

  it("stops when the page is another site", async () => {
    const r = await check({ role: "button", name: "Sign in", origin: desktop.browser.origin("b") });
    expect(r).toMatchObject({ status: "wrong_page", stop: true });
  });

  it("answers about the page after it navigated, not the page it was recorded on", async () => {
    await call("browser.navigate", { tabId, url: desktop.browser.url("a/landing") });
    expect(
      await check({ role: "button", name: "Sign in", origin: desktop.browser.origin("a") }),
    ).toMatchObject({ status: "missing", stop: true });
  });

  it("requires the origin: a call without one is refused, not guessed", async () => {
    const out = await call("browser.check_target", { tabId, name: "Sign in", role: "button" });
    expect(out.isError).toBe(true);
    expect(out).toMatchObject({ output: { error: { code: "invalid_params" } } });
  });
});
