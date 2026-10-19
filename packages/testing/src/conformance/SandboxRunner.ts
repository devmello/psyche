import type { SandboxRunner } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  type ConformanceContext,
  type ConformanceFactory,
  expectPsycheError,
  newContext,
} from "./harness.ts";

export interface SandboxRunnerConformanceContext extends ConformanceContext {
  /** `false`: build a runner on a host with no container backend (it must not fall back). */
  backendAvailable: boolean;
}

/** Architecture §9, security §5.4: containers only, argv arrays, no host fallback. */
export function describeSandboxRunnerConformance(
  name: string,
  factory: ConformanceFactory<SandboxRunner, SandboxRunnerConformanceContext>,
): void {
  const make = (backendAvailable: boolean) => factory({ ...newContext(), backendAvailable });
  const scope = { kind: "task" as const, id: "task_conf_sandbox" };

  describe(`SandboxRunner conformance: ${name}`, () => {
    it("has no host fallback when no backend exists", async () => {
      const runner = await make(false);
      expect(await runner.backends()).toEqual([]);
      await expectPsycheError(runner.ensureSandbox(scope), "unavailable");
      await expectPsycheError(
        runner.exec({
          sandboxId: "sbx_none",
          argv: ["echo", "hi"],
          cwd: "/workspace",
          timeoutMs: 5_000,
        }),
      );
    });

    it("ensureSandbox is idempotent per scope and defaults to network none", async () => {
      const runner = await make(true);
      const a = await runner.ensureSandbox(scope);
      const b = await runner.ensureSandbox(scope);
      expect(b.id).toBe(a.id);
      expect(a.network).toBe("none");
      expect(a.workspacePath).toBe("/workspace");
      expect(a.status).toBe("ready");
      const other = await runner.ensureSandbox({ kind: "task", id: "task_other" });
      expect(other.id).not.toBe(a.id);
    });

    it("runs argv arrays and reports a receipt-shaped result", async () => {
      const runner = await make(true);
      const sbx = await runner.ensureSandbox(scope);
      const r = await runner.exec({
        sandboxId: sbx.id,
        argv: ["echo", "hello"],
        cwd: "/workspace",
        timeoutMs: 10_000,
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("hello\n");
      expect(r.outcome).toBe("ok");
      expect(r.truncated).toBe(false);
      expect(r.timedOut).toBe(false);
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(r.filesChanged)).toBe(true);
    });

    it("does not interpret argv as a shell string", async () => {
      const runner = await make(true);
      const sbx = await runner.ensureSandbox(scope);
      const r = await runner.exec({
        sandboxId: sbx.id,
        argv: ["echo", "$HOME; rm -rf /"],
        cwd: "/workspace",
        timeoutMs: 10_000,
      });
      expect(r.stdout).toBe("$HOME; rm -rf /\n");
    });

    it("resolves non-zero exits as failed", async () => {
      const runner = await make(true);
      const sbx = await runner.ensureSandbox(scope);
      const r = await runner.exec({
        sandboxId: sbx.id,
        argv: ["false"],
        cwd: "/workspace",
        timeoutMs: 10_000,
      });
      expect(r.exitCode).not.toBe(0);
      expect(r.outcome).toBe("failed");
    });

    it("rejects empty argv, unknown sandboxes and pre-aborted calls", async () => {
      const runner = await make(true);
      const sbx = await runner.ensureSandbox(scope);
      await expectPsycheError(
        runner.exec({ sandboxId: sbx.id, argv: [], cwd: "/workspace", timeoutMs: 1_000 }),
        "invalid_params",
      );
      await expectPsycheError(
        runner.exec({
          sandboxId: "sbx_missing",
          argv: ["true"],
          cwd: "/workspace",
          timeoutMs: 1_000,
        }),
        "not_found",
      );
      const ac = new AbortController();
      ac.abort();
      await expectPsycheError(
        runner.exec({
          sandboxId: sbx.id,
          argv: ["true"],
          cwd: "/workspace",
          timeoutMs: 1_000,
          signal: ac.signal,
        }),
        "cancelled",
      );
    });
  });
}
