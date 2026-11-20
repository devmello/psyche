import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallContext } from "@psyche/browser";
import { getSetting, openDb, type PsycheDb, setSetting } from "@psyche/db";
import type {
  NodeCapability,
  NodeClient,
  NodeInfo,
  NodeInvokeResult,
  ToolRegistration,
} from "@psyche/protocol";
import { FakePermissionBroker } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APPLE_TOOLS,
  appleToolsFor,
  type ComputerDeps,
  type ComputerUse,
  createComputerUse,
  isRiskyChord,
  isSendApp,
  isSendChord,
  registerSurfaceRouter,
  type SurfaceCall,
  type SurfaceRouter,
  surfaceNodeId,
  surfaceNodesOnOffline,
} from "../src/compose/computer.ts";
import {
  COMPUTER_USE_LINUX,
  COMPUTER_USE_LINUX_REVOKE,
  cachedGraphicalSession,
  createLinuxComputerState,
  hasGraphicalSession,
  helperUnitFor,
  startHelperWithSystemd,
  systemBin,
} from "../src/compose/computer-linux.ts";
import { appTiersFrom, COMPUTER_USE_ENABLED } from "../src/compose/computer-settings.ts";

/** A Linux Host helper: records calls, answers the account capabilities from `state`. */
class FakeLinuxHelper implements NodeClient {
  readonly nodeId = "node-linux";
  readonly calls: { capability: string; params: Record<string, unknown> }[] = [];
  portal: Record<string, unknown> = {
    session: "wayland",
    desktop: "gnome",
    backend: "portal",
    allowed: true,
    active: false,
    warnings: [],
  };
  a11y: Record<string, unknown> = { available: true, enabled: true, enabledByPsyche: true };
  fail = new Set<string>();

  async info(): Promise<NodeInfo> {
    throw new Error("unused");
  }
  async capabilities(): Promise<NodeCapability[]> {
    return [];
  }
  async invoke(capability: string, params: unknown): Promise<NodeInvokeResult> {
    const p = (params ?? {}) as Record<string, unknown>;
    this.calls.push({ capability, params: p });
    if (this.fail.has(capability)) {
      return { ok: false, error: { code: "unavailable", message: "no" } };
    }
    switch (capability) {
      case "portal.status":
        return { ok: true, result: this.portal };
      case "a11y.status":
        return { ok: true, result: this.a11y };
      case "a11y.enable":
        return { ok: true, result: { ...this.a11y, enabled: p.enabled === true } };
      case "portal.revoke":
        this.portal = { ...this.portal, allowed: false };
        return { ok: true, result: { revoked: true } };
      case "computer.ax_tree":
        return {
          ok: true,
          result: { text: `window "Editor"\n  [e1] textarea "Body"`, tier: "interact" },
        };
      default:
        return { ok: true, result: { status: "ok", app: p.app ?? p.bundleId } };
    }
  }
}

let broker: FakePermissionBroker;
let helper: FakeLinuxHelper;
let connected: boolean;
let cu: ComputerUse;
let tools: Map<string, ToolRegistration>;
const contexts = new Map<string, CallContext>();
let n = 0;

function make(extra: Partial<ComputerDeps> = {}): void {
  cu = createComputerUse({
    broker,
    helper: () =>
      connected ? { nodeId: helper.nodeId, client: helper, kind: "host-helper" } : undefined,
    context: (callId) => {
      const c = contexts.get(callId);
      if (c === undefined) throw new Error(`no context ${callId}`);
      return c;
    },
    cancelRun: () => undefined,
    ...extra,
  });
  tools = new Map(cu.registrations().map((r) => [r.spec.name, r]));
}

beforeEach(() => {
  broker = new FakePermissionBroker({ armDelayMs: 0 });
  helper = new FakeLinuxHelper();
  connected = true;
  contexts.clear();
  make();
});

async function call(tool: string, params: unknown, ctx: Partial<CallContext> = {}) {
  const callId = `lcall_${++n}`;
  contexts.set(callId, {
    toolCallId: callId,
    threadId: "th_1",
    runId: "run_1",
    permissionMode: "balanced",
    taint: false,
    ...ctx,
  });
  const reg = tools.get(tool);
  if (reg === undefined) throw new Error(`no tool ${tool}`);
  return reg.execute(callId, params, new AbortController().signal, () => undefined);
}

const editor = "org.gnome.TextEditor";

describe("Linux app ids", () => {
  it.each([
    "org.gnome.TextEditor",
    "firefox",
    "gnome-terminal",
    "libreoffice-writer",
    "sublime_text",
    "org.kde.kmail2",
    "com.apple.Notes",
    "notepad.exe",
    "io.github.hexchat",
    "org.gnome.Console",
    "app+plus",
  ])("the tools accept %s", async (app) => {
    const r = await call("computer.snapshot", { app });
    expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
  });

  it.each([
    "",
    "has space",
    "a/b",
    "../etc",
    "a..b",
    ".hidden",
    "trailing.",
    'quo"te',
    "it's",
    "semi;colon",
    "dollar$x",
    "back`tick",
    "nl\nid",
    "tab\tid",
    "nul\u0000id",
    "-leading",
    `${"a".repeat(201)}`,
  ])("the tools refuse %j", async (app) => {
    const r = await call("computer.snapshot", { app });
    expect(r.isError).toBe(true);
    expect((r.output as { error: { code: string } }).error.code).toBe("invalid_params");
  });

  it("settings keep Linux ids and drop garbage, whatever the case", () => {
    expect(
      appTiersFrom([
        { id: "firefox", tier: "read" },
        { id: "org.gnome.TextEditor", tier: "interact" },
        { id: "gnome-terminal", tier: "click" },
        { id: "com.apple.Notes", tier: "interact" },
        { id: "notepad.exe", tier: "interact" },
        { id: "a/b", tier: "interact" },
        { id: "has space", tier: "interact" },
        { id: "../x", tier: "interact" },
        { id: 'q"', tier: "interact" },
        { id: "a".repeat(201), tier: "interact" },
      ]),
    ).toEqual({
      firefox: "read",
      "org.gnome.TextEditor": "interact",
      "gnome-terminal": "click",
      "com.apple.Notes": "interact",
      "notepad.exe": "interact",
    });
  });
});

describe("Linux chords and send apps", () => {
  it("treats Alt+F4 and Ctrl+F4 as risky, and leaves the Mac chords as they were", () => {
    expect(isRiskyChord("alt+f4")).toBe(true);
    expect(isRiskyChord("Ctrl+F4")).toBe(true);
    expect(isRiskyChord("cmd+q")).toBe(true);
    expect(isRiskyChord("cmd+w")).toBe(true);
    expect(isRiskyChord("cmd+f4")).toBe(false);
    expect(isRiskyChord("f4")).toBe(false);
    expect(isRiskyChord("ctrl+s")).toBe(false);
    expect(isRiskyChord("alt+tab")).toBe(false);
  });

  it.each([
    "thunderbird",
    "org.mozilla.Thunderbird",
    "evolution",
    "org.gnome.Geary",
    "kmail",
    "org.kde.kmail2",
    "slack",
    "discord",
    "signal-desktop",
    "org.signal.Signal",
    "telegram-desktop",
    "org.telegram.desktop",
    "element-desktop",
    "im.riot.Riot",
    "whatsapp-for-linux",
    "teams-for-linux",
    // Snap desktop ids (review of #1294 round 2, finding 1).
    "thunderbird_thunderbird",
    "Thunderbird_Thunderbird",
    "signal-desktop_signal-desktop",
    "telegram-desktop_telegram-desktop",
  ])("%s is a send app: Return sends", (app) => {
    expect(isSendApp(app)).toBe(true);
    expect(isSendChord(app, "Return")).toBe(true);
    expect(isSendChord(app, "ctrl+Return")).toBe(true);
    expect(isSendChord(app, "ctrl+s")).toBe(false);
  });

  it("does not take other Linux apps for send apps", () => {
    for (const app of [
      editor,
      "firefox",
      "gnome-terminal",
      "libreoffice-writer",
      "chromium_chromium",
      "libreoffice_writer",
      "thunderbirdx_notes",
    ]) {
      expect(isSendApp(app)).toBe(false);
    }
  });
});

describe("Apple tools on Linux", () => {
  const names = (reg: ToolRegistration[]) => reg.map((r) => r.spec.name);

  it("registers every tool by default and without the Apple ones on request", () => {
    expect(names(cu.registrations())).toHaveLength(10);
    const without = names(cu.registrations({ apple: false }));
    expect(without).toHaveLength(7);
    for (const t of APPLE_TOOLS) expect(without).not.toContain(t);
    expect(names(cu.registrations({ appleTools: new Set(["apps.shortcuts_list"]) }))).toContain(
      "apps.shortcuts_list",
    );
    expect(names(cu.registrations({ appleTools: new Set(["apps.shortcuts_list"]) }))).not.toContain(
      "apps.applescript",
    );
  });

  it("offers Apple tools on Linux only when the manifest lists them", () => {
    const cap = (name: string) => ({ name });
    expect(appleToolsFor(undefined, "linux")).toEqual(new Set());
    expect(
      appleToolsFor({ kind: "host-helper", capabilities: [cap("computer.click")] }, "linux"),
    ).toEqual(new Set());
    expect(
      appleToolsFor(
        { kind: "host-helper", capabilities: [cap("apps.jxa"), cap("apps.shortcut_run")] },
        "linux",
      ),
    ).toEqual(new Set(["apps.applescript", "apps.shortcut_run"]));
  });

  it("keeps every tool on macOS and Windows, with or without a manifest", () => {
    for (const platform of ["darwin", "win32"]) {
      expect(appleToolsFor(undefined, platform)).toBeUndefined();
      expect(appleToolsFor({ kind: "host-helper", capabilities: [] }, platform)).toBeUndefined();
    }
    expect(appleToolsFor({ kind: "win-helper", capabilities: [] }, "win32")).toBeUndefined();
    expect(appleToolsFor({ kind: "mac-helper", capabilities: [] }, "darwin")).toBeUndefined();
  });
});

describe("surfaces", () => {
  const routed: SurfaceCall[] = [];
  let off: (() => void) | undefined;
  const router: SurfaceRouter = {
    async invoke(c) {
      routed.push(c);
      if (c.capability === "computer.ax_tree") {
        return { ok: true, result: { text: `window "Sandbox"\n  [e1] button "Go"` } };
      }
      return { ok: true, result: { status: "ok", app: c.params.app } };
    },
  };

  beforeEach(() => {
    routed.length = 0;
  });
  afterEach(() => {
    off?.();
    off = undefined;
  });

  it("sends nothing about a surface to the Host helper on the direct path", async () => {
    await call("computer.snapshot", { app: editor });
    await call("computer.snapshot", { app: editor, surface: "direct" });
    expect(helper.calls).toHaveLength(2);
    for (const c of helper.calls) expect(c.params).not.toHaveProperty("surface");
    expect(cu.sessions()).toEqual([{ id: "run_1", nodeId: "node-linux", runIds: ["run_1"] }]);
  });

  it.each(["virtual_screen", "separate_desktop"] as const)(
    "answers unavailable (surface_unavailable) for %s with no router",
    async (surface) => {
      // The words follow the Host's platform: this is a Linux Host, whatever runs the test.
      const real = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      try {
        const r = await call("computer.snapshot", { app: editor, surface });
        expect(r.isError).toBe(true);
        const err = (r.output as { error: { code: string; message: string; details: unknown } })
          .error;
        expect(err.code).toBe("unavailable");
        expect(err.details).toMatchObject({ reason: "surface_unavailable" });
        expect(err.message).not.toMatch(/Mac/);
        expect(err.message).toMatch(/this computer/i);
        expect(helper.calls).toHaveLength(0);
      } finally {
        if (real !== undefined) Object.defineProperty(process, "platform", real);
      }
    },
  );

  it("routes a non-direct surface to its router, with its own session and refs", async () => {
    off = registerSurfaceRouter("virtual_screen", router);
    const snap = await call("computer.snapshot", { app: editor, surface: "virtual_screen" });
    expect(snap.isError).toBeUndefined();
    expect(helper.calls).toHaveLength(0);
    expect(routed[0]).toMatchObject({
      surface: "virtual_screen",
      tool: "computer.snapshot",
      capability: "computer.ax_tree",
      session: "run_1@virtual_screen",
      params: { app: editor, session: "run_1@virtual_screen" },
    });
    expect(routed[0]?.params).not.toHaveProperty("surface");
    expect(cu.sessions()).toEqual([
      {
        id: "run_1@virtual_screen",
        nodeId: "surface:virtual_screen",
        runIds: ["run_1"],
        surface: "virtual_screen",
      },
    ]);

    // e1 was seen on the virtual screen, not on the direct desktop.
    const direct = await call("computer.act", {
      app: editor,
      action: "click",
      ref: "e1",
      expect: { role: "button", label: "Go" },
    });
    expect(direct.isError).toBe(true);
    expect((direct.output as { error: { code: string } }).error.code).toBe("invalid_params");
    const onSurface = await call("computer.act", {
      app: editor,
      surface: "virtual_screen",
      action: "click",
      ref: "e1",
      expect: { role: "button", label: "Go" },
    });
    expect(onSurface.isError, JSON.stringify(onSurface.output)).toBeUndefined();
    expect(routed.at(-1)).toMatchObject({ capability: "computer.click" });
  });

  it("takes routers from the surfaces option, which wins over the registry", async () => {
    off = registerSurfaceRouter("separate_desktop", router);
    const own: SurfaceCall[] = [];
    make({
      surfaces: {
        separate_desktop: {
          async invoke(c) {
            own.push(c);
            return { ok: true, result: { apps: [] } };
          },
        },
      },
    });
    const r = await call("apps.list", { surface: "separate_desktop" });
    expect(r.isError).toBeUndefined();
    expect(own).toHaveLength(1);
    expect(routed).toHaveLength(0);
  });

  it("ends a routed session through its router when the run ends", async () => {
    const ended: string[] = [];
    off = registerSurfaceRouter("virtual_screen", {
      invoke: router.invoke,
      async endSession(id) {
        ended.push(id);
      },
    });
    await call("computer.snapshot", { app: editor, surface: "virtual_screen" });
    await call("computer.snapshot", { app: editor });
    await cu.runEnded("run_1");
    expect(ended).toEqual(["run_1@virtual_screen"]);
    expect(helper.calls.map((c) => c.capability)).toContain("computer.end_session");
    expect(cu.sessions()).toEqual([]);
  });

  it("allows one session per node and surface at a time", async () => {
    off = registerSurfaceRouter("virtual_screen", router);
    await call("computer.snapshot", { app: editor }, { runId: "run_a" });
    // Another run on the direct surface is busy; on the virtual screen it is not.
    const busy = await call("computer.snapshot", { app: editor }, { runId: "run_b" });
    expect((busy.output as { error: { details: { reason: string } } }).error.details.reason).toBe(
      "computer_busy",
    );
    const other = await call(
      "computer.snapshot",
      { app: editor, surface: "virtual_screen" },
      { runId: "run_b" },
    );
    expect(other.isError).toBeUndefined();
    const busyToo = await call(
      "computer.snapshot",
      { app: editor, surface: "virtual_screen" },
      { runId: "run_c" },
    );
    expect(
      (busyToo.output as { error: { details: { reason: string } } }).error.details.reason,
    ).toBe("computer_busy");
  });

  it("keeps a grant for one surface from covering another", async () => {
    const d = tools.get("computer.snapshot")?.describeCall?.({ app: editor });
    const v = tools
      .get("computer.snapshot")
      ?.describeCall?.({ app: editor, surface: "virtual_screen" });
    expect(d?.grantKey).toBe(`${editor}|read`);
    expect(v?.grantKey).toBe(`${editor}|read|virtual_screen`);
    expect(d?.bindingFields).not.toHaveProperty("surface");
    expect(v?.bindingFields).toMatchObject({ surface: "virtual_screen" });
  });
});

describe("starting the Linux helper on demand", () => {
  it("starts it, waits for it to connect, and goes on", async () => {
    connected = false;
    let started = 0;
    make({
      startHelper: async () => {
        started++;
        setTimeout(() => {
          connected = true;
        }, 30);
      },
      helperWait: { timeoutMs: 2_000, pollMs: 10 },
    });
    const r = await call("computer.snapshot", { app: editor });
    expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
    expect(started).toBe(1);
  });

  it("does not start it when it is connected", async () => {
    let started = 0;
    make({
      startHelper: async () => {
        started++;
      },
    });
    await call("computer.snapshot", { app: editor });
    expect(started).toBe(0);
  });

  it("starts it once for calls that arrive together", async () => {
    connected = false;
    let started = 0;
    make({
      startHelper: async () => {
        started++;
        setTimeout(() => {
          connected = true;
        }, 30);
      },
      helperWait: { timeoutMs: 2_000, pollMs: 10 },
    });
    const both = await Promise.all([
      call("apps.list", {}),
      call("apps.focus", { app: editor }, { runId: "run_2" }),
    ]);
    expect(both.map((r) => r.isError)).toEqual([undefined, undefined]);
    expect(started).toBe(1);
  });

  it("answers helper_not_started when systemctl fails", async () => {
    connected = false;
    make({
      startHelper: async () => {
        throw new Error("Failed to start psyche-helper.service");
      },
    });
    const r = await call("computer.snapshot", { app: editor });
    const err = (
      r.output as {
        error: { code: string; message: string; retryable?: boolean; details: { reason: string } };
      }
    ).error;
    expect(err).toMatchObject({
      code: "unavailable",
      message: "Needs a graphical session on this computer",
      retryable: true,
      details: { reason: "helper_not_started" },
    });
  });

  it("answers helper_not_started when the helper never connects", async () => {
    connected = false;
    make({
      startHelper: async () => undefined,
      helperWait: { timeoutMs: 50, pollMs: 10 },
    });
    const r = await call("computer.snapshot", { app: editor });
    const err = (
      r.output as { error: { code: string; retryable?: boolean; details: { reason: string } } }
    ).error;
    expect(err).toMatchObject({
      code: "unavailable",
      retryable: true,
      details: { reason: "helper_not_started" },
    });
  });

  it("never starts anything without a starter (macOS and Windows)", async () => {
    connected = false;
    const r = await call("computer.snapshot", { app: editor });
    const err = (r.output as { error: { code: string; message: string; details?: unknown } }).error;
    expect(err.code).toBe("unavailable");
    expect(err.details).toBeUndefined();
  });
});

describe("computerUse.linux and the account state", () => {
  let home = "";
  let db: PsycheDb;
  const published: unknown[] = [];

  function state(extra: { online?: boolean } = {}) {
    return createLinuxComputerState({
      db,
      publishEntry: (e) => published.push(e),
      helper: () =>
        extra.online === false || !connected
          ? undefined
          : { nodeId: helper.nodeId, client: helper, kind: "host-helper" },
      now: () => new Date("2026-11-05T12:00:00.000Z"),
    });
  }
  const stored = () => getSetting(db, COMPUTER_USE_LINUX)?.value;

  beforeEach(() => {
    published.length = 0;
    home = mkdtempSync(join(tmpdir(), "psyche-cu-linux-"));
    db = openDb(join(home, "psyche.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("writes the portal and accessibility state when the helper comes online", async () => {
    const s = state();
    await s.helperOnline();
    expect(stored()).toEqual({
      session: "wayland",
      desktop: "gnome",
      backend: "portal",
      allowed: true,
      a11yEnabled: true,
      // An older helper does not say whether it has a Stop.
      killSwitch: null,
      warnings: [],
      checkedAt: "2026-11-05T12:00:00.000Z",
    });
    expect(published).toHaveLength(1);
    // Computer use is off: the helper is told to put app structure back, never to expose it.
    expect(helper.calls.map((c) => [c.capability, c.params.enabled])).toEqual([
      ["a11y.enable", false],
      ["portal.status", undefined],
      ["a11y.status", undefined],
    ]);
  });

  // Review of #1294 round 2, finding 7: Settings can say computer use is refused for want of a Stop.
  it("passes on whether the helper has a working Stop", async () => {
    const s = state();
    helper.portal = { ...helper.portal, killSwitch: false };
    await s.refresh();
    expect(stored()).toMatchObject({ killSwitch: false });
    helper.portal = { ...helper.portal, killSwitch: true };
    await s.refresh();
    expect(stored()).toMatchObject({ killSwitch: true });
    helper.portal = { ...helper.portal, killSwitch: "yes" };
    await s.refresh();
    expect(stored()).toMatchObject({ killSwitch: null });
  });

  it("asks for app structure when it comes online while computer use is on", async () => {
    setSetting(db, COMPUTER_USE_ENABLED, true);
    const s = state();
    await s.helperOnline();
    expect(helper.calls[0]).toEqual({ capability: "a11y.enable", params: { enabled: true } });
  });

  it("keeps warnings and an unknown accessibility state, and never invents values", async () => {
    helper.portal = {
      session: "x11",
      desktop: "other",
      backend: "x11",
      allowed: false,
      active: false,
      warnings: ["x11", 4, "wlroots"],
    };
    helper.a11y = { available: false, enabled: null, enabledByPsyche: false };
    const s = state();
    await s.refresh();
    expect(stored()).toMatchObject({
      session: "x11",
      desktop: "other",
      backend: "x11",
      allowed: false,
      a11yEnabled: null,
      warnings: ["x11", "wlroots"],
    });
    helper.portal = { session: "mars", desktop: "cde", backend: "?", allowed: "yes" };
    await s.refresh();
    expect(stored()).toMatchObject({
      session: "headless",
      desktop: null,
      backend: "none",
      allowed: false,
    });
  });

  it("writes nothing on a refresh without a helper", async () => {
    const s = state({ online: false });
    await s.refresh();
    expect(stored()).toBeUndefined();
    expect(helper.calls).toHaveLength(0);
  });

  it("turns app structure on and off with Settings on a running helper", async () => {
    const s = state();
    s.onChanged([{ key: COMPUTER_USE_ENABLED, value: true }]);
    await s.settled();
    expect(helper.calls.map((c) => [c.capability, c.params.enabled])).toEqual([
      ["a11y.enable", true],
      ["portal.status", undefined],
      ["a11y.status", undefined],
    ]);
    // The same value again is not a change.
    helper.calls.length = 0;
    s.onChanged([{ key: COMPUTER_USE_ENABLED, value: true }]);
    await s.settled();
    expect(helper.calls).toHaveLength(0);

    s.onChanged([{ key: COMPUTER_USE_ENABLED, value: false }]);
    await s.settled();
    expect(helper.calls[0]).toEqual({ capability: "a11y.enable", params: { enabled: false } });
  });

  // PR #1498 r2, finding 1: off with no helper running starts nothing; the next helper is told.
  it("turning it off with no helper running waits for the next helper to connect", async () => {
    connected = false;
    setSetting(db, COMPUTER_USE_ENABLED, true);
    const s = state();
    s.onChanged([{ key: COMPUTER_USE_ENABLED, value: false }]);
    await s.settled();
    expect(helper.calls).toHaveLength(0);
    connected = true;
    await s.helperOnline();
    expect(helper.calls[0]).toEqual({ capability: "a11y.enable", params: { enabled: false } });
  });

  it("revokes when the UI sets a new computerUse.linuxRevoke, then refreshes", async () => {
    setSetting(db, COMPUTER_USE_LINUX_REVOKE, "2026-11-05T10:00:00.000Z");
    const s = state();
    // The value that was already stored at boot is not a request.
    s.onChanged([{ key: COMPUTER_USE_LINUX_REVOKE, value: "2026-11-05T10:00:00.000Z" }]);
    await s.settled();
    expect(helper.calls).toHaveLength(0);

    s.onChanged([{ key: COMPUTER_USE_LINUX_REVOKE, value: "2026-11-05T11:00:00.000Z" }]);
    await s.settled();
    expect(helper.calls.map((c) => c.capability)).toEqual([
      "portal.revoke",
      "portal.status",
      "a11y.status",
    ]);
    expect(stored()).toMatchObject({ allowed: false });

    helper.calls.length = 0;
    s.onChanged([{ key: COMPUTER_USE_LINUX_REVOKE, value: "2026-11-05T11:00:00.000Z" }]);
    s.onChanged([{ key: COMPUTER_USE_LINUX_REVOKE, value: "" }]);
    s.onChanged([{ key: COMPUTER_USE_LINUX_REVOKE, value: 5 }]);
    await s.settled();
    expect(helper.calls).toHaveLength(0);
  });

  // PR #1498 r2, finding 1: Revoke with no helper running starts nothing and is kept pending.
  it("keeps a Revoke for the next helper, once, and survives a helper that fails", async () => {
    connected = false;
    const s = state();
    s.onChanged([{ key: COMPUTER_USE_LINUX_REVOKE, value: "2026-11-05T11:00:00.000Z" }]);
    await s.settled();
    expect(helper.calls).toHaveLength(0);
    connected = true;
    await s.helperOnline();
    expect(helper.calls[0]?.capability).toBe("portal.revoke");
    // Applied once: the next connect does not revoke again.
    helper.calls.length = 0;
    await s.helperOnline();
    expect(helper.calls.map((c) => c.capability)).not.toContain("portal.revoke");

    helper.fail.add("portal.status");
    helper.calls.length = 0;
    s.onChanged([{ key: COMPUTER_USE_LINUX_REVOKE, value: "2026-11-05T12:30:00.000Z" }]);
    await s.settled();
    // The failed status read leaves the last good state in place.
    expect(stored()).toMatchObject({ session: "wayland" });
  });

  it("refreshes after a direct computer-use session ends", async () => {
    let ended = 0;
    make({ sessionEnded: () => ended++ });
    await call("computer.snapshot", { app: editor });
    expect(ended).toBe(0);
    await cu.runEnded("run_1");
    expect(ended).toBe(1);
  });
});

describe("the headless Host helper (B0)", () => {
  const out = (r: { output: unknown }) =>
    (r.output as { error: { code: string; details?: { reason?: string; surface?: string } } })
      .error;

  it("picks the unit from the session: graphical keeps psyche-helper.service", async () => {
    expect(helperUnitFor(true)).toBe("psyche-helper.service");
    expect(helperUnitFor(false)).toBe("psyche-helper-headless.service");
    const ran: string[][] = [];
    const run = async (file: string, args: string[]) => {
      ran.push([file, ...args]);
      return "";
    };
    await startHelperWithSystemd(undefined, run, async () => true);
    await startHelperWithSystemd(undefined, run, async () => false);
    const systemctl = systemBin("systemctl");
    expect(systemctl).toMatch(/^\/(usr\/)?bin\/systemctl$/);
    expect(ran).toEqual([
      [systemctl, "--user", "start", "psyche-helper.service"],
      [systemctl, "--user", "start", "psyche-helper-headless.service"],
    ]);
  });

  it("systemBin prefers /usr/bin, falls back to /bin, never uses PATH", () => {
    expect(systemBin("loginctl", () => true)).toBe("/usr/bin/loginctl");
    expect(systemBin("loginctl", (p) => p === "/bin/loginctl")).toBe("/bin/loginctl");
    expect(systemBin("loginctl", () => false)).toBe("/usr/bin/loginctl");
  });

  it("a failed start names the unit", async () => {
    const run = async () => {
      throw new Error("Unit not found");
    };
    await expect(startHelperWithSystemd(undefined, run, async () => false)).rejects.toMatchObject({
      unit: "psyche-helper-headless.service",
    });
  });

  interface FakeSession {
    id: string;
    uid?: string;
    type: string;
    state?: string;
    /** `Remote=`; default `no`. Undefined in the output when `null`. */
    remote?: string | null;
    /** `Seat=`; default `seat0`. SSH and pty sessions have none (`""`). */
    seat?: string;
    /** Gone between `list-sessions` and `show-session` (`No session '<id>' known`). */
    gone?: boolean;
  }

  /** Sockets that exist on the fake box: X display :0 and wayland-1 in the runtime dir. */
  const SOCKETS = new Set(["/tmp/.X11-unix/X0", "/run/user/1000/wayland-1", "/xdg/wayland-2"]);
  const sockets = (p: string) => SOCKETS.has(p);

  /** logind and the user manager as a table: sessions of uid 1000, plus the user environment. */
  const logind = (sessions: FakeSession[], env = "PATH=/usr/bin\n") => {
    const calls: string[][] = [];
    const run = async (file: string, args: string[]) => {
      calls.push([file.split("/").pop() ?? file, ...args]);
      if (args[0] === "list-sessions") {
        return sessions.map((s) => `${s.id} ${s.uid ?? "1000"} devmello seat0 -`).join("\n");
      }
      if (args[0] === "show-session") {
        const s = sessions.find((x) => x.id === args[1]);
        if (s === undefined || s.gone === true) throw new Error(`No session '${args[1]}' known`);
        const remote =
          s.remote === undefined ? "Remote=no\n" : s.remote === null ? "" : `Remote=${s.remote}\n`;
        // logind prints in its own order, not the requested one.
        return `User=${s.uid ?? "1000"}\nSeat=${s.seat ?? "seat0"}\nType=${s.type}\n${remote}State=${s.state ?? "active"}\n`;
      }
      if (args[0] === "--user" && args[1] === "show-environment") return env;
      throw new Error("unexpected");
    };
    return { run, calls };
  };

  const ssh = (id: string): FakeSession => ({ id, type: "tty", remote: "yes", seat: "" });

  it.each<[string, FakeSession[], string | undefined, boolean]>([
    ["x11", [{ id: "2", type: "x11" }], undefined, true],
    ["wayland", [{ id: "c1", type: "wayland" }], undefined, true],
    ["mir", [{ id: "c1", type: "mir" }], undefined, true],
    [
      "a wayland session among an ssh one",
      [
        { id: "4", type: "tty" },
        { id: "5", type: "wayland" },
      ],
      undefined,
      true,
    ],
    ["an ssh (tty) session alone", [ssh("4")], undefined, false],
    ["a local console tty session with no display", [{ id: "4", type: "tty" }], undefined, false],
    ["an unspecified or manager session", [{ id: "4", type: "unspecified" }], undefined, false],
    ["a closing x11 session", [{ id: "2", type: "x11", state: "closing" }], undefined, false],
    [
      "another user's wayland session",
      [{ id: "3", uid: "1001", type: "wayland" }],
      undefined,
      false,
    ],
    ["no session (linger only)", [], undefined, false],
    [
      "a tty session with DISPLAY in the user env (startx)",
      [{ id: "1", type: "tty" }],
      "PATH=/x\nDISPLAY=:0\n",
      true,
    ],
    [
      "a tty session with WAYLAND_DISPLAY (sway on a console)",
      [{ id: "1", type: "tty" }],
      "WAYLAND_DISPLAY=wayland-1\n",
      true,
    ],
    ["a tty session with an empty DISPLAY", [{ id: "1", type: "tty" }], "DISPLAY=\n", false],
    ["DISPLAY in the env but no session at all", [], "DISPLAY=:0\n", false],
    [
      "DISPLAY in the env but only a closing tty session",
      [{ id: "1", type: "tty", state: "closing" }],
      "DISPLAY=:0\n",
      false,
    ],
    // PR #1498 r2, finding 3: a DISPLAY left in the lingering user manager by a stopped desktop.
    [
      "an ssh session with a stale DISPLAY (probe P6)",
      [ssh("c18")],
      "PATH=/usr/bin\nDISPLAY=:0\n",
      false,
    ],
    [
      "an ssh session with a live WAYLAND_DISPLAY",
      [ssh("c18")],
      "WAYLAND_DISPLAY=wayland-1\n",
      false,
    ],
    [
      "a pty session (script + su -l: Remote=no, no seat) with DISPLAY",
      [{ id: "c2", type: "tty", seat: "" }],
      "DISPLAY=:0\n",
      false,
    ],
    [
      "a console tty session whose Remote= is not reported",
      [{ id: "1", type: "tty", remote: null }],
      "DISPLAY=:0\n",
      false,
    ],
    [
      "a console tty session with DISPLAY but no X socket",
      [{ id: "1", type: "tty" }],
      "DISPLAY=:7\n",
      false,
    ],
    [
      "a console tty session with WAYLAND_DISPLAY but no socket",
      [{ id: "1", type: "tty" }],
      "WAYLAND_DISPLAY=wayland-9\n",
      false,
    ],
    ["a screen number on the display", [{ id: "1", type: "tty" }], "DISPLAY=:0.0\n", true],
    ["a remote X display name", [{ id: "1", type: "tty" }], "DISPLAY=box:0\n", false],
    [
      "WAYLAND_DISPLAY in XDG_RUNTIME_DIR",
      [{ id: "1", type: "tty" }],
      "XDG_RUNTIME_DIR=/xdg\nWAYLAND_DISPLAY=wayland-2\n",
      true,
    ],
    [
      "a WAYLAND_DISPLAY that climbs out of the runtime dir",
      [{ id: "1", type: "tty" }],
      "WAYLAND_DISPLAY=../1000/wayland-1\n",
      false,
    ],
    // PR #1498 r2, finding 4: one session gone between list and show hides nothing else.
    [
      "a vanished session before a live wayland one (probe P5)",
      [
        { id: "c9", type: "tty", gone: true },
        { id: "c1", type: "wayland" },
      ],
      undefined,
      true,
    ],
    ["only a vanished session", [{ id: "c9", type: "wayland", gone: true }], undefined, false],
  ])("hasGraphicalSession: %s", async (_name, sessions, env, want) => {
    const { run } = logind(sessions, env);
    expect(await hasGraphicalSession(run, 1000, undefined, sockets)).toBe(want);
  });

  it("hasGraphicalSession asks logind with fixed arguments, not for Display=", async () => {
    const { run, calls } = logind([{ id: "2", type: "x11" }]);
    await hasGraphicalSession(run, 1000, undefined, sockets);
    expect(calls).toEqual([
      ["loginctl", "list-sessions", "--no-legend"],
      [
        "loginctl",
        "show-session",
        "2",
        ...["-p", "Type", "-p", "State", "-p", "User", "-p", "Remote", "-p", "Seat"],
      ],
    ]);
  });

  it("hasGraphicalSession: no loginctl or no logind record means no session", async () => {
    const run = async () => {
      throw new Error("ENOENT");
    };
    expect(await hasGraphicalSession(run, 1000)).toBe(false);
    expect(await hasGraphicalSession(run, undefined)).toBe(false);
  });

  // PR #1498 r2, finding 4: only a failed list-sessions fails closed.
  it("hasGraphicalSession fails closed when list-sessions itself fails", async () => {
    const shown: string[] = [];
    const run = async (_file: string, args: string[]) => {
      if (args[0] === "list-sessions") throw new Error("Failed to connect to bus");
      shown.push(args[1] ?? "");
      return "Type=wayland\nState=active\nUser=1000\n";
    };
    expect(await hasGraphicalSession(run, 1000, undefined, sockets)).toBe(false);
    expect(shown).toEqual([]);
  });

  it("hasGraphicalSession passes the signal to every spawn", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const ctrl = new AbortController();
    const { run } = logind([{ id: "1", type: "tty" }], "DISPLAY=:0\n");
    const spy = async (file: string, args: string[], signal?: AbortSignal) => {
      signals.push(signal);
      return run(file, args);
    };
    expect(await hasGraphicalSession(spy, 1000, ctrl.signal, sockets)).toBe(true);
    expect(signals).toHaveLength(3);
    for (const s of signals) expect(s).toBe(ctrl.signal);
  });

  // PR #1498 r2, finding 5: one lookup per few seconds for every call site.
  describe("cachedGraphicalSession", () => {
    it("makes one lookup for a burst of three calls, and a new one after the TTL", async () => {
      let lookups = 0;
      let t = 0;
      const check = cachedGraphicalSession(
        async () => {
          lookups++;
          await new Promise((r) => setTimeout(r, 5));
          return true;
        },
        { ttlMs: 3_000, now: () => t },
      );
      expect(await Promise.all([check(), check(), check()])).toEqual([true, true, true]);
      expect(lookups).toBe(1);
      t = 2_999;
      await check();
      expect(lookups).toBe(1);
      t = 3_000;
      await check();
      expect(lookups).toBe(2);
    });

    it("a cancelled caller stops waiting, kills the lookup, and nothing is cached", async () => {
      let lookups = 0;
      const seen: AbortSignal[] = [];
      const check = cachedGraphicalSession(
        (signal) => {
          lookups++;
          seen.push(signal);
          // The first lookup hangs until killed (a stalled logind); later ones answer.
          if (lookups > 1) return Promise.resolve(true);
          return new Promise<boolean>((resolve) => {
            signal.addEventListener("abort", () => resolve(false));
          });
        },
        { now: () => 0 },
      );
      const ctrl = new AbortController();
      const p = check(ctrl.signal);
      ctrl.abort();
      await expect(p).rejects.toMatchObject({ code: "cancelled" });
      expect(seen[0]?.aborted).toBe(true);
      // An already-cancelled caller does not start a lookup.
      await expect(check(ctrl.signal)).rejects.toMatchObject({ code: "cancelled" });
      expect(lookups).toBe(1);
      // The killed lookup's false was not cached: the next caller asks again and gets true.
      expect(await check()).toBe(true);
      expect(lookups).toBe(2);
    });

    it("keeps the lookup running while another caller still waits on it", async () => {
      let resolve: (v: boolean) => void = () => undefined;
      let signal: AbortSignal | undefined;
      const check = cachedGraphicalSession(
        (s) => {
          signal = s;
          return new Promise<boolean>((r) => {
            resolve = r;
          });
        },
        { now: () => 0 },
      );
      const a = new AbortController();
      const first = check(a.signal);
      const second = check(new AbortController().signal);
      a.abort();
      await expect(first).rejects.toMatchObject({ code: "cancelled" });
      expect(signal?.aborted).toBe(false);
      resolve(true);
      expect(await second).toBe(true);
    });
  });

  it("direct answers no_graphical_session and starts nothing", async () => {
    connected = false;
    let started = 0;
    make({
      startHelper: async () => {
        started++;
      },
      graphicalSession: async () => false,
    });
    const r = await call("computer.snapshot", { app: editor });
    expect(out(r)).toMatchObject({
      code: "unavailable",
      details: { reason: "no_graphical_session" },
    });
    expect(started).toBe(0);
  });

  it("with a graphical session, direct goes to the helper as before", async () => {
    make({ startHelper: async () => undefined, graphicalSession: async () => true });
    const r = await call("computer.snapshot", { app: editor });
    expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
    expect(helper.calls.every((c) => c.params.surface === "direct")).toBe(true);
  });

  it("virtual_screen starts the headless helper and sends it surface: virtual_screen", async () => {
    connected = false;
    let started = 0;
    make({
      startHelper: async () => {
        started++;
        setTimeout(() => {
          connected = true;
        }, 20);
      },
      graphicalSession: async () => false,
      helperWait: { timeoutMs: 2_000, pollMs: 10 },
    });
    const r = await call("computer.snapshot", { app: editor, surface: "virtual_screen" });
    expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
    expect(started).toBe(1);
    expect(helper.calls.length).toBeGreaterThan(0);
    for (const c of helper.calls) expect(c.params).toMatchObject({ surface: "virtual_screen" });
  });

  it("virtual_screen on a Host with a graphical session stays surface_unavailable", async () => {
    make({ startHelper: async () => undefined, graphicalSession: async () => true });
    const r = await call("computer.snapshot", { app: editor, surface: "virtual_screen" });
    expect(out(r)).toMatchObject({
      code: "unavailable",
      details: { reason: "surface_unavailable", surface: "virtual_screen" },
    });
    expect(helper.calls).toHaveLength(0);
  });

  // PR #1498 r2, finding 4: the router uses resolveTarget's decision; it never asks again.
  it("virtual_screen asks once per call and starts the unit that decision picked", async () => {
    connected = false;
    const answers = [false, true, true, true];
    let asked = 0;
    const starts: (boolean | undefined)[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    make({
      startHelper: async (_signal, graphical) => {
        starts.push(graphical);
        connected = true;
      },
      graphicalSession: async (signal) => {
        signals.push(signal);
        return answers[asked++] ?? true;
      },
      helperWait: { timeoutMs: 500, pollMs: 5 },
    });
    // The answer flips after resolveTarget asked: the call that holds a session still goes on.
    const r = await call(
      "computer.snapshot",
      { app: editor, surface: "virtual_screen" },
      { threadId: "t1", runId: "r1" },
    );
    expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
    expect(starts).toEqual([false]);
    // Asked once, by resolveTarget, with the call's signal; the router did not ask again.
    expect(asked).toBe(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(cu.sessions().map((s) => s.surface)).toEqual(["virtual_screen"]);
  });

  it("direct starts the graphical unit it decided on", async () => {
    connected = false;
    const starts: (boolean | undefined)[] = [];
    make({
      startHelper: async (_signal, graphical) => {
        starts.push(graphical);
        connected = true;
      },
      graphicalSession: async () => true,
      helperWait: { timeoutMs: 500, pollMs: 5 },
    });
    const r = await call("computer.snapshot", { app: editor });
    expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
    expect(starts).toEqual([true]);
  });

  /** A Linux-shaped helper: apps.open at the Ask tier needs `params.approval`, as the real one. */
  class StrictLinuxHelper extends FakeLinuxHelper {
    headless = false;
    override async invoke(capability: string, params: unknown): Promise<NodeInvokeResult> {
      const p = (params ?? {}) as Record<string, unknown>;
      const surface = p.surface;
      if (surface !== undefined && surface !== (this.headless ? "virtual_screen" : "direct")) {
        return {
          ok: false,
          error: { code: "invalid_params", message: "no", details: { reason: "surface_mismatch" } },
        };
      }
      if (this.headless && surface === undefined && capability.startsWith("apps.")) {
        // A headless helper serves a call that names no surface on its private screen.
        this.calls.push({ capability, params: p });
        return { ok: true, result: { status: "served_headless" } };
      }
      if (capability === "apps.open" && p.approval === undefined) {
        this.calls.push({ capability, params: p });
        return {
          ok: false,
          error: {
            code: "approval_required",
            message: "needs your permission",
            details: { app: p.app, reason: "tier_ask", tierRequired: "click" },
          },
        };
      }
      if (capability === "apps.resolve") {
        return { ok: false, error: { code: "not_implemented", message: "no" } };
      }
      if (capability === "apps.open") {
        this.calls.push({ capability, params: p });
        return { ok: true, result: { bundleId: p.app, name: "Editor", pid: 42 } };
      }
      return super.invoke(capability, params);
    }
  }

  const approveAll = () => {
    const request = broker.requestApproval.bind(broker);
    broker.requestApproval = async (input) => {
      const i = await request(input);
      queueMicrotask(() => {
        void broker.answer({
          approvalId: i.approval.id,
          answerToken: i.answerTokens.desktop ?? "",
          decision: "approve",
          scope: "once",
          decidedBy: { deviceId: "dev-owner", surface: "desktop" },
        });
      });
      return i;
    };
  };

  it.each([
    ["direct", undefined, true],
    ["virtual_screen", "virtual_screen", false],
  ] as const)(
    "apps.open at the Ask tier carries params.approval after the owner approves (%s)",
    async (_name, surface, graphical) => {
      const strict = new StrictLinuxHelper();
      strict.headless = !graphical;
      helper = strict;
      approveAll();
      make({
        startHelper: async () => undefined,
        graphicalSession: async () => graphical,
      });
      const r = await call("apps.open", {
        app: editor,
        ...(surface === undefined ? {} : { surface }),
      });
      expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
      const sent = strict.calls.filter((c) => c.capability === "apps.open");
      expect(sent.length).toBeGreaterThanOrEqual(2);
      expect(sent[0]?.params.approval).toBeUndefined();
      expect(sent[sent.length - 1]?.params.approval).toMatchObject({ app: editor });
    },
  );

  it("sends surface: direct on the Linux direct path", async () => {
    make({ startHelper: async () => undefined, graphicalSession: async () => true });
    await call("computer.snapshot", { app: editor });
    expect(helper.calls.length).toBeGreaterThan(0);
    for (const c of helper.calls) expect(c.params.surface).toBe("direct");
  });

  it("refuses direct on a still-connected headless helper once a session exists", async () => {
    const strict = new StrictLinuxHelper();
    strict.headless = true;
    helper = strict;
    make({ startHelper: async () => undefined, graphicalSession: async () => true });
    const r = await call("apps.list", {});
    expect(r.isError).toBe(true);
    expect(strict.calls.some((c) => (c.params as { surface?: string }).surface === undefined)).toBe(
      false,
    );
    expect(JSON.stringify(r.output)).not.toContain("served_headless");
  });

  it("a refused virtual_screen call on a graphical Host leaves no session behind", async () => {
    make({ startHelper: async () => undefined, graphicalSession: async () => true });
    const first = await call(
      "computer.snapshot",
      { app: editor, surface: "virtual_screen" },
      { threadId: "t1", runId: "r1" },
    );
    expect(out(first).details?.reason).toBe("surface_unavailable");
    expect(cu.sessions()).toEqual([]);
    const second = await call(
      "computer.snapshot",
      { app: editor, surface: "virtual_screen" },
      { threadId: "t2", runId: "r2" },
    );
    expect(out(second).details?.reason).toBe("surface_unavailable");
    expect(out(second).code).not.toBe("conflict");
  });

  it("a Host helper going offline ends the virtual_screen sessions", async () => {
    expect(surfaceNodesOnOffline("host-helper")).toEqual([surfaceNodeId("virtual_screen")]);
    expect(surfaceNodesOnOffline("mac-helper")).toEqual([surfaceNodeId("virtual_screen")]);
    expect(surfaceNodesOnOffline("guest")).toEqual([surfaceNodeId("separate_desktop")]);
    expect(surfaceNodesOnOffline("linux-helper")).toEqual([]);
    expect(surfaceNodesOnOffline(undefined)).toEqual([]);
    make({ startHelper: async () => undefined, graphicalSession: async () => false });
    await call("computer.snapshot", { app: editor, surface: "virtual_screen" });
    expect(cu.sessions().map((s) => s.nodeId)).toEqual([surfaceNodeId("virtual_screen")]);
    for (const id of surfaceNodesOnOffline("host-helper")) cu.nodeGone(id);
    await new Promise((r) => setTimeout(r, 20));
    expect(cu.sessions()).toEqual([]);
  });

  it("a start failure names the unit that could not be started", async () => {
    connected = false;
    make({
      startHelper: async () => {
        throw Object.assign(new Error("x"), { unit: "psyche-helper-headless.service" });
      },
      graphicalSession: async () => false,
    });
    const r = await call("computer.snapshot", { app: editor, surface: "virtual_screen" });
    const e = out(r) as unknown as { message: string; details: { reason: string } };
    expect(e.details.reason).toBe("helper_not_started");
    expect(e.message).toContain("psyche-helper-headless.service");
  });
});
