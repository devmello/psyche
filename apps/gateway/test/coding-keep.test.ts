import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingSandboxes } from "@psyche/agent-core";
import type { SandboxScope } from "@psyche/protocol";
import { FakeSandboxRunner } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { stopRepositorySandboxes } from "../src/compose/coding.ts";

/** #1438 review r1, item 3: "Keep it" stops the repository's sandboxes first, best-effort. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("stopping a repository's sandboxes before Keep it", () => {
  it("stops each one, and keeps a failed one listed for the next Keep it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-keep-"));
    dirs.push(dir);
    const file = join(dir, "sandboxes.json");
    const runner = new FakeSandboxRunner();
    const a = await runner.ensureSandbox({ kind: "project", id: "cw_a" });
    const b = await runner.ensureSandbox({ kind: "project", id: "cw_b" });
    const sandboxes = new CodingSandboxes(file);
    sandboxes.track("/r", { sandboxId: a.id, scope: a.scope });
    sandboxes.track("/r", { sandboxId: b.id, scope: b.scope });
    const logged: unknown[] = [];
    const logger = { log: (...args: unknown[]) => logged.push(args) };
    const fails = new Set(["cw_b"]);
    const destroyScope = runner.destroyScope.bind(runner);
    runner.destroyScope = async (scope: SandboxScope) => {
      if (fails.has(scope.id)) throw new Error("the runtime is not answering");
      await destroyScope(scope);
    };

    await stopRepositorySandboxes(sandboxes, runner, "/r", logger as never);
    expect(runner.sandboxes().map((s) => s.scope.id)).toEqual(["cw_b"]);
    expect(new CodingSandboxes(file).list("/r").map((s) => s.scope.id)).toEqual(["cw_b"]);
    expect(logged).toHaveLength(1);

    fails.clear();
    await stopRepositorySandboxes(sandboxes, runner, "/r", logger as never);
    expect(runner.sandboxes()).toEqual([]);
    expect(new CodingSandboxes(file).list("/r")).toEqual([]);
  });

  it("does nothing without a runner", async () => {
    const sandboxes = new CodingSandboxes();
    sandboxes.track("/r", { sandboxId: "sbx_1", scope: { kind: "project", id: "cw_1" } });
    await stopRepositorySandboxes(sandboxes, undefined, "/r");
    expect(sandboxes.list("/r")).toHaveLength(1);
  });
});
