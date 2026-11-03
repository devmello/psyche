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

/** Prefixed to every invocation. */
export const GIT_HARDENING = [
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

/**
 * `-c` pairs that switch off every driver `GIT_DRIVER_QUERY` listed: a `.gitattributes` line
 * (`* filter=x diff=x`) runs `filter.x.clean` / `process` on status and diff, `diff.x.textconv`
 * on diff, `merge.x.driver` on merge. Empty values turn each off (git checks `*cmd`).
 */
export function gitDriverOverrides(listed: string): string[] {
  const out = new Set<string>();
  for (const line of listed.split("\n")) {
    const m = /^(filter|diff|merge)\.(.+)\.[^.]+$/i.exec(line.trim());
    if (m === null) continue;
    const section = (m[1] as string).toLowerCase();
    const name = m[2] as string;
    // A name git cannot take back in `-c` is left alone; git then refuses the override and the
    // command fails rather than run the driver.
    if (/[=\s]/.test(name)) continue;
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

export async function git(
  runner: GitRunner,
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<GitResult> {
  const opts = signal === undefined ? {} : { signal };
  const drivers = await runner.run(cwd, [...GIT_HARDENING, ...GIT_DRIVER_QUERY], opts);
  const off = drivers.exitCode === 0 ? gitDriverOverrides(drivers.stdout) : [];
  return runner.run(cwd, [...GIT_HARDENING, ...off, ...args], opts);
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
