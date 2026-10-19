// Real-backend tests: the OpenMuse-style smoke test on every detected backend, and the
// SandboxRunner conformance suite on the preferred one. They need a container runtime.
//   PSYCHE_SANDBOX_TESTS=0                  skip them entirely
//   PSYCHE_SANDBOX_TEST_BACKENDS=docker,…   restrict to these backends
// A missing backend is skipped with a message; a present one that fails is a test failure.
import { randomBytes } from "node:crypto";
import { describeSandboxRunnerConformance } from "@psyche/testing/conformance";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import type { ContainerBackendKind } from "../src/backends.ts";
import { nodeCliDriver, runCli } from "../src/cli.ts";
import { type DetectedBackend, detectBackends, systemDetectDeps } from "../src/detect.ts";
import { buildImage, localImageTag } from "../src/image.ts";
import { ContainerSandboxRunner } from "../src/runner.ts";
import { SMOKE_CHECKS, type SmokeContext } from "../src/smoke.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 30 * 60_000 });

const enabled = process.env.PSYCHE_SANDBOX_TESTS !== "0";
const only = (process.env.PSYCHE_SANDBOX_TEST_BACKENDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "");

async function usableBackends(): Promise<DetectedBackend[]> {
  if (!enabled) return [];
  const found = await detectBackends(systemDetectDeps());
  const usable: DetectedBackend[] = [];
  for (const b of found) {
    if (only.length > 0 && !only.includes(b.kind)) continue;
    if (b.kind === "apple-container" && !(await appleServiceUp(b.cli))) {
      console.warn(`[sandbox tests] skipping apple-container: its system service cannot start`);
      continue;
    }
    usable.push(b);
  }
  return usable;
}

async function appleServiceUp(cli: string): Promise<boolean> {
  const status = await runCli(nodeCliDriver, cli, ["system", "status"], { timeoutMs: 15_000 });
  if (status.exitCode === 0) return true;
  const start = await runCli(nodeCliDriver, cli, ["system", "start", "--disable-kernel-install"], {
    timeoutMs: 120_000,
  });
  return start.exitCode === 0;
}

const backends = await usableBackends();
if (backends.length === 0) {
  console.warn(
    enabled
      ? "[sandbox tests] no container backend (Apple container, Docker or Podman) found; real-backend tests skipped"
      : "[sandbox tests] PSYCHE_SANDBOX_TESTS=0; real-backend tests skipped",
  );
}
const prefix = `psyche-test-${randomBytes(3).toString("hex")}`;
const built = new Map<ContainerBackendKind, Promise<unknown>>();
const ensureImage = (b: DetectedBackend) => {
  let p = built.get(b.kind);
  if (!p) {
    p = buildImage(b, "core");
    built.set(b.kind, p);
  }
  return p;
};

describe.skipIf(backends.length === 0)("sandbox smoke test", () => {
  for (const backend of backends) {
    describe(backend.kind, () => {
      const maxConcurrentExecs = 2;
      const runner = new ContainerSandboxRunner({
        backend: backend.kind,
        image: localImageTag("core"),
        namePrefix: prefix,
        maxConcurrentExecs,
        idleTimeoutMs: 0,
      });
      const scope = { kind: "task" as const, id: `smoke-${backend.kind}` };
      let ctx: SmokeContext;

      beforeAll(async () => {
        await ensureImage(backend);
        const sbx = await runner.ensureSandbox(scope);
        ctx = { runner, sandboxId: sbx.id, scope, maxConcurrentExecs };
      });

      afterAll(async () => {
        await runner.deleteWorkspace(scope).catch(() => undefined);
        await runner.dispose({ remove: true });
      });

      for (const check of SMOKE_CHECKS) {
        it(check.name, async () => {
          await check.run(ctx);
        });
      }
    });
  }
});

const primary = backends[0];
if (primary) {
  const runners: ContainerSandboxRunner[] = [];
  describe(`conformance on ${primary.kind}`, () => {
    beforeAll(async () => {
      await ensureImage(primary);
    });
    afterAll(async () => {
      const cleanup = new ContainerSandboxRunner({
        backend: primary.kind,
        image: localImageTag("core"),
        namePrefix: `${prefix}-conf`,
      });
      for (const id of ["task_conf_sandbox", "task_other"]) {
        await cleanup.deleteWorkspace({ kind: "task", id }).catch(() => undefined);
      }
      await Promise.all(runners.map((r) => r.dispose({ remove: true })));
    });

    describeSandboxRunnerConformance(`ContainerSandboxRunner (${primary.kind})`, (c) => {
      const runner = new ContainerSandboxRunner({
        backend: primary.kind,
        image: localImageTag("core"),
        namePrefix: `${prefix}-conf`,
        idleTimeoutMs: 0,
        ...(c.backendAvailable ? {} : { detect: async () => [] }),
      });
      runners.push(runner);
      return runner;
    });
  });
}
