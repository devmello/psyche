import { openDb, setSetting } from "@psyche/db";
import type { SandboxBackend } from "@psyche/protocol";
import {
  type CliDriver,
  type CliResult,
  type DetectDeps,
  resolveSrt,
  SRT_SETTING,
  type SrtDeps,
} from "@psyche/sandbox";
import { describe, expect, it } from "vitest";
import {
  composeSandbox,
  type DevServerSink,
  devServerBridge,
  sandboxSetupHandler,
} from "../src/compose/sandbox.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { createSrtResolver, type SrtResolver } from "../src/compose/srt.ts";

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
      exec: false,
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
      exec: false,
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

describe("sandbox.status (for psyche security audit)", () => {
  it("reports the backend and the egress proxy", async () => {
    const part = composeSandbox(services, {
      exec: false,
      runner: { cli: fakeCli(() => ({})) } as never,
    });
    (part.runner as unknown as { backends: () => Promise<string[]> }).backends = async () => [
      "docker",
    ];
    const status = part.handlers?.["sandbox.status"];
    expect(await status?.run({} as never, {} as never)).toEqual({
      backend: "docker",
      available: true,
      sandbox: null,
      egress: true,
    });
    await part.stop?.();
  });
});

describe("sandbox.setup (guided setup)", () => {
  /** A Mac whose runtimes are described by `present`: path of the CLI, and what its probe says. */
  const mac = (present: Record<string, string | null>, macosVersion = "26.1"): DetectDeps => ({
    platform: "darwin",
    arch: "arm64",
    env: {},
    which: async (c) => (c in present ? `/usr/local/bin/${c}` : null),
    macosVersion: async () => macosVersion,
    probe: async (cli) => present[cli.split("/").pop() ?? ""] ?? null,
  });
  /** srt as `resolveSrt` would find it: at `path` (on PATH), or nowhere. */
  const srtAt = (path: string | null): SrtResolver => ({
    inspect: async () =>
      path === null
        ? { available: false, path: null, source: null, version: null, problem: "not_found" }
        : { available: true, path, source: "detected", version: "srt 1.0", problem: null },
    resolve: async () => (path === null ? { missing: true, reason: "not_found" } : { path }),
  });
  const run = (
    deps: DetectDeps,
    active: SandboxBackend = "none",
    srt: SrtResolver | undefined = srtAt(null),
  ) => sandboxSetupHandler(async () => active, srt, deps).run();

  it("is ready with srt alone: no VM or container needed", async () => {
    const r = await run(mac({}), "none", srtAt("/opt/homebrew/bin/srt"));
    expect(r.ready).toBe(true);
    expect(r.srt).toMatchObject({ available: true, path: "/opt/homebrew/bin/srt" });
    expect(r.containers.ready).toBe(false);
  });

  it("reports nothing installed: no srt, Apple container recommended on macOS 26", async () => {
    const r = await run(mac({}));
    expect(r.ready).toBe(false);
    expect(r.srt.problem).toBe("not_found");
    expect(r.containers).toMatchObject({ recommended: "apple-container", ready: false });
    expect(r.containers.backends.map((b) => [b.kind, b.supported, b.installed, b.running])).toEqual(
      [
        ["apple-container", true, false, false],
        ["docker", true, false, false],
        ["podman", true, false, false],
      ],
    );
  });

  it("sees Docker installed but its daemon stopped", async () => {
    const r = await run(mac({ docker: null }));
    expect(r.containers.ready).toBe(false);
    expect(r.containers.backends.find((b) => b.kind === "docker")).toMatchObject({
      installed: true,
      running: false,
      version: null,
    });
  });

  it("asks for a restart when a runtime runs that the Gateway booted without", async () => {
    const r = await run(mac({ container: "1.5.0" }));
    expect(r.containers).toMatchObject({ ready: true, active: "none", restartNeeded: true });
    const booted = await run(mac({ container: "1.5.0" }), "apple-container");
    expect(booted.containers).toMatchObject({ ready: true, restartNeeded: false });
  });

  it("recommends Docker where Apple container cannot run, and never lists it as installed", async () => {
    const r = await run(mac({ container: "1.5.0" }, "15.4"));
    expect(r.containers.recommended).toBe("docker");
    expect(r.containers.backends[0]).toMatchObject({
      kind: "apple-container",
      supported: false,
      installed: false,
    });
  });
});

describe("srt resolution (shared by MCP servers and host exec)", () => {
  const deps = (
    executables: string[],
    dirs: string[] = ["/usr/bin", "/opt/homebrew/bin"],
  ): SrtDeps => ({
    isExecutable: async (p) => executables.includes(p),
    searchDirs: () => dirs,
    version: async () => "srt 1.0.0",
  });

  it("finds srt on PATH or in the usual folders", async () => {
    expect(await resolveSrt(deps(["/opt/homebrew/bin/srt"]), {})).toEqual({
      available: true,
      path: "/opt/homebrew/bin/srt",
      source: "detected",
      version: "srt 1.0.0",
      problem: null,
    });
    expect(await resolveSrt(deps([]), {})).toMatchObject({
      available: false,
      problem: "not_found",
    });
  });

  it("prefers PSYCHE_SRT_PATH, then the setting, and never falls through a broken override", async () => {
    const d = deps(["/opt/homebrew/bin/srt", "/custom/srt"]);
    expect(await resolveSrt(d, { env: "/custom/srt", setting: "/x/srt" })).toMatchObject({
      source: "env",
      path: "/custom/srt",
    });
    expect(await resolveSrt(d, { setting: "/custom/srt" })).toMatchObject({ source: "setting" });
    expect(await resolveSrt(d, { env: "/missing/srt" })).toMatchObject({
      available: false,
      source: "env",
      problem: "not_executable",
    });
    expect(await resolveSrt(d, { setting: "srt" })).toMatchObject({
      available: false,
      problem: "not_absolute",
    });
  });

  it("reads the exec.srtPath setting at each call, so a newly chosen srt needs no restart", async () => {
    const db = openDb(":memory:");
    const resolver = createSrtResolver({ db }, {}, deps(["/picked/srt"], []));
    expect(await resolver.resolve()).toEqual({ missing: true, reason: "not_found" });
    setSetting(db, SRT_SETTING, "/picked/srt");
    expect(await resolver.resolve()).toEqual({ path: "/picked/srt" });
    expect((await resolver.inspect()).source).toBe("setting");
  });
});
