/**
 * PR #1498 r2 probes, kept as tests: the real `composeComputer` on a Linux Gateway, with
 * `node:child_process` mocked so every `loginctl` and `systemctl` spawn is recorded.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallContext } from "@psyche/browser";
import { openDb, type PsycheDb, setSetting } from "@psyche/db";
import type {
  NodeCapability,
  NodeClient,
  NodeInfo,
  NodeInvokeResult,
  ToolRegistration,
} from "@psyche/protocol";
import { FakePermissionBroker } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const exec = vi.hoisted(() => ({
  sessions: "",
  show: {} as Record<string, string>,
  env: "PATH=/usr/bin\n",
  log: [] as string[][],
  onStart: (_unit: string): void => undefined,
}));

vi.mock("node:child_process", async (orig) => {
  const real = (await orig()) as typeof import("node:child_process");
  return {
    ...real,
    execFile: (
      file: string,
      args: string[],
      _opts: unknown,
      cb: (e: Error | null, out?: string) => void,
    ) => {
      exec.log.push([file, ...args]);
      const name = file.split("/").pop();
      setImmediate(() => {
        if (name === "loginctl" && args[0] === "list-sessions") return cb(null, exec.sessions);
        if (name === "loginctl" && args[0] === "show-session") {
          const shown = exec.show[args[1] ?? ""];
          if (shown === undefined) return cb(new Error(`No session '${args[1]}' known`));
          return cb(null, shown);
        }
        if (name === "systemctl" && args[1] === "show-environment") return cb(null, exec.env);
        if (name === "systemctl" && args[1] === "start") {
          exec.onStart(args[2] ?? "");
          return cb(null, "");
        }
        cb(new Error(`unexpected ${file} ${args.join(" ")}`));
      });
      return {} as never;
    },
  };
});

const { composeComputer } = await import("../src/compose/computer.ts");
const { COMPUTER_USE_ENABLED } = await import("../src/compose/computer-settings.ts");
const { COMPUTER_USE_LINUX_REVOKE, hasGraphicalSession } = await import(
  "../src/compose/computer-linux.ts"
);

class Fake implements NodeClient {
  readonly nodeId = "node-linux";
  calls: { capability: string; params: Record<string, unknown> }[] = [];
  async info(): Promise<NodeInfo> {
    throw new Error("unused");
  }
  async capabilities(): Promise<NodeCapability[]> {
    return [];
  }
  async invoke(capability: string, params: unknown): Promise<NodeInvokeResult> {
    const p = (params ?? {}) as Record<string, unknown>;
    this.calls.push({ capability, params: p });
    if (capability === "portal.status") {
      return { ok: true, result: { session: "headless", backend: "none", allowed: false } };
    }
    if (capability === "a11y.status") return { ok: true, result: { available: false } };
    if (capability === "computer.ax_tree") {
      return { ok: true, result: { text: `window "E"\n  [e1] textarea "B"`, tier: "interact" } };
    }
    return { ok: true, result: { status: "ok", app: p.app } };
  }
}

let home = "";
let db: PsycheDb;
let fake: Fake;
let connected = false;
let handler: (frame: string) => void = () => undefined;
const tools = new Map<string, ToolRegistration>();
const contexts = new Map<string, CallContext>();
let n = 0;
const realPlatform = process.platform;
const parts: { stop?: () => void | Promise<void> }[] = [];

function compose() {
  const broker = new FakePermissionBroker({ armDelayMs: 0 });
  const services = {
    db,
    home,
    publish: () => undefined,
    attention: { lastInput: () => undefined, paneHidden: () => false },
    broker,
    rawBroker: broker,
    calls: {
      get: () => undefined,
      context: (id: string) => contexts.get(id),
      authorityFor: () => undefined,
    },
    tools: {
      register: (r: ToolRegistration) => {
        tools.set(r.spec.name, r);
        return () => tools.delete(r.spec.name);
      },
    },
  };
  const part = composeComputer(services as never);
  const gw = {
    bus: {
      subscribe: (_s: unknown, fn: (f: string) => void) => {
        handler = fn;
        return () => undefined;
      },
    },
    context: {
      nodes: {
        hostHelper: () =>
          connected
            ? {
                info: { id: "node-linux", kind: "host-helper", status: "online", capabilities: [] },
                client: fake,
              }
            : undefined,
      },
      agent: { cancel: async () => undefined },
      runTrace: { addFrame: () => undefined },
    },
  };
  part.start?.(gw as never);
  parts.push(part);
  return part;
}

async function call(tool: string, params: unknown, ctx: Partial<CallContext> = {}) {
  const callId = `pc_${++n}`;
  contexts.set(callId, {
    toolCallId: callId,
    threadId: "th",
    runId: "r",
    permissionMode: "balanced",
    taint: false,
    ...ctx,
  });
  const reg = tools.get(tool);
  if (reg === undefined) throw new Error(`no tool ${tool}`);
  return reg.execute(callId, params, new AbortController().signal, () => undefined);
}

const emit = (event: string, payload: unknown) => handler(JSON.stringify({ event, payload }));
/** Every `systemctl --user start <unit>` spawned, by unit. */
const starts = () => exec.log.filter((l) => l[1] === "--user" && l[2] === "start").map((l) => l[3]);
const lookups = () => exec.log.filter((l) => l[1] === "list-sessions").length;
const settle = () => new Promise((r) => setTimeout(r, 60));
const helperOnline = () =>
  emit("node.updated", { node: { id: "node-linux", kind: "host-helper", status: "online" } });

const WAYLAND = {
  sessions: "c1 501 devmello seat0 tty2 active no -\n",
  show: { c1: "User=501\nType=wayland\nState=active\nRemote=no\nSeat=seat0\n" },
};

function session(kind: "none" | "graphical"): void {
  if (kind === "none") {
    exec.sessions = "";
    exec.show = {};
  } else {
    exec.sessions = WAYLAND.sessions.replaceAll("501", String(process.getuid?.() ?? 501));
    exec.show = {
      c1: WAYLAND.show.c1.replace("User=501", `User=${process.getuid?.() ?? 501}`),
    };
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "psyche-cu-compose-"));
  db = openDb(join(home, "psyche.db"));
  Object.defineProperty(process, "platform", { value: "linux" });
  fake = new Fake();
  connected = false;
  exec.log.length = 0;
  session("none");
  exec.env = "PATH=/usr/bin\n";
  exec.onStart = () => {
    connected = true;
  };
  tools.clear();
});
afterEach(async () => {
  for (const p of parts.splice(0)) await p.stop?.();
  Object.defineProperty(process, "platform", { value: realPlatform });
  db.close();
  rmSync(home, { recursive: true, force: true });
});

// PR #1498 r2, finding 1 (probes P1, P2). Owner rule: turning computer use off, and Revoke,
// never start anything, on the headless path or the graphical L5 one.
describe("off and Revoke start nothing", () => {
  it.each(["none", "graphical"] as const)(
    "turning computer use off with no helper running (%s session)",
    async (kind) => {
      session(kind);
      setSetting(db, COMPUTER_USE_ENABLED, true);
      compose();
      emit("settings.changed", { entries: [{ key: COMPUTER_USE_ENABLED, value: false }] });
      await settle();
      expect(starts()).toEqual([]);
      expect(fake.calls).toEqual([]);
      // The helper that connects later is told to put app structure back.
      connected = true;
      helperOnline();
      await settle();
      expect(fake.calls[0]).toEqual({ capability: "a11y.enable", params: { enabled: false } });
      expect(starts()).toEqual([]);
    },
  );

  it.each(["none", "graphical"] as const)(
    "Revoke with no helper running (%s session)",
    async (kind) => {
      session(kind);
      setSetting(db, COMPUTER_USE_ENABLED, false);
      compose();
      emit("settings.changed", {
        entries: [{ key: COMPUTER_USE_LINUX_REVOKE, value: "2026-11-20T00:00:00Z" }],
      });
      await settle();
      expect(starts()).toEqual([]);
      expect(fake.calls).toEqual([]);
      // The helper that connects later gets the pending revoke.
      connected = true;
      helperOnline();
      await settle();
      expect(fake.calls.map((c) => c.capability)).toContain("portal.revoke");
      expect(starts()).toEqual([]);
    },
  );

  it("with a helper already connected, off and Revoke go to it and start nothing", async () => {
    session("graphical");
    setSetting(db, COMPUTER_USE_ENABLED, true);
    connected = true;
    compose();
    await settle();
    fake.calls.length = 0;
    emit("settings.changed", { entries: [{ key: COMPUTER_USE_ENABLED, value: false }] });
    emit("settings.changed", {
      entries: [{ key: COMPUTER_USE_LINUX_REVOKE, value: "2026-11-20T01:00:00Z" }],
    });
    await settle();
    expect(starts()).toEqual([]);
    const sent = fake.calls.map((c) => c.capability);
    expect(fake.calls[0]).toEqual({ capability: "a11y.enable", params: { enabled: false } });
    expect(sent).toContain("portal.revoke");
  });

  it("a computer-use call still starts the helper on demand (the one path that may)", async () => {
    session("none");
    setSetting(db, COMPUTER_USE_ENABLED, true);
    compose();
    const r = await call("computer.snapshot", {
      app: "org.gnome.TextEditor",
      surface: "virtual_screen",
    });
    expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
    expect(starts()).toEqual(["psyche-helper-headless.service"]);
  });
});

// PR #1498 r1 finding 5, re-checked in r2 (probe P3).
it("a Host helper going offline releases the virtual_screen lock", async () => {
  setSetting(db, COMPUTER_USE_ENABLED, true);
  connected = true;
  compose();
  const app = { app: "org.gnome.TextEditor", surface: "virtual_screen" };
  const a = await call("computer.snapshot", app, { threadId: "t1", runId: "r1", taskId: "k1" });
  expect(a.isError, JSON.stringify(a.output)).toBeUndefined();
  const b = await call("computer.snapshot", app, { threadId: "t2", runId: "r2", taskId: "k2" });
  expect(JSON.stringify(b.output)).toContain("conflict");
  emit("node.updated", { node: { id: "node-linux", kind: "host-helper", status: "offline" } });
  await settle();
  const c = await call("computer.snapshot", app, { threadId: "t2", runId: "r2", taskId: "k2" });
  expect(c.isError, JSON.stringify(c.output)).toBeUndefined();
});

// PR #1498 r2, finding 5 (probe P4): one logind lookup for a burst, shared by every call site.
it("three direct calls in a burst make one logind lookup", async () => {
  setSetting(db, COMPUTER_USE_ENABLED, true);
  connected = true;
  session("graphical");
  compose();
  exec.log.length = 0;
  const results = await Promise.all(
    [1, 2, 3].map(() => call("computer.snapshot", { app: "org.gnome.TextEditor" })),
  );
  for (const r of results) expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
  for (let i = 0; i < 2; i++) {
    await call("computer.snapshot", { app: "org.gnome.TextEditor" });
  }
  expect(lookups()).toBe(1);
  expect(exec.log.filter((l) => l[1] === "show-session")).toHaveLength(1);
});

it("a virtual_screen call that starts the headless helper asks logind once", async () => {
  setSetting(db, COMPUTER_USE_ENABLED, true);
  session("none");
  compose();
  const r = await call("computer.snapshot", {
    app: "org.gnome.TextEditor",
    surface: "virtual_screen",
  });
  expect(r.isError, JSON.stringify(r.output)).toBeUndefined();
  // resolveTarget asked; the router and the unit choice reused that answer.
  expect(lookups()).toBe(1);
  expect(starts()).toEqual(["psyche-helper-headless.service"]);
});

// PR #1498 r2, findings 3 and 4 (probes P5, P6), on the real execFile path.
it("a vanished session does not hide a live wayland session (P5)", async () => {
  exec.sessions = "c9 1000 x - pts/3 closing no -\nc1 1000 x seat0 tty2 active no -\n";
  exec.show = { c1: "User=1000\nType=wayland\nState=active\nRemote=no\nSeat=seat0\n" };
  expect(await hasGraphicalSession(undefined, 1000)).toBe(true);
});

it("an SSH session with a stale DISPLAY in the user manager is not graphical (P6)", async () => {
  exec.sessions = "c18 1000 devmello - pts/1 active no -\n";
  exec.show = { c18: "User=1000\nType=tty\nState=active\nRemote=yes\nSeat=\n" };
  exec.env = "PATH=/usr/bin\nDISPLAY=:0\n";
  expect(await hasGraphicalSession(undefined, 1000, undefined, () => true)).toBe(false);
  // A pty session (script + su -l) is local but has no seat: not graphical either.
  exec.show = { c18: "User=1000\nType=tty\nState=active\nRemote=no\nSeat=\n" };
  expect(await hasGraphicalSession(undefined, 1000, undefined, () => true)).toBe(false);
});
