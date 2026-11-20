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
 * `code.run` and app launch config (#1434 reviews r1 and r2). A command in the sandbox may change
 * the working tree, but what an app or the next command on the host runs from it (`.vscode`,
 * `.obsidian`, `.husky`, `.npmrc`...; `launchConfigEntry`) is judged over the run window only,
 * right before and right after the command:
 * - existing launch-config folders are mounted read-only over the repository, like `.git`;
 * - an entry that appeared during the run is moved into a quarantine under `$PSYCHE_HOME`, never
 *   deleted; the owner gets a notice whose "Keep it" puts it back (`keepQuarantined`);
 * - a change to an existing entry (a file in a read-only folder, an existing launch-config file,
 *   `.git/config`, `.git/hooks`, `.git/info`) is only reported: it may be the owner's own IDE or
 *   Claude Code, so nothing is moved or reverted.
 * A writer the run left running in the sandbox after it returned is not seen (a residual: the
 * copy-out design is the fix).
 */

/** Launch-config folders mounted read-only at most (each is one bind mount). */
export const MAX_LAUNCH_CONFIG_MOUNTS = 24;
/** Files fingerprinted at most per folder (read-only folders and `.git`'s hooks and info). */
const MAX_PRINTS_PER_FOLDER = 5_000;
const FULL = { maxDirs: 50_000, maxFound: 512 } as const;
/** The fallback when the full walk is over its limits: the root and its folders. */
const TOP = { maxDirs: 50_000, maxFound: 512, maxDepth: 1 } as const;
/** `.git` entries that git runs code from or reads config from. */
const GIT_WATCHED = [".git/config", ".git/hooks", ".git/info"];
const QUARANTINE_ID = /^[0-9]{13}-[0-9a-f]{8}$/;

export interface LaunchConfigReport {
  /** Entries the run created, moved into the quarantine (repository-relative). */
  quarantined: string[];
  /** The quarantine that holds them, for "Keep it". */
  quarantineId?: string;
  /** Existing entries that changed during the run: reported, never moved. */
  changed: string[];
  /** New entries that could not be moved (they stay where the run put them). */
  unmoved: string[];
  /** The repository was too large to walk: only its top levels were checked. */
  partial: boolean;
}

export interface LaunchConfigGuard {
  /** Read-only mounts for the existing launch-config folders. */
  mounts: SandboxMount[];
  /** Run after the command. Never throws; what it could not check is in `unmoved`. */
  settle(): Promise<LaunchConfigReport>;
}

export interface LaunchGuardOptions {
  /** Where new entries go: `$PSYCHE_HOME/quarantine/code-run`. */
  quarantineDir: string;
  now?: () => Date;
  /** Folders walked at most before the walk falls back to the top levels (default 50 000). */
  maxDirs?: number;
}

/**
 * Snapshots the launch config under `root` (a canonical, real path) before a run that mounts it
 * read-write at `mountRoot`.
 */
export async function guardLaunchConfig(
  root: string,
  mountRoot: string,
  options: LaunchGuardOptions,
): Promise<LaunchConfigGuard> {
  const full = { ...FULL, maxDirs: options.maxDirs ?? FULL.maxDirs };
  let scan = await findLaunchConfig(root, full);
  const partial = !scan.complete;
  if (partial) scan = await findLaunchConfig(root, TOP);
  const before = await prints(root, scan);
  const dirs = scan.found
    .filter((f) => f.kind === "dir")
    .sort((a, b) => depth(a.rel) - depth(b.rel) || (a.rel < b.rel ? -1 : 1))
    .slice(0, MAX_LAUNCH_CONFIG_MOUNTS);
  return {
    mounts: dirs.map((d) => ({
      source: join(root, d.rel),
      target: `${mountRoot}/${d.rel}`,
      readOnly: true,
    })),
    settle: () => settle(root, scan, before, partial ? TOP : full, partial, options),
  };
}

const depth = (rel: string) => rel.split("/").length;

async function settle(
  root: string,
  was: LaunchConfigScan,
  before: Map<string, string>,
  limits: { maxDirs: number; maxFound: number; maxDepth?: number },
  partial: boolean,
  options: LaunchGuardOptions,
): Promise<LaunchConfigReport> {
  const report: LaunchConfigReport = { quarantined: [], changed: [], unmoved: [], partial };
  let now: LaunchConfigScan;
  try {
    now = await findLaunchConfig(root, limits);
  } catch {
    report.unmoved.push(".");
    return report;
  }
  if (!now.complete) report.partial = true;
  const known = new Set(was.found.map((f) => f.rel));
  const fresh = now.found.filter((f) => !known.has(f.rel));
  if (fresh.length > 0) {
    const id = `${(options.now?.() ?? new Date()).getTime()}-${randomBytes(4).toString("hex")}`;
    const held = join(options.quarantineDir, id);
    for (const f of fresh) {
      try {
        await moveInto(root, f.rel, join(held, "entries", f.rel));
        report.quarantined.push(f.rel);
      } catch {
        report.unmoved.push(f.rel);
      }
    }
    if (report.quarantined.length > 0) {
      report.quarantineId = id;
      await writeRecord(held, { root, entries: report.quarantined }).catch(() => undefined);
    }
  }
  // Existing entries: what is there now against what was there, for the same paths.
  const after = await prints(root, {
    found: now.found.filter((f) => known.has(f.rel)),
    complete: true,
  });
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const key of [...keys].sort()) {
    if (before.get(key) !== after.get(key)) report.changed.push(key);
  }
  return report;
}

/**
 * A fingerprint per path: each launch-config file and link, each file and link inside a
 * launch-config folder, and git's config, hooks and info. Inode, size, mtime and ctime (a write
 * through any share moves the host ctime, which nothing unprivileged can set back).
 */
async function prints(root: string, scan: LaunchConfigScan): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const one = async (rel: string) => {
    const st = await lstat(join(root, rel), { bigint: true }).catch(() => undefined);
    if (st === undefined) return undefined;
    const p = await print(join(root, rel), st);
    out.set(rel, p);
    return st;
  };
  const walk = async (rel: string) => {
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
        else await one(child);
      }
    }
  };
  for (const f of scan.found) {
    if (f.kind === "dir") {
      out.set(f.rel, "dir");
      await walk(f.rel);
    } else {
      await one(f.rel);
    }
  }
  const git = await lstat(join(root, ".git")).catch(() => undefined);
  if (git?.isDirectory() === true) {
    for (const rel of GIT_WATCHED) {
      const st = await one(rel);
      if (st?.isDirectory() === true) {
        out.delete(rel);
        await walk(rel);
      }
    }
  }
  return out;
}

async function print(path: string, st: BigIntStats): Promise<string> {
  if (st.isSymbolicLink()) return `link:${await readlink(path).catch(() => "?")}`;
  const kind = st.isFile() ? "file" : st.isDirectory() ? "dir" : "other";
  return `${kind}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}

/**
 * The entry's folder must still be the real folder the walk saw: a link swapped in since would
 * take the move outside the repository.
 */
async function assertParent(root: string, rel: string): Promise<string> {
  const path = join(root, rel);
  if ((await realpath(dirname(path))) !== dirname(path)) {
    throw new PsycheError("forbidden", `${dirname(rel)} moved during the check`);
  }
  return path;
}

/** Moves `rel` out of `root` to `dest` (a rename, or a copy then removal across volumes). */
async function moveInto(root: string, rel: string, dest: string): Promise<void> {
  const from = await assertParent(root, rel);
  await mkdir(dirname(dest), { recursive: true });
  await moveEntry(from, dest);
}

async function moveEntry(from: string, to: string): Promise<void> {
  if (
    await lstat(to).then(
      () => true,
      () => false,
    )
  ) {
    throw new PsycheError("conflict", `${to} already exists`);
  }
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    // Another volume: copied whole (links as links), and only then removed from where it was.
    await cp(from, to, {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
    await rm(from, { recursive: true, force: true });
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
  /** Entries left in the quarantine because something now has their name. */
  conflicts: string[];
}

/**
 * The owner's "Keep it": moves what quarantine `id` holds back into its repository. An entry
 * whose name is taken again stays held, and the call fails with `conflict` naming it, so the
 * notice stays open; nothing in the repository is overwritten.
 */
export async function keepQuarantined(quarantineDir: string, id: string): Promise<KeepResult> {
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
    try {
      await mkdir(dirname(to), { recursive: true });
      await assertParent(root, rel);
      await moveEntry(join(dir, "entries", rel), to);
      result.kept.push(rel);
    } catch {
      result.conflicts.push(rel);
    }
  }
  if (result.conflicts.length > 0) {
    await writeRecord(dir, { root, entries: result.conflicts });
    throw new PsycheError(
      "conflict",
      `${result.conflicts.join(", ")} could not be put back (something there has the same name); the rest is back`,
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
