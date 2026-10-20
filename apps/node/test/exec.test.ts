import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SandboxRunner } from "@psyche/protocol";
import { FakeSandboxRunner } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExecProvider, type HostExecResult } from "../src/capabilities/exec.ts";
import type { CapabilityOutcome, CapabilityProvider } from "../src/capabilities/types.ts";
import { createInvocationContext } from "../src/invocation.ts";

let base: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "psyche-exec-")));
  fs.mkdirSync(path.join(base, "work"));
  fs.mkdirSync(path.join(base, "elsewhere"));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

async function call(
  p: CapabilityProvider,
  name: string,
  params: unknown,
  init: { approvalId?: string; signal?: AbortSignal } = {},
) {
  const events: unknown[] = [];
  const entry = (await p.entries()).find((e) => e.manifest.name === name);
  if (!entry) throw new Error(`no ${name}`);
  const ctx = createInvocationContext({
    invocationId: "inv_1",
    capability: name,
    emit: (d) => events.push(d),
    ...init,
  });
  const out = await entry.handler(params, ctx);
  return { out, events };
}

function errorOf(out: CapabilityOutcome) {
  if (out.ok) throw new Error("expected failure");
  return out.error;
}

describe("exec (sandbox)", () => {
  it("runs through the runner with events and a receipt without output", async () => {
    const runner = new FakeSandboxRunner().script(["make"], {
      stdout: "built ok\n",
      stderr: "warning: x\n",
      filesChanged: ["out.bin"],
    });
    const p = createExecProvider({ runner });
    const names = (await p.entries()).map((e) => e.manifest.name);
    expect(names).toEqual(["exec"]);
    expect(await p.status?.()).toEqual({ sandbox: ["fake"], hostExec: false });

    const { out, events } = await call(p, "exec", {
      argv: ["make", "all"],
      env: { TOKEN: "s3cr3t-value" },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result).toMatchObject({ exitCode: 0, stdout: "built ok\n", stderr: "warning: x\n" });
    const sandboxId = runner.execs[0]?.sandboxId;
    expect(runner.execs[0]).toMatchObject({ argv: ["make", "all"], cwd: "/workspace" });
    expect(events).toEqual([
      { phase: "started", sandboxId },
      { phase: "exited", exitCode: 0 },
    ]);
    expect(out.receipt?.kind).toBe("exec");
    expect(out.receipt?.outcome).toBe("ok");
    expect(out.receipt?.payload).toMatchObject({
      argv: ["make", "all"],
      cwd: "/workspace",
      exitCode: 0,
      filesChanged: ["out.bin"],
      sandboxId,
      timedOut: false,
      truncated: false,
    });
    const text = JSON.stringify(out.receipt);
    expect(text).not.toContain("built ok");
    expect(text).not.toContain("warning");
    expect(text).not.toContain("s3cr3t");
  });

  it("is not offered without a backend or runner, and never falls back to the host", async () => {
    const none = createExecProvider({ runner: new FakeSandboxRunner({ backend: null }) });
    expect(await none.entries()).toEqual([]);
    expect(await none.status?.()).toEqual({ sandbox: "none", hostExec: false });
    expect(await createExecProvider({}).entries()).toEqual([]);
    const broken = {
      backends: async () => {
        throw new Error("boom");
      },
    } as unknown as SandboxRunner;
    expect(await createExecProvider({ runner: broken }).entries()).toEqual([]);
  });

  it("maps runner rejections to their error payloads", async () => {
    const runner = new FakeSandboxRunner();
    const p = createExecProvider({ runner });
    // A runner whose backend vanished after the manifest was declared.
    const noBackend = new FakeSandboxRunner({ backend: null });
    const gone: SandboxRunner = {
      backends: async () => ["fake"],
      ensureSandbox: (scope) => noBackend.ensureSandbox(scope),
      exec: (req) => noBackend.exec(req),
      destroy: (id) => noBackend.destroy(id),
    };
    const { out } = await call(createExecProvider({ runner: gone }), "exec", {
      argv: ["echo", "hi"],
    });
    expect(errorOf(out).code).toBe("unavailable");

    const ac = new AbortController();
    ac.abort();
    const cancelled = await call(p, "exec", { argv: ["echo", "hi"] }, { signal: ac.signal });
    expect(errorOf(cancelled.out).code).toBe("cancelled");
    expect(cancelled.out.receipt).toMatchObject({ kind: "exec", outcome: "failed" });

    expect(errorOf((await call(p, "exec", { argv: [] })).out).code).toBe("invalid_params");
    expect(errorOf((await call(p, "exec", { argv: ["x"], cwd: "rel" })).out).code).toBe(
      "invalid_params",
    );
  });
});

describe("exec.host", () => {
  function hostProvider(timeoutMsMax?: number) {
    return createExecProvider({
      hostExec: {
        enabled: true,
        allowedCwdRoots: [path.join(base, "work")],
        ...(timeoutMsMax === undefined ? {} : { timeoutMsMax }),
      },
    });
  }

  it("is not offered by default", async () => {
    expect(await createExecProvider({}).entries()).toEqual([]);
    expect(
      await createExecProvider({ hostExec: { enabled: false, allowedCwdRoots: [base] } }).entries(),
    ).toEqual([]);
    const p = hostProvider();
    const entries = await p.entries();
    expect(entries.map((e) => e.manifest)).toMatchObject([
      { name: "exec.host", sideEffect: "destructive", targetKind: "command", streaming: true },
    ]);
    expect(await p.status?.()).toEqual({ sandbox: "none", hostExec: true });
  });

  it("refuses without an approval", async () => {
    const marker = path.join(base, "work", "ran");
    const { out } = await call(hostProvider(), "exec.host", {
      argv: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`],
      cwd: path.join(base, "work"),
    });
    const err = errorOf(out);
    expect(err.code).toBe("approval_required");
    expect(err.details).toEqual({ reason: "host_exec_always_asks" });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("refuses a cwd outside the allowed roots, including via symlink", async () => {
    fs.symlinkSync(path.join(base, "elsewhere"), path.join(base, "work", "link"));
    const p = hostProvider();
    for (const cwd of [
      path.join(base, "elsewhere"),
      path.join(base, "work", "link"),
      `${path.join(base, "work")}/..`,
    ]) {
      const { out } = await call(p, "exec.host", { argv: ["true"], cwd }, { approvalId: "apr_1" });
      const err = errorOf(out);
      expect(err.code).toBe("forbidden");
      expect(err.details).toEqual({ reason: "outside_roots" });
    }
  });

  it("runs without a shell, streams stdout events and returns a receipt without output", async () => {
    const cwd = path.join(base, "work");
    const { out, events } = await call(
      hostProvider(),
      "exec.host",
      {
        argv: [
          process.execPath,
          "-e",
          'process.stdout.write("hello " + process.env.GREETING); process.stderr.write("oops"); process.exit(3)',
        ],
        cwd,
        env: { GREETING: "world" },
      },
      { approvalId: "apr_1" },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const r = out.result as HostExecResult;
    expect(r).toMatchObject({
      exitCode: 3,
      signal: null,
      stdout: "hello world",
      stderr: "oops",
      truncated: false,
      timedOut: false,
    });
    const streamed = events
      .filter(
        (e): e is { stream: string; text: string } =>
          (e as { stream?: string }).stream === "stdout",
      )
      .map((e) => e.text)
      .join("");
    expect(streamed).toBe("hello world");
    expect(out.receipt).toMatchObject({
      kind: "exec_host",
      outcome: "failed",
      approvalId: "apr_1",
      payload: { argv: expect.any(Array), cwd, exitCode: 3, timedOut: false, truncated: false },
    });
    const text = JSON.stringify(out.receipt);
    // Neither the output nor the env value ("world") reaches the receipt.
    expect(text).not.toContain("hello world");
    expect(text).not.toContain("world");
  });

  it("maps a missing executable to not_found", async () => {
    const { out } = await call(
      hostProvider(),
      "exec.host",
      { argv: ["definitely-not-a-command-psyche"], cwd: path.join(base, "work") },
      { approvalId: "apr_1" },
    );
    expect(errorOf(out).code).toBe("not_found");
    expect(out.receipt).toMatchObject({ kind: "exec_host", outcome: "failed" });
  });

  it("kills a command that outlives its timeout", async () => {
    const { out } = await call(
      hostProvider(),
      "exec.host",
      {
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        cwd: path.join(base, "work"),
        timeoutMs: 200,
      },
      { approvalId: "apr_1" },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result).toMatchObject({ exitCode: null, signal: "SIGTERM", timedOut: true });
    expect(out.receipt).toMatchObject({ outcome: "uncertain", payload: { timedOut: true } });
  });

  it("rejects a timeout above the configured max", async () => {
    const { out } = await call(
      hostProvider(1000),
      "exec.host",
      { argv: ["true"], cwd: path.join(base, "work"), timeoutMs: 5000 },
      { approvalId: "apr_1" },
    );
    expect(errorOf(out).code).toBe("invalid_params");
  });
});
