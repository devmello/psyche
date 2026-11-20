import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    // Psyche's home sits beside the repo, as on a real Mac; it is protected, the repo is not.
    home: join(dir, ".psyche"),
    rawBroker: {
      policy: { folders },
      grantedFolders: () => folders,
      freshGrantedFolders: async () => folders,
    },
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

describe("hostGit", () => {
  it("never discovers a repository above the folder it runs in (review of #1425 r1)", async () => {
    const sub = join(repo, "sub");
    mkdirSync(sub);
    const git = hostGit();
    expect((await git.run(repo, ["rev-parse", "--show-toplevel"])).exitCode).toBe(0);
    const inSub = await git.run(sub, ["rev-parse", "--show-toplevel"]);
    expect(inSub.exitCode).not.toBe(0);
    expect(inSub.stdout).not.toContain(repo);
  });
});

describe("hostGit per-command env", () => {
  it("takes only allowlisted variables and refuses anything else before running git", async () => {
    const git = hostGit();
    const ok = await git.run(repo, ["rev-parse", "--git-dir"], { env: { GIT_PROXY_COMMAND: "" } });
    expect(ok.exitCode).toBe(0);
    for (const key of [
      "PATH",
      "GIT_TERMINAL_PROMPT",
      "LC_ALL",
      "GIT_CEILING_DIRECTORIES",
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_EXEC_PATH",
      "GIT_DIR",
      "GIT_SSH_COMMAND",
      "DYLD_INSERT_LIBRARIES",
      "LD_PRELOAD",
      "git_proxy_command",
    ]) {
      await expect(
        git.run(repo, ["rev-parse", "--git-dir"], { env: { GIT_PROXY_COMMAND: "", [key]: "x" } }),
        key,
      ).rejects.toThrow(new RegExp(`may not be given ${key}`));
    }
  });
});

describe("hostGit push and core.gitProxy (review of #1425 r3)", () => {
  it("a git:// push never runs a proxy command, not even the owner's global one", async () => {
    const mark = join(dir, "PROXY_RAN");
    const proxy = join(dir, "proxy.sh");
    writeFileSync(proxy, `#!/bin/sh\ntouch "${mark}"\nexit 1\n`, { mode: 0o755 });
    const globalCfg = join(dir, "global.gitconfig");
    writeFileSync(globalCfg, `[core]\n\tgitProxy = ${proxy} for example.invalid\n`);
    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalCfg;
    try {
      const url = "git://example.invalid/x.git";
      const id = ["-c", "user.name=Avery Lin", "-c", "user.email=owner@example.com"];
      execFileSync("git", [...id, "commit", "--quiet", "--allow-empty", "-m", "one"], {
        cwd: repo,
      });
      execFileSync("git", ["remote", "add", "origin", url], { cwd: repo });
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
      // Control: plain git with this global config does run the proxy command.
      await hostGit().run(repo, ["push", "--porcelain", "origin", `${head}:refs/heads/main`]);
      expect(existsSync(mark)).toBe(true);
      rmSync(mark);
      const { s, registry } = services();
      composeCoding(s, { git: hostGit() });
      const run = (name: string, p: unknown) => registry.get(name)?.run?.(p, ctx);
      await run("code.open", { path: repo });
      const pushed = await run("code.git", {
        root: repo,
        op: "push",
        remote: "origin",
        remote_url: url,
        branch: "main",
        commit: head,
      });
      // `example.invalid` never resolves: the push fails, without the proxy.
      expect(pushed?.isError).toBe(true);
      expect(existsSync(mark)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved;
    }
  });
});

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
