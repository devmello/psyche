import { lstat, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findLaunchConfig, type LaunchConfigFound } from "@psyche/hostfs";
import { PsycheError, type SandboxMount } from "@psyche/protocol";

/**
 * `code.run` and app launch config (#1434 review r1, finding 1). A command in the sandbox can
 * change the working tree, but not what an app or the next command on the host runs from it
 * (`.vscode`, `.obsidian`, `.husky`, `.npmrc`...; `launchConfigEntry`):
 * - each existing launch-config folder is mounted read-only over the repository, like `.git`;
 * - each existing launch-config file is kept as it was: put back after the run if it changed or
 *   went (container runtimes that share folders over virtiofs cannot bind-mount a single file);
 * - after the run, launch-config entries the run created are removed, and a symlinked entry it
 *   replaced is linked again.
 * The tool result names what was removed or put back; `code.edit`, which asks, changes them.
 */

/** Launch-config folders mounted read-only at most (each is one bind mount). */
export const MAX_LAUNCH_CONFIG_MOUNTS = 24;
/** A launch-config file larger than this cannot be kept, so the run is refused. */
const MAX_KEPT_FILE_BYTES = 256 * 1024;
const SCAN = { maxDirs: 50_000 } as const;

interface Kept {
  rel: string;
  kind: LaunchConfigFound["kind"];
  content?: Buffer;
  mode?: number;
  linkTarget?: string;
}

export interface LaunchConfigReport {
  /** Entries the run created, removed again (repository-relative). */
  removed: string[];
  /** Existing entries the run changed or removed, put back as they were. */
  restored: string[];
  /** Entries that could not be removed or put back, or the check did not finish. */
  unchecked: string[];
}

export interface LaunchConfigGuard {
  /** Read-only mounts for the existing launch-config folders. */
  mounts: SandboxMount[];
  /** Run after the command: removes what it created, puts back what it changed. */
  settle(): Promise<LaunchConfigReport>;
}

/**
 * Snapshots the launch config under `root` (a canonical, real path) before a run that mounts it
 * read-write at `mountRoot`. Refuses (`forbidden`) when the repository has more of it than one
 * run can keep, or is too large to walk.
 */
export async function guardLaunchConfig(
  root: string,
  mountRoot: string,
): Promise<LaunchConfigGuard> {
  const scan = await findLaunchConfig(root, { ...SCAN, maxFound: 256 });
  if (!scan.complete) {
    throw new PsycheError(
      "forbidden",
      `${root} is too large to check for app launch config (.vscode, .husky, .npmrc...); code.run does not run there`,
      { details: { reason: "launch_config_unchecked" } },
    );
  }
  const kept: Kept[] = [];
  for (const f of scan.found) {
    const path = join(root, f.rel);
    if (f.kind === "file") {
      const st = await lstat(path);
      if (st.size > MAX_KEPT_FILE_BYTES) {
        throw new PsycheError(
          "forbidden",
          `${f.rel} is larger than code.run can keep unchanged; change it with code.edit`,
          { details: { reason: "launch_config_unchecked", path: f.rel } },
        );
      }
      kept.push({ ...f, content: await readFile(path), mode: st.mode & 0o7777 });
    } else {
      kept.push({ ...f });
    }
  }
  const dirs = kept.filter((k) => k.kind === "dir");
  if (dirs.length > MAX_LAUNCH_CONFIG_MOUNTS) {
    throw new PsycheError(
      "forbidden",
      `${root} has ${dirs.length} app launch-config folders; code.run keeps at most ${MAX_LAUNCH_CONFIG_MOUNTS} read-only`,
      { details: { reason: "launch_config_unchecked" } },
    );
  }
  return {
    mounts: dirs.map((d) => ({
      source: join(root, d.rel),
      target: `${mountRoot}/${d.rel}`,
      readOnly: true,
    })),
    settle: () => settle(root, kept),
  };
}

async function settle(root: string, kept: readonly Kept[]): Promise<LaunchConfigReport> {
  const report: LaunchConfigReport = { removed: [], restored: [], unchecked: [] };
  const before = new Map(kept.map((k) => [k.rel, k]));
  const scan = await findLaunchConfig(root, { ...SCAN, maxFound: 4096 });
  const now = new Map(scan.found.map((f) => [f.rel, f]));
  for (const f of scan.found) {
    const prior = before.get(f.rel);
    try {
      if (prior === undefined) {
        await removeEntry(root, f.rel);
        report.removed.push(f.rel);
      } else if (prior.kind === "file" && !(await sameFile(root, prior, f))) {
        await putBack(root, prior);
        report.restored.push(f.rel);
      } else if (
        prior.kind === "link" &&
        (f.kind !== "link" || f.linkTarget !== prior.linkTarget)
      ) {
        await putBack(root, prior);
        report.restored.push(f.rel);
      }
    } catch {
      report.unchecked.push(f.rel);
    }
  }
  // Kept files and links the run deleted come back too (folders are read-only mounts).
  for (const prior of kept) {
    if (now.has(prior.rel) || (prior.kind !== "file" && prior.kind !== "link")) continue;
    try {
      await putBack(root, prior);
      report.restored.push(prior.rel);
    } catch {
      report.unchecked.push(prior.rel);
    }
  }
  if (!scan.complete) report.unchecked.push(".");
  return report;
}

async function sameFile(root: string, prior: Kept, f: LaunchConfigFound): Promise<boolean> {
  if (f.kind !== "file" || prior.content === undefined) return false;
  const path = join(root, f.rel);
  const st = await lstat(path);
  if (st.size !== prior.content.length || (st.mode & 0o7777) !== prior.mode) return false;
  return (await readFile(path)).equals(prior.content);
}

/**
 * The entry's folder must still be the real folder the walk saw: a link swapped in since would
 * take the removal outside the repository.
 */
async function assertParent(root: string, rel: string): Promise<string> {
  const path = join(root, rel);
  if ((await realpath(dirname(path))) !== dirname(path)) {
    throw new PsycheError("forbidden", `${dirname(rel)} moved during the check`);
  }
  return path;
}

async function removeEntry(root: string, rel: string): Promise<void> {
  await rm(await assertParent(root, rel), { recursive: true, force: true });
}

async function putBack(root: string, prior: Kept): Promise<void> {
  const path = await assertParent(root, prior.rel);
  await rm(path, { recursive: true, force: true });
  if (prior.kind === "link" && prior.linkTarget !== undefined) {
    await symlink(prior.linkTarget, path);
  } else if (prior.content !== undefined) {
    await writeFile(path, prior.content, { flag: "wx", mode: prior.mode ?? 0o644 });
  }
}

/** The sentence the tool result carries when the run touched launch config. */
export function launchConfigNotice(r: LaunchConfigReport): string | undefined {
  const parts: string[] = [];
  if (r.removed.length > 0) parts.push(`removed what it created (${r.removed.join(", ")})`);
  if (r.restored.length > 0) parts.push(`put back what it changed (${r.restored.join(", ")})`);
  if (r.unchecked.length > 0) parts.push(`could not check ${r.unchecked.join(", ")}`);
  if (parts.length === 0) return undefined;
  return `code.run never changes app launch config (.vscode, .obsidian, .husky, .npmrc...): Psyche ${parts.join("; ")}. To change these files, use code.edit, which asks the owner.`;
}
