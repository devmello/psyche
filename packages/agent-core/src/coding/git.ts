import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { PsycheError } from "@psyche/protocol";

/**
 * Git for `code.git` (V10). Git runs on the host, because the repository's history and the
 * owner's credentials live there, but only as the fixed argv this module builds: never a shell,
 * never an argv from the model. Every invocation turns hooks off (a hook is code in the working
 * tree or `.git`, which a tainted turn may have written), fsmonitor off, and every filter, diff
 * and merge driver the repository's config names off (`gitDriverOverrides`), prompts off. A push is refused unless the remote's URL and the branch's commit still
 * equal the ones the owner approved, and it is never forced.
 */

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs `git <args>` in `cwd` without a shell; the Gateway supplies it (`compose/coding.ts`). */
export interface GitRunner {
  run(
    cwd: string,
    args: readonly string[],
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<GitResult>;
}

/** Bytes of git output a tool result carries. */
export const GIT_OUTPUT_CAP = 128 * 1024;

/**
 * Prefixed to every invocation. `--literal-pathspecs`: a path is a file name, never pathspec
 * magic, so `:!notes.md`, `:(exclude)…` or `*.md` in a commit's paths cannot widen what it stages.
 */
export const GIT_HARDENING = [
  "--literal-pathspecs",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.pager=cat",
  "-c",
  "color.ui=false",
  "-c",
  "advice.detachedHead=false",
] as const;

/**
 * Lists the filter, diff and merge drivers git's config defines. Reading config runs no program,
 * so this is safe to run first; its names feed `gitDriverOverrides`.
 */
export const GIT_DRIVER_QUERY = [
  "config",
  "--name-only",
  "--get-regexp",
  "^(filter|diff|merge)\\.",
] as const;

const UNSWITCHABLE =
  "a git driver in this repository's config has a name that cannot be switched off; the command was not run";

/**
 * `-c` pairs that switch off every driver `GIT_DRIVER_QUERY` listed: a `.gitattributes` line
 * (`* filter=x diff=x`) runs `filter.x.clean` / `process` on status and diff, `diff.x.textconv`
 * on diff, `merge.x.driver` on merge. Empty values turn each off (git checks `*cmd`).
 */
export function gitDriverOverrides(listed: string): string[] {
  const out = new Set<string>();
  for (const line of listed.split("\n")) {
    const m = /^(filter|diff|merge)\.(.*)\.[^.]+$/i.exec(line.trim());
    // `(.*)`: an empty driver name (`[filter ""]`, listed as `filter..clean`) is a driver too,
    // and `-c filter..clean=` switches it off.
    // Keys without a subsection (`diff.renames`, `merge.conflictstyle`) name no driver.
    if (m === null) continue;
    const section = (m[1] as string).toLowerCase();
    const name = m[2] as string;
    // A name `-c` cannot carry (it splits on the first `=` and trims) gets no override, and
    // leaving it out would let the driver run: fail closed, refuse the whole command.
    if (/[=\s]/.test(name)) throw new PsycheError("forbidden", UNSWITCHABLE);
    const keys =
      section === "filter"
        ? ["clean=", "smudge=", "process=", "required=false"]
        : section === "diff"
          ? ["textconv=", "command="]
          : ["driver="];
    for (const k of keys) out.add(`${section}.${name}.${k}`);
  }
  return [...out].flatMap((v) => ["-c", v]);
}

/** Branch names `code.git` accepts (a strict subset of `git check-ref-format --branch`). */
export const BRANCH_PATTERN =
  "^(?!-)(?!.*\\.\\.)(?!.*//)(?!.*@\\{)(?!.*\\.lock$)(?!.*/$)[A-Za-z0-9._/-]{1,200}$";
/** Remote names. */
export const REMOTE_PATTERN = "^(?!-)[A-Za-z0-9._-]{1,100}$";

export function capOutput(text: string): { text: string; truncated: boolean } {
  const b = Buffer.from(text, "utf8");
  if (b.byteLength <= GIT_OUTPUT_CAP) return { text, truncated: false };
  return { text: b.subarray(0, GIT_OUTPUT_CAP).toString("utf8"), truncated: true };
}

/**
 * Refuses unless `<root>/.git` is a real folder: not a link, not a `gitdir:` file, not missing.
 * Git otherwise finds its repository by itself, and a planted `.git` link or file (an archive, a
 * `code.run` in a folder without git) or a workspace inside a bigger repository would point it at
 * history, an index and files outside the workspace. A subfolder of a repository gets no
 * `code.git`: opening the repository root itself does. The repository's own config must not set
 * a key that runs a program or redirects git (`riskyLocalGitKey`).
 */
export async function assertOwnRepository(
  runner: GitRunner,
  root: string,
  signal?: AbortSignal,
): Promise<void> {
  const gitDir = join(root, ".git");
  const st = await lstat(gitDir).catch(() => undefined);
  if (st?.isDirectory() !== true) {
    throw new PsycheError(
      "forbidden",
      "git works only in a workspace that is its own repository root (a real .git folder)",
      { details: { reason: "not_own_repository" } },
    );
  }
  // A `commondir` file makes git read the config, refs and objects of another `.git`.
  if (await lstat(join(gitDir, "commondir")).catch(() => undefined)) {
    throw new PsycheError(
      "forbidden",
      `${gitDir} points at another repository (commondir); code.git works only in a repository's own .git`,
      { details: { reason: "not_own_repository" } },
    );
  }
  await assertSafeLocalConfig(runner, root, signal);
}

/**
 * Keys of a repository's own `.git/config` that run a program on the host, pull in other config,
 * or send git somewhere else. A `.git` written by a tainted turn (a `code.run` in a folder that
 * had none, an unpacked archive) is otherwise a way to run code as the owner: `core.sshCommand`
 * on a push, `credential.helper`, `alias.*`, a filter. `name` is as git prints it: section and
 * key lowercased, the subsection as written.
 */
export function riskyLocalGitKey(name: string): boolean {
  const n = name.toLowerCase();
  const first = n.indexOf(".");
  const last = n.lastIndexOf(".");
  if (first <= 0 || last === n.length - 1) return true; // not a key git would print: fail closed
  const section = n.slice(0, first);
  const key = n.slice(last + 1);
  const sub = first !== last;
  if (RISKY_SECTIONS.has(section)) return true;
  switch (section) {
    case "core":
      return RISKY_CORE_KEYS.has(key);
    case "diff":
      return sub ? key === "textconv" || key === "command" : key === "external";
    case "merge":
      return sub && key === "driver";
    case "gpg":
      return key === "program" || key === "defaultkeycommand";
    case "sequence":
      return key === "editor";
    case "http":
      return key.includes("proxy");
    case "url":
      return key === "insteadof" || key === "pushinsteadof";
    case "remote":
      return sub && REMOTE_PROGRAM_KEYS.has(key);
    case "protocol":
      return key === "allow";
    case "extensions":
      // Makes git read `.git/config.worktree` as well, which this check does not.
      return key === "worktreeconfig";
    case "trailer":
      return key === "command" || key === "cmd";
    default:
      return false;
  }
}

/** Every key in these sections names a program, a credential source or more config. */
const RISKY_SECTIONS = new Set([
  "include",
  "includeif",
  "credential",
  "filter",
  "alias",
  "uploadpack",
  "pager",
  "difftool",
  "mergetool",
]);
/**
 * `core.hooksPath`, `core.fsmonitor` and `core.pager` are not here: `GIT_HARDENING` forces them on
 * every call with `-c`, which beats the repository's config, so they cannot run anything; and
 * `husky install` writes `core.hooksPath=.husky` into most JavaScript repositories.
 */
const RISKY_CORE_KEYS = new Set([
  "sshcommand",
  "askpass",
  "editor",
  "gitproxy",
  "worktree",
  "alternaterefscommand",
]);
const REMOTE_PROGRAM_KEYS = new Set(["uploadpack", "receivepack", "proxy", "vcs"]);

/**
 * Refuses a repository whose own config sets a `riskyLocalGitKey`. The file is listed by name
 * only and without following includes (an `include.path` is itself refused); a config that
 * cannot be listed is refused too.
 */
async function assertSafeLocalConfig(
  runner: GitRunner,
  root: string,
  signal?: AbortSignal,
): Promise<void> {
  const file = join(root, ".git", "config");
  const st = await lstat(file).catch(() => undefined);
  if (st === undefined) return;
  const refuse = (why: string, keys?: string[]) =>
    new PsycheError("forbidden", why, {
      details: { reason: "unsafe_repository_config", ...(keys === undefined ? {} : { keys }) },
    });
  if (!st.isFile()) throw refuse(`${file} is not a regular file; code.git does not run there`);
  const r = await runner.run(
    root,
    [
      ...GIT_HARDENING,
      ...gitDirArgs(root),
      "config",
      "--file",
      file,
      "--null",
      "--name-only",
      "--list",
    ],
    signal === undefined ? {} : { signal },
  );
  if (r.exitCode !== 0) throw refuse(`${file} could not be read; code.git does not run there`);
  const risky = [...new Set(r.stdout.split("\0").filter((k) => k !== "" && riskyLocalGitKey(k)))];
  if (risky.length > 0) {
    throw refuse(
      `this repository's own .git/config sets ${risky.slice(0, 5).join(", ")}${risky.length > 5 ? ` and ${risky.length - 5} more` : ""}: a program git would run, more config or a redirect. code.git does not run there; the owner can remove it with \`git config --unset\``,
      risky,
    );
  }
}

/** The keys a repository could use to run a program, pinned to the owner's own values. */
const PINNED_QUERY = [
  "config",
  "--show-scope",
  "-z",
  "--get-regexp",
  "^(credential\\.helper|core\\.sshcommand|core\\.askpass)$",
] as const;
const REPO_SCOPES = new Set(["local", "worktree", "command"]);

/**
 * `-c` pairs that pin `credential.helper`, `core.sshCommand` and `core.askPass` to the values
 * the owner's own config gives them (system, global, the git binary's own): a repository's
 * config written after `assertOwnRepository` looked still cannot add a program. An empty
 * `credential.helper` resets the list, then the owner's helpers (the keychain) come back.
 */
export function ownerPins(listed: string): string[] {
  const values = new Map<string, string[]>();
  const parts = listed.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i] ?? "";
    const entry = parts[i + 1] ?? "";
    if (REPO_SCOPES.has(scope)) continue;
    const nl = entry.indexOf("\n");
    const key = (nl < 0 ? entry : entry.slice(0, nl)).toLowerCase();
    const value = nl < 0 ? "" : entry.slice(nl + 1);
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  const helpers = values.get("credential.helper") ?? [];
  const last = (k: string) => values.get(k)?.at(-1);
  return [
    "-c",
    "credential.helper=",
    ...helpers.filter((h) => h !== "").flatMap((h) => ["-c", `credential.helper=${h}`]),
    "-c",
    `core.sshCommand=${last("core.sshcommand") || "ssh"}`,
    "-c",
    `core.askPass=${last("core.askpass") ?? ""}`,
  ];
}

/**
 * The repository git uses, pinned to the root: `--git-dir` and `--work-tree` stop discovery, so
 * git never reads a `.git` above the root or one a link or `gitdir:` file names. Callers check
 * `assertOwnRepository` first.
 */
export function gitDirArgs(root: string): string[] {
  return [`--git-dir=${join(root, ".git")}`, `--work-tree=${root}`];
}

export async function git(
  runner: GitRunner,
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<GitResult> {
  const opts = signal === undefined ? {} : { signal };
  const pin = gitDirArgs(cwd);
  const drivers = await runner.run(cwd, [...GIT_HARDENING, ...pin, ...GIT_DRIVER_QUERY], opts);
  const off = drivers.exitCode === 0 ? gitDriverOverrides(drivers.stdout) : [];
  // Exit 1: none of the keys is set anywhere.
  const owner = await runner.run(cwd, [...GIT_HARDENING, ...pin, ...PINNED_QUERY], opts);
  if (owner.exitCode !== 0 && owner.exitCode !== 1) {
    throw new PsycheError("conflict", "git config could not be read; the command was not run");
  }
  const pins = ownerPins(owner.exitCode === 0 ? owner.stdout : "");
  return runner.run(cwd, [...GIT_HARDENING, ...pin, ...pins, ...off, ...args], opts);
}

/** Runs and throws on a non-zero exit, with git's own message. */
export async function gitOk(
  runner: GitRunner,
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const r = await git(runner, cwd, args, signal);
  if (r.exitCode !== 0) {
    const msg = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ");
    throw new PsycheError("conflict", `git ${args[0] ?? ""}: ${msg || `exit ${r.exitCode}`}`);
  }
  return r.stdout;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  head: string | null;
  files: { status: string; path: string }[];
  remotes: { name: string; url: string }[];
}

/** `git status --porcelain=v1 --branch` + `git remote -v` + HEAD. */
export function parseStatus(porcelain: string, remotes: string, head: string | null): GitStatus {
  const lines = porcelain.split("\n").filter((l) => l !== "");
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const first = lines[0];
  if (first?.startsWith("## ")) {
    const head = first.slice(3).replace(/^(No commits yet on |Initial commit on )/, "");
    if (!head.startsWith("HEAD (no branch)")) {
      const [refs = "", counts = ""] = head.split(" [");
      const [b = "", u] = refs.split("...");
      branch = b === "" ? null : b;
      upstream = u ?? null;
      ahead = Number(/ahead (\d+)/.exec(counts)?.[1] ?? 0);
      behind = Number(/behind (\d+)/.exec(counts)?.[1] ?? 0);
    }
    lines.shift();
  }
  const seen = new Map<string, string>();
  for (const l of remotes.split("\n")) {
    const m = /^(\S+)\t(\S+) \((fetch|push)\)$/.exec(l);
    if (m?.[1] !== undefined && m[2] !== undefined && (m[3] === "push" || !seen.has(m[1]))) {
      seen.set(m[1], m[2]);
    }
  }
  return {
    branch,
    upstream,
    ahead,
    behind,
    head,
    files: lines.map((l) => ({ status: l.slice(0, 2), path: l.slice(3) })),
    remotes: [...seen].map(([name, url]) => ({ name, url })),
  };
}
