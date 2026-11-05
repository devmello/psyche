import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRunContext } from "@psyche/agent-core";
import type { PermissionBroker, PsycheError } from "@psyche/protocol";
import type { DesktopContainers, DesktopShare } from "@psyche/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asksInSeparateDesktop,
  assertSeparateDesktopClipboard,
  type GrantedShare,
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

/** A container engine that "starts" by having the helper inside connect with the token file's token. */
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
      tokenPath: string;
      shares?: readonly DesktopShare[];
      memory?: string;
    }) {
      log.push("start");
      // What the entrypoint does: read the token from the mounted file, then empty it.
      const token = readFileSync(req.tokenPath, "utf8").trim();
      started.push({
        shares: req.shares ?? [],
        ...(req.memory === undefined ? {} : { memory: req.memory }),
        token,
      });
      if (opts.pairs !== false) {
        const n = await FakeNode.connect(req.socketPath, {
          origin: t?.gateway.origin ?? "",
          handlers: CAPS,
          key: newDeviceKey(),
          deviceId: `guest-${Math.random().toString(36).slice(2)}`,
          deviceFamily: "linux-helper",
          secret: token,
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

interface StoredApproval {
  id: string;
  kind: string;
  status: string;
  bindingHash: string;
  details: Record<string, unknown>;
}

/** The parts of the Permission Broker the separate desktop uses, over an in-memory store. */
function fakeBroker() {
  const approvals = new Map<string, StoredApproval>();
  const requested: Record<string, unknown>[] = [];
  const state = {
    answer: { status: "approved", details: {} as Record<string, unknown> },
    n: 0,
  };
  const broker = {
    requestApproval: async (input: Record<string, unknown>) => {
      const id = `apr_${++state.n}`;
      requested.push(input);
      approvals.set(id, {
        id,
        kind: String(input.kind),
        status: "pending",
        bindingHash: String(input.bindingHash),
        details: { ...(input.details as Record<string, unknown>) },
      });
      return { approval: { id } };
    },
    awaitDecision: async (id: string) => {
      const a = approvals.get(id);
      if (a !== undefined) {
        a.status = state.answer.status;
        a.details = { ...a.details, ...state.answer.details };
      }
      return { ...(a ?? {}), status: state.answer.status, details: state.answer.details };
    },
    get: async (id: string) => approvals.get(id),
  } as unknown as PermissionBroker;
  /** An approved card, as if the owner had said yes. */
  const approve = (input: Partial<StoredApproval> & { id?: string }): string => {
    const id = input.id ?? `apr_${++state.n}`;
    approvals.set(id, {
      id,
      kind: input.kind ?? "separate_desktop_share",
      status: input.status ?? "approved",
      bindingHash: input.bindingHash ?? "x",
      details: input.details ?? {},
    });
    return id;
  };
  return { broker, approvals, requested, state, approve };
}

async function setup(
  opts: {
    pairs?: boolean;
    unsaved?: string[];
    memory?: string;
    limits?: { memory: boolean; pids: boolean };
    lastGrants?: string;
    noBroker?: boolean;
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
  const fb = fakeBroker();
  const sd = new SeparateDesktop({
    ...(opts.noBroker ? {} : { broker: fb.broker }),
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
  /**
   * Starts a task with grants the owner approved: a card per share, and an internet card bound to
   * exactly this set. Plain shares and sites in, approved ones out.
   */
  const use = (
    sdx: SeparateDesktop,
    taskId: string,
    o: { shares?: readonly DesktopShare[]; internet?: { allow: readonly string[] } } = {},
  ) => {
    const shares: GrantedShare[] = (o.shares ?? []).map((s) => ({
      ...s,
      approvalId: fb.approve({
        kind: "separate_desktop_share",
        details: { granted: { path: s.source, mode: s.readOnly ? "ro" : "rw" } },
      }),
    }));
    const internet =
      o.internet === undefined
        ? undefined
        : {
            allow: o.internet.allow,
            approvalId: fb.approve({
              kind: "new_origin",
              bindingHash: grantsKey(shares, o.internet.allow),
              details: { separateDesktop: true },
            }),
          };
    return sdx.use(taskId, { shares, ...(internet === undefined ? {} : { internet }) });
  };
  return { sd, engine, states, allow, grants, logs, g: t.gateway, fb, use };
}

const share = (name: string, readOnly = true): DesktopShare => ({
  source: `/data/${name}`,
  name,
  readOnly,
});

/** The grants of the first task, already served: later tasks compare against these. */
const KEY_NONE = grantsKey([], undefined);

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

describe("routing to the separate desktop", () => {
  it("only the separate_desktop surface, only the guest of this container", async () => {
    const { sd, g, use } = await setup();
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
    await use(sd, "t1");
    const client = sd.clientFor("separate_desktop");
    expect(await client.invoke("computer.ax_tree", {})).toMatchObject({ ok: true });
  });
});

describe("the desktop's lifecycle", () => {
  it("starts on first use with the default memory, no shares and no internet", async () => {
    const { sd, engine, states, use } = await setup({ lastGrants: KEY_NONE });
    await use(sd, "t1");
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
    await ok.use(ok.sd, "t1");
    expect(ok.engine.started[0]?.memory).toBe("3g");
  });

  it("a bad memory value fails the start and leaves nothing running", async () => {
    const { sd, engine, states, use } = await setup({ memory: "64g" });
    await expect(use(sd, "t1")).rejects.toThrow(/memory/);
    expect(engine.log).toContain("stop");
    expect(guests?.isOpen(SEPARATE_DESKTOP_ID)).toBe(false);
    expect(states.at(-1)?.phase).toBe("failed");
  });

  it("stops when the task ends and nothing is watching: container gone, socket closed", async () => {
    const { sd, engine, states, use } = await setup({ lastGrants: KEY_NONE });
    await use(sd, "t1");
    await sd.release("t1");
    expect(engine.log).toEqual(["start", "stop"]);
    expect(guests?.isOpen(SEPARATE_DESKTOP_ID)).toBe(false);
    expect(() => sd.clientFor("separate_desktop")).toThrow();
    expect(states.at(-1)?.phase).toBe("off");
  });

  it("stays up while a watch view holds it", async () => {
    const { sd, engine, use } = await setup({ lastGrants: KEY_NONE });
    await use(sd, "t1");
    await sd.watching(true);
    await sd.release("t1");
    expect(engine.log).toEqual(["start"]);
    await sd.watching(false);
    expect(engine.log).toEqual(["start", "stop"]);
  });

  it("does not stop on unsaved changes, and says which apps; force stops anyway", async () => {
    const { sd, engine, use } = await setup({
      unsaved: ["libreoffice-writer"],
      lastGrants: KEY_NONE,
    });
    await use(sd, "t1");
    await expect(sd.release("t1")).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "unsaved_changes", apps: ["libreoffice-writer"] },
    });
    expect(engine.log).toEqual(["start"]);
    await use(sd, "t1");
    await sd.release("t1", { force: true });
    expect(engine.log).toEqual(["start", "stop"]);
  });

  it("fails closed when the helper never pairs: the container is removed and the socket closed", async () => {
    const { sd, engine, states, use } = await setup({ pairs: false, lastGrants: KEY_NONE });
    await expect(use(sd, "t1")).rejects.toMatchObject({ details: { reason: "guest_not_paired" } });
    expect(engine.log).toEqual(["start", "stop"]);
    expect(guests?.isOpen(SEPARATE_DESKTOP_ID)).toBe(false);
    expect(states.at(-1)?.phase).toBe("failed");
  });

  it("reset removes the container and its workspace", async () => {
    const { sd, engine, use } = await setup({ lastGrants: KEY_NONE });
    await use(sd, "t1");
    await sd.reset();
    expect(engine.log).toEqual(["start", "stop", "reset"]);
    expect(guests?.isOpen(SEPARATE_DESKTOP_ID)).toBe(false);
  });

  it("each start gets a new token", async () => {
    const { sd, engine, use } = await setup({ lastGrants: KEY_NONE });
    await use(sd, "t1");
    await sd.release("t1");
    await use(sd, "t2");
    expect(engine.started).toHaveLength(2);
    expect(engine.started[0]?.token).not.toBe(engine.started[1]?.token);
  });

  it("warns, and still runs, when the system does not enforce the memory or process limit", async () => {
    const { sd, states, logs, use } = await setup({
      limits: { memory: false, pids: false },
      lastGrants: KEY_NONE,
    });
    await use(sd, "t1");
    expect(sd.ready).toBe(true);
    expect(states.at(-1)).toMatchObject({ memoryEnforced: false, pidsEnforced: false });
    expect(logs).toContain("warn: separate desktop: memory limit not enforced on this system");
    expect(logs).toContain("warn: separate desktop: process limit not enforced on this system");
  });

  it("says nothing when the limits are enforced", async () => {
    const { sd, states, logs, use } = await setup({ lastGrants: KEY_NONE });
    await use(sd, "t1");
    expect(states.at(-1)?.memoryEnforced).toBeUndefined();
    expect(logs.filter((l) => l.startsWith("warn"))).toEqual([]);
  });
});

describe("one task at a time", () => {
  it("a second task gets conflict and nothing is disturbed; it can start once the first is done", async () => {
    const { sd, engine, use } = await setup({ lastGrants: KEY_NONE });
    await use(sd, "t1");
    await expect(use(sd, "t2")).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "separate_desktop_busy" },
    });
    await expect(use(sd, "t2", { shares: [share("c")] })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(engine.log).toEqual(["start"]);
    expect(sd.ready).toBe(true);
    await sd.release("t1");
    await use(sd, "t2");
    expect(engine.log).toEqual(["start", "stop", "start"]);
  });

  it("releasing a task that is not the current one changes nothing", async () => {
    const { sd, engine, use } = await setup({ lastGrants: KEY_NONE });
    await use(sd, "t1");
    await sd.release("t2");
    expect(engine.log).toEqual(["start"]);
    expect(sd.ready).toBe(true);
  });

  it("the same task calling again replaces its own tunnel: the old one is closed first", async () => {
    const { sd, engine, use } = await setup();
    await use(sd, "t1", { internet: { allow: ["example.com"] } });
    await use(sd, "t1", { internet: { allow: ["example.com"] } });
    expect(engine.egress).toHaveLength(2);
    expect(engine.egress[0]?.closed).toBe(true);
    expect(engine.egress[1]?.closed).toBe(false);
    await sd.release("t1");
    expect(engine.egress[1]?.closed).toBe(true);
  });

  it("a task that calls again without internet closes the tunnel it had", async () => {
    const { sd, engine, use } = await setup();
    await use(sd, "t1", { internet: { allow: ["example.com"] } });
    await use(sd, "t1");
    expect(engine.egress[0]?.closed).toBe(true);
    expect(engine.egress).toHaveLength(1);
  });
});

describe("a workspace never crosses grants", () => {
  it("resets /workspace when the shares or the internet differ from the last task's", async () => {
    const { sd, engine, use } = await setup({ lastGrants: KEY_NONE });
    await use(sd, "t1");
    expect(engine.log).toEqual(["start"]);
    await sd.release("t1");
    // Same grants: the workspace is reused.
    await use(sd, "t2");
    expect(engine.log).toEqual(["start", "stop", "start"]);
    await sd.release("t2");
    // A share: reset first.
    await use(sd, "t3", { shares: [share("a")] });
    expect(engine.log.slice(-3)).toEqual(["stop", "reset", "start"]);
    await sd.release("t3");
    // The same share again: reused. Read-write instead of read-only: reset.
    await use(sd, "t4", { shares: [share("a")] });
    expect(engine.log.slice(-2)).toEqual(["stop", "start"]);
    await sd.release("t4");
    await use(sd, "t5", { shares: [share("a", false)] });
    expect(engine.log.slice(-3)).toEqual(["stop", "reset", "start"]);
    await sd.release("t5");
    // Internet, then none, then other origins: each change resets.
    await use(sd, "t6", { shares: [share("a", false)], internet: { allow: ["a.example"] } });
    expect(engine.log).toContain("egress");
    expect(engine.log.indexOf("reset", engine.log.length - 6)).toBeGreaterThan(-1);
    await sd.release("t6");
    const before = engine.log.filter((l) => l === "reset").length;
    await use(sd, "t7", { shares: [share("a", false)], internet: { allow: ["b.example"] } });
    expect(engine.log.filter((l) => l === "reset").length).toBe(before + 1);
    await sd.release("t7");
    await use(sd, "t8");
    expect(engine.log.filter((l) => l === "reset").length).toBe(before + 2);
  });

  it("an unknown last grant counts as different", async () => {
    const { sd, engine, use } = await setup();
    await use(sd, "t1");
    expect(engine.log).toEqual(["reset", "start"]);
  });

  it("the grants of a task are remembered only once it started", async () => {
    const { sd, grants, use } = await setup({ pairs: false });
    await expect(use(sd, "t1", { shares: [share("a")] })).rejects.toBeDefined();
    expect(grants.last).toBeUndefined();
  });

  it("does not run a task with less than it asked for: no egress proxy means no start", async () => {
    t = await startTestGateway();
    guests = new GuestSockets({ ctx: t.gateway.context, home: t.home });
    const engine = fakeEngine();
    const fb = fakeBroker();
    const sd = new SeparateDesktop({
      broker: fb.broker,
      desktop: engine as unknown as DesktopContainers,
      guests,
      home: t.home,
      pairTimeoutMs: 600,
    });
    const internet = {
      allow: ["a.example"],
      approvalId: fb.approve({
        kind: "new_origin",
        bindingHash: grantsKey([], ["a.example"]),
        details: { separateDesktop: true },
      }),
    };
    await expect(sd.use("t1", { internet })).rejects.toMatchObject({
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

describe("a task starts with what the owner approved, and nothing else", () => {
  const sh = (name: string, readOnly: boolean, approvalId: string): GrantedShare => ({
    ...share(name, readOnly),
    approvalId,
  });
  const grantedFor = (s: DesktopShare, mode: "ro" | "rw") => ({
    kind: "separate_desktop_share",
    details: { granted: { path: s.source, mode } },
  });

  it("refuses a share with no approval, an unapproved one, one for another folder or another kind", async () => {
    const { sd, fb } = await setup({ lastGrants: KEY_NONE });
    const a = share("a");
    const refused = async (s: GrantedShare) =>
      expect(sd.use("t1", { shares: [s] })).rejects.toMatchObject({
        code: "forbidden",
        details: { reason: "share_not_approved" },
      });
    await refused(sh("a", true, "apr_missing"));
    await refused(sh("a", true, fb.approve({ ...grantedFor(a, "ro"), status: "pending" })));
    await refused(sh("a", true, fb.approve({ ...grantedFor(a, "ro"), status: "denied" })));
    await refused(sh("a", true, fb.approve(grantedFor(share("other"), "ro"))));
    await refused(
      sh("a", true, fb.approve({ kind: "folder_access", details: grantedFor(a, "ro").details })),
    );
    expect(guests?.isOpen(SEPARATE_DESKTOP_ID)).toBe(false);
  });

  it("read-write needs a card the owner allowed read-write on; a read-only card never becomes it", async () => {
    const { sd, fb } = await setup({ lastGrants: KEY_NONE });
    const a = share("a", false);
    await expect(
      sd.use("t1", { shares: [sh("a", false, fb.approve(grantedFor(a, "ro")))] }),
    ).rejects.toMatchObject({ details: { reason: "share_not_approved" } });
    await expect(
      sd.use("t1", { shares: [sh("a", false, fb.approve(grantedFor(a, "rw")))] }),
    ).resolves.toBeUndefined();
  });

  it("the internet card is bound to the whole set: other folders or other sites do not match", async () => {
    const { sd, fb } = await setup({ lastGrants: KEY_NONE });
    const a = share("a", false);
    const shareA = sh("a", false, fb.approve(grantedFor(a, "rw")));
    const card = fb.approve({
      kind: "new_origin",
      bindingHash: grantsKey([shareA], ["a.example"]),
      details: { separateDesktop: true },
    });
    const refused = (opts: Parameters<SeparateDesktop["use"]>[1]) =>
      expect(sd.use("t1", opts)).rejects.toMatchObject({
        details: { reason: "internet_not_approved" },
      });
    // Different sites, extra folder, no folder: refused.
    await refused({ shares: [shareA], internet: { allow: ["evil.example"], approvalId: card } });
    const b = share("b", false);
    await refused({
      shares: [shareA, sh("b", false, fb.approve(grantedFor(b, "rw")))],
      internet: { allow: ["a.example"], approvalId: card },
    });
    await refused({ shares: [], internet: { allow: ["a.example"], approvalId: card } });
    // A card of another kind, one that is not the separate desktop's, or still pending: refused.
    const other = (extra: Partial<StoredApproval>) =>
      fb.approve({
        kind: "new_origin",
        bindingHash: grantsKey([shareA], ["a.example"]),
        details: { separateDesktop: true },
        ...extra,
      });
    await refused({
      shares: [shareA],
      internet: { allow: ["a.example"], approvalId: other({ kind: "credential_fill" }) },
    });
    await refused({
      shares: [shareA],
      internet: { allow: ["a.example"], approvalId: other({ details: {} }) },
    });
    await refused({
      shares: [shareA],
      internet: { allow: ["a.example"], approvalId: other({ status: "pending" }) },
    });
    // The right set works.
    await expect(
      sd.use("t1", { shares: [shareA], internet: { allow: ["a.example"], approvalId: card } }),
    ).resolves.toBeUndefined();
  });

  it("a card is one task's: another task can't start with it", async () => {
    const { sd, fb } = await setup({ lastGrants: KEY_NONE });
    const a = share("a");
    const shareA = sh("a", true, fb.approve(grantedFor(a, "ro")));
    await sd.use("t1", { shares: [shareA] });
    await sd.release("t1");
    await expect(sd.use("t2", { shares: [shareA] })).rejects.toMatchObject({
      details: { reason: "approval_used" },
    });
    // The same task starting again with it is fine.
    await expect(sd.use("t1", { shares: [shareA] })).resolves.toBeUndefined();
  });

  it("with no broker no grant can be used, and a task with no grants still can", async () => {
    const { sd } = await setup({ noBroker: true, lastGrants: KEY_NONE });
    await expect(sd.use("t1", { shares: [sh("a", true, "apr_1")] })).rejects.toMatchObject({
      details: { reason: "no_broker" },
    });
    await expect(sd.use("t1")).resolves.toBeUndefined();
  });
});

describe("internet", () => {
  it("is the task's tunnel with the task's allowlist, and ends with the task", async () => {
    const { sd, engine, allow, states, use } = await setup();
    await use(sd, "t1", { internet: { allow: ["example.com"] } });
    expect(allow).toEqual([{ scope: { kind: "task", id: "t1" }, domains: ["example.com"] }]);
    expect(engine.egress).toHaveLength(1);
    expect(states.at(-1)?.internet).toBe(true);
    await sd.release("t1");
    expect(engine.egress[0]?.closed).toBe(true);
  });

  it("a task that did not ask for internet gets none", async () => {
    const { sd, engine, allow, use } = await setup({ lastGrants: KEY_NONE });
    await use(sd, "t1");
    expect(engine.egress).toEqual([]);
    expect(allow).toEqual([]);
  });

  it("the tunnel is closed even when the container is stopped over unsaved work", async () => {
    const { sd, engine, use } = await setup({ unsaved: ["gedit"] });
    await use(sd, "t1", { internet: { allow: ["example.com"] } });
    await expect(sd.release("t1")).rejects.toMatchObject({ code: "conflict" });
    expect(engine.egress[0]?.closed).toBe(true);
  });
});

describe("what the card for a shared folder says and does", () => {
  async function dir() {
    const d = mkdtempSync(join(tmpdir(), "psyche-sd-"));
    dirs.push(d);
    mkdirSync(join(d, "docs"));
    return join(d, "docs");
  }

  it("is its own approval kind that names the separate desktop and offers this task only", async () => {
    const { sd, fb } = await setup();
    fb.state.answer = {
      status: "approved",
      details: { granted: { path: "/data/docs", mode: "ro" } },
    };
    const docs = await dir();
    const out = await sd.requestShare(toolCtx(), {
      path: docs,
      reason: "to read the notes",
      access: "read",
    });
    const req = fb.requested[0] as Record<string, unknown>;
    expect(req.kind).toBe("separate_desktop_share");
    expect(req.summary).toBe(`Let the separate desktop read ${docs}`);
    expect(req.scopesOffered).toEqual(["once"]);
    expect(req.grantKey).toBe("separate_desktop_share|ro");
    expect((req.details as Record<string, unknown>).target).toBe("separate_desktop");
    expect(out).toMatchObject({
      granted: true,
      share: { source: "/data/docs", name: "docs", readOnly: true, approvalId: "apr_1" },
    });
  });

  it("asks a fresh card every time and says read and change for a read-write request", async () => {
    const { sd, fb } = await setup();
    fb.state.answer = {
      status: "approved",
      details: { granted: { path: "/data/docs", mode: "rw" } },
    };
    const docs = await dir();
    const ask = () => sd.requestShare(toolCtx(), { path: docs, reason: "r", access: "read_write" });
    const first = await ask();
    await ask();
    expect(fb.requested).toHaveLength(2);
    expect((fb.requested[0] as Record<string, unknown>).summary).toMatch(/read and change/);
    expect(first).toMatchObject({ granted: true, share: { readOnly: false } });
  });

  it("the owner can narrow read-write to read-only; a denial or a queued card shares nothing", async () => {
    const { sd, fb } = await setup();
    const docs = await dir();
    const ask = (mode = "attended") =>
      sd.requestShare(toolCtx(mode), { path: docs, reason: "r", access: "read_write" });
    fb.state.answer = {
      status: "approved",
      details: { granted: { path: "/data/docs", mode: "ro" } },
    };
    expect(await ask()).toMatchObject({ granted: true, share: { readOnly: true } });
    fb.state.answer = { status: "denied", details: {} };
    expect(await ask()).toEqual({ granted: false, status: "denied" });
    expect(await ask("unattended")).toEqual({ granted: false, status: "queued" });
  });

  it("only the owner can share a folder, and without a broker nothing is asked", async () => {
    const { sd } = await setup();
    const ctx = { ...toolCtx(), requester: { role: "allowed" } } as unknown as ToolRunContext;
    await expect(
      sd.requestShare(ctx, { path: "/tmp", reason: "r", access: "read" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const bare = await setup({ noBroker: true });
    await expect(
      bare.sd.requestShare(toolCtx(), { path: "/tmp", reason: "r", access: "read" }),
    ).rejects.toMatchObject({ details: { reason: "no_broker" } });
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
    expect(asksInSeparateDesktop("Delete", { ...base, readWriteShareMounted: false })).toBe(false);
  });

  it("follows the state of the task: web reached, login typed, read-write shares", async () => {
    const { sd, use } = await setup();
    const app = { app: "org.gnome.TextEditor" };
    await use(sd, "t1", { shares: [share("docs")] });
    expect(sd.asks("t1", "Delete", app)).toBe(false);
    expect(sd.asks("t1", "Delete", { app: "firefox" })).toBe(true);
    expect(sd.asks("other", "Delete", app)).toBe(true);
    await sd.release("t1");
    await use(sd, "t1b", { shares: [share("rw", false)] });
    expect(sd.asks("t1b", "Delete", app)).toBe(true);
    await sd.release("t1b");
    await use(sd, "t2", { internet: { allow: ["example.com"] } });
    expect(sd.asks("t2", "Delete", app)).toBe(true);
    await sd.release("t2");
    await use(sd, "t3");
    expect(sd.asks("t3", "Delete", app)).toBe(false);
  });

  it("closing the tunnel does not bring the relaxation back during the same task", async () => {
    const { sd, engine, use } = await setup();
    await use(sd, "t1", { internet: { allow: ["example.com"] } });
    await use(sd, "t1");
    expect(engine.egress[0]?.closed).toBe(true);
    expect(sd.asks("t1", "Delete", { app: "org.gnome.TextEditor" })).toBe(true);
  });
});

describe("typing a saved login into the desktop", () => {
  function steps() {
    const typed: string[] = [];
    const read = vi.fn(async () => "s3cret");
    return {
      typed,
      read,
      request: (origin = "https://bank.example") => ({
        origin,
        item: "Bank",
        read,
        type: async (s: string) => void typed.push(s),
      }),
    };
  }

  it("is refused without internet for the task, and for an origin the task may not reach", async () => {
    const { sd, fb, use } = await setup();
    const s = steps();
    await use(sd, "t1");
    await expect(sd.fillCredential("t1", toolCtx(), s.request())).rejects.toMatchObject({
      details: { reason: "credential_needs_internet" },
    });
    await sd.release("t1");
    await use(sd, "t2", { internet: { allow: ["bank.example"] } });
    for (const bad of ["https://evil.example", "not a url", "ftp://bank.example"]) {
      await expect(sd.fillCredential("t2", toolCtx(), s.request(bad))).rejects.toMatchObject({
        details: { reason: "credential_origin_not_allowed" },
      });
    }
    await expect(sd.fillCredential("other", toolCtx(), s.request())).rejects.toMatchObject({
      details: { reason: "credential_needs_internet" },
    });
    expect(fb.requested.filter((r) => r.kind === "credential_fill")).toEqual([]);
    expect(s.read).not.toHaveBeenCalled();
  });

  it("asks a fresh card of its own every time, names the unverifiable page, reads only after approval", async () => {
    const { sd, fb, use } = await setup();
    await use(sd, "t1", { internet: { allow: ["bank.example"] } });
    const s = steps();
    fb.state.answer = { status: "approved", details: {} };
    expect(await sd.fillCredential("t1", toolCtx(), s.request())).toBe(true);
    expect(await sd.fillCredential("t1", toolCtx(), s.request())).toBe(true);
    const cards = fb.requested.filter((r) => r.kind === "credential_fill");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      kind: "credential_fill",
      grantKey: "credential_fill|separate_desktop|https://bank.example",
      scopesOffered: ["once"],
      details: { origin: "https://bank.example", separateDesktop: true },
    });
    expect(s.typed).toEqual(["s3cret", "s3cret"]);
    fb.state.answer = { status: "denied", details: {} };
    const no = steps();
    expect(await sd.fillCredential("t1", toolCtx(), no.request())).toBe(false);
    expect(no.read).not.toHaveBeenCalled();
    expect(no.typed).toEqual([]);
  });

  it("an unattended task is never asked to type a login", async () => {
    const { sd, use } = await setup();
    await use(sd, "t1", { internet: { allow: ["bank.example"] } });
    const s = steps();
    expect(await sd.fillCredential("t1", toolCtx("unattended"), s.request())).toBe(false);
    expect(s.read).not.toHaveBeenCalled();
  });

  it("a login typed in turns the relaxed risky-word rule off for the rest of the task", async () => {
    const { sd, fb, use } = await setup();
    await use(sd, "t1", { internet: { allow: ["bank.example"] } });
    fb.state.answer = { status: "approved", details: {} };
    await sd.fillCredential("t1", toolCtx(), steps().request());
    expect(sd.asks("t1", "Delete", { app: "org.gnome.TextEditor" })).toBe(true);
    expect(
      asksInSeparateDesktop("Delete", {
        internetUsed: false,
        credentialFilled: true,
        app: "org.gnome.TextEditor",
        readWriteShareMounted: false,
      }),
    ).toBe(true);
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

describe("the card for the internet", () => {
  it("is bound to the whole set of grants, names a read-write folder and says files can leave through it", async () => {
    const { sd, fb } = await setup();
    fb.state.answer = { status: "approved", details: {} };
    const shares = [
      { source: "/data/docs", name: "docs", readOnly: false },
      { source: "/data/ro", name: "ro", readOnly: true },
    ];
    const out = await sd.requestInternet(toolCtx(), {
      allow: ["example.com"],
      shares,
      reason: "to look something up",
    });
    expect(out).toEqual({ approvalId: "apr_1" });
    const req = fb.requested[0] as {
      summary: string;
      bindingHash: string;
      details: Record<string, unknown>;
      scopesOffered: string[];
    };
    expect(req.bindingHash).toBe(grantsKey(shares, ["example.com"]));
    expect(req.summary).toContain("This task can also change /data/docs, and send files from it.");
    expect(req.summary).not.toContain("/data/ro");
    expect(req.details).toMatchObject({ separateDesktop: true, alsoChanges: ["/data/docs"] });
    expect(req.scopesOffered).toEqual(["once"]);
  });

  it("says nothing about files without a read-write folder, and a denied or unattended card gives no internet", async () => {
    const { sd, fb } = await setup();
    fb.state.answer = { status: "approved", details: {} };
    await sd.requestInternet(toolCtx(), {
      allow: ["example.com"],
      shares: [{ source: "/data/ro", name: "ro", readOnly: true }],
      reason: "r",
    });
    const req = fb.requested[0] as { summary: string; details: Record<string, unknown> };
    expect(req.summary).not.toMatch(/send files/);
    expect(req.details.alsoChanges).toBeUndefined();
    const ask = (mode = "attended") =>
      sd.requestInternet(toolCtx(mode), { allow: ["example.com"], shares: [], reason: "r" });
    fb.state.answer = { status: "denied", details: {} };
    expect(await ask()).toBeUndefined();
    fb.state.answer = { status: "approved", details: {} };
    expect(await ask("unattended")).toBeUndefined();
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
