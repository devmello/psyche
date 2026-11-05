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
} from "../src/compose/computer.ts";
import {
  COMPUTER_USE_LINUX,
  COMPUTER_USE_LINUX_REVOKE,
  createLinuxComputerState,
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
  ])("%s is a send app: Return sends", (app) => {
    expect(isSendApp(app)).toBe(true);
    expect(isSendChord(app, "Return")).toBe(true);
    expect(isSendChord(app, "ctrl+Return")).toBe(true);
    expect(isSendChord(app, "ctrl+s")).toBe(false);
  });

  it("does not take other Linux apps for send apps", () => {
    for (const app of [editor, "firefox", "gnome-terminal", "libreoffice-writer"]) {
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
      const r = await call("computer.snapshot", { app: editor, surface });
      expect(r.isError).toBe(true);
      const err = (r.output as { error: { code: string; message: string; details: unknown } })
        .error;
      expect(err.code).toBe("unavailable");
      expect(err.details).toMatchObject({ reason: "surface_unavailable" });
      expect(err.message).not.toMatch(/Mac/);
      expect(helper.calls).toHaveLength(0);
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

  function state(extra: { start?: () => Promise<void>; online?: boolean } = {}) {
    return createLinuxComputerState({
      db,
      publishEntry: (e) => published.push(e),
      helper: () =>
        extra.online === false || !connected
          ? undefined
          : { nodeId: helper.nodeId, client: helper, kind: "host-helper" },
      ...(extra.start === undefined
        ? {}
        : {
            startHelper: async () => {
              await extra.start?.();
            },
          }),
      helperWait: { timeoutMs: 200, pollMs: 10 },
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
      warnings: [],
      checkedAt: "2026-11-05T12:00:00.000Z",
    });
    expect(published).toHaveLength(1);
    // Computer use is off: nothing asked the helper to expose app structure.
    expect(helper.calls.map((c) => c.capability)).toEqual(["portal.status", "a11y.status"]);
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

  it("does not start the helper just to refresh, and writes nothing without one", async () => {
    let started = 0;
    const s = state({
      online: false,
      start: async () => {
        started++;
      },
    });
    await s.refresh();
    expect(started).toBe(0);
    expect(stored()).toBeUndefined();
  });

  it("turns app structure on and off with Settings, starting the helper for off", async () => {
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

    connected = false;
    let started = 0;
    setSetting(db, COMPUTER_USE_ENABLED, true);
    const stopper = createLinuxComputerState({
      db,
      publishEntry: () => undefined,
      helper: () =>
        connected ? { nodeId: helper.nodeId, client: helper, kind: "host-helper" } : undefined,
      startHelper: async () => {
        started++;
        connected = true;
      },
      helperWait: { timeoutMs: 200, pollMs: 10 },
    });
    helper.calls.length = 0;
    stopper.onChanged([{ key: COMPUTER_USE_ENABLED, value: false }]);
    await stopper.settled();
    expect(started).toBe(1);
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

  it("starts the helper for a revoke and survives a helper that fails", async () => {
    connected = false;
    const s = state({
      start: async () => {
        connected = true;
      },
    });
    s.onChanged([{ key: COMPUTER_USE_LINUX_REVOKE, value: "2026-11-05T11:00:00.000Z" }]);
    await s.settled();
    expect(helper.calls[0]?.capability).toBe("portal.revoke");

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
