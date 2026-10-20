import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentToolRegistry, type ToolRunContext } from "@psyche/agent-core";
import { fileTools } from "@psyche/files";
import { FakeSandboxRunner } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeCoding, hostGit } from "../src/compose/coding.ts";
import type { ComposeServices } from "../src/compose/services.ts";

/** The coding helper's part (V10): the P9 file tools' executors, the sandbox runner, host git. */

let dir: string;
let repo: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-compose-coding-")));
  repo = join(dir, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repo });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function services(withFiles = true) {
  const registry = new AgentToolRegistry();
  const folders = [{ path: dir, mode: "rw" as const }];
  if (withFiles) for (const t of fileTools({ folders: () => folders })) registry.register(t);
  const receipts: unknown[] = [];
  const s = {
    tools: registry,
    rawBroker: { policy: { folders } },
    broker: {
      recordReceipt: async (r: unknown) => {
        receipts.push(r);
        return { id: `rcp_${receipts.length}` };
      },
    },
  } as unknown as ComposeServices;
  return { s, registry, receipts };
}

const ctx: ToolRunContext = {
  callId: "c1",
  threadId: "thr_1",
  runId: "run_1",
  taint: false,
  permissionMode: "balanced",
  mode: "attended",
  signal: new AbortController().signal,
  onUpdate: () => undefined,
};

describe("composeCoding", () => {
  it("registers code.* over the composed file tools; code.run only with a sandbox runner", async () => {
    const { s, registry } = services();
    const part = composeCoding(s, { git: hostGit() });
    const names = registry.list().map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["code.open", "code.read", "code.edit", "code.git"]),
    );
    expect(names).not.toContain("code.run");
    await part.stop?.();
    expect(registry.list().map((t) => t.name)).not.toContain("code.open");

    const withRunner = services();
    composeCoding(withRunner.s, { runner: new FakeSandboxRunner(), git: null });
    const more = withRunner.registry.list().map((t) => t.name);
    expect(more).toContain("code.run");
    expect(more).not.toContain("code.git");
  });

  it("stays off without the P9 file tools", () => {
    const { s, registry } = services(false);
    composeCoding(s);
    expect(registry.list()).toEqual([]);
  });

  it("edits through write_file with a receipt carrying the diff, and reads status with host git", async () => {
    const { s, registry, receipts } = services();
    composeCoding(s, { git: hostGit() });
    const run = (name: string, p: unknown) => registry.get(name)?.run?.(p, ctx);
    const opened = (await run("code.open", { path: repo }))?.output as {
      git: { files: unknown[] };
    };
    expect(opened.git.files).toEqual([{ status: "??", path: "a.txt" }]);
    const patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n";
    const edited = await run("code.edit", { root: repo, patch });
    expect(edited?.receiptId).toBe("rcp_1");
    expect(receipts[0]).toMatchObject({ kind: "file_write", payload: { diff: patch } });
    const read = (await run("code.read", { root: repo, path: "a.txt" }))?.output as {
      content: string;
    };
    expect(read.content).toBe("1\ttwo");
  });
});
