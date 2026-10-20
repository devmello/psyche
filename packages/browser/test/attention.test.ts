import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRegistration, ToolRegistry, ToolResult } from "@psyche/protocol";
import { FakePermissionBroker } from "@psyche/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsQuarantineWriter } from "../src/downloads/library.ts";
import { CdpBridgeDriver } from "../src/drivers/cdp.ts";
import { MockDesktop } from "../src/testing/mock-desktop.ts";
import { ATTENTION_WINDOW_MS, type AttentionState } from "../src/tools/attention.ts";
import type { CallContext } from "../src/tools/gate.ts";
import { registerBrowserTools } from "../src/tools/register.ts";

/** #272 (security §7.2 item 5): sensitive origins need the pane visible and recent input. */
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

const ctx: CallContext = {
  toolCallId: "call_1",
  threadId: "thr_1",
  runId: "run_1",
  taskId: "task_1",
  permissionMode: "balanced",
  taint: false,
  unattended: true,
};

async function setup(withGate: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "psyche-s08-att-"));
  const desktop = new MockDesktop({ quarantineDir: dir });
  const driver = new CdpBridgeDriver(await desktop.connect(), {
    library: new FsQuarantineWriter(join(dir, "lib")),
  });
  const a = desktop.browser.origin("a");
  const b = desktop.browser.origin("b");
  const sessionId = (
    await driver.openSession({
      taskId: "task_1",
      policy: { devPreview: true, readWritable: [a, b] },
    })
  ).id;
  const clock = { now: 10_000_000 };
  const watch: { state: AttentionState | undefined } = { state: undefined };
  const registry = new Registry();
  registerBrowserTools(registry, {
    driver,
    broker: FakePermissionBroker.policy({ default: "allow" }),
    context: () => ctx,
    session: async () => sessionId,
    ...(withGate
      ? {
          attention: {
            // Site B plays the bank.
            isSensitive: (origin: string) => origin === b,
            state: () => watch.state,
            now: () => clock.now,
          },
        }
      : {}),
  });
  const call = (name: string, params: unknown): Promise<ToolResult> => {
    const t = registry.get(name);
    if (t === undefined) throw new Error(`no tool ${name}`);
    return t.execute("call_1", params, new AbortController().signal, () => {});
  };
  const close = async () => {
    driver.dispose();
    desktop.disconnect();
    await rm(dir, { recursive: true, force: true });
  };
  return { desktop, driver, call, clock, watch, close, a, b };
}

const away = {
  isError: true,
  output: { error: { code: "presence_required", details: { reason: "awaiting_attention" } } },
};

describe("pause-when-unwatched in the browser (#272)", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  let tabId = "";
  beforeAll(async () => {
    s = await setup(true);
    const open = await s.call("browser.open_tab", { url: s.desktop.browser.url("a/") });
    tabId = (open.output as { tab: { id: string } }).tab.id;
  });
  afterAll(async () => {
    await s.close();
  });

  it("acts freely on ordinary sites whatever the owner is doing", async () => {
    s.watch.state = undefined;
    expect((await s.call("browser.snapshot", { tabId })).isError).toBeUndefined();
    expect(
      (await s.call("browser.navigate", { tabId, url: s.desktop.browser.url("a/login") })).isError,
    ).toBeUndefined();
  });

  it("refuses to open a sensitive site while nothing reports the owner watching", async () => {
    s.watch.state = undefined;
    const r = await s.call("browser.navigate", { tabId, url: s.desktop.browser.url("b/") });
    expect(r).toMatchObject(away);
    expect(
      (r.output as { error: { details: Record<string, unknown> } }).error.details,
    ).toMatchObject({
      origin: s.b,
      paneVisible: false,
      lastInputAt: null,
    });
    expect(s.desktop.tab(tabId).url).not.toContain(new URL(s.b).host);
    expect(await s.call("browser.open_tab", { url: s.desktop.browser.url("b/") })).toMatchObject(
      away,
    );
  });

  it("needs both the pane visible and input within five minutes", async () => {
    // Visible, but the last input was more than five minutes ago.
    s.watch.state = { visible: true, lastInputAt: s.clock.now - ATTENTION_WINDOW_MS - 1 };
    expect(
      await s.call("browser.navigate", { tabId, url: s.desktop.browser.url("b/") }),
    ).toMatchObject(away);
    // Recent input, but the pane is hidden.
    s.watch.state = { visible: false, lastInputAt: s.clock.now - 1000 };
    expect(
      await s.call("browser.navigate", { tabId, url: s.desktop.browser.url("b/") }),
    ).toMatchObject(away);
    // Both: the agent may go there and act.
    s.watch.state = { visible: true, lastInputAt: s.clock.now - ATTENTION_WINDOW_MS };
    expect(
      (await s.call("browser.navigate", { tabId, url: s.desktop.browser.url("b/") })).isError,
    ).toBeUndefined();
    expect((await s.call("browser.snapshot", { tabId })).isError).toBeUndefined();
  });

  it("stops acting on a sensitive tab once the owner leaves, except to call them back", async () => {
    s.watch.state = { visible: true, lastInputAt: s.clock.now };
    // Six minutes later, with the pane still open but nobody touching anything.
    s.clock.now += 6 * 60_000;
    for (const [tool, params] of [
      ["browser.snapshot", { tabId }],
      ["browser.read_text", { tabId }],
      ["browser.scroll", { tabId, direction: "down" }],
      ["browser.press", { tabId, keys: "Tab" }],
      ["browser.navigate", { tabId, url: s.desktop.browser.url("a/") }],
    ] as const) {
      expect(await s.call(tool, params), tool).toMatchObject(away);
    }
    // Listing tabs, waiting and closing never act on the page.
    expect((await s.call("browser.tabs", {})).isError).toBeUndefined();
    expect(
      (await s.call("browser.wait", { tabId, for: { kind: "timeout", ms: 1 } })).isError,
    ).toBeUndefined();
    // Back: everything works again.
    s.watch.state = { visible: true, lastInputAt: s.clock.now };
    expect((await s.call("browser.snapshot", { tabId })).isError).toBeUndefined();
    expect((await s.call("browser.close_tab", { tabId })).isError).toBeUndefined();
  });

  it("checks download URLs too", async () => {
    s.watch.state = undefined;
    const open = await s.call("browser.open_tab", { url: s.desktop.browser.url("a/downloads") });
    const id = (open.output as { tab: { id: string } }).tab.id;
    expect(
      await s.call("browser.download", {
        tabId: id,
        source: { url: s.desktop.browser.url("b/files/x.csv") },
      }),
    ).toMatchObject(away);
  });
});

describe("without an attention source", () => {
  it("checks nothing (the Gateway turns it on once the desktop reports)", async () => {
    const s = await setup(false);
    const open = await s.call("browser.open_tab", { url: s.desktop.browser.url("b/") });
    expect(open.isError).toBeUndefined();
    await s.close();
  });
});
