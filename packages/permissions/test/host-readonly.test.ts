import { describe, expect, it } from "vitest";
import { classifyHostCommand, READ_ONLY_RULE } from "../src/host-readonly.ts";
import { approve, CTX, call, makeBroker } from "./helpers.ts";

/**
 * The read-only class of `exec_host` (security §5.4). Red team: nothing in it can write a file,
 * run another program or reach outside the folder by its argv; the broker lowers the floor only
 * when the Gateway's description and its own check agree; taint, `manual` mode and the owner's
 * switch still ask.
 */

const CWD = "/work/app";
const ro = (...argv: string[]) => classifyHostCommand(argv, CWD).readOnly;

describe("classifyHostCommand", () => {
  it("accepts the reading commands the owner expects to run quietly", () => {
    for (const argv of [
      ["date"],
      ["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"],
      ["pwd"],
      ["whoami"],
      ["uname", "-a"],
      ["ls", "-la", "src"],
      ["ls", `${CWD}/src`],
      ["cat", "README.md"],
      ["head", "-n", "20", "src/index.ts"],
      ["tail", "-n20", "log.txt"],
      ["wc", "-l", "a.ts", "b.ts"],
      ["file", "--mime-type", "image.png"],
      ["stat", "-f", "%z", "package.json"],
      ["which", "ls"],
      ["date", "+%H:%M"],
      ["ls", "-R", "src"],
    ]) {
      expect(classifyHostCommand(argv, CWD), argv.join(" ")).toMatchObject({ readOnly: true });
    }
  });

  it("refuses every way to write a file", () => {
    for (const argv of [
      ["git", "diff", "--output=out.patch"],
      ["git", "log", "--output", "x"],
      ["git", "branch", "new-branch"],
      ["git", "branch", "-d", "main"],
      ["git", "branch", "-m", "a", "b"],
      ["git", "branch", "--set-upstream-to=origin/main"],
      ["git", "commit", "-m", "x"],
      ["git", "checkout", "."],
      ["git", "stash"],
      ["git", "reset", "--hard"],
      ["git", "-C", "/tmp", "status"],
      ["git", "-c", "core.pager=sh", "log"],
      ["git", "--git-dir=/tmp/x", "log"],
      ["sort", "-o", "out", "in"],
      ["sed", "-i", "s/a/b/", "f"],
      ["file", "-C", "-m", "magic"],
      ["date", "0101000026"],
      ["tail", "-f", "log.txt"],
      ["cp", "a", "b"],
      ["mv", "a", "b"],
      ["rm", "a"],
      ["touch", "a"],
      ["tee", "a"],
      ["mkdir", "a"],
      ["ln", "-s", "a", "b"],
      ["ls", "-o"],
      ["cat", "-i", "x"],
    ]) {
      expect(ro(...argv), argv.join(" ")).toBe(false);
    }
  });

  it("refuses interpreters, launchers and find -exec anywhere in the argv", () => {
    for (const argv of [
      ["sh", "-c", "date"],
      ["bash", "-c", "ls"],
      ["/bin/sh", "-c", "ls"],
      ["python3", "-c", "print(1)"],
      ["node", "-e", "1"],
      ["env", "ls"],
      ["xargs", "cat"],
      ["find", ".", "-exec", "cat", "{}", ";"],
      ["which", "sh"],
      ["cat", "node"],
      ["git", "log", "-exec"],
      ["osascript", "-e", "x"],
      ["open", "-a", "Terminal"],
      ["awk", "1", "f"],
      ["sudo", "ls"],
    ]) {
      expect(ro(...argv), argv.join(" ")).toBe(false);
    }
  });

  it("takes the read-only git subcommands, with the flags a reader expects", () => {
    for (const argv of [
      ["git", "status"],
      ["git", "status", "--short", "--branch"],
      ["git", "status", "--porcelain=v2", "-uno"],
      ["git", "log"],
      ["git", "log", "--oneline", "-5"],
      ["git", "log", "-n", "5", "--graph", "--decorate", "--all"],
      ["git", "log", "--format=%h %an %s", "--since=2.days"],
      ["git", "log", "--author=ada", "--grep=fix", "--", "src"],
      ["git", "log", "main..HEAD", "--stat"],
      ["git", "diff"],
      ["git", "diff", "--cached", "--stat"],
      ["git", "diff", "HEAD~1", "--name-only"],
      ["git", "diff", "-U5", "--", "src/a.ts"],
      ["git", "show", "HEAD", "--stat"],
      ["git", "show", "HEAD~2", "--no-patch", "--format=%H"],
      ["git", "branch"],
      ["git", "branch", "-a", "-vv"],
      ["git", "branch", "--list"],
      ["git", "branch", "--show-current"],
      ["git", "rev-parse", "HEAD"],
      ["git", "rev-parse", "--show-toplevel"],
      ["git", "rev-parse", "--abbrev-ref", "HEAD"],
      ["git", "ls-files"],
      ["git", "ls-files", "-o", "--exclude-standard"],
      ["git", "ls-files", "src"],
      ["git", "blame", "src/a.ts"],
      ["git", "blame", "-L", "10,20", "src/a.ts"],
      ["git", "remote"],
      ["git", "remote", "-v"],
    ]) {
      expect(classifyHostCommand(argv, CWD), argv.join(" ")).toMatchObject({
        readOnly: true,
        program: "git",
      });
    }
  });

  it("refuses git that can write, run a program, leave the folder or reach the network", () => {
    for (const argv of [
      // Options before the subcommand: config, other directories, other programs.
      ["git", "-c", "core.pager=sh", "status"],
      ["git", "-ccore.pager=sh", "status"],
      ["git", "-C", "/etc", "status"],
      ["git", "-C", ".", "status"],
      ["git", "--git-dir=/tmp/x", "status"],
      ["git", "--git-dir", "/tmp/x", "status"],
      ["git", "--work-tree=/", "status"],
      ["git", "--exec-path=/tmp", "status"],
      ["git", "--config-env=core.pager=X", "status"],
      ["git", "--no-pager", "status"],
      ["git", "--paginate", "log"],
      ["git", "--help"],
      ["git", "-p", "log"],
      // Writing or executing flags.
      ["git", "diff", "--output=/tmp/x"],
      ["git", "diff", "--output", "/tmp/x"],
      ["git", "log", "--output=/tmp/x"],
      ["git", "log", "-o", "x"],
      ["git", "log", "--ext-diff"],
      ["git", "diff", "--ext-diff"],
      ["git", "diff", "--textconv"],
      ["git", "show", "--textconv", "HEAD"],
      ["git", "log", "--show-signature"],
      ["git", "log", "--format=%G?"],
      ["git", "log", "--pretty=format:%GS"],
      ["git", "show", "--show-signature"],
      ["git", "diff", "--no-index", "a", "b"],
      ["git", "diff", "--open-files-in-pager"],
      ["git", "diff", "-O", "orderfile"],
      ["git", "log", "--upload-pack=sh"],
      ["git", "status", "--exec-path"],
      ["git", "blame", "--contents", "x", "f"],
      ["git", "blame", "-L", "1,2;touch x", "f"],
      ["git", "ls-files", "--exclude-from=/etc/passwd"],
      ["git", "ls-files", "-x", "*"],
      ["git", "status", "-v"],
      ["git", "status", "-vv"],
      // Branch is list-only: any name creates one.
      ["git", "branch", "evil"],
      ["git", "branch", "-d", "x"],
      ["git", "branch", "-D", "x"],
      ["git", "branch", "-m", "a", "b"],
      ["git", "branch", "-M", "a"],
      ["git", "branch", "-c", "a", "b"],
      ["git", "branch", "-f", "a", "HEAD"],
      ["git", "branch", "--set-upstream-to=origin/main"],
      ["git", "branch", "-u", "origin/main"],
      ["git", "branch", "--edit-description"],
      ["git", "branch", "--format=%(signature)"],
      ["git", "branch", "--list", "feat/*"],
      ["git", "branch", "--", "evil"],
      ["git", "branch", "--delete", "x"],
      ["git", "branch", "--move", "a", "b"],
      // Remote only with -v or nothing.
      ["git", "remote", "add", "x", "https://example.com"],
      ["git", "remote", "remove", "origin"],
      ["git", "remote", "-v", "origin"],
      ["git", "remote", "show", "origin"],
      ["git", "remote", "update"],
      ["git", "remote", "set-url", "origin", "x"],
      // Other subcommands and the network.
      ["git", "push"],
      ["git", "fetch"],
      ["git", "pull"],
      ["git", "clone", "https://example.com/x"],
      ["git", "commit", "-m", "x"],
      ["git", "checkout", "."],
      ["git", "reset", "--hard"],
      ["git", "stash"],
      ["git", "config", "--get", "core.pager"],
      ["git", "config", "core.pager", "sh"],
      ["git", "grep", "x"],
      ["git", "format-patch", "-o", "/tmp", "HEAD~1"],
      ["git", "archive", "HEAD", "-o", "/tmp/x.tar"],
      ["git", "bundle", "create", "x", "HEAD"],
      ["git", "submodule", "status"],
      ["git", "worktree", "list"],
      ["git", "gc"],
      ["git", "rev-list", "HEAD"],
      ["git", "cat-file", "-p", "HEAD"],
      ["git", "difftool"],
      ["git", "mergetool"],
      ["git", "STATUS"],
      ["git", ""],
      ["git"],
      // Operands outside the folder, or revision/pathspec syntax that reaches elsewhere.
      ["git", "log", "--", "../other"],
      ["git", "diff", "/etc/hosts"],
      ["git", "diff", "HEAD", "--", "/etc/passwd"],
      ["git", "show", "HEAD:../secret"],
      ["git", "show", ":/"],
      ["git", "ls-files", "../x"],
      ["git", "ls-files", "~/.ssh"],
      ["git", "blame", "../x"],
      ["git", "status", "--", ":(top)x"],
      ["git", "rev-parse", "--resolve-git-dir", "/tmp"],
      // Not the bare system git, or smuggled through a shell, a launcher or shell syntax.
      ["/usr/bin/git", "status"],
      ["./git", "status"],
      ["env", "git", "status"],
      ["sh", "-c", "git status"],
      ["git", "status;", "rm", "-rf", "x"],
      ["git", "status", ";", "rm", "-rf", "x"],
      ["git", "status", "&&", "id"],
      ["git", "status", "|", "sh"],
      ["git", "log", ">", "x"],
      ["git", "log", "open"],
    ]) {
      expect(classifyHostCommand(argv, CWD), argv.join(" ")).toMatchObject({ readOnly: false });
    }
  });

  it("refuses ':' arguments, symlink-following ls and decompressing file (review 2-4)", () => {
    for (const argv of [
      ["cat", "HEAD:../x"],
      ["ls", ":/"],
      ["cat", "a:b"],
      ["wc", "-l", ":(top)secret"],
      ["ls", "-RL"],
      ["ls", "-L", "src"],
      ["ls", "-H", "src"],
      ["file", "-z", "a.gz"],
      ["file", "-Z", "a.gz"],
      ["file", "-L", "link"],
    ]) {
      expect(ro(...argv), argv.join(" ")).toBe(false);
    }
  });

  it("refuses paths outside the folder, paths with a slash in argv[0], and the network", () => {
    for (const argv of [
      ["cat", "/etc/passwd"],
      ["cat", "../secret"],
      ["cat", "src/../../secret"],
      ["cat", "~/.ssh/id_ed25519"],
      ["ls", "/Users"],
      ["head", "--", "../x"],
      ["git", "diff", "--no-index", "a", "b"],
      ["git", "diff", "/etc/hosts"],
      ["git", "log", "--", "../other"],
      ["/bin/ls"],
      ["./ls"],
      ["which", "/bin/ls"],
      ["curl", "https://example.com"],
      ["git", "fetch"],
      ["git", "pull"],
      ["git", "push"],
      ["git", "clone", "https://example.com/x"],
      ["ssh", "host"],
      ["nc", "-l", "80"],
    ]) {
      expect(ro(...argv), argv.join(" ")).toBe(false);
    }
    expect(classifyHostCommand(["ls"], "relative")).toMatchObject({ readOnly: false });
    expect(classifyHostCommand(["cat", "a\nb"], CWD)).toMatchObject({ readOnly: false });
  });
});

const ON = { exec: { execHostEnabled: true }, folders: [{ path: "/work", mode: "rw" as const }] };

/** What the loop sends for `exec_host`: the tool's `destructive` and the description's meta. */
function host(argv: string[], meta = true, params: Record<string, unknown> = {}) {
  return call("exec_host", "destructive", undefined, {
    params: { argv, cwd: CWD, ...params },
    ...(meta ? { meta: { hostCommand: "read_only" as const } } : {}),
  });
}

describe("the broker and the read-only class", () => {
  it("runs a read-only command without a card, at side effect read", async () => {
    const h = makeBroker({ policy: ON });
    const d = await h.broker.decide(host(["ls", "-la"]), CTX);
    expect(d).toMatchObject({ decision: "allow", rule: READ_ONLY_RULE, sideEffect: "read" });
    // Read-only git runs quietly too; a git that can write still asks, with the Gateway's word.
    expect(await h.broker.decide(host(["git", "log", "--oneline", "-5"]), CTX)).toMatchObject({
      decision: "allow",
      rule: READ_ONLY_RULE,
    });
    for (const argv of [
      ["git", "-c", "core.pager=sh", "status"],
      ["git", "diff", "--output=/tmp/x"],
      ["git", "branch", "evil"],
      ["git", "push"],
      ["git", "-C", "/etc", "status"],
      ["git", "status;", "rm", "-rf", "x"],
    ]) {
      expect(await h.broker.decide(host(argv), CTX), argv.join(" ")).toMatchObject({
        decision: "ask",
        sideEffect: "destructive",
      });
    }
    // And again: no `once`-style card in between.
    expect((await h.broker.decide(host(["date"]), CTX)).decision).toBe("allow");
  });

  it("a description alone never lowers the floor: the broker re-checks the argv", async () => {
    const h = makeBroker({ policy: ON });
    for (const argv of [
      ["rm", "-rf", "."],
      ["sh", "-c", "date"],
      ["cat", "/etc/passwd"],
    ]) {
      const d = await h.broker.decide(host(argv), CTX);
      // Asked as destructive, or refused outright (`rm -rf .` is a hard prohibition).
      expect(["ask", "deny"], argv.join(" ")).toContain(d.decision);
      expect(d.sideEffect, argv.join(" ")).toBe("destructive");
    }
    // Env or network take a command out of the class.
    expect(
      await h.broker.decide(host(["ls"], true, { env: { COLUMNS: "80" } }), CTX),
    ).toMatchObject({ decision: "ask", sideEffect: "destructive" });
    expect(
      await h.broker.decide(host(["ls"], true, { allowedDomains: ["example.com"] }), CTX),
    ).toMatchObject({ decision: "ask", sideEffect: "destructive" });
    // Without the Gateway's word (no meta) the same argv asks as before.
    expect(await h.broker.decide(host(["ls"], false), CTX)).toMatchObject({
      decision: "ask",
      sideEffect: "destructive",
    });
  });

  it("taint forces a card (security §3.6), offered once, labelled read", async () => {
    const h = makeBroker({ policy: ON });
    const d = await h.broker.decide(host(["date"]), { ...CTX, taint: true });
    expect(d).toMatchObject({ decision: "ask", sideEffect: "read", scopesOffered: ["once"] });
    const { approval } = await approve(h, host(["date"]), { ...CTX, taint: true }, "once");
    expect(approval).toMatchObject({ deviceOnly: true, requiresAuthentication: false });
    expect(approval.sideEffect).toBe("read");
  });

  it("manual mode and the owner's switch still ask, every time", async () => {
    const manual = makeBroker({ policy: ON });
    const ctx = { ...CTX, permissionMode: "manual" as const };
    expect(await manual.broker.decide(host(["date"]), ctx)).toMatchObject({
      decision: "ask",
      rule: "mode:manual/exec_host",
      sideEffect: "read",
    });
    await approve(manual, host(["date"]), ctx, "once");
    expect((await manual.broker.decide(host(["date"]), ctx)).decision).toBe("ask");

    const off = makeBroker({
      policy: { ...ON, exec: { execHostEnabled: true, readOnlyWithoutAsking: false } },
    });
    expect(await off.broker.decide(host(["date"]), CTX)).toMatchObject({
      decision: "ask",
      rule: "exec_host:read_only_off",
    });
    await approve(off, host(["date"]), CTX, "once");
    expect((await off.broker.decide(host(["date"]), CTX)).decision).toBe("ask");
  });

  it("without srt it asks, as a read", async () => {
    const h = makeBroker({ policy: ON });
    const c = call("exec_host", "destructive", undefined, {
      params: { argv: ["date"], cwd: CWD },
      meta: { hostCommand: "read_only", hostSandbox: "missing" },
    });
    expect(await h.broker.decide(c, CTX)).toMatchObject({
      decision: "ask",
      rule: "exec_host:no_sandbox",
      sideEffect: "read",
    });
  });

  it("read-only git: asks in manual mode and in a tainted turn, denied outside a shared folder", async () => {
    const status = host(["git", "status"]);
    const manual = makeBroker({ policy: ON });
    expect(
      await manual.broker.decide(status, { ...CTX, permissionMode: "manual" as const }),
    ).toMatchObject({ decision: "ask", rule: "mode:manual/exec_host" });
    const h = makeBroker({ policy: ON });
    for (const permissionMode of ["balanced", "auto"] as const) {
      expect(await h.broker.decide(status, { ...CTX, permissionMode })).toMatchObject({
        decision: "allow",
        rule: READ_ONLY_RULE,
      });
    }
    expect((await h.broker.decide(status, { ...CTX, taint: true })).decision).toBe("ask");
    // The cwd of the call is outside every shared folder.
    const elsewhere = host(["git", "status"], true, { cwd: "/elsewhere/app" });
    expect(await h.broker.decide(elsewhere, CTX)).toMatchObject({
      decision: "deny",
      rule: "folder:not_granted",
    });
  });

  it("still needs exec_host on and a granted cwd", async () => {
    const offHost = makeBroker({ policy: { folders: ON.folders } });
    expect(await offHost.broker.decide(host(["date"]), CTX)).toMatchObject({
      decision: "deny",
      rule: "exec_host:disabled",
    });
    const noFolder = makeBroker({ policy: { exec: { execHostEnabled: true } } });
    expect(await noFolder.broker.decide(host(["date"]), CTX)).toMatchObject({
      decision: "deny",
      rule: "folder:not_granted",
    });
  });

  it("is the owner's only: a designated person's request gets no quiet run", async () => {
    const h = makeBroker({ policy: ON });
    const d = await h.broker.decide(host(["date"]), {
      ...CTX,
      requester: { role: "designated", identityId: "id_1" },
    });
    expect(d.decision).not.toBe("allow");
  });
});

describe("writes under .git/ (security review, finding 1)", () => {
  const RW = { folders: [{ path: "/work", mode: "rw" as const }] };
  const write = (path: string) =>
    call("write_file", "write", { kind: "path", value: path }, { params: { path, content: "x" } });

  it("are destructive and ask, where a plain write in the folder does not", async () => {
    const h = makeBroker({ policy: RW });
    expect((await h.broker.decide(write("/work/app/notes.txt"), CTX)).decision).toBe("allow");
    for (const path of [
      "/work/app/.git/config",
      "/work/app/.git/hooks/pre-commit",
      "/work/.git/info/attributes",
      // APFS is case-insensitive: git uses `.GIT` as `.git`.
      "/work/app/.GIT/config",
      "/work/app/.Git/HEAD",
    ]) {
      expect(await h.broker.decide(write(path), CTX), path).toMatchObject({
        decision: "ask",
        sideEffect: "destructive",
      });
    }
  });
});
