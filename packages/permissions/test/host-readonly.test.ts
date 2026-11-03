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

  it("never takes git: config can make every reading subcommand run a program (review 1)", () => {
    for (const argv of [
      ["git", "status"],
      ["git", "status", "-vv"],
      ["git", "diff"],
      ["git", "log", "--show-signature"],
      ["git", "log", "--format=%G?"],
      ["git", "show", "--show-signature"],
      ["git", "branch", "--format=%(signature)"],
      ["git", "branch", "-a"],
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
    // git never: even with the Gateway's word, the broker's own check says no.
    expect(await h.broker.decide(host(["git", "status"]), CTX)).toMatchObject({
      decision: "ask",
      sideEffect: "destructive",
    });
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
    expect(approval).toMatchObject({ deviceOnly: true, requiresAuthentication: true });
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
    ]) {
      expect(await h.broker.decide(write(path), CTX), path).toMatchObject({
        decision: "ask",
        sideEffect: "destructive",
      });
    }
  });
});
