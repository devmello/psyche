import { randomBytes } from "node:crypto";
import type { BigIntStats, Dirent } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { findLaunchConfig, type LaunchConfigScan } from "@psyche/hostfs";
import { PsycheError, type SandboxMount } from "@psyche/protocol";

/**
 * `code.run` and app launch config (#1434 reviews r1 and r2, #1435 review r1). A command in the
 * sandbox may change the working tree, but what an app or the next command on the host runs from
 * it (`.vscode`, `.obsidian`, `.husky`, `.npmrc`...; `launchConfigEntry`) is judged over the run
 * window only, right before and right after the command:
 * - existing launch-config folders, `.claude` (Claude Code's settings and the worktrees in it)
 *   and every nested repository's `.git` are mounted read-only over the repository, like the
 *   root `.git`; more than `MAX_LAUNCH_CONFIG_MOUNTS` of them and the run is refused;
 * - an entry that appeared during the run is moved into a quarantine under `$PSYCHE_HOME`, never
 *   deleted; the owner gets a notice whose "Keep it" puts it back (`keepQuarantined`);
 * - a change to an existing entry (an existing launch-config file, which no runtime can mount
 *   read-only on its own, a file in a read-only folder, a git folder's config, hooks and info) is
 *   reported, not reverted: it may be the owner's own IDE or Claude Code. Known IDE noise inside
 *   the read-only folders (`LAUNCH_CONFIG_NOISE`) is left out.
 * Moves check the identity of what they moved: a folder swapped for a link meanwhile (a process
 * the run left running) cannot make one take something of the owner's from elsewhere. A writer
 * left running after the check is not seen (a residual: the copy-out design is the fix).
 */

/** Read-only folder mounts at most (each is one bind mount); over it `code.run` is refused. */
export const MAX_LAUNCH_CONFIG_MOUNTS = 24;
/** Files fingerprinted at most per folder (read-only folders and git's hooks and info). */
const MAX_PRINTS_PER_FOLDER = 5_000;
const FULL = { maxDirs: 50_000, maxFound: 512, nestedGit: true } as const;
/** The fallback when the full walk is over its limits: the root and its folders. */
const TOP = { maxDirs: 50_000, maxFound: 512, maxDepth: 1, nestedGit: true } as const;
/** What a git folder runs code from or reads config from. */
const GIT_WATCHED = ["config", "hooks", "info"];
const QUARANTINE_ID = /^[0-9]{13}-[0-9a-f]{8}$/;
/** Claude Code's folder: mounted read-only whole, so its worktrees' settings are covered too. */
const CLAUDE_DIR = ".claude";

/**
 * Files apps rewrite all the time inside their own folder, left out of "changed" (only inside a
 * read-only-mounted launch-config folder, which the sandbox cannot write): JetBrains' workspace
 * state and shelf, Obsidian's open panes, VS Code's logs. As `[folder, test on the path inside]`.
 */
export const LAUNCH_CONFIG_NOISE: readonly (readonly [string, (inner: string) => boolean])[] = [
  [".idea", (p) => p === "workspace.xml" || p.startsWith("shelf/")],
  [".obsidian", (p) => /^workspace[^/]*\.json$/.test(p)],
  [".vscode", (p) => /^[^/]+\.log$/.test(p)],
];

export interface LaunchConfigReport {
  /** Entries the run created, moved into the quarantine (repository-relative). */
  quarantined: string[];
  /** The quarantine that holds them, for "Keep it". */
  quarantineId?: string;
  /** Existing entries that changed during the run: reported, never moved. */
  changed: string[];
  /** What each changed path is now (its fingerprint, `gone` when it went). */
  fingerprints: Record<string, string>;
  /** New entries that could not be moved, or moved something other than was checked. */
  unmoved: string[];
  /** The repository was too large to walk: only its top levels were checked. */
  partial: boolean;
}

export interface LaunchConfigGuard {
  /** Read-only mounts for the existing launch-config folders, `.claude` and nested `.git`s. */
  mounts: SandboxMount[];
  /** Run after the command. Never throws; what it could not handle is in `unmoved`. */
  settle(): Promise<LaunchConfigReport>;
}

export interface LaunchGuardOptions {
  /** Where new entries go: `$PSYCHE_HOME/quarantine/code-run`. */
  quarantineDir: string;
  now?: () => Date;
  /** Folders walked at most before the walk falls back to the top levels (default 50 000). */
  maxDirs?: number;
  /** Test seam: runs between a move's checks and the move itself. */
  beforeMove?: (from: string) => Promise<void> | void;
}

type Limits = { maxDirs: number; maxFound: number; maxDepth?: number; nestedGit: true };

/**
 * Snapshots the launch config under `root` (a canonical, real path) before a run that mounts it
 * read-write at `mountRoot`. Refuses (`forbidden`) when more folders need a read-only mount than
 * one sandbox takes.
 */
export async function guardLaunchConfig(
  root: string,
  mountRoot: string,
  options: LaunchGuardOptions,
): Promise<LaunchConfigGuard> {
  const full: Limits = { ...FULL, maxDirs: options.maxDirs ?? FULL.maxDirs };
  let scan = await findLaunchConfig(root, full);
  const partial = !scan.complete;
  const limits: Limits = partial ? TOP : full;
  if (partial) scan = await findLaunchConfig(root, TOP);
  const claude = await isRealDir(join(root, CLAUDE_DIR));
  const readOnly = [
    ...(claude ? [CLAUDE_DIR] : []),
    ...scan.found
      .filter((f) => f.kind === "dir" && !underClaude(f.rel, claude))
      .map((f) => f.rel)
      .sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1)),
  ];
  if (readOnly.length > MAX_LAUNCH_CONFIG_MOUNTS) {
    throw new PsycheError(
      "forbidden",
      `${root} has ${readOnly.length} app launch-config and git folders; code.run keeps at most ${MAX_LAUNCH_CONFIG_MOUNTS} read-only, so it does not run here`,
      { details: { reason: "launch_config_too_many", count: readOnly.length } },
    );
  }
  const before = await prints(root, scan);
  return {
    mounts: readOnly.map((rel) => ({
      source: join(root, rel),
      target: `${mountRoot}/${rel}`,
      readOnly: true,
    })),
    settle: () => settle(root, scan, claude, before, limits, partial, options),
  };
}

const depth = (rel: string) => rel.split("/").length;
const underClaude = (rel: string, claude: boolean) =>
  claude && (rel === CLAUDE_DIR || rel.startsWith(`${CLAUDE_DIR}/`));

async function isRealDir(path: string): Promise<boolean> {
  const st = await lstat(path).catch(() => undefined);
  return st?.isDirectory() === true;
}

async function settle(
  root: string,
  was: LaunchConfigScan,
  claudeBefore: boolean,
  before: Map<string, string>,
  limits: Limits,
  partial: boolean,
  options: LaunchGuardOptions,
): Promise<LaunchConfigReport> {
  const report: LaunchConfigReport = {
    quarantined: [],
    changed: [],
    fingerprints: {},
    unmoved: [],
    partial,
  };
  let now: LaunchConfigScan;
  try {
    now = await findLaunchConfig(root, limits);
  } catch {
    report.unmoved.push(".");
    return report;
  }
  if (!now.complete) report.partial = true;
  const known = new Set(was.found.map((f) => f.rel));
  // New: launch config the run created, and a `.claude` that was not there (its worktrees are
  // never walked). A new nested `.git` is a clone the run made: reported, not moved.
  const fresh = now.found
    .filter((f) => !known.has(f.rel) && f.git !== true)
    .map((f) => f.rel)
    .filter((rel) => !(!claudeBefore && rel.startsWith(`${CLAUDE_DIR}/`)));
  if (!claudeBefore && (await lstat(join(root, CLAUDE_DIR)).catch(() => undefined))) {
    fresh.unshift(CLAUDE_DIR);
  }
  if (fresh.length > 0) {
    const id = `${(options.now?.() ?? new Date()).getTime()}-${randomBytes(4).toString("hex")}`;
    const held = join(options.quarantineDir, id);
    for (const rel of fresh) {
      try {
        await moveChecked(join(root, rel), join(held, "entries", rel), {
          root,
          rel,
          ...(options.beforeMove === undefined ? {} : { beforeMove: options.beforeMove }),
        });
        report.quarantined.push(rel);
      } catch {
        report.unmoved.push(rel);
      }
    }
    if (report.quarantined.length > 0) {
      report.quarantineId = id;
      await writeRecord(held, { root, entries: report.quarantined }).catch(() => undefined);
    }
  }
  // Existing entries: what is there now against what was there, for the same paths.
  const after = await prints(root, {
    found: now.found.filter((f) => known.has(f.rel) || f.git === true),
    complete: true,
  });
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const key of [...keys].sort()) {
    const was = before.get(key);
    const is = after.get(key);
    if (was === is || noise(key, was, is)) continue;
    report.changed.push(key);
    report.fingerprints[key] = is?.split("\0in:")[0] ?? "gone";
  }
  return report;
}

/**
 * IDE noise: a known file inside a read-only launch-config folder (a print taken inside one
 * carries that folder's path).
 */
function noise(key: string, ...prints: (string | undefined)[]): boolean {
  const inside = prints.find((p) => p?.includes("\0in:"))?.split("\0in:")[1];
  if (inside === undefined) return false;
  const folder = inside.split("/").pop()?.toLowerCase() ?? "";
  const inner = key.slice(inside.length + 1);
  return LAUNCH_CONFIG_NOISE.some(([name, test]) => name === folder && test(inner));
}

/**
 * A fingerprint per path: each launch-config file and link, each file and link inside a
 * launch-config folder, and each git folder's config, hooks and info. Inode, size, mtime and
 * ctime (a write through any share moves the host ctime, which nothing unprivileged can set
 * back). A print taken inside a launch-config folder carries that folder's path, for `noise`.
 */
async function prints(root: string, scan: LaunchConfigScan): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const one = async (rel: string, folder?: string) => {
    const st = await lstat(join(root, rel), { bigint: true }).catch(() => undefined);
    if (st === undefined) return undefined;
    const p = await print(join(root, rel), st);
    out.set(rel, folder === undefined ? p : `${p}\0in:${folder}`);
    return st;
  };
  const walk = async (rel: string, folder?: string) => {
    let budget = MAX_PRINTS_PER_FOLDER;
    const queue = [rel];
    while (queue.length > 0 && budget > 0) {
      const dir = queue.shift() as string;
      let entries: Dirent[];
      try {
        entries = await readdir(join(root, dir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of entries) {
        if (--budget < 0) break;
        const child = `${dir}/${d.name}`;
        if (d.isDirectory()) queue.push(child);
        else await one(child, folder);
      }
    }
  };
  const gitFolder = async (git: string) => {
    for (const name of GIT_WATCHED) {
      const rel = `${git}/${name}`;
      const st = await one(rel);
      if (st?.isDirectory() === true) {
        out.delete(rel);
        await walk(rel);
      }
    }
  };
  for (const f of scan.found) {
    if (f.git === true) {
      if (f.kind === "dir") await gitFolder(f.rel);
      else await one(f.rel);
    } else if (f.kind === "dir") {
      out.set(f.rel, "dir");
      await walk(f.rel, f.rel);
    } else {
      await one(f.rel);
    }
  }
  if (await isRealDir(join(root, ".git"))) await gitFolder(".git");
  return out;
}

async function print(path: string, st: BigIntStats): Promise<string> {
  if (st.isSymbolicLink()) return `link:${await readlink(path).catch(() => "?")}`;
  const kind = st.isFile() ? "file" : st.isDirectory() ? "dir" : "other";
  return `${kind}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}

/**
 * `rel`'s folder, and every folder between it and `root`, must be the real folder the walk saw:
 * a link swapped in since would take a move outside the repository. Checked on the deepest one
 * that exists, so Keep can check before it makes any.
 */
async function assertInside(root: string, rel: string): Promise<void> {
  let dir = dirname(join(root, rel));
  for (;;) {
    const real = await realpath(dir).catch(() => undefined);
    if (real !== undefined) {
      if (real !== dir) throw new PsycheError("forbidden", `${dir} moved during the check`);
      return;
    }
    if (dir === root || dirname(dir) === dir) {
      throw new PsycheError("forbidden", `${root} moved during the check`);
    }
    dir = dirname(dir);
  }
}

const same = (a: BigIntStats | undefined, b: BigIntStats | undefined) =>
  a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino;

/**
 * Moves `from` (`rel` in `root`) to `to`, then makes sure what arrived is what was checked and
 * that `from`'s folder is still the one it was: if a folder on the way was swapped for a link,
 * the move is undone and fails. A rename, or a copy then removal across volumes.
 */
async function moveChecked(
  from: string,
  to: string,
  at: { root: string; rel: string; beforeMove?: (from: string) => Promise<void> | void },
): Promise<void> {
  await assertInside(at.root, at.rel);
  const entry = await lstat(from, { bigint: true });
  const parent = await lstat(dirname(from), { bigint: true });
  if (
    await lstat(to).then(
      () => true,
      () => false,
    )
  ) {
    throw new PsycheError("conflict", `${to} already exists`);
  }
  await mkdir(dirname(to), { recursive: true });
  await at.beforeMove?.(from);
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    // Another volume: copied whole (links as links), and removed only when still the same entry.
    await cp(from, to, {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
    if (!same(await lstat(from, { bigint: true }).catch(() => undefined), entry)) {
      throw new PsycheError("forbidden", `${at.rel} changed while it was moved; it was left`);
    }
    await rm(from, { recursive: true, force: true });
    return;
  }
  const arrived = await lstat(to, { bigint: true }).catch(() => undefined);
  const still = await lstat(dirname(from), { bigint: true }).catch(() => undefined);
  if (!same(arrived, entry) || !same(still, parent)) {
    // Something else came through a swapped folder: put it back where it came from.
    await rename(to, from).catch(() => undefined);
    throw new PsycheError("forbidden", `${at.rel} changed while it was moved; it was left`);
  }
}

interface QuarantineRecord {
  root: string;
  entries: string[];
}

async function writeRecord(dir: string, record: QuarantineRecord): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "record.json"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export interface KeepResult {
  root: string;
  /** Entries put back where the run had made them. */
  kept: string[];
  /** Entries left in the quarantine: their name is taken again, or a folder on the way moved. */
  conflicts: string[];
}

/**
 * The owner's "Keep it": moves what quarantine `id` holds back into its repository. An entry
 * whose name is taken again, or whose folder is no longer the real one, stays held, and the call
 * fails with `conflict` naming it, so the notice stays open; nothing is overwritten.
 */
export async function keepQuarantined(
  quarantineDir: string,
  id: string,
  options: { beforeMove?: (from: string) => Promise<void> | void } = {},
): Promise<KeepResult> {
  if (!QUARANTINE_ID.test(id)) throw new PsycheError("invalid_params", "not a quarantine id");
  const dir = join(quarantineDir, id);
  let record: QuarantineRecord;
  try {
    record = JSON.parse(await readFile(join(dir, "record.json"), "utf8")) as QuarantineRecord;
  } catch {
    throw new PsycheError("not_found", "nothing is held for this notice any more");
  }
  const root = record.root;
  if (typeof root !== "string" || (await realpath(root).catch(() => undefined)) !== root) {
    throw new PsycheError("not_found", `${String(root)} is not where it was`);
  }
  const result: KeepResult = { root, kept: [], conflicts: [] };
  for (const rel of record.entries) {
    if (typeof rel !== "string" || rel.split("/").some((s) => s === ".." || s === "")) continue;
    const to = join(root, rel);
    const from = join(dir, "entries", rel);
    try {
      // Checked before any folder is made, then again by the move.
      await assertInside(root, rel);
      await mkdir(dirname(to), { recursive: true });
      await assertInside(root, rel);
      const parent = await lstat(dirname(to), { bigint: true });
      await moveChecked(from, to, {
        root: dir,
        rel: join("entries", rel),
        ...(options.beforeMove === undefined ? {} : { beforeMove: options.beforeMove }),
      });
      if (
        !same(await lstat(dirname(to), { bigint: true }).catch(() => undefined), parent) ||
        (await realpath(dirname(to)).catch(() => undefined)) !== dirname(to)
      ) {
        // It went through a folder swapped for a link: back into the quarantine.
        await rename(to, from).catch(() => undefined);
        throw new PsycheError("forbidden", `${dirname(rel)} moved while ${rel} was put back`);
      }
      result.kept.push(rel);
    } catch {
      result.conflicts.push(rel);
    }
  }
  if (result.conflicts.length > 0) {
    await writeRecord(dir, { root, entries: result.conflicts });
    throw new PsycheError(
      "conflict",
      `${result.conflicts.join(", ")} could not be put back (something there has the same name, or its folder moved); the rest is back`,
      { details: { kept: result.kept, conflicts: result.conflicts } },
    );
  }
  // Only Psyche's own record and the emptied folders are left.
  await rm(dir, { recursive: true, force: true });
  return result;
}

/** What the tool result tells the model, when the run touched launch config. */
export function launchConfigNotice(r: LaunchConfigReport): string | undefined {
  const parts: string[] = [];
  if (r.quarantined.length > 0) {
    parts.push(
      `moved what the run created into a quarantine (${r.quarantined.join(", ")}); the owner can keep it`,
    );
  }
  if (r.unmoved.length > 0) parts.push(`could not move ${r.unmoved.join(", ")}`);
  if (r.changed.length > 0) {
    parts.push(
      `noticed changes to existing launch config (${r.changed.join(", ")}) and told the owner`,
    );
  }
  if (parts.length === 0) return undefined;
  return `code.run does not create app launch config (.vscode, .obsidian, .husky, .npmrc...): Psyche ${parts.join("; ")}. To change launch config, use code.edit, which asks the owner.`;
}
