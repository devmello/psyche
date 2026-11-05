import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSetting } from "@psyche/db";
import type { ModelEvent } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { COMPUTER_USE_APPS, COMPUTER_USE_ENABLED } from "../src/compose/computer-settings.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { cleanAppCapture, recordableApps } from "../src/compose/teach-app.ts";
import { silentLogger } from "../src/log.ts";
import { FakeNode, type FakeNodeHandler, pairNodeDevice } from "./fake-node.ts";
import { adminClient, ik, newDeviceKey, type TestClient, wsUrlOf } from "./helpers.ts";

/**
 * Teach by showing in a Windows app (docs/design/teach-by-showing-2026.md §13.10): the Host's own
 * `win-helper` serves `teach.record.*`, an app is its lowercase executable name, and the same
 * gates hold as on a Mac: desktop shell only, the grant list, the never-recorded list, and no way
 * through `nodes.invoke`.
 */

// Secret-looking fixtures are built at run time so the repo's secret scan never sees them.
const CARD = ["4111", "1111", "1111", "1111"].join(" ");
const NOTEPAD = "notepad.exe";
const SPACED = "adobe premiere pro.exe";

const say = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  {
    type: "usage",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
  },
  { type: "finish", reason: "stop" },
];

let composed: ComposedGateway | null = null;
let home = "";
const clients: TestClient[] = [];
const nodes: FakeNode[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const n of nodes.splice(0)) await n.close().catch(() => undefined);
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

function recordHandlers(capture: () => unknown): FakeNodeHandler[] {
  return [
    {
      capability: { name: "teach.record.start", sideEffect: "write", streaming: false },
      run: (p) => ({
        sessionId: "app-teach-w1",
        app: { bundleId: (p as { bundleId: string }).bundleId, name: "Notepad" },
      }),
    },
    {
      capability: { name: "teach.record.stop", sideEffect: "none", streaming: false },
      run: capture,
    },
    {
      capability: { name: "teach.record.cancel", sideEffect: "none", streaming: false },
      run: () => ({ cancelled: true }),
    },
    {
      capability: { name: "teach.record.status", sideEffect: "read", streaming: false },
      run: () => ({
        active: true,
        sessionId: "app-teach-w1",
        app: { bundleId: NOTEPAD, name: "Notepad" },
        steps: 2,
        startedAt: "2026-11-05T10:00:00.000Z",
      }),
    },
  ];
}

async function setup() {
  home = mkdtempSync(join(tmpdir(), "psyche-teach-win-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider().script([say("ok")]), model: "fake/model" },
  });
  const c = composed;
  setSetting(c.db, COMPUTER_USE_ENABLED, true);
  setSetting(c.db, COMPUTER_USE_APPS, [
    { id: NOTEPAD, name: "Notepad", tier: "interact" },
    { id: SPACED, name: "Premiere", tier: "click" },
    { id: "calculatorapp.exe", name: "Calculator", tier: "ask" },
    { id: "1password.exe", name: "1Password", tier: "interact" },
    { id: "consent.exe", name: "UAC", tier: "interact" },
    { id: "psyche.exe", name: "Psyche", tier: "interact" },
    { id: "credentialuibroker.exe", name: "Credential UI", tier: "interact" },
    { id: "tradingview.exe", name: "TradingView", tier: "interact" },
    { id: "windowsterminal.exe", name: "Terminal", tier: "interact" },
    { id: "msedge.exe", name: "Edge", tier: "read" },
  ]);
  const rec: { capture: unknown } = { capture: {} };
  const helper = await FakeNode.connect(c.gateway.config.nodeSocketPath, {
    origin: c.gateway.origin,
    secret: c.gateway.handshakeSecret,
    deviceFamily: "win-helper",
    handlers: recordHandlers(() => rec.capture),
  });
  nodes.push(helper);
  const desk = await adminClient(c.gateway);
  clients.push(desk);
  return { c, desk, rec, helper };
}

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as Error).message);
  }
  throw new Error("expected the call to fail");
}

describe("recording in a Windows app", () => {
  it("lists granted apps by executable name, never the never-list", async () => {
    const { desk } = await setup();
    const { apps } = await desk.call<{ apps: { bundleId: string; tier: string }[] }>(
      "teach.app.apps",
    );
    expect(apps.map((a) => a.bundleId)).toEqual([NOTEPAD, SPACED]);
  });

  it("starts, reports, stops and cancels through the win-helper", async () => {
    const { desk, rec, helper } = await setup();
    rec.capture = {
      id: "app-teach-w1",
      endedBy: "stop",
      app: { bundleId: NOTEPAD, name: "Notepad" },
      skipped: 1,
      steps: [
        {
          id: "a1",
          kind: "app_menu",
          app: { bundleId: NOTEPAD, name: "Notepad" },
          role: "menuitem",
          name: "Save",
          path: ["File", "Save"],
        },
        {
          id: "a2",
          kind: "app_type",
          app: { bundleId: NOTEPAD, name: "Notepad" },
          role: "textbox",
          name: "Text editor",
          sample: "Quarterly report",
        },
      ],
    };
    const started = await desk.call<{ sessionId: string; app: { bundleId: string } }>(
      "teach.app.start",
      { bundleId: NOTEPAD },
      ik(),
    );
    expect(started).toMatchObject({ sessionId: "app-teach-w1", app: { bundleId: NOTEPAD } });
    expect(helper.invocations.find((i) => i.capability === "teach.record.start")?.params).toEqual({
      bundleId: NOTEPAD,
    });
    expect(await desk.call("teach.app.status")).toMatchObject({
      active: true,
      steps: 2,
      app: { bundleId: NOTEPAD },
    });
    const cap = await desk.call<{ steps: { kind: string; sample?: string }[]; skipped: number }>(
      "teach.app.stop",
      {},
    );
    expect(cap.steps.map((s) => s.kind)).toEqual(["app_menu", "app_type"]);
    expect(cap.steps[1]?.sample).toBe("Quarterly report");
    expect(cap.skipped).toBe(1);
    expect(await desk.call("teach.app.cancel", {}, ik())).toEqual({ cancelled: true });
    // An app with a space in its name is recordable too.
    await desk.call("teach.app.start", { bundleId: SPACED }, ik());
  });

  it("refuses the never-list, ungranted apps, terminals and browsers on start", async () => {
    const { desk, helper } = await setup();
    for (const bundleId of [
      "1password.exe",
      "consent.exe",
      "psyche.exe",
      "credentialuibroker.exe",
      "tradingview.exe",
      "windowsterminal.exe",
      "msedge.exe",
      "calculatorapp.exe",
      "unlisted.exe",
    ]) {
      const msg = await failure(desk.call("teach.app.start", { bundleId }, ik()));
      expect(msg, bundleId).toContain("policy_denied");
    }
    expect(helper.invocations.filter((i) => i.capability === "teach.record.start")).toEqual([]);
  });

  it("a win-helper that paired over the WebSocket is not the Host helper", async () => {
    const { c } = await setup();
    const key = newDeviceKey();
    pairNodeDevice(c.gateway, "win-phone", key);
    const lone = await FakeNode.connectWs(wsUrlOf(c.gateway), {
      origin: c.gateway.origin,
      handlers: recordHandlers(() => ({})),
      key,
      deviceId: "win-phone",
      deviceFamily: "win-helper",
    });
    nodes.push(lone);
    expect(c.gateway.context.nodes.isHostHelper(lone.nodeId)).toBe(false);
  });

  it("teach.record.* is unreachable through nodes.invoke, on the Host helper and on a remote win-helper", async () => {
    const { c, desk, helper } = await setup();
    const key = newDeviceKey();
    pairNodeDevice(c.gateway, "second-pc", key);
    const second = await FakeNode.connectWs(wsUrlOf(c.gateway), {
      origin: c.gateway.origin,
      handlers: recordHandlers(() => ({})),
      key,
      deviceId: "second-pc",
      deviceFamily: "win-helper",
    });
    nodes.push(second);
    const list = await desk.call<{ nodes: { id: string; kind: string }[] }>("nodes.list");
    expect(list.nodes.find((n) => n.id === helper.nodeId)?.kind).toBe("win-helper");
    expect(list.nodes.find((n) => n.id === second.nodeId)?.kind).toBe("remote");
    for (const nodeId of [helper.nodeId, second.nodeId]) {
      for (const capability of [
        "teach.record.start",
        "teach.record.stop",
        "teach.record.cancel",
        "teach.record.status",
      ]) {
        const msg = await failure(
          desk.call("nodes.invoke", { nodeId, capability, params: { bundleId: NOTEPAD } }, ik()),
        );
        expect(msg, `${nodeId} ${capability}`).toContain("forbidden");
      }
    }
    expect(
      [...helper.invocations, ...second.invocations].filter((i) =>
        i.capability.startsWith("teach."),
      ),
    ).toEqual([]);
  });
});

describe("a Windows capture is cleaned again", () => {
  it("accepts exe ids, drops secrets and other apps", () => {
    expect(
      recordableApps(true, [
        { id: NOTEPAD, name: "Notepad", tier: "interact" },
        { id: "NOTEPAD.EXE", name: "dupe", tier: "read" },
        { id: "bad/name.exe", name: "x", tier: "interact" },
      ]),
    ).toEqual([{ bundleId: NOTEPAD, name: "Notepad", tier: "interact" }]);
    const cap = cleanAppCapture(
      {
        id: "app-teach-w1",
        endedBy: "stop",
        app: { bundleId: NOTEPAD, name: "Notepad" },
        skipped: 0,
        steps: [
          {
            id: "x",
            kind: "app_type",
            app: { bundleId: NOTEPAD, name: "Notepad" },
            role: "textbox",
            name: "Notes",
            sample: CARD,
          },
          {
            id: "y",
            kind: "app_type",
            app: { bundleId: NOTEPAD, name: "Notepad" },
            role: "textbox",
            name: "Code",
            sample: "123456",
          },
          {
            id: "z",
            kind: "app_click",
            app: { bundleId: "1password.exe", name: "1Password" },
            role: "button",
            name: "Unlock",
          },
          {
            id: "w",
            kind: "app_click",
            app: { bundleId: NOTEPAD, name: "Notepad" },
            role: "button",
            name: "OK",
          },
        ],
      },
      { bundleId: NOTEPAD },
    );
    expect(cap.steps.map((s) => s.name)).toEqual(["Notes", "Code", "OK"]);
    expect(cap.steps[0]).toMatchObject({ sensitive: true });
    expect(cap.steps[0]?.sample).toBeUndefined();
    expect(cap.steps[1]).toMatchObject({ sensitive: true });
    expect(cap.steps[1]?.sample).toBeUndefined();
    expect(JSON.stringify(cap)).not.toContain("4111");
  });
});
