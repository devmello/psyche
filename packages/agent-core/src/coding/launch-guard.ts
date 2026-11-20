import { randomBytes } from "node:crypto";
import { type BigIntStats, constants, type Dirent } from "node:fs";
import {
  cp,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
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
 * Mode bits the run set through the share (#1438 review r3) neither pin an entry in place nor
 * hide it from the walk: on a folder the Gateway's own user owns, the bits a move or the walk
 * needs are added back (`lift`), only through a handle checked to be that folder.
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
/** The same, plus the files that point git at another folder, for a `.git` a run made. */
const GIT_RUNS_FROM = ["config", "hooks", "info", "commondir", "gitdir"];
const QUARANTINE_ID = /^[0-9]{13}-[0-9a-f]{8}$/;
/** Claude Code's folder: mounted read-only whole, so its worktrees' settings are covered too. */
const CLAUDE_DIR = ".claude";
/** Rounds of making unlistable folders listable again (each one level deeper) at most. */
const MAX_UNHIDE_ROUNDS = 16;
/** Folders and files inside one entry given back their owner's bits at most, for a copy. */
const MAX_LIFTED = 10_000;

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
  /**
   * New entries that could not be moved, still in place and not held; folders the run made
   * unlistable that stay so, or that were swapped while they were made listable; and folders
   * unlistable before the run that changed during it: nothing in them was checked.
   */
  unmoved: string[];
  /**
   * Entries whose move brought in something other than what was checked (a folder on the way
   * was swapped for a link): held in the quarantine all the same, never moved back, so the
   * owner can look before Keep it puts them at their path.
   */
  incidents: string[];
  /** Links the run replaced or removed, linked again as they were (`.claude`). */
  relinked: string[];
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
  const claude = await claudeFolder(root);
  const readOnly = [
    ...(claude.mount === undefined ? [] : [claude.mount]),
    ...scan.found
      .filter((f) => f.kind === "dir" && !underClaude(f.rel, claude.kind === "dir"))
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
  const before = await prints(root, scan, claude.kind === "link");
  // Who each read-only folder is (#1438 reviews r1 and r2): a read-only mount moves with its
  // folder when the run renames the folder above it, so the same path can hold something new
  // afterwards, and the owner's original can turn up under another name. Only these folders,
  // whose contents the run cannot change, exempt a new path: a file the run moved or linked
  // elsewhere can carry new content, so it is held like anything new.
  const ids: Identities = { mounted: new Map(), originals: new Set(), hidden: new Map() };
  // Folders already unlistable before the run are left as they are, but watched.
  for (const rel of scan.unreadable ?? []) {
    const st = await lstat(join(root, rel), { bigint: true }).catch(() => undefined);
    if (st !== undefined) ids.hidden.set(rel, stamp(st));
  }
  for (const rel of readOnly) {
    const st = await lstat(join(root, rel), { bigint: true }).catch(() => undefined);
    if (st === undefined) continue;
    const git = rel === ".git" || rel.endsWith("/.git");
    ids.mounted.set(rel, { id: idOf(st), git });
    ids.originals.add(idOf(st));
  }
  return {
    mounts: readOnly.map((rel) => ({
      source: join(root, rel),
      target: `${mountRoot}/${rel}`,
      readOnly: true,
    })),
    settle: () => settle(root, scan, claude, ids, before, limits, partial, options),
  };
}

interface Identities {
  /** Each read-only-mounted folder: its identity, and whether it is a git folder. */
  mounted: Map<string, { id: string; git: boolean }>;
  /** Every read-only-mounted folder, by identity: the owner's, wherever it is now. */
  originals: Set<string>;
  /** Folders the walk could not list before the run, with their `stamp`. */
  hidden: Map<string, string>;
}

const idOf = (st: BigIntStats) => `${st.dev}:${st.ino}`;
/** Who a folder is and when it or its entries last changed. */
const stamp = (st: BigIntStats) => `${idOf(st)}:${st.mtimeNs}:${st.ctimeNs}`;

async function identity(path: string): Promise<string | undefined> {
  const st = await lstat(path, { bigint: true }).catch(() => undefined);
  return st === undefined ? undefined : idOf(st);
}

/**
 * `.claude` as it is before the run, of any kind (#1435 review r3). A real folder is mounted
 * read-only whole. A link to a folder inside the repository gets that folder mounted read-only
 * (the link resolves to it in the sandbox too); a link outside it resolves to nothing the
 * sandbox shares. Either way an existing `.claude` is never quarantined, and the settings files
 * behind a link are fingerprinted, so a change there shows under "changed".
 */
interface ClaudeFolder {
  kind: "none" | "dir" | "link" | "other";
  /** The repository-relative folder to mount read-only, if any. */
  mount?: string;
  /** A link's own text, to link it again as it was. */
  linkText?: string;
  /** Where a link resolved before the run, and what was there (dev:ino); unset when dangling. */
  real?: string;
  targetId?: string;
}

async function claudeFolder(root: string): Promise<ClaudeFolder> {
  const path = join(root, CLAUDE_DIR);
  const st = await lstat(path).catch(() => undefined);
  if (st === undefined) return { kind: "none" };
  if (st.isDirectory()) return { kind: "dir", mount: CLAUDE_DIR };
  if (!st.isSymbolicLink()) return { kind: "other" };
  const linkText = await readlink(path);
  const { real, id: targetId } = await resolution(path);
  const resolved = {
    ...(real === undefined ? {} : { real }),
    ...(targetId === undefined ? {} : { targetId }),
  };
  const target = real === undefined ? undefined : await lstat(real).catch(() => undefined);
  if (real === undefined || target?.isDirectory() !== true) {
    return { kind: "link", linkText, ...resolved };
  }
  const rel = relative(root, real);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  return inside
    ? { kind: "link", mount: rel.split(sep).join("/"), linkText, ...resolved }
    : { kind: "link", linkText, ...resolved };
}

/** Where `path` resolves and who is there (dev:ino); both unset when nothing is. */
async function resolution(path: string): Promise<{ real?: string; id?: string }> {
  const real = await realpath(path).catch(() => undefined);
  if (real === undefined) return {};
  const id = await identity(real);
  return id === undefined ? { real } : { real, id };
}

const depth = (rel: string) => rel.split("/").length;
const underClaude = (rel: string, claude: boolean): boolean =>
  claude && (rel === CLAUDE_DIR || rel.startsWith(`${CLAUDE_DIR}/`));

async function isRealDir(path: string): Promise<boolean> {
  const st = await lstat(path).catch(() => undefined);
  return st?.isDirectory() === true;
}

async function settle(
  root: string,
  was: LaunchConfigScan,
  claude: ClaudeFolder,
  ids: Identities,
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
    incidents: [],
    relinked: [],
    partial,
  };
  let now: LaunchConfigScan;
  try {
    now = await findLaunchConfig(root, limits);
  } catch {
    report.unmoved.push(".");
    return report;
  }
  // A folder the run made unlistable (no read or search permission) hides what is in it from
  // the walk, though an app can still open a file in it by name: listable again, as it was
  // before the run, when the Gateway's user owns it; each round can show one more level.
  const hiddenBefore = new Set(ids.hidden.keys());
  const tried = new Set<string>();
  // Refused, or swapped for something else meanwhile: said, whatever is at the path now.
  const failed = new Set<string>();
  for (let round = 0; round < MAX_UNHIDE_ROUNDS; round++) {
    const hidden = (now.unreadable ?? []).filter((r) => !hiddenBefore.has(r) && !tried.has(r));
    if (hidden.length === 0) break;
    for (const rel of hidden) {
      tried.add(rel);
      try {
        await assertInside(root, `${rel}/-`);
        await lift(join(root, rel), 0o500);
      } catch {
        failed.add(rel);
      }
    }
    try {
      now = await findLaunchConfig(root, limits);
    } catch {
      report.unmoved.push(".");
      return report;
    }
  }
  for (const rel of now.unreadable ?? []) if (!hiddenBefore.has(rel)) failed.add(rel);
  // One unlistable before the run that changed during it may hold what the run made there.
  for (const [rel, was] of ids.hidden) {
    const st = await lstat(join(root, rel), { bigint: true }).catch(() => undefined);
    if (st === undefined || stamp(st) !== was) failed.add(rel);
  }
  report.unmoved.push(...[...failed].sort());
  if (!now.complete) report.partial = true;
  const known = new Set(was.found.map((f) => f.rel));
  // New: launch config the run created, and a `.claude` that was not there (its worktrees are
  // never walked; under an existing `.claude`, read-only in the sandbox, anything new is the
  // owner's). A `.git` the run made keeps its objects and refs (a clone keeps its history), but
  // what git runs or reads config from goes: its config, hooks, info and pointer files, or a
  // `.git` file whole.
  const claudeBefore = claude.kind !== "none";
  const claudeNow = !claudeBefore && (await lstat(join(root, CLAUDE_DIR)).catch(() => undefined));
  const fresh: string[] = claudeNow ? [CLAUDE_DIR] : [];
  const gitRunsFrom = async (rel: string) => {
    for (const name of GIT_RUNS_FROM) {
      if (await lstat(join(root, rel, name)).catch(() => undefined)) fresh.push(`${rel}/${name}`);
    }
  };
  // A read-only folder whose path now holds something else: its folder was renamed during the
  // run and this was made in its place. It counts as new.
  const replacedMounts = new Set<string>();
  for (const [rel, m] of ids.mounted) {
    const id = await identity(join(root, rel));
    if (id === undefined || id === m.id) continue;
    replacedMounts.add(rel);
    if (m.git) await gitRunsFrom(rel);
    else fresh.push(rel);
  }
  // `.claude` was a link: one the run replaced, retargeted or removed is put back as it was (what
  // replaced it is held); one that no longer resolves to the folder that was mounted is held.
  let relink = false;
  // `.claude` still leads to its mounted target, which was made again in place: the link is the
  // owner's and stays, unless that target cannot be moved (then the link is held too).
  let claudeIfTargetStays = false;
  if (claude.kind === "link" && claude.linkText !== undefined) {
    const path = join(root, CLAUDE_DIR);
    const st = await lstat(path).catch(() => undefined);
    const text = st?.isSymbolicLink() === true ? await readlink(path).catch(() => "") : undefined;
    if (st === undefined) {
      relink = true;
    } else if (text !== claude.linkText) {
      fresh.push(CLAUDE_DIR);
      relink = true;
    } else {
      // The same text can lead elsewhere when a folder on its way was swapped: held then, and
      // not linked again (the same text would lead to the same place).
      const now = await resolution(path);
      // Its mounted target made again in place is held above; the link itself is the owner's.
      const targetHeld =
        claude.mount !== undefined && replacedMounts.has(claude.mount) && now.real === claude.real;
      if (targetHeld) {
        claudeIfTargetStays = true;
      } else if (now.real !== claude.real || now.id !== claude.targetId) {
        fresh.push(CLAUDE_DIR);
      }
    }
  }
  for (const f of now.found) {
    if (known.has(f.rel) || f.rel === CLAUDE_DIR || f.rel.startsWith(`${CLAUDE_DIR}/`)) continue;
    // The owner's own read-only folder under the name its renamed parent has now: never held.
    const id = await identity(join(root, f.rel));
    if (id !== undefined && ids.originals.has(id)) continue;
    if (f.git !== true || f.kind !== "dir") {
      fresh.push(f.rel);
      continue;
    }
    await gitRunsFrom(f.rel);
  }
  if (fresh.length > 0) {
    const id = `${(options.now?.() ?? new Date()).getTime()}-${randomBytes(4).toString("hex")}`;
    const held = join(options.quarantineDir, id);
    const incidents: Incident[] = [];
    const links: Record<string, HeldLink> = {};
    const hold = async (rel: string) => {
      try {
        // A link is kept with where it led: the owner's `.claude` with where it led before the
        // run, any other with where it leads now. Keep it refuses one that would lead elsewhere.
        const at = join(root, rel);
        const lst = await lstat(at).catch(() => undefined);
        if (lst?.isSymbolicLink() === true) {
          const text = await readlink(at);
          const was = rel === CLAUDE_DIR && text === claude.linkText;
          const r = was
            ? {
                ...(claude.real === undefined ? {} : { real: claude.real }),
                ...(claude.targetId === undefined ? {} : { id: claude.targetId }),
              }
            : await resolution(at);
          links[rel] = { text, ...r };
        }
        const moved = await moveChecked(join(root, rel), join(held, "entries", rel), {
          root,
          rel,
          ...(options.beforeMove === undefined ? {} : { beforeMove: options.beforeMove }),
        });
        report.quarantined.push(rel);
        if (moved !== undefined) {
          report.incidents.push(rel);
          incidents.push({ rel, ...moved, at: (options.now?.() ?? new Date()).toISOString() });
        }
      } catch {
        delete links[rel];
        report.unmoved.push(rel);
      }
    };
    for (const rel of fresh) await hold(rel);
    // Decided only now that the moves are done: a target left in place would be live through
    // the owner's link, so the link is held as well.
    if (
      claudeIfTargetStays &&
      claude.mount !== undefined &&
      !report.quarantined.includes(claude.mount)
    ) {
      await hold(CLAUDE_DIR);
    }
    if (report.quarantined.length > 0) {
      report.quarantineId = id;
      try {
        await writeRecord(held, { root, entries: report.quarantined, incidents, links });
      } catch {
        // Without its record Keep it cannot find them: say so rather than hold them silently.
        report.unmoved.push(...report.quarantined.map((rel) => `${rel} (held in ${held})`));
      }
    }
  }
  if (relink && claude.linkText !== undefined) {
    const path = join(root, CLAUDE_DIR);
    if ((await lstat(path).catch(() => undefined)) !== undefined) {
      // Something is at the path again: nothing is linked over it.
      report.unmoved.push(CLAUDE_DIR);
    } else {
      try {
        await symlink(claude.linkText, path);
        report.relinked.push(CLAUDE_DIR);
      } catch {
        report.unmoved.push(CLAUDE_DIR);
      }
    }
  }
  // Existing entries: what is there now against what was there, for the same paths.
  const after = await prints(
    root,
    { found: now.found.filter((f) => known.has(f.rel) || f.git === true), complete: true },
    claude.kind === "link",
  );
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
async function prints(
  root: string,
  scan: LaunchConfigScan,
  claudeLink = false,
): Promise<Map<string, string>> {
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
  if (claudeLink) {
    // The walk never follows the link: the link itself, and the settings files behind it.
    await one(CLAUDE_DIR);
    const names = await readdir(join(root, CLAUDE_DIR)).catch(() => [] as string[]);
    for (const name of names) {
      if (/^settings.*\.json$/i.test(name)) await one(`${CLAUDE_DIR}/${name}`);
    }
  }
  return out;
}

async function print(path: string, st: BigIntStats): Promise<string> {
  if (st.isSymbolicLink()) {
    // The text, and where it leads now (a folder on its way swapped changes that alone).
    const r = await resolution(path);
    return `link:${await readlink(path).catch(() => "?")}:${r.real ?? "-"}:${r.id ?? "-"}`;
  }
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

/** What arrived when a move brought in something other than what was checked. */
interface Arrived {
  dev: string;
  ino: string;
}

interface Incident extends Arrived {
  rel: string;
  at: string;
}

/**
 * Moves `from` (`rel` in `root`) to `to`, then makes sure what arrived is what was checked and
 * that `from`'s folder is still the one it was. When not (a folder on the way was swapped for a
 * link), what arrived stays where it is: moving it back would go through the same swapped path.
 * The answer is then its identity, for the incident record. A rename, or a copy then removal
 * across volumes.
 */
async function moveChecked(
  from: string,
  to: string,
  at: { root: string; rel: string; beforeMove?: (from: string) => Promise<void> | void },
): Promise<Arrived | undefined> {
  try {
    return await moveOnce(from, to, at);
  } catch (err) {
    if (!denied(err)) throw err;
  }
  // Refused for its mode bits (#1438 review r3): a run can make a folder read-only through the
  // share, and a folder without write permission can neither lose an entry nor gain one, nor be
  // moved under another folder itself. When the Gateway's user owns them, the folder `from` is
  // in and the one `to` goes into get write and search permission, and `from` itself write
  // permission, each through a handle checked to be the folder that was checked (never by
  // path: a link swapped in would take the mode outside the share); then one more try. The two
  // folders get their modes back after; what moved keeps its write permission, so the owner
  // can look at it and Keep it can move it again.
  await assertInside(at.root, at.rel);
  const restore: (() => Promise<void>)[] = [];
  try {
    const parent = await lstat(dirname(from), { bigint: true });
    // Not there yet when the first try stopped before making it.
    const into = await lstat(dirname(to), { bigint: true }).catch(() => undefined);
    const lifted = await lift(dirname(from), 0o300, parent);
    if (lifted !== undefined) restore.push(lifted);
    if (into !== undefined && !same(parent, into)) {
      const liftedInto = await lift(dirname(to), 0o300, into);
      if (liftedInto !== undefined) restore.push(liftedInto);
    }
    await lift(from, 0o200);
    return await moveOnce(from, to, at);
  } finally {
    for (const r of restore.reverse()) await r();
  }
}

const denied = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
};

const GATEWAY_UID = process.getuid?.();
/** darwin's `O_EXEC`: with `O_DIRECTORY`, a folder opened to search it, without read permission. */
const DARWIN_O_EXEC = 0x40000000;

/**
 * Adds `bits` (user bits only) to the mode of `path` when it is a real folder (or, with `files`,
 * a regular file) that the Gateway's own user owns and that lacks them, as a folder a run made
 * through the share can; anything else is left alone. `expect` pins who it must be. The answer
 * restores the mode it had, while it is still the same entry, when anything changed. Only the
 * permission bits are ever written: setuid, setgid and sticky bits are dropped, never set.
 */
async function lift(
  path: string,
  bits: number,
  expect?: BigIntStats,
  files = false,
): Promise<(() => Promise<void>) | undefined> {
  const st = await lstat(path, { bigint: true });
  if (expect !== undefined && !same(st, expect)) {
    throw new PsycheError("forbidden", `${path} moved during the check`);
  }
  if (!(st.isDirectory() || (files && st.isFile()))) return undefined;
  if (GATEWAY_UID === undefined || st.uid !== BigInt(GATEWAY_UID)) return undefined;
  const mode = Number(st.mode & 0o777n);
  if ((mode & bits) === bits) return undefined;
  await setMode(path, st, mode | (bits & 0o700));
  return () => setMode(path, st, mode).catch(() => undefined);
}

/**
 * Sets the mode of the entry `st` is, never by path (#1450 review r1): `chmod` follows a link
 * swapped in meanwhile, which would give a mode the run picked to something of the owner's
 * outside the share. Only through a handle opened without following a link and checked to be
 * `st`: a folder for reading, or on macOS for search only; a file for reading or writing. What
 * cannot be opened so is refused, and its entry stays where it is (said as not held).
 */
async function setMode(path: string, st: BigIntStats, mode: number): Promise<void> {
  const base = constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const tries = st.isDirectory()
    ? [
        base | constants.O_DIRECTORY | constants.O_RDONLY,
        ...(process.platform === "darwin" ? [base | constants.O_DIRECTORY | DARWIN_O_EXEC] : []),
      ]
    : [base | constants.O_RDONLY, base | constants.O_WRONLY];
  let handle: FileHandle | undefined;
  for (const flags of tries) {
    try {
      handle = await open(path, flags);
      break;
    } catch (err) {
      if (!denied(err)) {
        throw new PsycheError("forbidden", `${path} moved during the check`);
      }
    }
  }
  if (handle === undefined) {
    throw new PsycheError("forbidden", `${path} cannot be opened to give its mode back`);
  }
  try {
    if (!same(await handle.stat({ bigint: true }), st)) {
      throw new PsycheError("forbidden", `${path} moved during the check`);
    }
    await handle.chmod(mode & 0o777);
  } finally {
    await handle.close();
  }
}

/**
 * Gives read and write permission back to the folders and files inside `from` (never through a
 * link), for a copy across volumes and the removal after it; at most `MAX_LIFTED` of them. One
 * it cannot give them back to, or one swapped meanwhile, stops the move: the entry stays.
 */
async function liftInside(from: string): Promise<void> {
  const queue = [from];
  let count = 0;
  while (queue.length > 0 && count < MAX_LIFTED) {
    const dir = queue.shift() as string;
    const st = await lstat(dir).catch(() => undefined);
    if (st?.isDirectory() !== true) continue;
    count++;
    await lift(dir, 0o700);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
    for (const d of entries) {
      if (d.isDirectory()) queue.push(join(dir, d.name));
      else if (d.isFile() && count++ < MAX_LIFTED) {
        await lift(join(dir, d.name), 0o600, undefined, true);
      }
    }
  }
}

async function moveOnce(
  from: string,
  to: string,
  at: { root: string; rel: string; beforeMove?: (from: string) => Promise<void> | void },
): Promise<Arrived | undefined> {
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
    // A folder or file inside it the run made unreadable or read-only would stop either half way.
    await liftInside(from);
    await cp(from, to, {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
    const source = await lstat(from, { bigint: true }).catch(() => undefined);
    if (!same(source, entry)) {
      // A copy of something else: kept, and the source is not removed.
      return { dev: String(source?.dev ?? "?"), ino: String(source?.ino ?? "?") };
    }
    await rm(from, { recursive: true, force: true });
    return undefined;
  }
  const arrived = await lstat(to, { bigint: true }).catch(() => undefined);
  const still = await lstat(dirname(from), { bigint: true }).catch(() => undefined);
  if (!same(arrived, entry) || !same(still, parent)) {
    return { dev: String(arrived?.dev ?? "?"), ino: String(arrived?.ino ?? "?") };
  }
  return undefined;
}

/** A held link: its text, and where it led (dev:ino of what was there); unset when dangling. */
interface HeldLink {
  text: string;
  real?: string;
  id?: string;
}

interface QuarantineRecord {
  root: string;
  entries: string[];
  links?: Record<string, HeldLink>;
  /** Moves that brought in something other than what was checked: identity and time. */
  incidents?: Incident[];
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
  options: {
    /**
     * Runs once the record is read, before anything moves: the caller stops the repository's
     * sandbox there, so nothing still running in it can swap a folder during the moves.
     */
    beforeKeep?: (root: string) => Promise<void> | void;
    /** Test seam: runs between a move's checks and the move. */
    beforeMove?: (from: string) => Promise<void> | void;
  } = {},
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
  await options.beforeKeep?.(root);
  const result: KeepResult = { root, kept: [], conflicts: [] };
  for (const rel of record.entries) {
    if (typeof rel !== "string" || rel.split("/").some((s) => s === ".." || s === "")) continue;
    const to = join(root, rel);
    const from = join(dir, "entries", rel);
    try {
      const link = record.links?.[rel];
      if (link !== undefined) {
        const would = await resolution(
          isAbsolute(link.text) ? link.text : join(dirname(to), link.text),
        );
        if (would.real !== link.real || would.id !== link.id) {
          throw new PsycheError("conflict", `${rel} would now lead somewhere else`, {
            details: { reason: "link_resolves_elsewhere", path: rel },
          });
        }
      }
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
        // The sandbox is stopped by now, so only something on the host swapped the folder: what
        // was put back is not moved again (that would go through the same path). Said loudly.
        throw new PsycheError(
          "conflict",
          `${dirname(rel)} was swapped for a link while ${rel} was put back; check where it went`,
          { details: { reason: "keep_folder_swapped", path: rel } },
        );
      }
      result.kept.push(rel);
    } catch (err) {
      if ((err as { details?: { reason?: string } }).details?.reason === "keep_folder_swapped") {
        throw err;
      }
      result.conflicts.push(rel);
    }
  }
  if (result.conflicts.length > 0) {
    await writeRecord(dir, {
      root,
      entries: result.conflicts,
      ...(record.incidents === undefined ? {} : { incidents: record.incidents }),
      ...(record.links === undefined ? {} : { links: record.links }),
    });
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
  if (r.unmoved.length > 0) {
    parts.push(
      `could not move ${r.unmoved.join(", ")}, which is still in place and not held, and told the owner`,
    );
  }
  if (r.relinked.length > 0) {
    parts.push(`linked ${r.relinked.join(", ")} again as it was before the run`);
  }
  if (r.changed.length > 0) {
    parts.push(
      `noticed changes to existing launch config (${r.changed.join(", ")}) and told the owner`,
    );
  }
  if (parts.length === 0) return undefined;
  return `code.run does not create app launch config (.vscode, .obsidian, .husky, .npmrc...): Psyche ${parts.join("; ")}. To change launch config, use code.edit, which asks the owner.`;
}
