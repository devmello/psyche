import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecResult } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExecProvider } from "../src/capabilities/exec.ts";
import { GuestRunner } from "../src/capabilities/guest-runner.ts";
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
