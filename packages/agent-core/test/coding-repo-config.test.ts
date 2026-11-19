import { execFile } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, ownerPins, riskyLocalGitKey } from "../src/coding/git.ts";
import {
  type AgentToolRegistration,
  codingTools,
  defineTool,
  type GitRunner,
  type ToolRunContext,
} from "../src/index.ts";

/**
 * A repository's own `.git/config` never makes `code.git` run a program on the host (review of
 * #1425: a `.git` planted by a run in a folder without git, with `core.sshCommand`,
 * `credential.helper` or `include.path`). Temporary folders only.
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

describe("riskyLocalGitKey", () => {
  // Names as git prints them: section and key lowercased, the subsection as written.
  const REFUSED = [
    "include.path",
    "includeif.gitdir:~/work/.path",
    "credential.helper",
    "credential.https://Example.com.helper",
    "credential.usehttppath",
    "core.sshcommand",
    "core.askpass",
    "core.editor",
    "core.gitproxy",
    "core.worktree",
    "core.alternaterefscommand",
    "filter.lfs.clean",
    "filter.pwn.process",
    "diff.pwn.textconv",
    "diff.pwn.command",
    "diff.external",
    "merge.ours.driver",
    "gpg.program",
    "gpg.ssh.program",
    "gpg.x509.program",
    "gpg.ssh.defaultkeycommand",
    "sequence.editor",
    "http.proxy",
    "http.https://example.com/.proxy",
    "http.proxyauthmethod",
    "url.https://evil.example/.insteadof",
    "url.git@Evil:.pushinsteadof",
    "remote.origin.uploadpack",
    "remote.origin.receivepack",
    "remote.origin.proxy",
    "remote.origin.vcs",
    "protocol.allow",
    "protocol.ext.allow",
    "uploadpack.packobjectshook",
    "alias.st",
    "alias.co",
    "pager.log",
    "difftool.x.cmd",
    "mergetool.x.cmd",
    "trailer.sign.command",
    "trailer.sign.cmd",
    "extensions.worktreeconfig",
    // Not a name git prints: refused rather than guessed at.
    "nodot",
    "trailing.",
  ];
  const ALLOWED = [
    "remote.origin.url",
    "remote.origin.fetch",
    "remote.origin.pushurl",
    "branch.main.remote",
    "branch.main.merge",
    "user.name",
    "user.email",
    "core.bare",
    "core.ignorecase",
    "core.filemode",
    "core.repositoryformatversion",
    "core.logallrefupdates",
    "core.precomposeunicode",
    "core.autocrlf",
    // Forced by GIT_HARDENING's `-c` on every call, so the repository's value never applies.
    "core.hookspath",
    "core.fsmonitor",
    "core.pager",
    "diff.renames",
    "diff.colormoved",
    "merge.ff",
    "pull.rebase",
    "gc.auto",
    "lfs.repositoryformatversion",
    "commit.gpgsign",
    "gpg.format",
    "http.sslverify",
    // Near misses: the risky word sits in a subsection, not in the key.
    "http.https://proxy.example.com/.sslverify",
    "remote.proxy.url",
    "branch.insteadof.remote",
    "remote.uploadpack.url",
    "branch.alias.merge",
    "user.alias",
  ];
  it.each(REFUSED)("refuses %s", (k) => expect(riskyLocalGitKey(k)).toBe(true));
  it.each(ALLOWED)("allows %s", (k) => expect(riskyLocalGitKey(k)).toBe(false));
});

describe("ownerPins", () => {
  it("keeps the owner's helpers and drops the repository's", () => {
    const listed = [
      "unknown",
      "credential.helper\nosxkeychain",
      "global",
      "core.sshcommand\nssh -i ~/.ssh/work",
      "local",
      "credential.helper\n!touch /tmp/pwned",
      "local",
      "core.sshcommand\ntouch /tmp/pwned",
      "command",
      "core.askpass\n/tmp/evil",
      "",
    ].join("\0");
    expect(ownerPins(listed)).toEqual([
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=osxkeychain",
      "-c",
      "core.sshCommand=ssh -i ~/.ssh/work",
      "-c",
      "core.askPass=",
    ]);
  });

  it("with nothing set: no helper, plain ssh, no askpass", () => {
    expect(ownerPins("")).toEqual([
      "-c",
      "credential.helper=",
      "-c",
      "core.sshCommand=ssh",
      "-c",
      "core.askPass=",
    ]);
  });
});

/** Plain stand-ins: these tests never read or write through the file tools. */
function fileTools() {
  const read = defineTool({
    name: "read_file",
    description: "read",
    input: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer()) }),
    sideEffect: "read",
    provenanceOut: "untrusted",
    async run(p) {
      const text = await readFile(p.path, "utf8");
      return { output: { path: p.path, text }, provenance: "untrusted" };
    },
  });
  const write = defineTool({
    name: "write_file",
    description: "write",
    input: Type.Object({ path: Type.String(), content: Type.String() }),
    sideEffect: "write",
    async run(p) {
      await writeFile(p.path, p.content);
      return { output: { path: p.path }, provenance: "trusted" };
    },
  });
  return { read, write };
}

let dir: string;
let repo: string;
const pwned = () => join(dir, "PWNED");

async function sh(cwd: string, ...args: string[]) {
  return (await run("git", args, { cwd })).stdout.trim();
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-coding-gitcfg-")));
  repo = join(dir, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  await sh(repo, "init", "--quiet", "--initial-branch=main");
  await sh(repo, "config", "user.name", "Avery Lin");
  await sh(repo, "config", "user.email", "owner@example.com");
  await sh(repo, "config", "commit.gpgsign", "false");
  await sh(repo, "config", "core.ignorecase", "true");
  await sh(repo, "config", "core.hooksPath", ".husky");
  await sh(repo, "remote", "add", "origin", "ssh://git@example.invalid/x.git");
  await sh(repo, "config", "branch.main.remote", "origin");
  await sh(repo, "add", ".");
  await sh(repo, "commit", "--quiet", "-m", "initial");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ctx(): ToolRunContext {
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
  };
}

function setup() {
  const tools = codingTools({
    files: fileTools(),
    folders: () => [{ path: repo, mode: "rw" }],
    git: hostGit,
  });
  const byName = new Map(tools.map((t) => [t.spec.name, t]));
  return async (name: string, params: unknown) => {
    const t = byName.get(name) as AgentToolRegistration;
    return (await t.run?.(params, ctx())) as { output: Record<string, unknown> };
  };
}

/** Appends to the repository's own config, as a run in the working tree could. */
const plant = (text: string) => appendFileSync(join(repo, ".git/config"), text);

describe("code.git and the repository's own config", () => {
  it("allows an ordinary repository (remote, branch, user, core basics, a husky hooks path)", async () => {
    const use = setup();
    const opened = await use("code.open", { path: repo });
    expect(opened.output.git).toMatchObject({ branch: "main" });
    expect((await use("code.git", { root: repo, op: "log" })).output.commits).toHaveLength(1);
  });

  it("a planted core.sshCommand never runs on push", async () => {
    plant(`[core]\n\tsshCommand = touch ${pwned()}\n`);
    const use = setup();
    const opened = await use("code.open", { path: repo });
    expect(opened.output.git).toEqual({ error: expect.stringMatching(/core\.sshcommand/) });
    const head = await sh(repo, "rev-parse", "HEAD");
    await expect(
      use("code.git", {
        root: repo,
        op: "push",
        remote: "origin",
        remote_url: "ssh://git@example.invalid/x.git",
        branch: "main",
        commit: head,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(() => readFileSync(pwned())).toThrow();
  });

  it.each([
    ["include.path", "[include]\n\tpath = ../evil.cfg\n"],
    ["credential.helper", '[credential]\n\thelper = "!touch /nonexistent"\n'],
    ["alias", "[alias]\n\tst = !touch /nonexistent\n"],
    ["url insteadOf", '[url "ssh://evil.example/"]\n\tinsteadOf = ssh://git@example.invalid/\n'],
    ["a filter", '[filter "x"]\n\tclean = touch /nonexistent\n'],
  ])("refuses every op when the repository sets %s", async (_label, text) => {
    plant(text);
    const use = setup();
    expect((await use("code.open", { path: repo })).output.git).toEqual({
      error: expect.stringMatching(/this repository's own \.git\/config sets/),
    });
    for (const op of ["status", "log", "diff"]) {
      await expect(use("code.git", { root: repo, op })).rejects.toThrow(
        /this repository's own \.git\/config sets/,
      );
    }
  });

  it("refuses a .git whose commondir points at another repository", async () => {
    writeFileSync(join(repo, ".git/commondir"), "../../elsewhere/.git\n");
    const use = setup();
    await use("code.open", { path: repo });
    await expect(use("code.git", { root: repo, op: "status" })).rejects.toThrow(/commondir/);
  });

  it("pins the program keys even when a config is written after the check", async () => {
    // `git` below is what every op runs after assertOwnRepository: the check is skipped here.
    plant(
      `[core]\n\tsshCommand = touch ${pwned()}\n[credential]\n\thelper = "!touch ${pwned()}"\n`,
    );
    const ssh = await git(hostGit, repo, ["config", "--get", "core.sshCommand"]);
    expect(ssh.stdout.trim()).not.toContain("touch");
    const helpers = (await git(hostGit, repo, ["config", "--get-all", "credential.helper"])).stdout
      .split("\n")
      .filter((l, i, all) => i < all.length - 1 || l !== "");
    // Git drops every helper before the last empty one: only the owner's come after it.
    const afterReset = helpers.slice(helpers.lastIndexOf("") + 1);
    expect(afterReset.join("\n")).not.toContain("touch");
    expect(() => readFileSync(pwned())).toThrow();
  });
});
