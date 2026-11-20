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
      "global",
      "gpg.program\n/opt/homebrew/bin/gpg",
      "local",
      "gpg.ssh.program\n/tmp/evil",
      "local",
      "gpg.openpgp.program\n/tmp/evil",
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
      "-c",
      "gpg.program=/opt/homebrew/bin/gpg",
      "-c",
      "gpg.openpgp.program=/opt/homebrew/bin/gpg",
      "-c",
      "gpg.x509.program=gpgsm",
      "-c",
      "gpg.ssh.program=ssh-keygen",
    ]);
  });

  it("with nothing set: no helper, plain ssh, no askpass, git's own signing programs", () => {
    expect(ownerPins("")).toEqual([
      "-c",
      "credential.helper=",
      "-c",
      "core.sshCommand=ssh",
      "-c",
      "core.askPass=",
      "-c",
      "gpg.program=gpg",
      "-c",
      "gpg.openpgp.program=gpg",
      "-c",
      "gpg.x509.program=gpgsm",
      "-c",
      "gpg.ssh.program=ssh-keygen",
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
  clean = readFileSync(join(repo, ".git/config"), "utf8");
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
/** The config as `beforeEach` left it. */
let clean = "";

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

  it("re-checks the config right before each command", async () => {
    const use = setup();
    await use("code.open", { path: repo });
    // Written after code.open checked it: the next git call refuses before running anything.
    plant(`[core]\n\tsshCommand = touch ${pwned()}\n`);
    await expect(git(hostGit, repo, ["log", "--oneline"])).rejects.toThrow(
      /this repository's own \.git\/config sets core\.sshcommand/,
    );
    await expect(use("code.git", { root: repo, op: "log" })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("pins the program keys even when the config changes between the check and the command", async () => {
    const evil = `[core]\n\tsshCommand = touch ${pwned()}\n[credential]\n\thelper = "!touch ${pwned()}"\n[gpg]\n\tprogram = touch ${pwned()}\n[gpg "ssh"]\n\tprogram = touch ${pwned()}\n[gpg "x509"]\n\tprogram = touch ${pwned()}\n`;
    /** Plants the config when the command itself starts: after every check `git` makes. */
    const racing = (marker: string): GitRunner => ({
      run: (cwd, args, o) => {
        if (args.includes(marker)) plant(evil);
        return hostGit.run(cwd, args, o);
      },
    });
    const get = async (key: string) =>
      (await git(racing("--get"), repo, ["config", "--get", key])).stdout.trim();
    for (const key of ["core.sshCommand", "gpg.program", "gpg.ssh.program", "gpg.x509.program"]) {
      writeFileSync(join(repo, ".git/config"), clean);
      expect(await get(key), key).not.toContain("touch");
    }
    writeFileSync(join(repo, ".git/config"), clean);
    const helpers = (
      await git(racing("--get-all"), repo, ["config", "--get-all", "credential.helper"])
    ).stdout
      .split("\n")
      .filter((l, i, all) => i < all.length - 1 || l !== "");
    // Git drops every helper before the last empty one: only the owner's come after it.
    const afterReset = helpers.slice(helpers.lastIndexOf("") + 1);
    expect(afterReset.join("\n")).not.toContain("touch");
    expect(() => readFileSync(pwned())).toThrow();
  });

  it("runs the driver and pin queries first: the config re-check is the last call before the command", async () => {
    const calls: string[][] = [];
    const recording: GitRunner = {
      run: (cwd, args, o) => {
        calls.push([...args]);
        return hostGit.run(cwd, args, o);
      },
    };
    await git(recording, repo, ["log", "--oneline"]);
    const at = (pred: (c: string[]) => boolean) => calls.findIndex(pred);
    const drivers = at((c) => c.includes("^(filter|diff|merge)\\."));
    const pins = at((c) => c.includes("--show-scope"));
    const recheck = at((c) => c.includes("--file") && c.includes("--list"));
    const command = at((c) => c.at(-1) === "--oneline");
    expect(command).toBe(calls.length - 1);
    expect(recheck).toBe(command - 1);
    expect(drivers).toBeGreaterThanOrEqual(0);
    expect(pins).toBeGreaterThan(drivers);
    expect(recheck).toBeGreaterThan(pins);
  });

  it("a push names git's own receive-pack and no proxy command for the pushed remote", async () => {
    const remote = join(dir, "remote.git");
    await sh(dir, "init", "--quiet", "--bare", remote);
    await sh(repo, "remote", "set-url", "origin", remote);
    const calls: string[][] = [];
    const envs: (Readonly<Record<string, string>> | undefined)[] = [];
    const recording: GitRunner = {
      run: (cwd, args, o) => {
        calls.push([...args]);
        envs.push(o?.env);
        return hostGit.run(cwd, args, o);
      },
    };
    const tools = codingTools({
      files: fileTools(),
      folders: () => [{ path: repo, mode: "rw" }],
      git: recording,
    });
    const t = (n: string) => tools.find((x) => x.spec.name === n) as AgentToolRegistration;
    await t("code.open").run?.({ path: repo }, ctx());
    const head = await sh(repo, "rev-parse", "HEAD");
    const r = await t("code.git").run?.(
      {
        root: repo,
        op: "push",
        remote: "origin",
        remote_url: remote,
        branch: "main",
        commit: head,
      },
      ctx(),
    );
    expect(r?.isError).toBeUndefined();
    const n = calls.findIndex((c) => c.includes("push"));
    const push = calls[n] as string[];
    const i = push.indexOf("push");
    expect(push.slice(i - 2, i)).toEqual(["-c", "remote.origin.receivepack=git-receive-pack"]);
    expect(push).not.toContain("core.gitProxy=");
    expect(envs[n]).toEqual({ GIT_PROXY_COMMAND: "" });
    // Only the push gets it.
    expect(envs.filter((e) => e !== undefined)).toHaveLength(1);
    expect(await sh(remote, "rev-parse", "refs/heads/main")).toBe(head);
  });
});

/** A nested repository `sub` whose own config has a clean filter that leaves a mark. */
async function nestedRepo(name: string, mark: string): Promise<string> {
  const sub = join(repo, name);
  mkdirSync(sub);
  writeFileSync(join(sub, "f.txt"), "one\n");
  writeFileSync(join(sub, ".gitattributes"), "* filter=x\n");
  await sh(sub, "init", "--quiet", "--initial-branch=main");
  await sh(sub, "config", "user.name", "X");
  await sh(sub, "config", "user.email", "x@example.com");
  await sh(sub, "config", "commit.gpgsign", "false");
  await sh(sub, "add", ".");
  await sh(sub, "commit", "--quiet", "-m", "sub");
  // Only now the driver, in the submodule's own config (assertOwnRepository reads the top one).
  await sh(sub, "config", "filter.x.clean", `sh -c 'touch ${mark}; cat'`);
  return sub;
}

const marked = (m: string) => {
  try {
    readFileSync(m);
    return true;
  } catch {
    return false;
  }
};

describe("submodules (review of #1425 r2)", () => {
  const SUBMODULES = /repositories with submodules aren't supported by code\.git yet/;
  const mark = () => join(dir, "SUBMODULE_FILTER_RAN");

  it("S1: a committed gitlink whose submodule has a filter: open, status and diff run nothing", async () => {
    const sub = await nestedRepo("sub", mark());
    await sh(repo, "add", "sub");
    await sh(repo, "commit", "--quiet", "-m", "gitlink");
    writeFileSync(join(sub, "f.txt"), "two\n");
    const use = setup();
    const opened = await use("code.open", { path: repo });
    expect(opened.output.git).toEqual({ error: expect.stringMatching(SUBMODULES) });
    for (const op of ["status", "diff", "log"]) {
      await expect(use("code.git", { root: repo, op }), op).rejects.toThrow(SUBMODULES);
    }
    expect(marked(mark())).toBe(false);
  });

  it("S2: a commit never stages a nested repository, and status after it runs nothing", async () => {
    const sub = await nestedRepo("nested", mark());
    writeFileSync(join(sub, "f.txt"), "two\n");
    writeFileSync(join(repo, "b.txt"), "b\n");
    const use = setup();
    await use("code.open", { path: repo });
    const before = await sh(repo, "rev-parse", "HEAD");
    await expect(
      use("code.git", { root: repo, op: "commit", message: "add nested" }),
    ).rejects.toThrow(/nested is a nested repository/);
    expect(await sh(repo, "rev-parse", "HEAD")).toBe(before);
    // Not left in the index as a gitlink: the repository still has code.git.
    expect(await sh(repo, "ls-files", "--stage", "nested")).toBe("");
    const status = await use("code.git", { root: repo, op: "status" });
    expect(status.output).toMatchObject({ branch: "main" });
    expect(marked(mark())).toBe(false);
    // Leaving it out of the paths commits the rest.
    const c = await use("code.git", { root: repo, op: "commit", message: "b", paths: ["b.txt"] });
    expect(c.output.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(marked(mark())).toBe(false);
  });

  it("a refused commit leaves the index exactly as it was (review of #1425 r3)", async () => {
    // The owner's own staged change, an unstaged new file, and a nested repository one folder
    // down inside an untracked folder.
    writeFileSync(join(repo, "a.txt"), "a, staged by the owner\n");
    await sh(repo, "add", "a.txt");
    writeFileSync(join(repo, "a.txt"), "a, staged by the owner, then edited\n");
    writeFileSync(join(repo, "b.txt"), "b\n");
    mkdirSync(join(repo, "deep"));
    writeFileSync(join(repo, "deep", "c.txt"), "c\n");
    await nestedRepo("deep/nested", mark());
    const index = async () => await sh(repo, "ls-files", "--stage");
    const cached = async () => await sh(repo, "diff", "--cached", "--name-only");
    const before = { index: await index(), cached: await cached() };
    const use = setup();
    await use("code.open", { path: repo });
    for (const paths of [undefined, ["."], ["deep"], ["b.txt", "deep/nested"]]) {
      await expect(
        use("code.git", { root: repo, op: "commit", message: "x", ...(paths ? { paths } : {}) }),
        JSON.stringify(paths),
      ).rejects.toThrow(/deep\/nested is a nested repository/);
      expect({ index: await index(), cached: await cached() }).toEqual(before);
    }
    expect(before.cached).toBe("a.txt");
    expect(marked(mark())).toBe(false);
  });

  it("S3: submodule.recurse=true in the top config: a branch switch is refused and runs nothing", async () => {
    await nestedRepo("sub", mark());
    await sh(repo, "add", "sub");
    await sh(repo, "commit", "--quiet", "-m", "gitlink");
    await sh(repo, "branch", "other");
    await sh(repo, "config", "submodule.recurse", "true");
    const use = setup();
    await use("code.open", { path: repo });
    await expect(use("code.git", { root: repo, op: "branch", name: "other" })).rejects.toThrow(
      SUBMODULES,
    );
    expect(marked(mark())).toBe(false);
  });

  it("refuses a repository with .git/modules", async () => {
    mkdirSync(join(repo, ".git/modules/x"), { recursive: true });
    const use = setup();
    await use("code.open", { path: repo });
    await expect(use("code.git", { root: repo, op: "status" })).rejects.toThrow(
      /\.git\/modules exists/,
    );
  });

  it("S4: the hardening and the argv keep status, diff and switch out of the submodule", async () => {
    // `git` directly: the submodule refusal is skipped, only GIT_HARDENING and argv apply.
    const sub = await nestedRepo("sub", mark());
    await sh(repo, "add", "sub");
    await sh(repo, "commit", "--quiet", "-m", "gitlink");
    const run = async (args: string[]) => {
      writeFileSync(join(sub, "f.txt"), `${args.join(" ")}\n`);
      await git(hostGit, repo, args);
      expect(marked(mark()), args.join(" ")).toBe(false);
    };
    // GIT_HARDENING's diff.ignoreSubmodules=all alone, for the commands code.git runs.
    await run(["status", "--porcelain=v1", "--branch", "--untracked-files=all"]);
    await run(["diff", "--no-ext-diff", "--no-textconv", "--no-color"]);
    await run(["diff", "--cached", "--quiet"]);
    // A `.gitmodules` with `ignore = none` beats that config, not the argv flag tools.ts passes.
    writeFileSync(
      join(repo, ".gitmodules"),
      '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tignore = none\n',
    );
    await run([
      "status",
      "--porcelain=v1",
      "--branch",
      "--untracked-files=all",
      "--ignore-submodules=all",
    ]);
    await run(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=all"]);
    rmSync(join(repo, ".gitmodules"));
    await sh(sub, "checkout", "--", "f.txt");
    await sh(repo, "branch", "other");
    await sh(repo, "config", "submodule.recurse", "true");
    // The checkout above ran in the submodule itself (its filter is the setup's, not ours).
    rmSync(mark(), { force: true });
    await git(hostGit, repo, ["switch", "other"]);
    expect(marked(mark())).toBe(false);
  });
});
