import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  anyArgvSafe,
  HOST_PROGRAM_ANY_ARGV,
  hostProgramCoverage,
  isNeverProgram,
  operandsInside,
  type PolicyCall,
  type PolicyContext,
  programName,
  readsCwdConfig,
  sedScriptSafe,
} from "../src/index.ts";
import { CTX, call, DEVICE, type Harness, makeBroker, memoryDb, sqliteBroker } from "./helpers.ts";

/**
 * "Always allow <program> in <folder>" on an exec_host card (security §5.4). Two-way tables: what
 * must still ask, and what may run quietly, each with a positive control. The grant is keyed on
 * the binary's real path and SHA-256 plus the folder; arguments are free only for tools that
 * cannot run other code.
 */

const sha = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;

const ARGS_OK: [string, string[]][] = [
  ["ls", ["-la"]],
  // `--` followed only by operands, and long options that are not follow abbreviations.
  ["grep", ["-r", "foo", "--", "a.txt"]],
  ["rg", ["-e", "--", "TOKEN", "."]],
  ["grep", ["--count", "foo", "f"]],
  ["ls", ["--color=never"]],
  ["tree", ["-L", "2", "."]],
  ["tree", ["-a", "-I", "node_modules"]],
  ["ls", ["-R", "sub"]],
  ["cat", ["a.txt", "b.txt"]],
  ["head", ["-n", "5", "f"]],
  ["tail", ["-n", "3", "f"]],
  ["wc", ["-l", "f"]],
  ["grep", ["-rn", "foo", "."]],
  ["rg", ["foo"]],
  ["rg", ["-i", "-g", "*.ts", "foo"]],
  ["rg", ["--hidden", "--files"]],
  ["find", [".", "-name", "*.ts"]],
  ["find", [".", "-type", "f", "-newer", "x"]],
  ["jq", [".", "f.json"]],
  ["sed", ["-n", "1,5p", "f"]],
  ["sed", ["s/a/b/g", "f"]],
  ["sed", ["-E", "-n", "/x/p", "f"]],
  ["sed", ["-e", "s/a/b/", "-e", "2d", "f"]],
  ["sed", ["-ne", "$p", "f"]],
  ["ls", ["-R"]],
  ["grep", ["-r", "foo", "."]],
  ["rg", ["foo"]],
  // `z` in the value of an option is not the -z flag.
  ["rg", ["-f/var/folders/zz/pats"]],
  ["rg", ["-nf/var/folders/zz/pats"]],
  ["rg", ["--ignore-file=plain.txt", "foo"]],
  ["tree", ["-L", "2"]],
  ["du", ["-sh", "."]],
  ["stat", ["f"]],
  ["file", ["f"]],
  // A separate option value is not the first operand (so a later option is not "late").
  ["rg", ["-t", "ts", "-i", "foo"]],
  ["rg", ["--type", "ts", "-i", "foo", "."]],
  ["grep", ["-A", "3", "-n", "foo", "."]],
  ["grep", ["-C", "2", "-rn", "foo", "."]],
  ["tree", ["-I", "node_modules", "-L", "2"]],
  ["tree", ["-LI", "2", "x", "-a"]],
  ["head", ["-n", "20", "-q", "f"]],
  ["du", ["-d", "1", "-h", "."]],
  ["jq", ["--arg", "k", "v", "-r", ".", "f"]],
  ["rg", ["-d", "1", "-i", "foo"]],
  ["rg", ["--max-count", "3", "-i", "foo"]],
  ["rg", ["--regexp", "foo", "-i", "."]],
  ["grep", ["--include", "*.ts", "-r", "foo", "."]],
  ["tail", ["--lines", "5", "-q", "f"]],
  ["du", ["--max-depth", "1", "-h", "."]],
  ["tree", ["--sort", "name", "-a"]],
  // A dash-led value is not skipped, but it is no danger flag either.
  ["rg", ["-t", "-i", "foo"]],
];

const ARGS_DANGEROUS: [string, string[]][] = [
  ["find", [".", "-exec", "rm", "{}", ";"]],
  ["find", [".", "-execdir", "sh", "-c", "x", ";"]],
  ["find", [".", "-ok", "rm", "{}", ";"]],
  ["find", [".", "-okdir", "rm", "{}", ";"]],
  ["find", [".", "-delete"]],
  ["find", [".", "-fprint", "out"]],
  ["find", [".", "-fprintf", "out", "%p"]],
  ["find", [".", "-fls", "out"]],
  ["sed", ["-i", "s/a/b/", "f"]],
  ["sed", ["-i.bak", "s/a/b/", "f"]],
  ["sed", ["-ni", "p", "f"]],
  ["sed", ["-Ei", "s/a/b/", "f"]],
  ["sed", ["--in-place", "s/a/b/", "f"]],
  ["sed", ["--in-place=.bak", "s/a/b/", "f"]],
  ["sed", ["s/a/b/e", "f"]],
  ["sed", ["s/a/b/w out", "f"]],
  ["sed", ["1e date", "f"]],
  ["sed", ["e", "f"]],
  ["sed", ["-e", "w out", "f"]],
  ["sed", ["-n", "-e", "p;w out", "f"]],
  ["sed", ["-f", "script.sed", "f"]],
  ["sed", ["--file=script.sed", "f"]],
  ["sed", ["-s", "p", "f"]],
  ["sed", ["1r /etc/hosts", "f"]],
  ["sed", ["s|a|b|", "f"]],
  ["sed", []],
  ["rg", ["--pre", "cat", "foo"]],
  ["rg", ["--pre=cat", "foo"]],
  ["rg", ["--pre-glob", "*.x", "foo"]],
  ["rg", ["--hostname-bin", "x", "foo"]],
  ["rg", ["-z", "foo"]],
  ["rg", ["-uz", "foo"]],
  ["rg", ["--search-zip", "foo"]],
  // Flags that follow symbolic links can leave the folder through a link inside it.
  ["rg", ["-L", "foo"]],
  ["rg", ["--follow", "foo"]],
  ["rg", ["-uL", "foo"]],
  ["grep", ["-S", "foo", "."]],
  ["grep", ["-rS", "foo", "."]],
  ["grep", ["-R", "foo", "."]],
  ["grep", ["-O", "foo", "."]],
  ["grep", ["--dereference-recursive", "foo", "."]],
  ["find", [".", "-follow", "-name", "x"]],
  ["find", ["-L", "."]],
  ["find", ["-H", "."]],
  ["ls", ["-L"]],
  ["ls", ["-LR"]],
  ["ls", ["-H"]],
  ["ls", ["--dereference"]],
  ["tree", ["-l", "."]],
  ["du", ["-L", "."]],
  ["du", ["-H", "."]],
  ["stat", ["-L", "f"]],
  ["file", ["-L", "f"]],
  ["sed", ["--follow-symlinks", "p"]],
  // A `--` that is an option's value: the flags after it still apply (review of #1368).
  ["rg", ["-e", "--", "--pre=./x.sh", "-e", "TOKEN", "."]],
  ["rg", ["-g", "--", "--pre=./x.sh", "TOKEN"]],
  ["rg", ["-e", "--", "--hostname-bin=./x.sh"]],
  ["rg", ["-e", "--", "-z"]],
  ["rg", ["-e", "--", "-L"]],
  ["grep", ["-e", "--", "-rS", "-e", "TOKEN", "."]],
  ["grep", ["-e", "--", "-f/etc/passwd", "."]],
  ["grep", ["-e", "--", "--file=/etc/passwd", "."]],
  ["du", ["-d", "--", "-L", "."]],
  // A dash-led operand after a real `--` asks too: the checker can't tell the two apart.
  ["sed", ["p", "--", "-f"]],
  ["ls", ["--", "-weird"]],
  // tree reads every letter of a cluster as a flag; a value letter takes the next argument.
  ["tree", ["-Ll", "2", "."]],
  ["tree", ["-L2l", "."]],
  ["tree", ["-Pl", "x"]],
  ["tree", ["-Il", "node_modules"]],
  // GNU getopt_long takes any unique prefix of a long option.
  ["grep", ["--der", "foo", "."]],
  ["grep", ["--dereference-r", "foo", "."]],
  ["ls", ["--deref"]],
  ["du", ["--foll", "."]],
  ["wc", ["--files0=list"]],
  ["du", ["--files0-f=list"]],
  ["file", ["--f=list.txt"]],
  ["wc", ["--f=list"]],
  ["du", ["--f=list"]],
  ["file", ["--com"]],
  ["file", ["--unc", "f"]],
  ["file", ["--mag=m", "f"]],
  // A file naming the files to read: its entries are never checked.
  ["wc", ["--files0-from=list"]],
  ["du", ["--files0-from=list"]],
  ["file", ["-f", "list.txt"]],
  ["tree", ["-R", "-L", "1"]],
  ["tree", ["-H", "."]],
  // GNU getopt reads options after operands.
  ["sed", ["p", "f", "-e", "1e id"]],
  ["sed", ["p", "f", "-i"]],
  ["sed", ["p", "f", "--in-place"]],
  ["sed", ["-n", "p", "f", "-f", "s.sed"]],
  ["ls", ["sub", "-R"]],
  ["grep", ["foo", ".", "-r"]],
  ["rg", ["foo", "-z"]],
  ["head", ["f", "-n", "3"]],
  ["tree", ["-o", "out"]],
  ["tree", ["-Ho", "out"]],
  ["tree", ["--output=out"]],
  ["file", ["-C", "-m", "magic"]],
  ["file", ["-z", "f"]],
  ["file", ["--compile"]],
  // A separate value never hides a flag, an operand or a path (review of #1368, round 2).
  ["rg", ["-t", "ts", "-L", "foo"]],
  ["rg", ["-t", "ts", "--pre=./x.sh", "foo"]],
  ["rg", ["--type", "ts", "--pre", "./x.sh", "foo"]],
  ["rg", ["-t", "ts", "-z", "foo"]],
  ["rg", ["-e", "--pre=./x.sh", "."]],
  ["rg", ["-t", "ts", "foo", "-L"]],
  ["grep", ["-A", "3", "-rS", "foo", "."]],
  ["grep", ["-e", "-rS", "."]],
  ["grep", ["-A", "3", "foo", ".", "-r"]],
  ["tree", ["-I", "x", "-l", "."]],
  ["tree", ["-LI", "2", "x", "-l"]],
  ["du", ["-d", "1", "-L", "."]],
  ["head", ["-n", "5", "f", "-q"]],
  ["jq", ["--arg", "k", "v", ".", "f", "-r"]],
  ["grep", ["--file", "pats", "-r", "foo", "--", "-x"]],
  // Not on the any-argv list at all.
  ["git", ["status"]],
  ["awk", ["BEGIN{system(1)}"]],
  ["tee", ["out"]],
];

describe("anyArgvSafe: the danger flags, both ways", () => {
  it.each(ARGS_OK)("%s %j may run with these arguments", (program, args) => {
    expect(anyArgvSafe(program, args)).toBe(true);
  });
  it.each(ARGS_DANGEROUS)("%s %j asks", (program, args) => {
    expect(anyArgvSafe(program, args)).toBe(false);
  });
  it("asks for any dash-led argument after `--`, and judges the whole sed script", () => {
    // `--` may be an option's value (`rg -e -- -z`), so what follows it is never trusted.
    expect(anyArgvSafe("rg", ["foo", "--", "-z"])).toBe(false);
    expect(anyArgvSafe("rg", ["foo", "--", "z.txt"])).toBe(true);
    expect(sedScriptSafe("1,3{p;d}")).toBe(true);
    expect(sedScriptSafe("s/a/b/;w x")).toBe(false);
  });
});

describe("the never list and the any-argv list", () => {
  const NEVER = [
    "sh",
    "bash",
    "zsh",
    "fish",
    "env",
    "xargs",
    "python",
    "python3",
    "python3.12",
    "/usr/bin/python3",
    "node",
    "node22",
    "ruby",
    "perl",
    "perl5.34",
    "osascript",
    "sudo",
    "open",
    "curl",
    "wget",
    "ssh",
    "scp",
    "rsync",
    "npm",
    "pnpm",
    "yarn",
    "pip",
    "brew",
    "make",
    "cargo",
    "go",
    "BASH",
    "ſh",
    "baſh",
    "oſascript",
    "Sh",
  ];
  const OK = ["ls", "git", "rg", "jq", "pythonista", "gofmt", "cat", "/opt/homebrew/bin/rg"];
  it.each(NEVER)("%s is never offered", (name) => {
    expect(isNeverProgram(name)).toBe(true);
  });
  it.each(OK)("%s is not on the never list", (name) => {
    expect(isNeverProgram(name)).toBe(false);
  });
  it("folds case and long s before comparing names", () => {
    expect(programName("/bin/ſh")).toBe("sh");
    expect(programName("/usr/bin/GIT")).toBe("git");
    for (const n of ["GIT", "ſh", "baſh", "oſascript", "ſqlite3"]) {
      expect(hostProgramCoverage([n, "x"], `/usr/bin/${n}`), n).toBe("exact");
    }
    expect(readsCwdConfig("/usr/bin/GIT")).toBe(true);
    expect(readsCwdConfig("/usr/bin/git")).toBe(true);
    expect(readsCwdConfig("/usr/bin/Make")).toBe(true);
    expect(readsCwdConfig("/usr/bin/ls")).toBe(false);
  });
  it("lists the any-argv programs", () => {
    expect([...HOST_PROGRAM_ANY_ARGV].sort()).toEqual(
      [
        "cat",
        "du",
        "file",
        "find",
        "grep",
        "head",
        "jq",
        "ls",
        "rg",
        "sed",
        "stat",
        "tail",
        "tree",
        "wc",
      ].sort(),
    );
  });
  it("is exact-argv unless the real binary carries the tool's own name and the flags are safe", () => {
    expect(hostProgramCoverage(["ls", "-la"], "/bin/ls")).toBe("any");
    expect(hostProgramCoverage(["git", "status"], "/usr/bin/git")).toBe("exact");
    expect(hostProgramCoverage(["find", ".", "-delete"], "/usr/bin/find")).toBe("exact");
    // `ls` that is really another binary (a link) is judged as that binary.
    expect(hostProgramCoverage(["ls"], "/usr/bin/true")).toBe("exact");
  });
});

// ---- the broker ------------------------------------------------------------------------------

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "psy-hp-")));
const WORK = join(ROOT, "work");
const WORK2 = join(ROOT, "work2");
const HOME = join(ROOT, "home");
const SYS = join(ROOT, "sys");
const SYS2 = join(ROOT, "sys2");
for (const d of [WORK, join(WORK, "sub"), WORK2, HOME, join(HOME, "proj"), SYS, SYS2]) {
  mkdirSync(d, { recursive: true });
}
const PROGRAMS = [
  "jq",
  "grep",
  "du",
  "ls",
  "find",
  "sed",
  "rg",
  "tree",
  "file",
  "tool",
  "bash",
  "python3",
  "curl",
  "make",
  "tool",
  "GIT",
  "baſh",
  "ſh",
  "oſascript",
];
for (const name of PROGRAMS) {
  writeFileSync(join(SYS, name), `#!/bin/sh\n# ${name}\n`, { mode: 0o755 });
}
writeFileSync(join(SYS2, "ls"), "#!/bin/sh\n# shadow ls\n", { mode: 0o755 });
writeFileSync(join(WORK, "ls"), "#!/bin/sh\n# planted\n", { mode: 0o755 });
symlinkSync(join(SYS, "tool"), join(SYS, "cat"));
symlinkSync(HOME, join(WORK, "escape"));
writeFileSync(join(WORK, "a.txt"), "x");
linkSync(join(WORK, "a.txt"), join(WORK, "b.txt"));
writeFileSync(join(WORK, "plain.txt"), "x");
// A link inside the shared folder to a place outside it, with a file behind it.
const OUTSIDE = join(ROOT, "outside");
mkdirSync(join(OUTSIDE, "deep"), { recursive: true });
writeFileSync(join(OUTSIDE, "deep", "secret.txt"), "TOKEN");
symlinkSync(OUTSIDE, join(WORK, "tmplink"));

const SHA = (name: string) => sha(`${name}-v1`);
const POLICY = {
  exec: { execHostEnabled: true },
  folders: [
    { path: WORK, mode: "rw" as const },
    { path: WORK2, mode: "rw" as const },
  ],
};
const OPTS = { hostProgram: { roots: [SYS, SYS2], platform: "darwin" as const, home: HOME } };
const harness = (policy: object = POLICY) =>
  makeBroker({ policy: policy as never, ...OPTS } as never);

interface Over {
  cwd?: string;
  exe?: string;
  sha?: string;
  env?: Record<string, string>;
  domains?: string[];
  cwdReal?: string;
}
function host(argv: string[], o: Over = {}): PolicyCall {
  const name = (argv[0] ?? "").split("/").pop() ?? "x";
  const cwd = o.cwd ?? WORK;
  const executable = o.exe ?? join(SYS, name);
  const hash = o.sha ?? SHA(name);
  const env = o.env ?? {};
  return call("exec_host", "destructive", undefined, {
    params: { argv, cwd, env, allowedDomains: o.domains ?? [] },
    binding: {
      argv,
      cwd,
      env,
      executable,
      executableSha256: hash,
      network: (o.domains ?? []).length === 0 ? "none" : "proxy",
    },
    meta: { hostProgram: { executable, sha256: hash, cwdReal: o.cwdReal ?? cwd } },
  });
}

async function card(h: Harness, c: PolicyCall, ctx: PolicyContext = CTX) {
  const d = await h.broker.decide(c, ctx);
  if (d.decision !== "ask" || d.approvalKind === undefined) throw new Error(`no ask: ${d.rule}`);
  const issued = await h.broker.requestApproval({
    kind: d.approvalKind,
    summary: "run",
    details: {},
    bindingHash: d.bindingHash ?? "",
    grantKey: d.grantKey ?? "",
    requestedBy: { runId: ctx.runId, taskId: ctx.taskId ?? null, threadId: ctx.threadId },
    sideEffect: d.sideEffect,
    surfaces: ["desktop"],
    taint: ctx.taint,
  });
  h.clock.advance(500);
  return issued;
}
const offer = (issued: Awaited<ReturnType<typeof card>>) =>
  (issued.approval.details as { hostProgram?: Record<string, unknown> }).hostProgram;

async function allowProgram(h: Harness, c: PolicyCall, ctx: PolicyContext = CTX) {
  const issued = await card(h, c, ctx);
  expect(offer(issued)).toBeDefined();
  return h.broker.answer({
    approvalId: issued.approval.id,
    answerToken: issued.answerTokens.desktop ?? "",
    decision: "approve",
    scope: "once",
    hostProgram: true,
    decidedBy: DEVICE,
  });
}
const verdict = async (h: Harness, c: PolicyCall, ctx: PolicyContext = CTX) =>
  (await h.broker.decide(c, ctx)).decision;

describe("exec_host program grant: the card", () => {
  it("offers the program, its folder and (for a safe tool) any arguments", async () => {
    const h = harness();
    const o = offer(await card(h, host(["ls", "-la"])));
    expect(o).toMatchObject({
      program: "ls",
      executable: join(SYS, "ls"),
      sha256: SHA("ls"),
      folder: WORK,
      argv: null,
    });
  });
  it("offers nothing for a program that is not on the any-argv list (its exact grant stays)", async () => {
    const h = harness();
    expect(offer(await card(h, host(["tool", "status"])))).toBeUndefined();
    expect(await verdict(h, host(["tool", "status"]))).toBe("ask");
  });
  it("never offers it for a program that reads config from the folder (git, make, npm)", async () => {
    const h = harness();
    expect(offer(await card(h, host(["git", "status"])))).toBeUndefined();
    expect(await verdict(h, host(["git", "status"]))).toBe("ask");
  });
  it("offers nothing for a danger flag of a safe tool, or a link named like one", async () => {
    const h = harness();
    expect(offer(await card(h, host(["find", ".", "-delete"])))).toBeUndefined();
    const real = host(["cat", "x"], { exe: join(SYS, "tool"), sha: SHA("tool") });
    expect(offer(await card(h, real))).toBeUndefined();
  });
  it("never offers it for GIT, baſh or ſh (case and long-s folding)", async () => {
    const h = harness();
    for (const n of ["GIT", "baſh", "ſh", "oſascript"]) {
      const c = host([n, "x"], { exe: join(SYS, n), sha: sha(n) });
      expect(offer(await card(h, c)), n).toBeUndefined();
    }
  });

  const NO_OFFER: [string, PolicyCall, Partial<PolicyContext>?][] = [
    ["a shell string", host(["ls | wc -l"])],
    ["a redirect string", host(["cat x > y"])],
    ["env changes", host(["ls"], { env: { CI: "1" } })],
    ["network domains", host(["ls"], { domains: ["example.com"] })],
    ["a binary inside the shared folder (planted)", host(["./ls"], { exe: join(WORK, "ls") })],
    ["a binary outside every trusted root", host(["ls"], { exe: join(ROOT, "home", "ls") })],
    ["a tainted turn", host(["ls"]), { taint: true }],
    ["manual mode", host(["ls"]), { permissionMode: "manual" }],
    ["an MCP app caller", host(["ls"]), { initiator: "mcp_app" }],
    ["the home folder itself", host(["ls"], { cwd: join(HOME, "proj") })],
    ...["bash", "python3", "curl", "make"].map(
      (n) => [`${n} (never)`, host([n, "-c", "x"])] as [string, PolicyCall],
    ),
  ];
  it.each(NO_OFFER)("is not offered for %s", async (_n, c, ctx = {}) => {
    const h = harness(
      _n.startsWith("the home")
        ? { ...POLICY, folders: [{ path: HOME, mode: "rw" as const }] }
        : POLICY,
    );
    const issued = await card(h, c, { ...CTX, ...ctx });
    expect(offer(issued)).toBeUndefined();
  });

  it("refuses an answer that asks for a grant the card did not offer", async () => {
    const h = harness();
    for (const c of [host(["bash", "-c", "x"]), host(["ls"], { env: { A: "1" } })]) {
      const issued = await card(h, c);
      await expect(
        h.broker.answer({
          approvalId: issued.approval.id,
          answerToken: issued.answerTokens.desktop ?? "",
          decision: "approve",
          scope: "once",
          hostProgram: true,
          decidedBy: DEVICE,
        }),
      ).rejects.toThrow(/does not offer/);
    }
    const ok = await card(h, host(["ls"]));
    await expect(
      h.broker.answer({
        approvalId: ok.approval.id,
        answerToken: ok.answerTokens.desktop ?? "",
        decision: "approve",
        scope: "always",
        hostProgram: true,
        decidedBy: DEVICE,
      }),
    ).rejects.toThrow(/does not offer/);
  });

  it("ignores a hostProgram offer the caller put in its own details", async () => {
    const h = harness();
    const c = host(["bash", "-c", "x"]);
    const d = await h.broker.decide(c, CTX);
    const issued = await h.broker.requestApproval({
      kind: d.approvalKind ?? "exec_host",
      summary: "run",
      details: {
        hostProgram: { executable: join(SYS, "bash"), sha256: SHA("bash"), folder: WORK },
      },
      bindingHash: d.bindingHash ?? "",
      grantKey: d.grantKey ?? "",
      requestedBy: { runId: CTX.runId, taskId: "task_1", threadId: CTX.threadId },
      sideEffect: d.sideEffect,
      surfaces: ["desktop"],
      taint: false,
    });
    expect(offer(issued)).toBeUndefined();
  });
});

describe("exec_host program grant: ask / run quietly", () => {
  async function granted() {
    const h = harness();
    await allowProgram(h, host(["ls", "-la"]));
    return h;
  }

  const RUNS: [string, PolicyCall][] = [
    ["the same command", host(["ls", "-la"])],
    ["other arguments", host(["ls", "-1", "-R", "sub"])],
    ["a subfolder", host(["ls"], { cwd: join(WORK, "sub") })],
  ];
  it.each(RUNS)("runs quietly: %s", async (_n, c) => {
    const h = await granted();
    const d = await h.broker.decide(c, CTX);
    expect(d.decision).toBe("allow");
    expect(d.rule).toMatch(/^grant:/);
  });

  const ASKS: [string, PolicyCall, Partial<PolicyContext>?][] = [
    ["a replaced binary (hash changed)", host(["ls"], { sha: sha("ls-evil") })],
    ["a renamed binary at another path", host(["ls"], { exe: join(SYS, "tool"), sha: SHA("ls") })],
    [
      "PATH shadowing (same name, earlier root)",
      host(["ls"], { exe: join(SYS2, "ls"), sha: sha("shadow") }),
    ],
    [
      "a same-name binary in the workspace",
      host(["ls"], { exe: join(WORK, "ls"), sha: sha("planted") }),
    ],
    [
      "a link named ls to another binary",
      host(["ls"], { exe: join(SYS, "tool"), sha: SHA("tool") }),
    ],
    ["a cwd in another shared folder", host(["ls"], { cwd: WORK2 })],
    ["a cwd outside every shared folder", host(["ls"], { cwd: ROOT })],
    ["a cwd whose real path leaves the folder", host(["ls"], { cwdReal: WORK2 })],
    ["a tainted turn", host(["ls"]), { taint: true }],
    ["manual mode", host(["ls"]), { permissionMode: "manual" }],
    ["env changes", host(["ls"], { env: { LANG: "C" } })],
    ["network domains", host(["ls"], { domains: ["example.com"] })],
    ["a shell string", host(["ls -la | wc"])],
    ["a program that has only its exact grant", host(["tool", "status"])],
    ["an absolute path outside the folder", host(["ls", "-la", join(HOME, ".aws")])],
    ["a ~ path", host(["ls", "~/.aws"])],
    ["a .. path out of the folder", host(["ls", "../../.."])],
    ["a symlink that leaves the folder", host(["ls", "escape"])],
    ["a hard-linked file", host(["ls", "a.txt"])],
    ["an option after an operand", host(["ls", "sub", "-R"])],
    ["a designated person's request", host(["ls"]), { requester: { role: "friend" } } as never],
  ];
  it.each(ASKS)("asks: %s", async (_n, c, ctx = {}) => {
    const h = await granted();
    expect(await verdict(h, c, { ...CTX, ...ctx })).not.toBe("allow");
  });

  it("treats a missing meta.hostProgram or a mismatching binding as not described", async () => {
    const h = await granted();
    const bare = host(["ls"]);
    delete (bare as { meta?: unknown }).meta;
    expect(await verdict(h, bare)).toBe("ask");
    const lying = host(["ls"]);
    (lying.meta as { hostProgram: { sha256: string } }).hostProgram.sha256 = sha("ls-evil");
    expect(await verdict(h, lying)).toBe("ask");
  });

  const PROBE: [string, string[], string[][]][] = [
    [
      "find",
      [".", "-name", "x"],
      [
        [".", "-exec", "rm", "{}", ";"],
        [".", "-delete"],
      ],
    ],
    [
      "sed",
      ["-n", "p", "f"],
      [
        ["-i", "p", "f"],
        ["e", "f"],
        ["s/a/b/e", "f"],
      ],
    ],
    [
      "rg",
      ["foo"],
      [
        ["--pre", "cat", "foo"],
        ["-z", "foo"],
      ],
    ],
    ["tree", ["-L", "1"], [["-o", "out"]]],
    ["file", ["f"], [["-C"], ["-z", "f"]]],
  ];
  it.each(PROBE)(
    "%s: the grant covers safe arguments and asks for each danger flag",
    async (name, ok, bad) => {
      const h = harness();
      await allowProgram(h, host([name, ...ok]));
      expect(await verdict(h, host([name, ...ok, "more"]))).toBe("allow");
      for (const flags of bad) {
        expect(await verdict(h, host([name, ...flags])), flags.join(" ")).not.toBe("allow");
      }
    },
  );

  it("expires after 30 days and stops when revoked", async () => {
    const h = await granted();
    h.clock.advance(29 * 86_400_000);
    expect(await verdict(h, host(["ls"]))).toBe("allow");
    h.clock.advance(2 * 86_400_000);
    expect(await verdict(h, host(["ls"]))).toBe("ask");

    const r = await granted();
    const [g] = await r.broker.listGrants({ kind: "exec_host" } as never);
    expect(g?.subject).toMatchObject({ hostProgram: { folder: WORK } });
    await r.broker.revokeGrant(g?.id ?? "");
    expect(await verdict(r, host(["ls"]))).toBe("ask");
  });

  it("stops covering a folder the owner no longer shares", async () => {
    const h = await granted();
    h.broker.setPolicy({
      exec: { execHostEnabled: true },
      folders: [{ path: WORK2, mode: "rw" }],
    } as never);
    expect(await verdict(h, host(["ls"]))).not.toBe("allow");
  });

  it("does not let a hand-made grant for a never-program run", async () => {
    // A grant row for bash can only exist if someone wrote it: the match still refuses.
    const h = harness();
    expect(await verdict(h, host(["bash", "-c", "ls"]))).toBe("ask");
    const issued = await card(h, host(["bash", "-c", "ls"]));
    expect(offer(issued)).toBeUndefined();
  });
});

describe("exec_host program grant: SQLite round trip", () => {
  it("survives a restart with its folder, binary identity and argv rule intact", async () => {
    const db = memoryDb();
    const clock = new FakeClock();
    const opts = { policy: POLICY as never, ...OPTS };
    const first = sqliteBroker(db, clock, opts as never);
    const h: Harness = { broker: first, clock } as Harness;
    await allowProgram(h, host(["ls", "-la"]));

    const second = sqliteBroker(db, clock, opts as never);
    const d = (c: PolicyCall) => second.decide(c, CTX).then((x) => x.decision);
    expect(await d(host(["ls", "-R"]))).toBe("allow");
    expect(await d(host(["tool", "log"]))).toBe("ask");
    expect(await d(host(["ls"], { sha: sha("ls-evil") }))).toBe("ask");
    expect(await d(host(["ls"], { cwd: WORK2 }))).toBe("ask");

    const grants = await second.listGrants({} as never);
    const mine = grants.filter((g) => (g.subject as { hostProgram?: unknown }).hostProgram);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.subject).toMatchObject({ hostProgram: { argv: null } });
    expect(mine.every((g) => g.scope === "always" && g.revokedAt === null)).toBe(true);

    await second.revokeGrant(mine[0]?.id ?? "");
    const third = sqliteBroker(db, clock, opts as never);
    expect((await third.decide(host(["ls"]), CTX)).decision).toBe("ask");
  });
});

describe("exec_host program grant: every path stays inside the folder", () => {
  async function grantedTools() {
    const h = harness();
    await allowProgram(h, host(["ls", "-la"]));
    await allowProgram(h, host(["find", ".", "-name", "x"]));
    await allowProgram(h, host(["sed", "-n", "p", "plain.txt"]));
    await allowProgram(h, host(["rg", "foo"]));
    await allowProgram(h, host(["tree", "-L", "1"]));
    await allowProgram(h, host(["grep", "-r", "foo", "."]));
    await allowProgram(h, host(["du", "-s", "."]));
    await allowProgram(h, host(["jq", ".", "plain.txt"]));
    await allowProgram(h, host(["head", "-n", "1", "plain.txt"]));
    return h;
  }
  const RUN: [string, string[]][] = [
    ["ls", ["-la", "sub"]],
    ["ls", ["--", "weird"]],
    ["find", [".", "-name", "*.ts"]],
    ["find", ["sub", "-type", "f"]],
    ["sed", ["-n", "/x/p", "plain.txt"]],
    ["sed", ["-e", "s/a/b/", "plain.txt"]],
    ["rg", ["foo", "sub"]],
    ["tree", ["-L", "2"]],
    ["ls", ["-R"]],
    ["grep", ["-r", "foo", "."]],
    ["rg", ["foo"]],
    ["rg", ["--ignore-file=plain.txt", "foo"]],
    ["du", ["-s", "sub"]],
    // A separate option value is skipped, so the options after it are not late.
    ["rg", ["-t", "ts", "-i", "foo"]],
    ["rg", ["--type", "ts", "-i", "foo", "."]],
    ["grep", ["-A", "3", "-n", "foo", "."]],
    ["grep", ["-C", "2", "-rn", "foo", "."]],
    ["tree", ["-I", "node_modules", "-L", "2"]],
    ["tree", ["-LI", "2", "x", "-a"]],
    ["head", ["-n", "20", "-q", "plain.txt"]],
    ["du", ["-d", "1", "-h", "."]],
    ["jq", ["--arg", "k", "v", "-r", ".", "plain.txt"]],
    ["jq", ["--slurpfile", "k", "plain.txt", "-n", "1"]],
    ["rg", ["--file", "plain.txt", "-i", "."]],
    ["grep", ["-f", "plain.txt", "-r", "x", "."]],
    ["jq", ["-L", "sub", "-n", "1"]],
  ];
  const ASK: [string, string[]][] = [
    ["ls", ["-la", join(HOME, ".aws")]],
    ["ls", ["~"]],
    ["ls", ["escape"]],
    ["ls", ["../work2"]],
    ["find", ["/", "-name", "id_rsa*"]],
    ["find", ["-name", "x"]],
    ["find", [".."]],
    ["find", [".", "-newer", join(HOME, "x")]],
    ["sed", ["-n", "p", join(HOME, ".aws", "credentials")]],
    ["sed", ["-n", "p", "../../../etc/passwd"]],
    ["sed", ["p", "plain.txt", "-e", "1e id"]],
    ["sed", ["p", "plain.txt", "-i"]],
    ["rg", ["-uu", "KEY", join(HOME, "proj")]],
    ["rg", ["foo", "a.txt"]],
    ["tree", ["-R", "-L", "1"]],
    ["tree", ["-H", "."]],
    ["tree", ["/"]],
    // A link inside the folder to outside: the flags that follow it ask.
    ["rg", ["-L", "TOKEN", "."]],
    ["rg", ["--follow", "TOKEN"]],
    ["grep", ["-rS", "TOKEN", "."]],
    ["grep", ["-R", "TOKEN", "."]],
    ["grep", ["--dereference-recursive", "TOKEN", "."]],
    ["find", [".", "-follow", "-name", "secret.txt"]],
    ["find", ["-L", "."]],
    ["ls", ["-LR", "."]],
    ["tree", ["-l", "."]],
    ["du", ["-L", "."]],
    // Option values name paths too.
    ["rg", [`--ignore-file=${join(HOME, "ignore")}`, "foo"]],
    ["rg", [`--file=${join(OUTSIDE, "pats")}`, "."]],
    ["rg", [`-f${join(OUTSIDE, "pats")}`, "."]],
    ["rg", ["--ignore-file=../work2/x", "foo"]],
    ["grep", [`--file=${join(HOME, "pats")}`, "-r", "."]],
    ["jq", [`-L${OUTSIDE}`, "-n", "1"]],
    ["jq", [`--library-path=${OUTSIDE}`, "-n", "1"]],
    ["jq", ["-L", OUTSIDE, "-n", "1"]],
    ["du", ["--files0-from=list"]],
    // A separate value that names a path is checked like an operand.
    ["grep", ["-f", "/etc/passwd", "-r", "x", "."]],
    ["grep", ["-f", join(OUTSIDE, "pats"), "x"]],
    ["grep", ["--file", join(OUTSIDE, "pats"), "x"]],
    ["rg", ["--file", join(OUTSIDE, "pats"), "."]],
    ["rg", ["-f", join(HOME, "pats"), "."]],
    ["rg", ["--ignore-file", "/etc/passwd", "foo"]],
    ["rg", ["--ignore-file", "../work2/x", "foo"]],
    ["rg", ["-t", "ts", "--ignore-file", join(OUTSIDE, "ig"), "foo"]],
    ["jq", ["-L", "/outside", "-n", 'import "x" as x; 1']],
    ["jq", ["-nL", OUTSIDE, "1"]],
    ["jq", ["--library-path", OUTSIDE, "-n", "1"]],
    ["jq", ["--slurpfile", "k", join(HOME, "x.json"), "-n", "1"]],
    ["jq", ["--rawfile", "k", "/etc/passwd", "-n", "1"]],
    ["jq", ["--arg", "k", "v", "--rawfile", "r", "../work2/x", "-n", "1"]],
    ["tree", ["--gitfile", "/etc/passwd", "-a"]],
    // Flags and operands behind a separate value are still seen.
    ["grep", ["-A", "3", "-rS", "foo", "."]],
    ["rg", ["-t", "ts", "-L", "foo"]],
    ["rg", ["-t", "ts", "--pre=./x.sh", "foo"]],
    ["tree", ["-I", "x", "-l", "."]],
    ["grep", ["-e", "-rS", "."]],
    ["rg", ["-e", "--pre=./x.sh", "."]],
    ["du", ["-d", "1", "-L", "."]],
    ["rg", ["-t", "ts", "-i", "foo", "/etc"]],
    ["grep", ["-A", "3", "-n", "foo", "/etc"]],
    ["head", ["-n", "20", "-q", join(HOME, "x")]],
    ["tree", ["-LI", "2", "x", "/"]],
    ["tree", ["-L2", "/"]],
    ["tree", ["-L22", "/"]],
    ["tree", ["-L2I", "x", "/"]],
    ["jq", ["--arg", "k", "v", "-r", ".", join(HOME, "x.json")]],
  ];
  it.each(RUN)("%s %j runs quietly", async (name, args) => {
    const h = await grantedTools();
    expect(await verdict(h, host([name, ...args]))).toBe("allow");
  });
  it.each(ASK)("%s %j asks", async (name, args) => {
    const h = await grantedTools();
    expect(await verdict(h, host([name, ...args]))).not.toBe("allow");
  });
  it("attached option values are paths too, in the folder or out of it", () => {
    expect(operandsInside("rg", ["--ignore-file=plain.txt", "foo"], WORK, WORK)).toBe(true);
    expect(operandsInside("rg", [`--ignore-file=${OUTSIDE}/x`, "foo"], WORK, WORK)).toBe(false);
    expect(operandsInside("jq", ["-Lsub", "-n", "1"], WORK, WORK)).toBe(true);
    expect(operandsInside("jq", [`-L${OUTSIDE}`, "-n", "1"], WORK, WORK)).toBe(false);
    expect(operandsInside("rg", [`-nf${OUTSIDE}/p`], WORK, WORK)).toBe(false);
  });
  it("a separate option value is skipped only where the option is known to take one", () => {
    const inside = (name: string, args: string[]) => operandsInside(name, args, WORK, WORK);
    // Known value options: a plain value is no operand, a path value is judged as one.
    expect(inside("rg", ["-t", "/etc/passwd", "foo"])).toBe(true);
    expect(inside("grep", ["-e", "/etc/passwd", "."])).toBe(true);
    expect(inside("rg", ["--ignore-file", "plain.txt", "foo"])).toBe(true);
    expect(inside("rg", ["--ignore-file", `${OUTSIDE}/x`, "foo"])).toBe(false);
    expect(inside("grep", ["-f", `${OUTSIDE}/x`, "foo"])).toBe(false);
    expect(inside("jq", ["-L", `${OUTSIDE}`, "-n", "1"])).toBe(false);
    expect(inside("jq", ["--arg", "k", "/etc/passwd", "-n", "1"])).toBe(true);
    expect(inside("jq", ["--rawfile", "k", "/etc/passwd", "-n", "1"])).toBe(false);
    // Unknown or abbreviated long options, BSD's optional values, jq -f (a boolean in jq 1.7)
    // and tools without a table keep the next argument as an operand.
    expect(inside("rg", ["--typ", "/etc/passwd", "foo"])).toBe(false);
    expect(inside("rg", ["--no-such", "/etc/passwd", "foo"])).toBe(false);
    expect(inside("grep", ["--context", "/etc/passwd", "foo"])).toBe(false);
    expect(inside("grep", ["--color", "/etc/passwd", "foo"])).toBe(false);
    expect(inside("jq", ["-f", "/etc/passwd", "-n"])).toBe(false);
    expect(inside("jq", ["--from-file", "/etc/passwd"])).toBe(false);
    expect(inside("ls", ["-w", "/etc/passwd"])).toBe(false);
    expect(inside("stat", ["-f", "/etc/passwd", "x"])).toBe(false);
    expect(inside("file", ["-F", "/etc/passwd", "x"])).toBe(false);
    // An attached value takes no slot; a dash-led value is not skipped.
    expect(inside("rg", ["-tts", "/etc/passwd"])).toBe(false);
    expect(inside("rg", ["--type=ts", "/etc/passwd"])).toBe(false);
    expect(inside("rg", ["-t", "-/etc/x", "foo"])).toBe(true);
    // tree: each value letter of a cluster takes one following argument, in order.
    expect(inside("tree", ["-LI", "2", "x"])).toBe(true);
    expect(inside("tree", ["-LI", "2", "x", "/etc"])).toBe(false);
    expect(inside("tree", ["-LI", "2"])).toBe(true);
    // `-L` with attached digits takes nothing from the next argument (review of #1372).
    expect(inside("tree", ["-L2", "/etc"])).toBe(false);
    expect(inside("tree", ["-L22", "/etc"])).toBe(false);
    expect(inside("tree", ["-L2I", "x", "/etc"])).toBe(false);
    expect(inside("tree", ["-L2I", "x"])).toBe(true);
    expect(inside("tree", ["-L2", "."])).toBe(true);
    // Only as many values as the cluster has slots.
    expect(inside("rg", ["-t", "ts", "/etc/passwd"])).toBe(false);
    expect(inside("jq", ["--arg", "k", "v", "/etc/passwd"])).toBe(false);
  });
  it("a PSYCHE_HOME inside the shared folder refuses the folder (no offer)", async () => {
    const inside = makeBroker({
      policy: POLICY as never,
      psycheHome: join(WORK, ".psyche"),
      ...OPTS,
    } as never);
    expect(offer(await card(inside, host(["ls"])))).toBeUndefined();
    expect(offer(await card(harness(), host(["ls"])))).toBeDefined();
  });
  it("operandsInside judges the real path, with and without the files existing", () => {
    expect(operandsInside("ls", ["plain.txt", "not-there/x"], WORK, WORK)).toBe(true);
    expect(operandsInside("ls", ["escape/proj"], WORK, WORK)).toBe(false);
    expect(operandsInside("ls", ["a.txt"], WORK, WORK)).toBe(false);
    expect(operandsInside("ls", [], WORK2, WORK)).toBe(false);
  });
});
