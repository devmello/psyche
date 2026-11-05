import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ManagedWhisperServerBackend,
  WhisperServerProcess,
  type WhisperServerProcessOptions,
} from "../src/engines/whisper-server-process.ts";
import { FIXTURES } from "./helpers.ts";

const FAKE = join(FIXTURES, "fake-whisper-server.mjs");
const dirs: string[] = [];
const procs: WhisperServerProcess[] = [];

afterEach(async () => {
  for (const p of procs.splice(0)) await p.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function server(
  extra: Partial<WhisperServerProcessOptions> = {},
  testFlags: string[] = [],
): { proc: WhisperServerProcess; workDir: string; ports: number[] } {
  const workDir = mkdtempSync(join(tmpdir(), "psyche-wsrv-"));
  dirs.push(workDir);
  const ports: number[] = [];
  const proc = new WhisperServerProcess({
    serverPath: join(workDir, "bin", "whisper-server.exe"),
    modelPath: join(workDir, "ggml-base.en.bin"),
    workDir,
    command: [process.execPath, FAKE, ...testFlags],
    onListening: (port) => {
      ports.push(port);
      return () => {
        ports.splice(ports.indexOf(port), 1);
      };
    },
    isStaleServer: async () => false,
    ...extra,
  });
  procs.push(proc);
  return { proc, workDir, ports };
}

const backend = (proc: WhisperServerProcess) =>
  new ManagedWhisperServerBackend({ process: proc, ready: async () => true });

const pcm = new Uint8Array(3200);

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Each case spawns real Node processes; a busy machine needs more than the 5 s default.
describe("the Gateway's whisper-server (lifecycle)", { timeout: 30_000 }, () => {
  it("starts on demand on loopback under a secret request path, and registers its port", async () => {
    const { proc, workDir, ports } = server();
    expect(proc.state).toBe("stopped");
    const segs = await backend(proc).transcribe({ pcm });
    expect(segs[0]?.text).toMatch(/^heard \d+ bytes with ggml-base\.en\.bin$/);
    expect(proc.state).toBe("running");
    const base = proc.baseUrl ?? "";
    const url = new URL(base);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.pathname).toMatch(/^\/psyche-[0-9a-f]{32}$/);
    expect(ports).toEqual([Number(url.port)]);
    // Without the token nothing answers.
    expect((await fetch(`http://127.0.0.1:${url.port}/health`)).status).toBe(404);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect(readFileSync(join(workDir, "whisper-server.pid"), "utf8").trim()).toBe(String(proc.pid));
    await proc.stop();
    expect(proc.state).toBe("stopped");
    expect(ports).toEqual([]);
    expect(existsSync(join(workDir, "whisper-server.pid"))).toBe(false);
  });

  it("shares one start between concurrent requests and waits for the model to load", async () => {
    const { proc } = server({}, ["--slow-start", "300"]);
    const t0 = Date.now();
    const [a, b] = await Promise.all([proc.start(), proc.start()]);
    expect(a).toBe(b);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });

  it("stops after the idle time and starts again on the next request", async () => {
    const { proc, ports } = server({ idleMs: 150 });
    await backend(proc).transcribe({ pcm });
    const first = proc.pid;
    await until(() => proc.state === "stopped");
    expect(ports).toEqual([]);
    await backend(proc).transcribe({ pcm });
    expect(proc.state).toBe("running");
    expect(proc.pid).not.toBe(first);
  });

  it("restarts after a crash: between requests, and once under a request", async () => {
    const { proc, workDir } = server();
    const b = backend(proc);
    await b.transcribe({ pcm });
    const first = proc.pid as number;
    process.kill(first);
    await until(() => proc.state === "stopped");
    expect(proc.lastError).toBe("crashed");
    expect((await b.transcribe({ pcm }))[0]?.text).toMatch(/^heard/);
    const second = proc.pid;
    expect(second).not.toBe(first);
    // The server dies while answering: the request is retried on a fresh server.
    writeFileSync(join(workDir, "die-once"), "");
    expect((await b.transcribe({ pcm }))[0]?.text).toMatch(/^heard/);
    expect(proc.pid).not.toBe(second);
  });

  it("stops retrying after three crashes in a minute", async () => {
    const { proc } = server();
    for (let i = 0; i < 3; i++) {
      await proc.start();
      process.kill(proc.pid as number);
      await until(() => proc.state === "stopped");
    }
    await expect(proc.start()).rejects.toMatchObject({
      code: "unavailable",
      details: { reason: "crash_loop" },
    });
    expect(proc.lastError).toBe("crash_loop");
    expect(await backend(proc).available()).toBe(false);
  });

  it("reports a server that exits before it is ready", async () => {
    const { proc } = server({}, ["--exit-code", "7"]);
    await expect(proc.start()).rejects.toMatchObject({
      code: "unavailable",
      details: { reason: "exited", exitCode: 7 },
    });
    expect(proc.state).toBe("stopped");
  });

  it.skipIf(process.platform !== "win32")(
    "names a missing Visual C++ runtime (STATUS_DLL_NOT_FOUND)",
    async () => {
      const { proc } = server({}, ["--exit-code", String(0xc0000135)]);
      await expect(proc.start()).rejects.toMatchObject({ details: { reason: "vcredist_missing" } });
      expect(proc.lastError).toBe("vcredist_missing");
    },
  );

  it("reports a missing binary, and the engine steps aside so selection falls through", async () => {
    const { proc } = server({ command: [join(tmpdir(), "no-such-whisper-server.exe")] });
    const b = backend(proc);
    expect(await b.available()).toBe(true);
    await expect(proc.start()).rejects.toMatchObject({ details: { reason: "not_installed" } });
    expect(proc.usable).toBe(false);
    expect(await b.available()).toBe(false);
    proc.reset();
    expect(await b.available()).toBe(true);
  });

  it("stops a server an earlier Gateway left running (pid file)", async () => {
    const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const exited = new Promise((r) => orphan.once("exit", r));
    const seen: number[] = [];
    const { proc, workDir } = server({
      isStaleServer: async (pid) => {
        seen.push(pid);
        return pid === orphan.pid;
      },
    });
    writeFileSync(join(workDir, "whisper-server.pid"), `${orphan.pid}\n`);
    await proc.start();
    await exited;
    expect(seen).toEqual([orphan.pid]);
  });

  it("does not start the server for the availability probe", async () => {
    const { proc } = server();
    let ready = false;
    const b = new ManagedWhisperServerBackend({ process: proc, ready: async () => ready });
    expect(await b.available()).toBe(false);
    await b.warm();
    expect(proc.state).toBe("stopped");
    ready = true;
    expect(await b.available()).toBe(true);
    expect(proc.state).toBe("stopped");
    await b.warm();
    expect(proc.state).toBe("running");
  });
});
