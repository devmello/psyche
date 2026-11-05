import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRunContext } from "@psyche/agent-core";
import type { PermissionBroker, PsycheError } from "@psyche/protocol";
import type { DesktopContainers, DesktopShare } from "@psyche/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asksInSeparateDesktop,
  assertSeparateDesktopClipboard,
  type CredentialCard,
  grantsKey,
  originAllowed,
  type RiskContext,
  SEPARATE_DESKTOP_ID,
  SeparateDesktop,
  type SeparateDesktopState,
  separateDesktopFolderEnv,
} from "../src/compose/separate-desktop.ts";
import { GuestSockets } from "../src/nodes/guest-sockets.ts";
import { FakeNode, type FakeNodeHandler } from "./fake-node.ts";
import { newDeviceKey, startTestGateway, type TestGateway } from "./helpers.ts";

let t: TestGateway | null = null;
const nodes: FakeNode[] = [];
let guests: GuestSockets | null = null;
const dirs: string[] = [];

afterEach(async () => {
  for (const n of nodes.splice(0)) await n.close().catch(() => undefined);
  guests?.closeAll();
  guests = null;
  await t?.cleanup();
  t = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CAPS: FakeNodeHandler[] = [
  {
    capability: { name: "computer.ax_tree", sideEffect: "read", streaming: false },
    run: () => ({ ok: 1 }),
  },
];

/** A container engine that "starts" by having the helper inside connect with the token. */
function fakeEngine(opts: { pairs?: boolean; limits?: { memory: boolean; pids: boolean } } = {}) {
  const log: string[] = [];
  const started: { shares: readonly DesktopShare[]; memory?: string; token: string }[] = [];
  const egress: { scope: unknown; closed: boolean }[] = [];
  const engine = {
    log,
    started,
    egress,
    requireBackend: async () => ({
      kind: "podman",
      cli: "/usr/bin/podman",
      version: "4.9.3",
      rootless: true,
    }),
    reconcile: async () => [],
    async start(req: {
      socketPath: string;
      token: string;
      shares?: readonly DesktopShare[];
      memory?: string;
    }) {
      log.push("start");
      started.push({
        shares: req.shares ?? [],
        ...(req.memory === undefined ? {} : { memory: req.memory }),
        token: req.token,
      });
      if (opts.pairs !== false) {
        const n = await FakeNode.connect(req.socketPath, {
          origin: t?.gateway.origin ?? "",
          handlers: CAPS,
          key: newDeviceKey(),
          deviceId: `guest-${Math.random().toString(36).slice(2)}`,
          deviceFamily: "linux-helper",
          secret: req.token,
        });
        nodes.push(n);
      }
      return {
        container: "psyche-desktop-main",
        startMs: 1,
        backend: await engine.requireBackend(),
        limits: opts.limits ?? { memory: true, pids: true },
      };
    },
    async stop() {
      log.push("stop");
    },
    async reset() {
      log.push("reset");
    },
    async openEgress(_id: string, scope: unknown) {
      const e = { scope, closed: false };
      egress.push(e);
      log.push("egress");
      return {
        close: () => {
          e.closed = true;
        },
      };
    },
  };
  return engine;
}

async function setup(
  opts: {
    pairs?: boolean;
    unsaved?: string[];
    memory?: string;
    limits?: { memory: boolean; pids: boolean };
    lastGrants?: string;
  } = {},
) {
  t = await startTestGateway();
  guests = new GuestSockets({ ctx: t.gateway.context, home: t.home });
  const engine = fakeEngine({
    ...(opts.pairs === undefined ? {} : { pairs: opts.pairs }),
    ...(opts.limits === undefined ? {} : { limits: opts.limits }),
  });
  const states: SeparateDesktopState[] = [];
  const logs: string[] = [];
  const allow: { scope: unknown; domains: readonly string[] }[] = [];
  const grants = { last: opts.lastGrants };
  const sd = new SeparateDesktop({
    desktop: engine as unknown as DesktopContainers,
    guests,
    home: t.home,
    ...(opts.memory === undefined ? {} : { memory: () => opts.memory }),
    report: (s) => states.push(s),
    grants: {
      read: () => grants.last,
      write: (k) => {
        grants.last = k;
      },
    },
    logger: { log: (level, msg) => void logs.push(`${level}: ${msg}`) },
    egress: {
      tunnel: { handle: () => undefined },
      allowlist: (scope, domains) => void allow.push({ scope, domains }),
    },
    ...(opts.unsaved === undefined ? {} : { unsaved: async () => opts.unsaved ?? [] }),
    pairTimeoutMs: 600,
  });
  return { sd, engine, states, allow, grants, logs, g: t.gateway };
}

const share = (name: string, readOnly = true): DesktopShare => ({
  source: `/data/${name}`,
  name,
  readOnly,
});

/** The grants of the first task, already served: later tasks compare against these. */
const KEY_NONE = grantsKey([], undefined);

describe("routing to the separate desktop", () => {
  it("only the separate_desktop surface, only the guest of this container", async () => {
    const { sd, g } = await setup();
    expect(() => sd.clientFor("direct")).toThrow(/not a separate desktop call/);
    expect(() => sd.clientFor("virtual_screen")).toThrow(/not a separate desktop call/);
    expect(() => sd.clientFor(undefined)).toThrow(/not a separate desktop call/);
    // Not running: unavailable, and never the Host's helper or any other node.
    await FakeNode.connectRemote(g, { handlers: CAPS, deviceFamily: "vm-guest" }).then((n) =>
      nodes.push(n),
    );
    try {
      sd.clientFor("separate_desktop");
      throw new Error("should refuse");
    } catch (e) {
      expect((e as PsycheError).code).toBe("unavailable");
      expect((e as PsycheError).details).toMatchObject({ reason: "separate_desktop_not_running" });
    }
    await sd.use("t1");
    const client = sd.clientFor("separate_desktop");
    expect(await client.invoke("computer.ax_tree", {})).toMatchObject({ ok: true });
  });
});

describe("the desktop's lifecycle", () => {
  it("starts on first use with the default memory, no shares and no internet", async () => {
    const { sd, engine, states } = await setup({ lastGrants: KEY_NONE });
    await sd.use("t1");
    expect(engine.log).toEqual(["start"]);
    expect(engine.started[0]).toMatchObject({ shares: [], memory: "2g" });
    expect(engine.egress).toEqual([]);
    expect(states.map((s) => s.phase)).toEqual(["starting", "running"]);
    expect(states.at(-1)).toMatchObject({
      engine: "podman",
      rootless: true,
      shares: [],
      internet: false,
    });
  });

  it("uses the memory setting", async () => {
    const ok = await setup({ memory: "3g" });
    await ok.sd.use("t1");
    expect(ok.engine.started[0]?.memory).toBe("3g");
  });

  it("a bad memory value fails the start and leaves nothing running", async () => {
    const { sd, engine, states } = await setup({ memory: "64g" });
    await expect(sd.use("t1")).rejects.toThrow(/memory/);
    expect(engine.log).toContain("stop");
    expect(guests?.isOpen(SEPARATE_DESKTOP_ID)).toBe(false);
    expect(states.at(-1)?.phase).toBe("failed");
  });

  it("stops when the task ends and nothing is watching: container gone, socket closed", async () => {
    const { sd, engine, states } = await setup({ lastGrants: KEY_NONE });
    await sd.use("t1");
    await sd.release("t1");
    expect(engine.log).toEqual(["start", "stop"]);
    expect(guests?.isOpen(SEPARATE_DESKTOP_ID)).toBe(false);
    expect(() => sd.clientFor("separate_desktop")).toThrow();
    expect(states.at(-1)?.phase).toBe("off");
  });

  it("stays up while a watch view holds it", async () => {
    const { sd, engine } = await setup({ lastGrants: KEY_NONE });
    await sd.use("t1");
    await sd.watching(true);
    await sd.release("t1");
    expect(engine.log).toEqual(["start"]);
    await sd.watching(false);
    expect(engine.log).toEqual(["start", "stop"]);
  });

  it("does not stop on unsaved changes, and says which apps; force stops anyway", async () => {
    const { sd, engine } = await setup({ unsaved: ["libreoffice-writer"], lastGrants: KEY_NONE });
    await sd.use("t1");
    await expect(sd.release("t1")).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "unsaved_changes", apps: ["libreoffice-writer"] },
    });
    expect(engine.log).toEqual(["start"]);
    // The task is over: a third party can't use its session, and a new task starts clean.
    await sd.use("t1");
    await sd.release("t1", { force: true });
    expect(engine.log).toEqual(["start", "stop"]);
  });

  it("fails closed when the helper never pairs: the container is removed and the socket closed", async () => {
    const { sd, engine, states } = await setup({ pairs: false, lastGrants: KEY_NONE });
    await expect(sd.use("t1")).rejects.toMatchObject({ details: { reason: "guest_not_paired" } });
    expect(engine.log).toEqual(["start", "stop"]);
    expect(guests?.isOpen(SEPARATE_DESKTOP_ID)).toBe(false);
    expect(states.at(-1)?.phase).toBe("failed");
  });

  it("reset removes the container and its workspace", async () => {
    const { sd, engine } = await setup({ lastGrants: KEY_NONE });
    await sd.use("t1");
    await sd.reset();
    expect(engine.log).toEqual(["start", "stop", "reset"]);
    expect(guests?.isOpen(SEPARATE_DESKTOP_ID)).toBe(false);
  });

  it("each start gets a new token", async () => {
    const { sd, engine } = await setup({ lastGrants: KEY_NONE });
    await sd.use("t1");
    await sd.release("t1");
    await sd.use("t2");
    expect(engine.started).toHaveLength(2);
    expect(engine.started[0]?.token).not.toBe(engine.started[1]?.token);
  });

  it("warns, and still runs, when the system does not enforce the memory or process limit", async () => {
    const { sd, states, logs } = await setup({
      limits: { memory: false, pids: false },
      lastGrants: KEY_NONE,
    });
    await sd.use("t1");
    expect(sd.ready).toBe(true);
    expect(states.at(-1)).toMatchObject({ memoryEnforced: false, pidsEnforced: false });
    expect(logs).toContain("warn: separate desktop: memory limit not enforced on this system");
    expect(logs).toContain("warn: separate desktop: process limit not enforced on this system");
  });

  it("says nothing when the limits are enforced", async () => {
    const { sd, states, logs } = await setup({ lastGrants: KEY_NONE });
    await sd.use("t1");
    expect(states.at(-1)?.memoryEnforced).toBeUndefined();
    expect(logs.filter((l) => l.startsWith("warn"))).toEqual([]);
  });
});

describe("one task at a time", () => {
  it("a second task gets conflict and nothing is disturbed; it can start once the first is done", async () => {
    const { sd, engine } = await setup({ lastGrants: KEY_NONE });
    await sd.use("t1");
    await expect(sd.use("t2")).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "separate_desktop_busy" },
    });
    await expect(sd.use("t2", { shares: [share("c")] })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(engine.log).toEqual(["start"]);
    expect(sd.ready).toBe(true);
    await sd.release("t1");
    await sd.use("t2");
    expect(engine.log).toEqual(["start", "stop", "start"]);
  });

  it("releasing a task that is not the current one changes nothing", async () => {
    const { sd, engine } = await setup({ lastGrants: KEY_NONE });
    await sd.use("t1");
    await sd.release("t2");
    expect(engine.log).toEqual(["start"]);
    expect(sd.ready).toBe(true);
  });

  it("the same task calling again replaces its own tunnel: the old one is closed first", async () => {
    const { sd, engine } = await setup();
    await sd.use("t1", { internet: { allow: ["example.com"] } });
    await sd.use("t1", { internet: { allow: ["example.com"] } });
    expect(engine.egress).toHaveLength(2);
    expect(engine.egress[0]?.closed).toBe(true);
    expect(engine.egress[1]?.closed).toBe(false);
    await sd.release("t1");
    expect(engine.egress[1]?.closed).toBe(true);
  });

  it("a task that calls again without internet closes the tunnel it had", async () => {
    const { sd, engine } = await setup();
    await sd.use("t1", { internet: { allow: ["example.com"] } });
    await sd.use("t1");
    expect(engine.egress[0]?.closed).toBe(true);
    expect(engine.egress).toHaveLength(1);
  });
});

describe("a workspace never crosses grants", () => {
  it("resets /workspace when the shares or the internet differ from the last task's", async () => {
    const { sd, engine } = await setup({ lastGrants: KEY_NONE });
    await sd.use("t1");
    expect(engine.log).toEqual(["start"]);
    await sd.release("t1");
    // Same grants: the workspace is reused.
    await sd.use("t2");
    expect(engine.log).toEqual(["start", "stop", "start"]);
    await sd.release("t2");
    // A share: reset first.
    await sd.use("t3", { shares: [share("a")] });
    expect(engine.log.slice(-3)).toEqual(["stop", "reset", "start"]);
    await sd.release("t3");
    // The same share again: reused. Read-write instead of read-only: reset.
    await sd.use("t4", { shares: [share("a")] });
    expect(engine.log.slice(-2)).toEqual(["stop", "start"]);
    await sd.release("t4");
    await sd.use("t5", { shares: [share("a", false)] });
    expect(engine.log.slice(-3)).toEqual(["stop", "reset", "start"]);
    await sd.release("t5");
    // Internet, then none, then other origins: each change resets.
    await sd.use("t6", { shares: [share("a", false)], internet: { allow: ["a.example"] } });
    expect(engine.log).toContain("egress");
    expect(engine.log.indexOf("reset", engine.log.length - 6)).toBeGreaterThan(-1);
    await sd.release("t6");
    const before = engine.log.filter((l) => l === "reset").length;
    await sd.use("t7", { shares: [share("a", false)], internet: { allow: ["b.example"] } });
    expect(engine.log.filter((l) => l === "reset").length).toBe(before + 1);
    await sd.release("t7");
    await sd.use("t8");
    expect(engine.log.filter((l) => l === "reset").length).toBe(before + 2);
  });

  it("an unknown last grant counts as different", async () => {
    const { sd, engine } = await setup();
    await sd.use("t1");
    expect(engine.log).toEqual(["reset", "start"]);
  });

  it("the grants of a task are remembered only once it started", async () => {
    const { sd, grants } = await setup({ pairs: false });
    await expect(sd.use("t1", { shares: [share("a")] })).rejects.toBeDefined();
    expect(grants.last).toBeUndefined();
  });

  it("does not run a task with less than it asked for: no egress proxy means no start", async () => {
    t = await startTestGateway();
    guests = new GuestSockets({ ctx: t.gateway.context, home: t.home });
    const engine = fakeEngine();
    const sd = new SeparateDesktop({
      desktop: engine as unknown as DesktopContainers,
      guests,
      home: t.home,
      pairTimeoutMs: 600,
    });
    await expect(sd.use("t1", { internet: { allow: ["a.example"] } })).rejects.toMatchObject({
      details: { reason: "no_egress_proxy" },
    });
    expect(guests.isOpen(SEPARATE_DESKTOP_ID)).toBe(false);
    expect(sd.ready).toBe(false);
    // The task slot is free again.
    await expect(sd.use("t2")).resolves.toBeUndefined();
  });

  it("the grants key tells apart shares, access and origins, and ignores order", () => {
    const a = share("a");
    const b = share("b", false);
    expect(grantsKey([a, b], ["x.example", "y.example"])).toBe(
      grantsKey([b, a], ["y.example", "x.example"]),
    );
    expect(grantsKey([a], undefined)).not.toBe(grantsKey([a], []));
    expect(grantsKey([a], undefined)).not.toBe(grantsKey([{ ...a, readOnly: false }], undefined));
    expect(grantsKey([a], ["x.example"])).not.toBe(grantsKey([a], ["y.example"]));
  });
});

describe("internet", () => {
  it("is the task's tunnel with the task's allowlist, and ends with the task", async () => {
    const { sd, engine, allow, states } = await setup();
    await sd.use("t1", { internet: { allow: ["example.com"] } });
    expect(allow).toEqual([{ scope: { kind: "task", id: "t1" }, domains: ["example.com"] }]);
    expect(engine.egress).toHaveLength(1);
    expect(states.at(-1)?.internet).toBe(true);
    await sd.release("t1");
    expect(engine.egress[0]?.closed).toBe(true);
  });

  it("a task that did not ask for internet gets none", async () => {
    const { sd, engine, allow } = await setup({ lastGrants: KEY_NONE });
    await sd.use("t1");
    expect(engine.egress).toEqual([]);
    expect(allow).toEqual([]);
  });

  it("the tunnel is closed even when the container is stopped over unsaved work", async () => {
    const { sd, engine } = await setup({ unsaved: ["gedit"] });
    await sd.use("t1", { internet: { allow: ["example.com"] } });
    await expect(sd.release("t1")).rejects.toMatchObject({ code: "conflict" });
    expect(engine.egress[0]?.closed).toBe(true);
  });
});

describe("what the card for a shared folder says and does", () => {
  function broker() {
    const calls: { requested: unknown[]; decided: string[] } = { requested: [], decided: [] };
    let answer: { status: string; details: Record<string, unknown> } = {
      status: "approved",
      details: { granted: { path: "/data/docs", mode: "ro" } },
    };
    const b = {
      requestApproval: async (input: unknown) => {
        calls.requested.push(input);
        return { approval: { id: "apr_1" } };
      },
      awaitDecision: async (id: string) => {
        calls.decided.push(id);
        return answer;
      },
    } as unknown as PermissionBroker;
    return {
      b,
      calls,
      set: (a: typeof answer) => {
        answer = a;
      },
    };
  }
  const toolCtx = (mode = "attended"): ToolRunContext =>
    ({
      threadId: "thr_1",
      runId: "run_1",
      callId: "call_1",
      taskId: "task_1",
      taint: false,
      mode,
      signal: new AbortController().signal,
    }) as unknown as ToolRunContext;

  async function dir() {
    const d = mkdtempSync(join(tmpdir(), "psyche-sd-"));
    dirs.push(d);
    mkdirSync(join(d, "docs"));
    return join(d, "docs");
  }

  it("is its own approval kind that names the separate desktop and offers this task only", async () => {
    const { sd } = await setup();
    const { b, calls } = broker();
    const docs = await dir();
    const out = await sd.requestShare({ broker: b, surfaces: ["desktop"] }, toolCtx(), {
      path: docs,
      reason: "to read the notes",
      access: "read",
    });
    const req = calls.requested[0] as Record<string, unknown>;
    expect(req.kind).toBe("separate_desktop_share");
    expect(req.summary).toBe(`Let the separate desktop read ${docs}`);
    expect(req.scopesOffered).toEqual(["once"]);
    expect(req.grantKey).toBe("separate_desktop_share|ro");
    expect((req.details as Record<string, unknown>).target).toBe("separate_desktop");
    expect(out).toEqual({
      granted: true,
      share: { source: "/data/docs", name: "docs", readOnly: true },
    });
  });

  it("asks a fresh card every time and says read and change for a read-write request", async () => {
    const { sd } = await setup();
    const { b, calls, set } = broker();
    set({ status: "approved", details: { granted: { path: "/data/docs", mode: "rw" } } });
    const docs = await dir();
    const ask = () =>
      sd.requestShare({ broker: b, surfaces: ["desktop"] }, toolCtx(), {
        path: docs,
        reason: "r",
        access: "read_write",
      });
    const first = await ask();
    await ask();
    expect(calls.requested).toHaveLength(2);
    expect((calls.requested[0] as Record<string, unknown>).summary).toMatch(/read and change/);
    expect(first).toMatchObject({ granted: true, share: { readOnly: false } });
  });

  it("the owner can narrow read-write to read-only; a denial or a queued card shares nothing", async () => {
    const { sd } = await setup();
    const { b, set } = broker();
    const docs = await dir();
    const ask = (mode = "attended") =>
      sd.requestShare({ broker: b, surfaces: ["desktop"] }, toolCtx(mode), {
        path: docs,
        reason: "r",
        access: "read_write",
      });
    set({ status: "approved", details: { granted: { path: "/data/docs", mode: "ro" } } });
    expect(await ask()).toMatchObject({ granted: true, share: { readOnly: true } });
    set({ status: "denied", details: {} });
    expect(await ask()).toEqual({ granted: false, status: "denied" });
    expect(await ask("unattended")).toEqual({ granted: false, status: "queued" });
  });

  it("only the owner can share a folder", async () => {
    const { sd } = await setup();
    const { b } = broker();
    const ctx = { ...toolCtx(), requester: { role: "allowed" } } as unknown as ToolRunContext;
    await expect(
      sd.requestShare({ broker: b, surfaces: ["desktop"] }, ctx, {
        path: "/tmp",
        reason: "r",
        access: "read",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("the risky-word rule", () => {
  const base: RiskContext = {
    internetUsed: false,
    credentialFilled: false,
    app: "org.gnome.TextEditor",
    readWriteShareMounted: false,
  };

  it("file-local words skip the card only when every condition holds", () => {
    for (const w of [
      "Delete",
      "Move to Trash",
      "Remove file",
      "Empty trash",
      "Clear history",
      "Erase",
      "Discard changes",
    ]) {
      expect(asksInSeparateDesktop(w, base), w).toBe(false);
    }
  });

  it("words that reach the outside world ask even then", () => {
    for (const w of [
      "Send",
      "Submit order",
      "Purchase",
      "Buy now",
      "Pay",
      "Transfer funds",
      "Delete and send",
      "Unsubscribe",
      "Sign out",
    ]) {
      expect(asksInSeparateDesktop(w, base), w).toBe(true);
    }
  });

  it("with no context nothing is relaxed", () => {
    expect(asksInSeparateDesktop("Delete")).toBe(true);
    expect(asksInSeparateDesktop(undefined)).toBe(false);
  });

  it("an open or earlier egress tunnel turns the relaxation off", () => {
    expect(asksInSeparateDesktop("Delete", { ...base, internetUsed: true })).toBe(true);
  });

  it("a login typed in during the task turns it off", () => {
    expect(asksInSeparateDesktop("Delete", { ...base, credentialFilled: true })).toBe(true);
  });

  it("a browser, or an app that is not known, turns it off", () => {
    for (const app of [
      "firefox",
      "org.mozilla.firefox",
      "firefox-esr",
      "chromium",
      "google-chrome",
      "brave-browser",
      "vivaldi-stable",
      "epiphany",
      "Firefox",
    ]) {
      expect(asksInSeparateDesktop("Delete", { ...base, app }), app).toBe(true);
    }
    expect(asksInSeparateDesktop("Delete", { ...base, app: undefined })).toBe(true);
    expect(asksInSeparateDesktop("Delete", { ...base, app: "" })).toBe(true);
  });

  it("any read-write share mounted turns it off, whatever the file is called or where it is", () => {
    expect(asksInSeparateDesktop("Delete", { ...base, readWriteShareMounted: true })).toBe(true);
    expect(asksInSeparateDesktop("Remove file", { ...base, readWriteShareMounted: true })).toBe(
      true,
    );
    // A read-only share is not a read-write one.
    expect(asksInSeparateDesktop("Delete", { ...base, readWriteShareMounted: false })).toBe(false);
  });

  it("follows the state of the task: web reached, login typed, read-write shares", async () => {
    const { sd } = await setup();
    const app = { app: "org.gnome.TextEditor" };
    await sd.use("t1", { shares: [share("docs")] });
    // A read-only share does not matter; a browser does.
    expect(sd.asks("t1", "Delete", app)).toBe(false);
    expect(sd.asks("t1", "Delete", { app: "firefox" })).toBe(true);
    // Not this task's: asks.
    expect(sd.asks("other", "Delete", app)).toBe(true);
    await sd.release("t1");
    // A read-write share anywhere: asks, even for the container's own files.
    await sd.use("t1b", { shares: [share("rw", false)] });
    expect(sd.asks("t1b", "Delete", app)).toBe(true);
    await sd.release("t1b");
    await sd.use("t2", { internet: { allow: ["example.com"] } });
    expect(sd.asks("t2", "Delete", app)).toBe(true);
    // The tunnel is gone after release, and a new task starts clean.
    await sd.release("t2");
    await sd.use("t3");
    expect(sd.asks("t3", "Delete", app)).toBe(false);
  });

  it("closing the tunnel does not bring the relaxation back during the same task", async () => {
    const { sd, engine } = await setup();
    await sd.use("t1", { internet: { allow: ["example.com"] } });
    await sd.use("t1");
    expect(engine.egress[0]?.closed).toBe(true);
    expect(sd.asks("t1", "Delete", { app: "org.gnome.TextEditor" })).toBe(true);
  });
});

describe("typing a saved login into the desktop", () => {
  function steps(approve: boolean) {
    const cards: CredentialCard[] = [];
    const typed: string[] = [];
    const read = vi.fn(async () => "s3cret");
    return {
      cards,
      typed,
      read,
      request: (origin = "https://bank.example") => ({
        origin,
        item: "Bank",
        approve: async (c: CredentialCard) => {
          cards.push(c);
          return approve;
        },
        read,
        type: async (s: string) => void typed.push(s),
      }),
    };
  }

  it("is refused without internet for the task, and for an origin the task may not reach", async () => {
    const { sd } = await setup();
    const s = steps(true);
    await sd.use("t1");
    await expect(sd.fillCredential("t1", s.request())).rejects.toMatchObject({
      details: { reason: "credential_needs_internet" },
    });
    await sd.release("t1");
    await sd.use("t2", { internet: { allow: ["bank.example"] } });
    await expect(sd.fillCredential("t2", s.request("https://evil.example"))).rejects.toMatchObject({
      details: { reason: "credential_origin_not_allowed" },
    });
    await expect(sd.fillCredential("t2", s.request("not a url"))).rejects.toMatchObject({
      details: { reason: "credential_origin_not_allowed" },
    });
    await expect(sd.fillCredential("t2", s.request("ftp://bank.example"))).rejects.toMatchObject({
      details: { reason: "credential_origin_not_allowed" },
    });
    await expect(sd.fillCredential("other", s.request())).rejects.toMatchObject({
      details: { reason: "credential_needs_internet" },
    });
    expect(s.cards).toEqual([]);
    expect(s.read).not.toHaveBeenCalled();
  });

  it("asks a fresh card every time, names the unverifiable page, reads only after approval", async () => {
    const { sd } = await setup();
    await sd.use("t1", { internet: { allow: ["bank.example"] } });
    const s = steps(true);
    expect(await sd.fillCredential("t1", s.request())).toBe(true);
    expect(await sd.fillCredential("t1", s.request())).toBe(true);
    expect(s.cards).toHaveLength(2);
    expect(s.cards[0]).toMatchObject({
      kind: "credential_fill",
      details: { origin: "https://bank.example", separateDesktop: true },
    });
    expect(s.typed).toEqual(["s3cret", "s3cret"]);
    const no = steps(false);
    expect(await sd.fillCredential("t1", no.request())).toBe(false);
    expect(no.read).not.toHaveBeenCalled();
    expect(no.typed).toEqual([]);
  });

  it("a login typed in turns the relaxed risky-word rule off for the rest of the task", async () => {
    const { sd } = await setup();
    await sd.use("t1", { internet: { allow: ["bank.example"] } });
    const target = { app: "org.gnome.TextEditor" };
    // Internet already turned it off; the flag is checked on its own in the risk context.
    expect(
      asksInSeparateDesktop("Delete", {
        internetUsed: false,
        credentialFilled: true,
        app: target.app,
        readWriteShareMounted: false,
      }),
    ).toBe(true);
    const s = steps(false);
    await sd.fillCredential("t1", s.request());
    expect(sd.asks("t1", "Delete", target)).toBe(true);
  });

  it("origins are judged like the egress proxy judges them", () => {
    expect(originAllowed("https://a.example/path?q=1", ["a.example"])).toBe(true);
    expect(originAllowed("https://sub.a.example", ["*.a.example"])).toBe(true);
    expect(originAllowed("https://a.example", ["*.a.example"])).toBe(false);
    expect(originAllowed("https://a.example:8443", ["a.example"])).toBe(false);
    expect(originAllowed("https://a.example:8443", ["a.example:8443"])).toBe(true);
    expect(originAllowed("http://a.example", ["a.example"])).toBe(true);
    expect(originAllowed("https://a.example.evil", ["a.example"])).toBe(false);
    expect(originAllowed("https://a.example", [])).toBe(false);
  });
});

describe("the cards for a login and for the internet", () => {
  function broker(status = "approved") {
    const requested: Record<string, unknown>[] = [];
    const b = {
      requestApproval: async (input: Record<string, unknown>) => {
        requested.push(input);
        return { approval: { id: "apr_1" } };
      },
      awaitDecision: async () => ({ status, details: {} }),
    } as unknown as PermissionBroker;
    return { b, requested };
  }
  const tctx = (mode = "attended"): ToolRunContext =>
    ({
      threadId: "thr_1",
      runId: "run_1",
      callId: "call_1",
      taskId: "task_1",
      taint: false,
      mode,
      signal: new AbortController().signal,
    }) as unknown as ToolRunContext;

  it("a login card has its own grant key, offers once only, and says the page can't be verified", async () => {
    const { sd } = await setup();
    await sd.use("t1", { internet: { allow: ["bank.example"] } });
    const { b, requested } = broker();
    const approve = (card: CredentialCard) =>
      sd.askCredential({ broker: b, surfaces: ["desktop"] }, tctx(), card);
    let seen: CredentialCard | undefined;
    const ok = await sd.fillCredential("t1", {
      origin: "https://bank.example",
      item: "Bank",
      approve: (c) => {
        seen = c;
        return approve(c);
      },
      read: async () => "x",
      type: async () => undefined,
    });
    expect(ok).toBe(true);
    expect(seen?.grantKey).toBe("credential_fill|separate_desktop|https://bank.example");
    expect(requested[0]).toMatchObject({
      kind: "credential_fill",
      grantKey: "credential_fill|separate_desktop|https://bank.example",
      scopesOffered: ["once"],
      details: { separateDesktop: true, origin: "https://bank.example" },
    });
  });

  it("a denied login card types nothing", async () => {
    const { sd } = await setup();
    await sd.use("t1", { internet: { allow: ["bank.example"] } });
    const { b } = broker("denied");
    const type = vi.fn(async () => undefined);
    const ok = await sd.fillCredential("t1", {
      origin: "https://bank.example",
      item: "Bank",
      approve: (c) => sd.askCredential({ broker: b, surfaces: ["desktop"] }, tctx(), c),
      read: async () => "x",
      type,
    });
    expect(ok).toBe(false);
    expect(type).not.toHaveBeenCalled();
  });

  it("the internet card names a read-write folder and says files can leave through it", async () => {
    const { sd } = await setup();
    const { b, requested } = broker();
    const granted = await sd.requestInternet({ broker: b, surfaces: ["desktop"] }, tctx(), {
      allow: ["example.com"],
      shares: [
        { source: "/data/docs", name: "docs", readOnly: false },
        { source: "/data/ro", name: "ro", readOnly: true },
      ],
      reason: "to look something up",
    });
    expect(granted).toBe(true);
    const req = requested[0] as {
      summary: string;
      details: Record<string, unknown>;
      scopesOffered: string[];
    };
    expect(req.summary).toContain("This task can also change /data/docs, and send files from it.");
    expect(req.summary).not.toContain("/data/ro");
    expect(req.details).toMatchObject({ separateDesktop: true, alsoChanges: ["/data/docs"] });
    expect(req.scopesOffered).toEqual(["once"]);
  });

  it("without a read-write folder the internet card says nothing about files", async () => {
    const { sd } = await setup();
    const { b, requested } = broker();
    await sd.requestInternet({ broker: b, surfaces: ["desktop"] }, tctx(), {
      allow: ["example.com"],
      shares: [{ source: "/data/ro", name: "ro", readOnly: true }],
      reason: "r",
    });
    const req = requested[0] as { summary: string; details: Record<string, unknown> };
    expect(req.summary).not.toMatch(/send files/);
    expect(req.details.alsoChanges).toBeUndefined();
  });

  it("a denied or unattended internet card gives no internet", async () => {
    const { sd } = await setup();
    const denied = broker("denied");
    const ask = (b: PermissionBroker, mode = "attended") =>
      sd.requestInternet({ broker: b, surfaces: ["desktop"] }, tctx(mode), {
        allow: ["example.com"],
        shares: [],
        reason: "r",
      });
    expect(await ask(denied.b)).toBe(false);
    expect(await ask(broker().b, "unattended")).toBe(false);
  });
});

describe("what never reaches the container", () => {
  it("the Linux extras and the shared list are protected roots", () => {
    const env = separateDesktopFolderEnv("/home/o/.psyche");
    for (const p of ["/proc", "/sys", "/etc", "/run", "/var/lib"]) {
      expect(env.protectedRoots).toContain(p);
    }
    expect(env.protectedRoots?.some((p) => p.endsWith("/.ssh"))).toBe(true);
    for (const rel of [".local", ".cargo", "snap", "bin", ".bitcoin"]) {
      expect(
        env.protectedRoots?.some((p) => p.endsWith(`/${rel}`)),
        rel,
      ).toBe(true);
    }
  });

  it("only the owner's paste goes into the desktop; nothing comes out", () => {
    expect(() => assertSeparateDesktopClipboard("paste_into")).not.toThrow();
    expect(() => assertSeparateDesktopClipboard("to_host")).toThrow(/no clipboard/);
    expect(() => assertSeparateDesktopClipboard("from_host")).toThrow(/no clipboard/);
  });
});
