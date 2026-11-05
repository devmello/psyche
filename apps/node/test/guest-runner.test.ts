import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecResult } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExecProvider } from "../src/capabilities/exec.ts";
import { type GuestNetwork, GuestRunner } from "../src/capabilities/guest-runner.ts";
import { createInvocationContext } from "../src/invocation.ts";

/** VM mode's guest runner: commands run on the guest itself, one directory per scope. */

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "psyche-guest-")));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const node = (code: string) => [process.execPath, "-e", code];

describe("GuestRunner (VM mode)", () => {
  it("runs argv in the scope's /workspace with an explicit env, through the exec capability", async () => {
    const provider = createExecProvider({ runner: new GuestRunner({ root }) });
    const entry = (await provider.entries()).find((e) => e.manifest.name === "exec");
    expect(entry).toBeDefined();
    const ctx = createInvocationContext({
      invocationId: "inv_1",
      capability: "exec",
      emit: () => undefined,
    });
    const out = await entry?.handler(
      {
        argv: node("console.log(process.cwd() + ' ' + process.env.GREETING)"),
        cwd: "/workspace/app",
        env: { GREETING: "hello" },
        scope: { kind: "task", id: "task_1" },
        timeoutMs: 10_000,
      },
      ctx,
    );
    expect(out?.ok).toBe(true);
    const result = (out as { result: ExecResult }).result;
    expect(result).toMatchObject({ exitCode: 0, outcome: "ok", provenance: "untrusted" });
    expect(result.stdout.trim()).toBe(
      `${path.join(root, "task-task_1", "workspace", "app")} hello`,
    );
  });

  it("keeps scopes apart and refuses a cwd outside /workspace", async () => {
    const r = new GuestRunner({ root });
    const a = await r.ensureSandbox({ kind: "task", id: "a/../b" });
    expect(a.backend).toBe("vm");
    await expect(
      r.exec({ sandboxId: a.id, argv: node("1"), cwd: "/workspace/../../etc", timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    const fail = await r.exec({
      sandboxId: a.id,
      argv: node("process.exit(3)"),
      cwd: "/workspace",
      timeoutMs: 5_000,
    });
    expect(fail).toMatchObject({ exitCode: 3, outcome: "failed" });
    expect(fs.readdirSync(root)).toEqual(["task-a____b"]);
    expect(() => new GuestRunner({ root: "relative" })).toThrow();
  });
});

/** A guest that can isolate by prefixing a marker, or cannot and is online / offline. */
const isolating: GuestNetwork = {
  isolate: (argv) => [process.execPath, "-e", "console.log('isolated')", "--", ...argv],
  online: () => true,
};
const cannotIsolate = (online: boolean): GuestNetwork => ({
  isolate: () => null,
  online: () => online,
});

const capability = async (provider: ReturnType<typeof createExecProvider>, name: string) => {
  const entry = (await provider.entries()).find((e) => e.manifest.name === name);
  if (entry === undefined) throw new Error(`no ${name}`);
  return entry;
};
const ctxFor = (name: string, emit: (d: unknown) => void = () => undefined, signal?: AbortSignal) =>
  createInvocationContext({
    invocationId: `inv_${name}`,
    capability: name,
    emit,
    ...(signal === undefined ? {} : { signal }),
  });

describe("GuestRunner isolated runs (srt features in the sandbox PC)", () => {
  it("stages files, feeds stdin and removes an ephemeral workspace afterwards", async () => {
    const provider = createExecProvider({
      runner: new GuestRunner({ root, network: isolating }),
    });
    const exec = await capability(provider, "exec");
    expect(Object.keys(exec.manifest.inputSchema?.properties ?? {})).toEqual(
      expect.arrayContaining(["stdin", "files", "network", "ephemeral"]),
    );
    const out = await exec.handler(
      {
        argv: [process.execPath, "main.mjs"],
        files: [
          {
            path: "main.mjs",
            content:
              "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).n*2, process.cwd()))",
          },
        ],
        stdin: JSON.stringify({ n: 21 }),
        network: "allow",
        ephemeral: true,
        scope: { kind: "thread", id: "scripts" },
        timeoutMs: 10_000,
      },
      ctxFor("exec"),
    );
    expect(out.ok).toBe(true);
    const r = (out as { result: ExecResult }).result;
    const [answer, cwd] = r.stdout.trim().split(" ");
    expect(answer).toBe("42");
    expect(cwd?.startsWith(path.join(root, "thread-scripts", "runs"))).toBe(true);
    // The throwaway folder is gone; the scope's own workspace was never written.
    expect(fs.existsSync(cwd as string)).toBe(false);
    expect(fs.readdirSync(path.join(root, "thread-scripts", "workspace"))).toEqual([]);
  });

  it("runs network:none under the guest's isolation, and refuses when it cannot isolate an online guest", async () => {
    const isolated = new GuestRunner({ root, network: isolating });
    const a = await isolated.ensureSandbox({ kind: "thread", id: "n" });
    const r = await isolated.run({
      sandboxId: a.id,
      argv: [process.execPath, "-e", "console.log('raw')"],
      cwd: "/workspace",
      timeoutMs: 5_000,
      network: "none",
    });
    expect(r.stdout.trim()).toBe("isolated");

    const online = new GuestRunner({ root, network: cannotIsolate(true) });
    const b = await online.ensureSandbox({ kind: "thread", id: "n" });
    await expect(
      online.run({
        sandboxId: b.id,
        argv: [process.execPath, "-e", "1"],
        cwd: "/workspace",
        timeoutMs: 5_000,
        network: "none",
      }),
    ).rejects.toMatchObject({ code: "unavailable" });

    // An offline guest needs no isolation; `allow` is the guest's own network as is.
    const offline = new GuestRunner({ root, network: cannotIsolate(false) });
    const c = await offline.ensureSandbox({ kind: "thread", id: "n" });
    const plain = await offline.run({
      sandboxId: c.id,
      argv: [process.execPath, "-e", "console.log('raw')"],
      cwd: "/workspace",
      timeoutMs: 5_000,
      network: "none",
    });
    expect(plain.stdout.trim()).toBe("raw");
  });

  it("refuses staged paths that leave the workspace, and extras on a runner that cannot honour them", async () => {
    const r = new GuestRunner({ root, network: isolating });
    const a = await r.ensureSandbox({ kind: "thread", id: "x" });
    for (const p of ["../evil", "/etc/passwd", "a/../../b", "a\\b", ""]) {
      await expect(
        r.run({
          sandboxId: a.id,
          argv: [process.execPath, "-e", "1"],
          cwd: "/workspace",
          timeoutMs: 5_000,
          files: [{ path: p, content: "x" }],
        }),
      ).rejects.toMatchObject({ code: "invalid_params" });
    }
    // A plain SandboxRunner (a container) never gets stdin dropped on the floor.
    const plain = createExecProvider({
      runner: {
        backends: async () => ["fake"],
        ensureSandbox: async (scope) => ({
          id: "s",
          scope,
          backend: "fake",
          network: "none",
          workspacePath: "/workspace",
          status: "ready",
        }),
        exec: async () => {
          throw new Error("must not run");
        },
        destroy: async () => undefined,
      },
    });
    const names = (await plain.entries()).map((e) => e.manifest.name);
    expect(names).toEqual(["exec"]);
    const exec = await capability(plain, "exec");
    const out = await exec.handler({ argv: ["cat"], stdin: "secret" }, ctxFor("exec"));
    expect(out).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  });

  it("does not stage through a symlink a previous run left behind", async () => {
    const r = new GuestRunner({ root, network: isolating });
    const a = await r.ensureSandbox({ kind: "thread", id: "sym" });
    const ws = path.join(root, "thread-sym", "workspace");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "psyche-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "target"), "keep");
      try {
        fs.symlinkSync(path.join(outside, "target"), path.join(ws, "server.mjs"));
        fs.symlinkSync(outside, path.join(ws, "lib"), "junction");
      } catch {
        return; // no symlink privilege on this Windows account
      }
      await r.run({
        sandboxId: a.id,
        argv: [process.execPath, "-e", "1"],
        cwd: "/workspace",
        timeoutMs: 5_000,
        files: [{ path: "server.mjs", content: "new" }],
      });
      expect(fs.readFileSync(path.join(outside, "target"), "utf8")).toBe("keep");
      expect(fs.readFileSync(path.join(ws, "server.mjs"), "utf8")).toBe("new");
      await expect(
        r.run({
          sandboxId: a.id,
          argv: [process.execPath, "-e", "1"],
          cwd: "/workspace",
          timeoutMs: 5_000,
          files: [{ path: "lib/x.mjs", content: "x" }],
        }),
      ).rejects.toMatchObject({ code: "invalid_params" });
      expect(fs.existsSync(path.join(outside, "x.mjs"))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("exec.session.* (long-lived stdio in the guest)", () => {
  it("streams stdout, takes stdin writes and ends with the exit when stdin closes", async () => {
    const provider = createExecProvider({
      runner: new GuestRunner({ root, network: isolating }),
    });
    const open = await capability(provider, "exec.session.open");
    const write = await capability(provider, "exec.session.write");
    const events: Array<Record<string, string>> = [];
    let gotOutput: () => void = () => undefined;
    const output = new Promise<void>((r) => {
      gotOutput = r;
    });
    const started = new Promise<void>((resolve) => {
      const done = open.handler(
        {
          sessionId: "sess_000001",
          argv: [
            process.execPath,
            "-e",
            "process.stdin.on('data',d=>process.stdout.write(String(d).toUpperCase()));process.stdin.on('end',()=>process.exit(0))",
          ],
          scope: { kind: "task", id: "mcp:echo" },
          network: "allow",
        },
        ctxFor("exec.session.open", (d) => {
          const e = d as Record<string, string>;
          events.push(e);
          if (e.phase === "started") resolve();
          if (e.stream === "stdout") gotOutput();
        }),
      );
      (globalThis as { __done?: Promise<unknown> }).__done = done;
    });
    await started;
    const w = await write.handler(
      { sessionId: "sess_000001", data: Buffer.from("hello\n").toString("base64") },
      ctxFor("exec.session.write"),
    );
    expect(w).toMatchObject({ ok: true, result: { bytes: 6 } });
    await output;
    await write.handler({ sessionId: "sess_000001", end: true }, ctxFor("exec.session.write"));
    const end = await (globalThis as { __done?: Promise<unknown> }).__done;
    expect(end).toMatchObject({ ok: true, result: { exitCode: 0 } });
    const text = events
      .filter((e) => e.stream === "stdout")
      .map((e) => Buffer.from(e.data as string, "base64").toString("utf8"))
      .join("");
    expect(text).toBe("HELLO\n");
    // Gone once it exited.
    const late = await write.handler({ sessionId: "sess_000001", data: "" }, ctxFor("w"));
    expect(late).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("is stopped by close and by the invocation's abort; refuses bad ids and duplicates", async () => {
    const provider = createExecProvider({
      runner: new GuestRunner({ root, network: isolating }),
    });
    const open = await capability(provider, "exec.session.open");
    const close = await capability(provider, "exec.session.close");
    const forever = [process.execPath, "-e", "setInterval(()=>{},1000)"];
    const bad = await open.handler({ sessionId: "x", argv: forever }, ctxFor("o"));
    expect(bad).toMatchObject({ ok: false, error: { code: "invalid_params" } });

    let ready: () => void = () => undefined;
    const isUp = new Promise<void>((r) => {
      ready = r;
    });
    const first = open.handler(
      { sessionId: "sess_close1", argv: forever, network: "allow" },
      ctxFor("o", (d) => {
        if ((d as { phase?: string }).phase === "started") ready();
      }),
    );
    await isUp;
    const dup = await open.handler({ sessionId: "sess_close1", argv: forever }, ctxFor("o"));
    expect(dup).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await close.handler({ sessionId: "sess_close1" }, ctxFor("c"))).toMatchObject({
      ok: true,
    });
    expect(await first).toMatchObject({ ok: true });

    const abort = new AbortController();
    let up2: () => void = () => undefined;
    const isUp2 = new Promise<void>((r) => {
      up2 = r;
    });
    const second = open.handler(
      { sessionId: "sess_abort1", argv: forever, network: "allow" },
      ctxFor(
        "o",
        (d) => {
          if ((d as { phase?: string }).phase === "started") up2();
        },
        abort.signal,
      ),
    );
    await isUp2;
    abort.abort();
    const ended = (await second) as { ok: boolean; receipt?: { outcome: string } };
    expect(ended.ok).toBe(true);
    expect(ended.receipt?.outcome).toBe("uncertain");
  });

  it("fails a session whose program does not exist, and keeps sessions off the network by default", async () => {
    const provider = createExecProvider({
      runner: new GuestRunner({ root, network: cannotIsolate(true) }),
    });
    const open = await capability(provider, "exec.session.open");
    // Default network is none, and this guest cannot isolate while online: refused.
    const refused = await open.handler(
      { sessionId: "sess_net001", argv: [process.execPath, "-e", "1"] },
      ctxFor("o"),
    );
    expect(refused).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const missing = await open.handler(
      { sessionId: "sess_miss01", argv: ["psyche-no-such-program"], network: "allow" },
      ctxFor("o"),
    );
    expect(missing.ok).toBe(false);
  });
});
