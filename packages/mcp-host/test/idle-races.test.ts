import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxInstance, SandboxNetwork, SandboxScope } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  containerLauncher,
  directLauncher,
  type McpHostEvent,
  PsycheMcpHost,
  type SandboxStdioHost,
  type SandboxStdioProcess,
  type StdioLauncher,
} from "../src/index.ts";

/**
 * Races between a restart and a removal, a close or a slow stop (PR #1401 review round 2), on real
 * timers and real processes. Each test fails on the code before that review's fixes.
 */

const SERVER = fileURLToPath(new URL("./fixtures/stdio-mutable-server.ts", import.meta.url));
let dir: string;
let desc: string;
let starts: string;
let poison: string;
let dieOnList: string;
const hosts: PsycheMcpHost[] = [];
const startCount = () => readFileSync(starts, "utf8").split("\n").filter(Boolean).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const code = (e: unknown) => (e as { code?: string }).code;

/** directLauncher whose `prepare` and early cleanups can be held, logging every step in order. */
function gatedLauncher() {
  const inner = directLauncher();
  const log: string[] = [];
  let gate: Promise<void> | undefined;
  let cleanupGate: Promise<void> | undefined;
  let n = 0;
  const launcher: StdioLauncher = {
    isolation: inner.isolation,
    async prepare(spec) {
      n += 1;
      const id = n;
      log.push(`prepare#${id}`);
      if (gate !== undefined) await gate;
      const p = await (inner.prepare as NonNullable<typeof inner.prepare>)(spec);
      return {
        ...p,
        cleanup: async () => {
          if (cleanupGate !== undefined && id <= 2) await cleanupGate;
          log.push(`cleanup#${id}`);
        },
      };
    },
    async forget(id) {
      log.push(`forget:${id}`);
    },
  };
  /** Holds every later `prepare` until the returned function is called. */
  const hold = () => {
    let release!: () => void;
    gate = new Promise<void>((r) => {
      release = r;
    });
    return () => {
      gate = undefined;
      release();
    };
  };
  const holdCleanup = () => {
    let release!: () => void;
    cleanupGate = new Promise<void>((r) => {
      release = r;
    });
    return () => {
      cleanupGate = undefined;
      release();
    };
  };
  /** Ids of prepared launches that were never cleaned up. */
  const leaked = () => {
    const prepared = log.filter((l) => l.startsWith("prepare#")).map((l) => l.slice(8));
    const cleaned = new Set(log.filter((l) => l.startsWith("cleanup#")).map((l) => l.slice(8)));
    return prepared.filter((id) => !cleaned.has(id));
  };
  return { launcher, log, hold, holdCleanup, leaked };
}

type HostOptions = ConstructorParameters<typeof PsycheMcpHost>[0];

async function setup(options: HostOptions = {}, extra: Record<string, unknown> = {}) {
  const events: McpHostEvent[] = [];
  const host = new PsycheMcpHost({
    bundledServerIds: ["mut"],
    launcher: directLauncher(),
    idleStopMs: 200,
    ...options,
    onEvent: (e) => {
      events.push(e);
      options.onEvent?.(e);
    },
  });
  hosts.push(host);
  const info = await host.addServer({
    id: "mut",
    name: "Mutable",
    trust: "bundled",
    transport: { kind: "stdio", command: [process.execPath, SERVER, desc, starts, poison] },
    ...extra,
  } as Parameters<PsycheMcpHost["addServer"]>[0]);
  expect(info.status).toBe("connected");
  const { toolsListHash } = await host.listTools("mut");
  return { host, events, toolsListHash };
}

const status = (host: PsycheMcpHost) => host.listServers().then((l) => l[0]?.status);
const stopped = (host: PsycheMcpHost) =>
  vi.waitFor(async () => expect(await status(host)).toBe("disconnected"), { timeout: 5000 });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "psyche-mcp-races-"));
  desc = join(dir, "desc.txt");
  starts = join(dir, "starts.txt");
  poison = join(dir, "poison");
  dieOnList = join(dir, "die-on-list");
  writeFileSync(desc, "Pings.");
  writeFileSync(starts, "");
});
afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("removal during a restart (finding 1, TM-18)", () => {
  it("a second caller waiting on the wake does not start the server again after forget", async () => {
    const g = gatedLauncher();
    const { host, toolsListHash } = await setup({ launcher: g.launcher });
    await stopped(host);
    const release = g.hold();
    const a = host.callTool("mut", "ping", {}, { toolsListHash }).catch((e) => e);
    const b = host.callTool("mut", "ping", {}, { toolsListHash }).catch((e) => e);
    const removed = host.removeServer("mut");
    await sleep(50);
    release();
    await removed;
    expect(code(await a)).toBe("not_found");
    expect(code(await b)).toBe("not_found");
    await sleep(800);
    const forgot = g.log.indexOf("forget:mut");
    expect(forgot).toBeGreaterThan(-1);
    expect(g.log.slice(forgot).filter((l) => l.startsWith("prepare"))).toEqual([]);
    expect(g.leaked()).toEqual([]);
  });

  it("with the container launcher: no egress allowlist or sandbox after the revoke", async () => {
    const log: string[] = [];
    let gate: Promise<void> | undefined;
    const children: ReturnType<typeof spawn>[] = [];
    const sandbox: SandboxStdioHost = {
      async ensureSandbox(scope: SandboxScope, o: { network?: SandboxNetwork } = {}) {
        log.push("ensureSandbox");
        return {
          id: "sbx_mut",
          scope,
          backend: "fake",
          network: o.network ?? "none",
          workspacePath: "/workspace",
          status: "ready",
        } as SandboxInstance;
      },
      async openStdio(_id, o): Promise<SandboxStdioProcess> {
        log.push("openStdio");
        const [cmd, ...rest] = o.argv;
        const child = spawn(cmd as string, rest, { stdio: ["pipe", "pipe", "pipe"] });
        children.push(child);
        const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => child.once("exit", (exitCode, signal) => resolve({ exitCode, signal })),
        );
        return {
          stdin: child.stdin as NonNullable<typeof child.stdin>,
          stdout: child.stdout as NonNullable<typeof child.stdout>,
          stderr: child.stderr as NonNullable<typeof child.stderr>,
          exited,
          kill: async () => {
            child.kill("SIGTERM");
            await exited;
          },
        };
      },
      async deleteWorkspace() {
        log.push("deleteWorkspace");
      },
    };
    const launcher = containerLauncher({
      sandbox,
      egressAllowlist: async () => {
        log.push("egressAllowlist");
        if (gate !== undefined) await gate;
      },
      egressRevoke: () => void log.push("egressRevoke"),
    });
    try {
      const { host, toolsListHash } = await setup(
        { launcher },
        { sandbox: { allowedDomains: ["a.example"] } },
      );
      await stopped(host);
      let release!: () => void;
      gate = new Promise<void>((r) => {
        release = r;
      });
      const a = host.callTool("mut", "ping", {}, { toolsListHash }).catch((e) => e);
      const b = host.callTool("mut", "ping", {}, { toolsListHash }).catch((e) => e);
      await vi.waitFor(() => expect(log.at(-1)).toBe("egressAllowlist"));
      const removed = host.removeServer("mut");
      await sleep(50);
      gate = undefined;
      release();
      await removed;
      expect(code(await a)).toBe("not_found");
      expect(code(await b)).toBe("not_found");
      await sleep(800);
      const revoked = log.indexOf("egressRevoke");
      expect(revoked).toBeGreaterThan(-1);
      expect(log.slice(revoked)).toEqual(["egressRevoke", "deleteWorkspace"]);
    } finally {
      for (const c of children) c.kill("SIGKILL");
    }
  });
});

describe("close during a restart (finding 2)", () => {
  it("a wake in flight is dropped: the call fails, nothing stays connected, the launch is cleaned up", async () => {
    const g = gatedLauncher();
    const { host, toolsListHash } = await setup({ launcher: g.launcher });
    await stopped(host);
    const release = g.hold();
    const a = host.callTool("mut", "ping", {}, { toolsListHash }).catch((e) => e);
    await vi.waitFor(() => expect(g.log.at(-1)).toMatch(/^prepare#/));
    const closing = host.close();
    release();
    await closing;
    const r = await a;
    expect(r).toBeInstanceOf(Error);
    expect(code(r)).toBe("unavailable");
    expect(await status(host)).not.toBe("connected");
    expect(g.leaked()).toEqual([]);
    await expect(host.callTool("mut", "ping", {}, { toolsListHash })).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("close() returns while a launcher step is still held, and the late launch is cleaned up (round 3)", async () => {
    const g = gatedLauncher();
    const { host, toolsListHash } = await setup({ launcher: g.launcher });
    await stopped(host);
    const release = g.hold();
    const a = host.callTool("mut", "ping", {}, { toolsListHash }).catch((e) => e);
    await vi.waitFor(() => expect(g.log.at(-1)).toMatch(/^prepare#/));
    const base = startCount();
    // The prepare stays held: close() must not wait for it.
    const closed = await Promise.race([
      host.close().then(() => "closed"),
      sleep(2000).then(() => "still waiting"),
    ]);
    expect(closed).toBe("closed");
    expect(code(await a)).toBe("unavailable");
    expect(await status(host)).not.toBe("connected");
    release();
    await vi.waitFor(() => expect(g.leaked()).toEqual([]));
    // The late launch was never started.
    await sleep(200);
    expect(startCount()).toBe(base);
  });

  it("removeServer aborts a start's connect but still runs forget after the launcher step settles", async () => {
    const g = gatedLauncher();
    const { host, toolsListHash } = await setup({ launcher: g.launcher });
    await stopped(host);
    const release = g.hold();
    const a = host.callTool("mut", "ping", {}, { toolsListHash }).catch((e) => e);
    await vi.waitFor(() => expect(g.log.at(-1)).toMatch(/^prepare#/));
    const removed = host.removeServer("mut");
    await sleep(100);
    // Not forgotten while the prepare could still recreate state (TM-18).
    expect(g.log).not.toContain("forget:mut");
    expect(code(await a)).toBe("not_found");
    release();
    await removed;
    const forgot = g.log.indexOf("forget:mut");
    expect(forgot).toBe(g.log.length - 1);
    expect(g.leaked()).toEqual([]);
  });
});

describe("the Gateway's checks while a server is stopped (round 3)", () => {
  it("a server that became neverAutoStart while stopped is not woken by a call", async () => {
    let checked = false;
    const { host, toolsListHash } = await setup({ neverAutoStart: () => checked });
    await stopped(host);
    checked = true;
    const base = startCount();
    await expect(host.callTool("mut", "ping", {}, { toolsListHash })).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringMatching(/starts again only through Psyche's checks/),
    });
    expect(startCount()).toBe(base);
    // Refused while the check says so; the approved listing stays pinned meanwhile.
    expect(host.pinnedTools("mut").toolsListHash).toBe(toolsListHash);
    // A check that failed only for a moment (an unreadable ledger, #1421 review) strands nothing:
    // once it passes, the next call starts the server.
    checked = false;
    const r = await host.callTool("mut", "ping", {}, { toolsListHash });
    expect(r.isError).toBe(false);
    expect(startCount()).toBeGreaterThan(base);
  });
});

describe("a slow stop and a new start (finding 3)", () => {
  it("a stop still cleaning up does not mark the newer connection disconnected", async () => {
    const g = gatedLauncher();
    const release = g.holdCleanup();
    const { host, toolsListHash } = await setup({ launcher: g.launcher, idleStopMs: 300 });
    // The idle stop has begun and hangs in its cleanup; a call starts the server again.
    await sleep(500);
    const r1 = await host.callTool("mut", "ping", {}, { toolsListHash });
    expect(r1.isError).toBe(false);
    release();
    await sleep(100);
    expect(await status(host)).toBe("connected");
    const r2 = await host.callTool("mut", "ping", {}, { toolsListHash });
    expect(r2.isError).toBe(false);
  });

  it("a server that lingers after stdin closes: a call right after the idle stop keeps working", async () => {
    const { host } = await setup(
      { idleStopMs: 1000 },
      {
        transport: {
          kind: "stdio",
          command: [process.execPath, SERVER, desc, starts, poison, "--sticky"],
        },
      },
    );
    const { toolsListHash } = await host.listTools("mut");
    // The stop begins at 1s; the old process takes 2s + 2s to be closed and killed.
    await sleep(1100);
    const r1 = await host.callTool("mut", "ping", {}, { toolsListHash });
    expect(r1.isError).toBe(false);
    // Calls every 400 ms keep the new process from its own idle stop while the old one goes.
    for (let i = 0; i < 12; i += 1) {
      await sleep(400);
      expect(await status(host)).toBe("connected");
      const r = await host.callTool("mut", "ping", {}, { toolsListHash });
      expect(r.isError).toBe(false);
    }
  }, 20_000);
});

describe("crash counting (findings 4 and 5)", () => {
  const dying = () => ({
    transport: {
      kind: "stdio",
      command: [process.execPath, SERVER, desc, starts, poison, dieOnList],
    },
  });

  it("a death during the tool listing counts once", async () => {
    const { host, toolsListHash } = await setup(
      { restart: { baseMs: 50, maxMs: 50, maxAttempts: 2 } },
      dying(),
    );
    await stopped(host);
    writeFileSync(dieOnList, "x");
    await expect(host.callTool("mut", "ping", {}, { toolsListHash })).rejects.toMatchObject({
      code: "unavailable",
    });
    // One failure of two: after the backoff the next call may start it again.
    await rm(dieOnList);
    await sleep(100);
    const base = startCount();
    const r = await host.callTool("mut", "ping", {}, { toolsListHash });
    expect(r.isError).toBe(false);
    expect(startCount()).toBeGreaterThan(base);
  });

  it("a cancel does not undo a give-up made during the same start", async () => {
    const ac = new AbortController();
    let armed = false;
    const { host, toolsListHash } = await setup(
      {
        restart: { baseMs: 50, maxMs: 50, maxAttempts: 1 },
        // The death's own status event: the turn is cancelled right then.
        onEvent: (e) => {
          if (armed && e.type === "status" && e.status === "disconnected") ac.abort();
        },
      },
      dying(),
    );
    await stopped(host);
    writeFileSync(dieOnList, "x");
    armed = true;
    await expect(
      host.callTool("mut", "ping", {}, { toolsListHash, signal: ac.signal }),
    ).rejects.toBeDefined();
    expect(ac.signal.aborted).toBe(true);
    await rm(dieOnList);
    await sleep(100);
    const base = startCount();
    await expect(host.callTool("mut", "ping", {}, { toolsListHash })).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringMatching(/tries again in 10 minutes, or edit or re-add the server/),
    });
    expect(startCount()).toBe(base);
  });
});

describe("a failed start that was superseded (finding 6)", () => {
  it("cleans up its own launch", async () => {
    const g = gatedLauncher();
    const host = new PsycheMcpHost({ bundledServerIds: ["mut"], launcher: g.launcher });
    hosts.push(host);
    writeFileSync(poison, "x");
    const release = g.hold();
    const adding = host.addServer({
      id: "mut",
      name: "Mutable",
      trust: "bundled",
      transport: { kind: "stdio", command: [process.execPath, SERVER, desc, starts, poison] },
    } as Parameters<PsycheMcpHost["addServer"]>[0]);
    await vi.waitFor(() => expect(g.log).toContain("prepare#1"));
    // removeServer now waits for the held prepare before `forget` (round 3): release it first.
    const removing = host.removeServer("mut");
    release();
    await removing;
    await adding.catch(() => undefined);
    await vi.waitFor(() => expect(g.leaked()).toEqual([]));
  });

  it("cleans up its own launch when a newer connect superseded it without an abort", async () => {
    const g = gatedLauncher();
    const host = new PsycheMcpHost({ bundledServerIds: ["mut"], launcher: g.launcher });
    hosts.push(host);
    writeFileSync(poison, "x");
    const release = g.hold();
    const adding = host.addServer({
      id: "mut",
      name: "Mutable",
      trust: "bundled",
      transport: { kind: "stdio", command: [process.execPath, SERVER, desc, starts, poison] },
    } as Parameters<PsycheMcpHost["addServer"]>[0]);
    await vi.waitFor(() => expect(g.log).toContain("prepare#1"));
    // Both starts hold in prepare; the first one's launch is then overwritten by the second's.
    const again = host.connect("mut");
    await vi.waitFor(() => expect(g.log).toContain("prepare#2"));
    release();
    await adding.catch(() => undefined);
    await again.catch(() => undefined);
    await vi.waitFor(() => expect(g.leaked()).toEqual([]));
  });
});
