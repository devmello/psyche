import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FakeSandboxRunner } from "@psyche/testing";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentToolRegistration,
  type CodingFolderGrant,
  codingTools,
  defineTool,
  type GitRunner,
  type ToolRunContext,
} from "../src/index.ts";

/**
 * `code.*` never leaves the workspace through a link committed in the repository (review of
 * #1395 r3, finding 2: `up -> ..` and `code.search {path: "up/.ssh"}` returned a private key).
 * The `read_file` / `write_file` stand-ins below follow links on purpose, so every refusal here
 * comes from the coding tools themselves. Everything lives in a temporary folder: the "home" with
 * its `.ssh` is a fake one next to the repository.
 */

const run = promisify(execFile);

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

/** Link-following stand-ins: the real P9 tools refuse links too, these deliberately don't. */
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

// Split so the secret scan does not take the fixture for a key.
const KEY = `${["-----BEGIN ", "OPENSSH PRIVATE KEY-----"].join("")}\nAAAAKEYMATERIAL\n`;
const SECRET = "TOPSECRET-1395\n";

let dir: string;
let repo: string;
let home: string;
let outside: string;

async function sh(cwd: string, ...args: string[]) {
  return (await run("git", args, { cwd })).stdout.trim();
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-coding-links-")));
  repo = join(dir, "repo");
  home = join(dir, "home");
  outside = join(dir, "Documents");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/add.js"), "export const add = (a, b) => a + b;\n");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh/id_test"), KEY);
  // The reviewer's layout: the private key in a `.ssh` right next to the repository.
  mkdirSync(join(dir, ".ssh"));
  writeFileSync(join(dir, ".ssh/id_test"), KEY);
  mkdirSync(join(outside, "b/c"), { recursive: true });
  writeFileSync(join(outside, "secret.txt"), SECRET);
  writeFileSync(join(outside, "b/c/file.txt"), SECRET);
  await sh(repo, "init", "--quiet", "--initial-branch=main");
  await sh(repo, "config", "user.name", "Avery Lin");
  await sh(repo, "config", "user.email", "owner@example.com");
  await sh(repo, "config", "commit.gpgsign", "false");
  await sh(repo, "add", ".");
  await sh(repo, "commit", "--quiet", "-m", "initial");
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

/** The grant is the repository alone: everything else in `dir` is outside it. */
async function setup(
  folders: CodingFolderGrant[] = [{ path: repo, mode: "rw" }],
  git: GitRunner = hostGit,
) {
  const writes: string[] = [];
  const runner = new FakeSandboxRunner();
  const tools = codingTools({
    files: fileTools(writes),
    folders: () => folders,
    runner,
    git,
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
  return { use, runner, writes, open: () => use("code.open", { path: repo }) };
}

const forbidden = { code: "forbidden" };

/** Whatever came back (a result or an error) never carries the outside content. */
async function noLeak(p: Promise<unknown>): Promise<void> {
  const out = await p.then(
    (r) => JSON.stringify(r),
    (e) => String((e as Error).message),
  );
  expect(out).not.toContain("OPENSSH");
  expect(out).not.toContain("TOPSECRET");
}

describe("code.* and links in the repository", () => {
  it("the reviewer's probe: `up -> ..` never reaches the .ssh next to the repo", async () => {
    const { use, open } = await setup();
    symlinkSync("..", join(repo, "up"));
    symlinkSync("../Documents", join(repo, "leak"));
    await open();
    await expect(
      use("code.search", { root: repo, path: "up/.ssh", pattern: "." }),
    ).rejects.toMatchObject(forbidden);
    await noLeak(use("code.search", { root: repo, path: "up/.ssh", pattern: "." }));
    await expect(
      use("code.search", { root: repo, path: "leak", pattern: "TOPSECRET" }),
    ).rejects.toMatchObject(forbidden);
    await expect(use("code.read", { root: repo, path: "leak/secret.txt" })).rejects.toMatchObject(
      forbidden,
    );
    await expect(use("code.read", { root: repo, path: "up/.ssh/id_test" })).rejects.toMatchObject(
      forbidden,
    );
    // The whole repository: the links are skipped, the real files are searched.
    const all = await use("code.search", { root: repo, pattern: "." });
    expect(all.output.hits).toEqual(["src/add.js:1:export const add = (a, b) => a + b;"]);
  });

  it("a linked file that points outside is never read, searched or written", async () => {
    const { use, open, writes } = await setup();
    symlinkSync("../Documents/secret.txt", join(repo, "notes.txt"));
    await open();
    await expect(use("code.read", { root: repo, path: "notes.txt" })).rejects.toMatchObject(
      forbidden,
    );
    await noLeak(use("code.search", { root: repo, pattern: "TOPSECRET" }));
    expect((await use("code.search", { root: repo, pattern: "TOPSECRET" })).output.hits).toEqual(
      [],
    );
    await expect(
      use("code.search", { root: repo, path: "notes.txt", pattern: "." }),
    ).rejects.toMatchObject(forbidden);
    const patch = "--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-TOPSECRET-1395\n+pwned\n";
    await expect(use("code.edit", { root: repo, patch })).rejects.toMatchObject(forbidden);
    expect(writes).toEqual([]);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe(SECRET);
  });

  it("an absolute link to ~/.ssh is refused as a path and skipped by the walk", async () => {
    const { use, open } = await setup();
    symlinkSync(join(home, ".ssh"), join(repo, "keys"));
    await open();
    await expect(
      use("code.search", { root: repo, path: "keys", pattern: "." }),
    ).rejects.toMatchObject(forbidden);
    await expect(use("code.read", { root: repo, path: "keys/id_test" })).rejects.toMatchObject(
      forbidden,
    );
    await noLeak(use("code.search", { root: repo, pattern: "PRIVATE KEY" }));
    // An absolute path under the root that goes through the link is the same refusal.
    await expect(
      use("code.read", { root: repo, path: join(repo, "keys/id_test") }),
    ).rejects.toMatchObject(forbidden);
  });

  it("a link to a folder inside the repository: refused as a path, skipped by the walk", async () => {
    // Chosen rule: paths are used by their real name, like read_file and code.open; a walk never
    // follows a link, so `lib -> src` is not searched twice.
    const { use, open } = await setup();
    symlinkSync("src", join(repo, "lib"));
    await open();
    const all = await use("code.search", { root: repo, pattern: "add" });
    expect(all.output.hits).toEqual(["src/add.js:1:export const add = (a, b) => a + b;"]);
    await expect(use("code.search", { root: repo, path: "lib", pattern: "add" })).rejects.toThrow(
      /goes through a symlink; use the real path/,
    );
    await expect(use("code.read", { root: repo, path: "lib/add.js" })).rejects.toMatchObject(
      forbidden,
    );
    // The real path works.
    expect((await use("code.read", { root: repo, path: "src/add.js" })).output.totalLines).toBe(1);
    expect(
      (await use("code.search", { root: repo, path: "src", pattern: "add" })).output.hits,
    ).toHaveLength(1);
  });

  it("a link in a parent component is refused by search, read, edit, run and git", async () => {
    const { use, open, runner, writes } = await setup();
    symlinkSync("../Documents", join(repo, "a"));
    await open();
    await expect(
      use("code.search", { root: repo, path: "a/b/c", pattern: "." }),
    ).rejects.toMatchObject(forbidden);
    await expect(use("code.read", { root: repo, path: "a/b/c/file.txt" })).rejects.toMatchObject(
      forbidden,
    );
    // Creating a file under the link would write outside the repository.
    const create = "--- /dev/null\n+++ b/a/b/new.txt\n@@ -0,0 +1 @@\n+planted\n";
    await expect(use("code.edit", { root: repo, patch: create })).rejects.toMatchObject(forbidden);
    expect(writes).toEqual([]);
    expect(() => readFileSync(join(outside, "b/new.txt"))).toThrow();
    await expect(use("code.run", { root: repo, argv: ["ls"], cwd: "a/b" })).rejects.toMatchObject(
      forbidden,
    );
    expect(runner.execs).toHaveLength(0);
    await expect(
      use("code.git", { root: repo, op: "diff", paths: ["a/b/c/file.txt"] }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      use("code.git", { root: repo, op: "commit", message: "x", paths: ["a/b/c/file.txt"] }),
    ).rejects.toMatchObject(forbidden);
  });

  it("`..` traversal stays refused", async () => {
    const { use, open } = await setup();
    await open();
    for (const path of ["../Documents", "src/../../Documents", "../.ssh"]) {
      await expect(
        use("code.search", { root: repo, path, pattern: "." }),
        path,
      ).rejects.toMatchObject(forbidden);
    }
    for (const path of ["../Documents/secret.txt", "src/../../.ssh/id_test"]) {
      await expect(use("code.read", { root: repo, path }), path).rejects.toMatchObject(forbidden);
    }
    await expect(
      use("code.run", { root: repo, argv: ["ls"], cwd: "../home" }),
    ).rejects.toMatchObject(forbidden);
  });

  it("git still commits a link as a link (only the last part may be one)", async () => {
    const { use, open } = await setup();
    symlinkSync("src/add.js", join(repo, "alias.js"));
    await open();
    const c = await use("code.git", {
      root: repo,
      op: "commit",
      message: "Alias",
      paths: ["alias.js"],
    });
    expect(c.output.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await sh(repo, "show", "--name-only", "--format=", "HEAD")).toBe("alias.js");
    const d = await use("code.git", { root: repo, op: "diff", paths: ["alias.js", "src"] });
    expect(d.output.diff).toBe("");
  });

  it("code.run never mounts a `.git` that is a link", async () => {
    // A folder without git: a run could plant `.git -> ~/.ssh` in the working tree, and the next
    // run would bind-mount what it points at, resolved on the host.
    const plain = join(dir, "plain");
    mkdirSync(plain);
    const { use, runner } = await setup([{ path: plain, mode: "rw" }]);
    await use("code.open", { path: plain });
    symlinkSync(join(home, ".ssh"), join(plain, ".git"));
    await expect(use("code.run", { root: plain, argv: ["ls"] })).rejects.toThrow(
      /\.git is a symlink/,
    );
    expect(runner.execs).toHaveLength(0);
  });

  it("a root swapped for a link after code.open is refused before any walk or read", async () => {
    const { use, open } = await setup([{ path: dir, mode: "rw" }]);
    await open();
    renameSync(repo, join(dir, "repo-moved"));
    symlinkSync(home, repo);
    await expect(use("code.search", { root: repo, pattern: "." })).rejects.toMatchObject(forbidden);
    await expect(use("code.read", { root: repo, path: ".ssh/id_test" })).rejects.toMatchObject(
      forbidden,
    );
  });
});

/** Another repository next to the workspace, with history and a file the workspace must not see. */
async function otherRepo(): Promise<string> {
  const other = join(dir, "other");
  mkdirSync(join(other, "sub"), { recursive: true });
  writeFileSync(join(other, "private.txt"), SECRET);
  writeFileSync(join(other, "sub", "a.txt"), "inside\n");
  await sh(other, "init", "--quiet", "--initial-branch=main");
  await sh(other, "config", "user.name", "X");
  await sh(other, "config", "user.email", "x@example.com");
  await sh(other, "config", "commit.gpgsign", "false");
  await sh(other, "add", ".");
  await sh(other, "commit", "--quiet", "-m", "private history TOPSECRET-LOG");
  return other;
}

const NOT_OWN = /git works only in a workspace that is its own repository root/;

describe("code.git uses only the workspace's own repository (review of #1425 r1)", () => {
  /** Every read op refused with nothing of the other repository in the answer. */
  async function refusesEveryOp(use: Awaited<ReturnType<typeof setup>>["use"], root: string) {
    for (const params of [
      { root, op: "status" },
      { root, op: "log" },
      { root, op: "diff" },
      { root, op: "diff", staged: true },
      { root, op: "commit", message: "x" },
      { root, op: "branch", name: "evil", create: true },
    ]) {
      await expect(use("code.git", params), JSON.stringify(params)).rejects.toThrow(NOT_OWN);
      await noLeak(use("code.git", params));
    }
  }

  it("P2: a `.git` link to another repository", async () => {
    const other = await otherRepo();
    const plain = join(dir, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "x.txt"), "x\n");
    symlinkSync(join(other, ".git"), join(plain, ".git"));
    const { use } = await setup([{ path: plain, mode: "rw" }]);
    const opened = await use("code.open", { path: plain });
    expect(opened.output.git).toEqual({ error: expect.stringMatching(NOT_OWN) });
    expect(JSON.stringify(opened.output)).not.toContain("private.txt");
    await refusesEveryOp(use, plain);
    expect(await sh(other, "branch", "--list", "evil")).toBe("");
  });

  it("P3: a `gitdir:` file naming another repository (no link at all)", async () => {
    const other = await otherRepo();
    const plain = join(dir, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, ".git"), `gitdir: ${join(other, ".git")}\n`);
    const { use } = await setup([{ path: plain, mode: "rw" }]);
    const opened = await use("code.open", { path: plain });
    expect(opened.output.git).toEqual({ error: expect.stringMatching(NOT_OWN) });
    await refusesEveryOp(use, plain);
  });

  it("P4: a workspace that is a subfolder of a repository gets no code.git", async () => {
    const other = await otherRepo();
    writeFileSync(join(other, "private.txt"), `${SECRET}changed-OUTSIDE-WORKSPACE\n`);
    const before = await sh(other, "rev-parse", "HEAD");
    const sub = join(other, "sub");
    const { use } = await setup([{ path: sub, mode: "rw" }]);
    expect((await use("code.open", { path: sub })).output.git).toBeNull();
    await refusesEveryOp(use, sub);
    // Nothing was committed or staged in the repository around it.
    expect(await sh(other, "rev-parse", "HEAD")).toBe(before);
    expect(await sh(other, "diff", "--cached", "--name-only")).toBe("");
  });

  it("a `.git` planted after code.open (by a run in a folder without git) is refused", async () => {
    const other = await otherRepo();
    const plain = join(dir, "plain");
    mkdirSync(plain);
    const { use, runner } = await setup([{ path: plain, mode: "rw" }]);
    await use("code.open", { path: plain });
    await use("code.run", { root: plain, argv: ["true"] });
    // What that run could leave in the read-write working tree: a `gitdir:` file, or a link.
    expect(runner.execs).toHaveLength(1);
    writeFileSync(join(plain, ".git"), `gitdir: ${join(other, ".git")}\n`);
    await refusesEveryOp(use, plain);
    rmSync(join(plain, ".git"));
    symlinkSync(join(other, ".git"), join(plain, ".git"));
    await refusesEveryOp(use, plain);
  });

  it("pins every git call to the root's own .git and work tree", async () => {
    const calls: string[][] = [];
    const recording: GitRunner = {
      run: (cwd, args, o) => {
        calls.push([cwd, ...args]);
        return hostGit.run(cwd, args, o);
      },
    };
    const { use } = await setup(undefined, recording);
    await use("code.open", { path: repo });
    await use("code.git", { root: repo, op: "log" });
    await use("code.git", { root: repo, op: "diff", paths: ["src"] });
    expect(calls.length).toBeGreaterThan(4);
    for (const c of calls) {
      expect(c[0]).toBe(repo);
      expect(c).toContain(`--git-dir=${join(repo, ".git")}`);
      expect(c).toContain(`--work-tree=${repo}`);
    }
  });
});

describe("files that are not one regular file (review of #1425 r1)", () => {
  it("a hard link to a file outside is neither searched nor read", async () => {
    linkSync(join(dir, ".ssh/id_test"), join(repo, "hl.txt"));
    const { use, open } = await setup();
    await open();
    await noLeak(use("code.search", { root: repo, pattern: "OPENSSH" }));
    expect((await use("code.search", { root: repo, pattern: "OPENSSH" })).output.hits).toEqual([]);
    await expect(use("code.read", { root: repo, path: "hl.txt" })).rejects.toThrow(
      /has other hard links/,
    );
    await noLeak(use("code.read", { root: repo, path: "hl.txt" }));
    // Control: the file with one name still reads.
    expect((await use("code.read", { root: repo, path: "src/add.js" })).output.totalLines).toBe(1);
  });

  it("a FIFO is refused at once, never opened and waited on", async () => {
    execFileSync("mkfifo", [join(repo, "pipe")]);
    const { use, open } = await setup();
    await open();
    await expect(use("code.read", { root: repo, path: "pipe" })).rejects.toMatchObject({
      code: "invalid_params",
    });
    const hits = await use("code.search", { root: repo, pattern: "add" });
    expect(hits.output.hits).toEqual(["src/add.js:1:export const add = (a, b) => a + b;"]);
  });
});
