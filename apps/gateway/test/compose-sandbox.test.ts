import type { CliDriver, CliResult } from "@psyche/sandbox";
import { describe, expect, it } from "vitest";
import { composeSandbox, type DevServerSink, devServerBridge } from "../src/compose/sandbox.ts";
import type { ComposeServices } from "../src/compose/services.ts";

/** A container CLI that runs nothing: inspect says "absent", the listener probe answers `probe`. */
function fakeCli(probe: () => object): CliDriver {
  const result = (r: Partial<CliResult>): CliResult => ({
    exitCode: 0,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    ...r,
  });
  return {
    start(_file, args) {
      const a = [...args];
      let r: Partial<CliResult> = {};
      if (a[0] === "inspect" || (a[0] === "volume" && a[1] === "inspect")) r = { exitCode: 1 };
      else if (a.some((x) => x.includes("/proc/net/tcp"))) {
        r = { stdout: Buffer.from(JSON.stringify(probe())) };
      }
      return { pid: 1, done: Promise.resolve(result(r)), kill: () => undefined };
    },
    stream() {
      throw new Error("no connection in this test");
    },
  };
}

function recordingSink() {
  const calls: Array<["started", Parameters<DevServerSink["started"]>[0]] | ["stopped", number]> =
    [];
  const sink: DevServerSink = {
    started: (s) => calls.push(["started", s]),
    stopped: (port) => calls.push(["stopped", port]),
  };
  return { sink, calls };
}

const services = {} as ComposeServices;

describe("composeSandbox: dev servers reach the browser's dev-preview registry (I12)", () => {
  it("announces the forward's host port, the root pid and the task, then stopped on shutdown", async () => {
    const { sink, calls } = recordingSink();
    let probe: object = {
      sid: 41,
      alive: true,
      listeners: [{ port: 5173, addr: "0.0.0.0", pid: 57 }],
    };
    const part = composeSandbox(services, {
      devServers: sink,
      runner: {
        driver: fakeCli(() => probe),
        detect: async () => [{ kind: "docker", cli: "/usr/bin/docker", version: "29" }],
        image: "psyche-sandbox:core-dev",
        idleTimeoutMs: 0,
        devServers: { probeDelaysMs: [], pollMs: 60_000 },
      },
    });
    const sbx = await part.runner.ensureSandbox({ kind: "task", id: "task_1" });
    await part.runner.exec({
      sandboxId: sbx.id,
      argv: ["npm", "run", "dev"],
      cwd: "/workspace/app",
      timeoutMs: 1000,
    });

    expect(calls).toHaveLength(1);
    const [kind, server] = calls[0] ?? [];
    expect(kind).toBe("started");
    if (typeof server !== "object") throw new Error("expected a server");
    expect(server).toMatchObject({
      pid: 41,
      cwd: "/workspace/app",
      taskId: "task_1",
      name: "npm run dev (sandbox port 5173)",
    });
    // Never the container's number: that would alias a host process on 5173 (security §3.10).
    expect(server.port).not.toBe(5173);

    probe = { sid: 41, alive: false, listeners: [] };
    await part.stop?.();
    expect(calls[1]).toEqual(["stopped", server.port]);
  });

  it("forwards nothing and never probes without a registry", async () => {
    let probed = false;
    const part = composeSandbox(services, {
      runner: {
        driver: fakeCli(() => {
          probed = true;
          return {};
        }),
        detect: async () => [{ kind: "docker", cli: "/usr/bin/docker", version: "29" }],
        image: "psyche-sandbox:core-dev",
        idleTimeoutMs: 0,
      },
    });
    const sbx = await part.runner.ensureSandbox({ kind: "thread", id: "thr_1" });
    await part.runner.exec({
      sandboxId: sbx.id,
      argv: ["true"],
      cwd: "/workspace",
      timeoutMs: 1000,
    });
    expect(probed).toBe(false);
    await part.stop?.();
  });

  it("a thread or project sandbox's server carries no task restriction", () => {
    const { sink, calls } = recordingSink();
    const server = {
      sandboxId: "sbx_1",
      scope: { kind: "thread" as const, id: "thr_1" },
      port: 50_123,
      containerPort: 3000,
      pid: 7,
      listenerPid: 9,
      cwd: "/workspace",
      argv: ["vite"],
    };
    devServerBridge(sink)({ type: "started", server });
    expect(calls[0]?.[1]).not.toHaveProperty("taskId");
  });
});
