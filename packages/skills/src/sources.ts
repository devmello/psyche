import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PsycheError, type SkillInstallSource } from "@psyche/protocol";
import { unzipSync } from "fflate";
import {
  DEFAULT_LIMITS,
  readSkillDir,
  type SkillTree,
  TreeBuilder,
  type TreeLimits,
} from "./tree.ts";

/**
 * Fetching a skill from an install source into memory (feature T2). Nothing is written under
 * `$PSYCHE_HOME/skills/` until the owner approves; the fetched tree is what gets scanned, shown,
 * hashed and later written.
 */
export interface FetchedSkill {
  tree: SkillTree;
  /** Git commit the ref resolved to. */
  commit?: string;
}

export interface SourceOptions {
  limits?: TreeLimits;
  /** Allow `file://` git URLs (tests, local mirrors). Default false. */
  allowFileGitUrls?: boolean;
  /** Git binary (default `git` on PATH). */
  gitBinary?: string;
  /** Milliseconds per git command (default 60 s). */
  gitTimeoutMs?: number;
}

const MAX_ZIP_BYTES = 5 * 1024 * 1024;

export async function fetchSource(
  source: SkillInstallSource,
  opts: SourceOptions = {},
): Promise<FetchedSkill> {
  switch (source.kind) {
    case "path":
      return fetchPath(source.path, opts);
    case "zip":
      return { tree: unzipSkill(readArchive(source.path), opts.limits) };
    case "git":
      return fetchGit(source.url, source.ref, opts);
  }
}

/** Reads an archive only if it is a regular file within the size limit (not `/dev/zero`). */
function readArchive(path: string): Uint8Array {
  const st = statSync(path);
  if (!st.isFile()) throw new PsycheError("invalid_params", "archive must be a regular file");
  if (st.size > MAX_ZIP_BYTES)
    throw new PsycheError("invalid_params", `archive is larger than ${MAX_ZIP_BYTES} bytes`);
  return readFileSync(path);
}

/** A folder, a `SKILL.md` inside one, or a `.zip` / `.skill` archive. */
function fetchPath(path: string, opts: SourceOptions): FetchedSkill {
  const real = realpathSync(path);
  const st = statSync(real);
  if (st.isFile() && /\.(?:zip|skill)$/i.test(real)) {
    return { tree: unzipSkill(readArchive(real), opts.limits) };
  }
  const dir = st.isFile() && basename(real) === "SKILL.md" ? dirname(real) : real;
  if (!statSync(dir).isDirectory())
    throw new PsycheError("invalid_params", "path must be a skill folder, its SKILL.md or a zip");
  return { tree: readSkillDir(dir, opts.limits) };
}

/**
 * Unpacks a zip (Claude's `.skill` files are zips). Entries are checked before inflating:
 * declared sizes against the limits, paths against traversal. A single top-level folder that
 * holds `SKILL.md` is stripped.
 */
export function unzipSkill(data: Uint8Array, limits: TreeLimits = DEFAULT_LIMITS): SkillTree {
  if (data.byteLength > MAX_ZIP_BYTES)
    throw new PsycheError("invalid_params", `archive is larger than ${MAX_ZIP_BYTES} bytes`);
  let count = 0;
  let declared = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter: (f) => {
        if (f.name.endsWith("/")) return false;
        count += 1;
        declared += f.originalSize;
        if (
          count > limits.maxFiles ||
          f.originalSize > limits.maxFileBytes ||
          declared > limits.maxTotalBytes
        )
          throw new PsycheError("invalid_params", "archive exceeds the skill size limits");
        return true;
      },
    });
  } catch (err) {
    if (err instanceof PsycheError) throw err;
    throw new PsycheError("invalid_params", `not a readable zip: ${(err as Error).message}`);
  }
  const names = Object.keys(files);
  let prefix = "";
  if (!names.includes("SKILL.md")) {
    const tops = new Set(names.map((n) => n.split("/")[0]));
    const [top] = [...tops];
    if (tops.size === 1 && top !== undefined && names.includes(`${top}/SKILL.md`))
      prefix = `${top}/`;
  }
  const b = new TreeBuilder(limits);
  for (const name of names.sort()) {
    if (!name.startsWith(prefix)) continue;
    b.add(name.slice(prefix.length), files[name] as Uint8Array);
  }
  return b.tree;
}

/** https, ssh and scp-style URLs; `file://` only when allowed. Never an option-looking string. */
export function checkGitUrl(url: string, allowFile = false): void {
  const ok =
    /^https:\/\/[^\s]+$/i.test(url) ||
    /^ssh:\/\/[^\s]+$/i.test(url) ||
    /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(url) ||
    (allowFile && /^file:\/\/\/[^\s]+$/.test(url));
  if (!ok || url.startsWith("-"))
    throw new PsycheError("invalid_params", "git URL must be https://, ssh:// or user@host:path");
  // Credentials in a URL would be stored in the lock file, the proposal and the approval card.
  if (/^(?:https|ssh|file):\/\//i.test(url)) {
    const u = new URL(url);
    if (u.password !== "" || (u.protocol === "https:" && u.username !== ""))
      throw new PsycheError("invalid_params", "git URL must not contain credentials");
  }
}

export function checkGitRef(ref: string): void {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(ref) || ref.startsWith("-") || ref.includes(".."))
    throw new PsycheError("invalid_params", "invalid git ref");
}

const GIT_SUBCOMMANDS = new Set(["init", "fetch", "rev-parse", "ls-tree", "cat-file"]);

function run(bin: string, args: string[], cwd: string, timeoutMs: number, binary = false) {
  return new Promise<Buffer>((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "buffer",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: cwd,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_ASKPASS: "/bin/false",
          SSH_ASKPASS: "/bin/false",
          GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
        },
      },
      (err, stdout, stderr) => {
        if (err !== null) {
          const msg = Buffer.from(stderr).toString("utf8").trim().split("\n").slice(-1)[0];
          const sub = args.find((a) => GIT_SUBCOMMANDS.has(a)) ?? "command";
          reject(new PsycheError("unavailable", `git ${sub} failed: ${msg || err.message}`));
        } else resolve(binary ? stdout : Buffer.from(stdout));
      },
    );
  });
}

/**
 * Fetches one commit without checking it out: `git fetch --depth 1`, then `ls-tree` and
 * `cat-file` per blob. No working tree means no hooks, filters, LFS smudge or symlinks on disk;
 * symlinks and submodules in the tree are refused. The ref is resolved to a commit for the lock.
 */
export async function fetchGit(
  url: string,
  ref: string,
  opts: SourceOptions = {},
): Promise<FetchedSkill> {
  checkGitUrl(url, opts.allowFileGitUrls === true);
  checkGitRef(ref);
  const git = opts.gitBinary ?? "git";
  const timeout = opts.gitTimeoutMs ?? 60_000;
  const protocols = [
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
    "-c",
    "protocol.ssh.allow=always",
    ...(opts.allowFileGitUrls === true ? ["-c", "protocol.file.allow=always"] : []),
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "submodule.recurse=false",
  ];
  const dir = mkdtempSync(join(tmpdir(), "psyche-skill-"));
  try {
    await run(git, [...protocols, "init", "-q", "--bare", "."], dir, timeout);
    await run(
      git,
      [...protocols, "fetch", "--depth", "1", "--no-tags", "-q", "--", url, ref],
      dir,
      timeout,
    );
    const commit = (await run(git, ["-C", dir, "rev-parse", "FETCH_HEAD^{commit}"], dir, timeout))
      .toString("utf8")
      .trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit))
      throw new PsycheError("unavailable", "could not resolve the ref");
    const listing = (
      await run(git, ["-C", dir, "ls-tree", "-r", "-z", "--full-tree", commit], dir, timeout)
    )
      .toString("utf8")
      .split("\0")
      .filter((l) => l.length > 0);
    const b = new TreeBuilder(opts.limits);
    for (const entry of listing) {
      const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(entry);
      if (m === null) throw new PsycheError("unavailable", "unexpected git ls-tree output");
      const [, mode, type, sha, path] = m as unknown as [string, string, string, string, string];
      if (mode === "120000")
        throw new PsycheError("invalid_params", `symbolic link in skill: ${path}`);
      if (type !== "blob") throw new PsycheError("invalid_params", `submodule in skill: ${path}`);
      const bytes = await run(git, ["-C", dir, "cat-file", "blob", sha], dir, timeout, true);
      b.add(path, new Uint8Array(bytes), mode === "100755");
    }
    return { tree: b.tree, commit };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
