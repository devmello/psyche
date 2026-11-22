import { realpathSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, posix, resolve, win32 } from "node:path";
import {
  canonicalHostPath,
  isAbsoluteHostPath,
  isMacMagicPath,
  isUnderHostPath,
  isWin32HostPath,
  joinHostPath,
  sameHostPath,
} from "@psyche/hostfs";
import { CLI_HOME_DIRS } from "@psyche/model-router";
import { PsycheError } from "@psyche/protocol";

/**
 * Folder access requested by the agent (security §3.5, "Folder access"). The owner's own pick is
 * what is granted: the path is resolved to its real path (symlinks, `..`) and refused when it is
 * a sensitive root, an ancestor of one, or not a folder. Nothing broader than the pick is ever
 * granted, and taint always limits the answer to `once` (§3.6; no exception).
 */

export interface FolderGrantEntry {
  path: string;
  mode: "ro" | "rw";
  /**
   * A single attached file (chat attachment), not a folder: it matches that exact path only, so
   * a file replaced by a folder opens nothing inside it. Always `ro`.
   */
  file?: true;
  /**
   * The folder's real path when it was granted (a pick is already real; Settings records it for a
   * typed path; an older grant gets the first one seen). A root whose real path is somewhere else
   * now covers nothing (`grantedRootRefused`).
   */
  real?: string;
}

/** Whether `entry` names `target` (a file entry: that exact path; a folder: it and what is inside). */
export function entryMatches(entry: FolderGrantEntry, target: string): boolean {
  return entry.file === true
    ? sameHostPath(target, entry.path)
    : isUnderHostPath(target, entry.path);
}

/**
 * The entries that still do something: a file entry that a granted folder already covers is
 * dropped (the longest root decides, so a read-only file entry would narrow a read-write folder,
 * including one granted after the file was attached).
 */
export function effectiveEntries(entries: readonly FolderGrantEntry[]): FolderGrantEntry[] {
  const folders = entries.filter((e) => e.file !== true);
  return entries.filter(
    (e) => e.file !== true || !folders.some((f) => isUnderHostPath(e.path, f.path)),
  );
}

/** A folder grant whose lifetime is the conversation, not Settings. */
export interface SessionFolderGrant extends FolderGrantEntry {
  threadId: string;
}

export interface FolderAccessEnv {
  /** The owner's home directory. */
  home?: string;
  /**
   * Compare POSIX paths without case (APFS and HFS+ are case-insensitive by default, so `/OPT`
   * is `/opt`). Default: true on macOS. Windows paths are always compared without case.
   */
  caseInsensitive?: boolean;
  /** Tests: the platform whose path rules apply (default `process.platform`). */
  platform?: NodeJS.Platform;
  /** `$PSYCHE_HOME`. */
  psycheHome?: string;
  /** Extra protected locations (credential stores) as written; real paths are added too. */
  protectedRoots?: readonly string[];
  /**
   * Folders Psyche creates inside `$PSYCHE_HOME` for its own runs (the subscription CLI working
   * directories, `<home>/cli/<id>`). Each is shareable although `$PSYCHE_HOME` is not; nothing
   * else under `$PSYCHE_HOME` is, and a folder holding one of them stays refused.
   */
  ownDirs?: readonly string[];
  /**
   * Windows: the owner's temp folder (default `os.tmpdir()`, i.e. `%TEMP%`). It and its
   * subfolders are shareable although the `~\AppData` around it is not, as `/tmp` and `$TMPDIR`
   * are on macOS; only when its real path lies under the profile's AppData.
   */
  tempDir?: string;
}

/** System roots refused as themselves and as ancestors, but not for their subfolders. */
const EXACT_ROOTS = ["/", "/Users", "/home", "/Volumes", "/private", "/var", "/private/var"];

/** System roots refused with everything under them. */
const SUBTREE_ROOTS = [
  "/System",
  "/Library",
  "/etc",
  "/private/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/dev",
  "/cores",
  "/Applications",
  // Installed software outside /usr: `/opt/homebrew` (Apple silicon Homebrew), `/opt/local`
  // (MacPorts) and the rest of `/opt`. A read-write grant there lets `write_file` overwrite an
  // executable (it keeps mode 0755), e.g. the `op` CLI Psyche runs unsandboxed. Intel Homebrew
  // lives in `/usr/local`, already under `/usr`.
  "/opt",
  // Linux: packaged binaries and libraries (snap, the Nix store, /lib*, the boot files).
  "/snap",
  "/nix",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/boot",
];

/**
 * Windows: system folders refused with everything under them, from the environment with the
 * usual defaults. `$Recycle.Bin` and `System Volume Information` are refused on every drive.
 */
function windowsSubtreeRoots(): string[] {
  const e = process.env;
  const drive = (e.SystemDrive ?? "C:").replace(/[\\/]+$/, "");
  return [
    e.SystemRoot ?? `${drive}\\Windows`,
    e.ProgramFiles ?? `${drive}\\Program Files`,
    e["ProgramFiles(x86)"] ?? `${drive}\\Program Files (x86)`,
    e.ProgramData ?? `${drive}\\ProgramData`,
    `${drive}\\Recovery`,
    `${drive}\\Boot`,
  ].flatMap((r) => {
    try {
      return [canonicalHostPath(r, "win32")];
    } catch {
      return [];
    }
  });
}

/** Windows: refused as themselves and as ancestors (the profiles folder). */
function windowsExactRoots(): string[] {
  const drive = (process.env.SystemDrive ?? "C:").replace(/[\\/]+$/, "");
  return [`${drive}\\Users`];
}

/** `C:\`, a UNC share root, or a drive's recycle bin / volume information (any drive). */
function windowsVolumeRefused(real: string): boolean {
  if (/^[A-Z]:\\$/.test(real) || /^\\\\[^\\]+\\[^\\]+$/.test(real)) return true;
  const second = /^[A-Z]:\\([^\\]+)/.exec(real)?.[1]?.toLowerCase();
  return second === "$recycle.bin" || second === "system volume information";
}

/** Under the home directory on Windows: the profile's AppData (its `~/Library`) and the CLIs'. */
const WINDOWS_HOME_SENSITIVE = [
  "AppData",
  ".ssh",
  ".gnupg",
  ".aws",
  ".config/gcloud",
  ".config/gh",
  ".config/glab-cli",
  ".config/op",
  ".op",
  ".azure",
  ".config/doctl",
  ".config/hub",
  ".kube",
  ".docker",
  ".netrc",
  "_netrc",
  ".psyche",
  "NTUSER.DAT",
  // What git runs on its own (hooks paths, fsmonitor, aliases), and a bin folder on PATH.
  "bin",
  ".gitconfig",
  ".config/git",
];

/** Under the home directory: refused with everything under them. */
const HOME_SENSITIVE = [
  "Library",
  ".ssh",
  ".gnupg",
  ".aws",
  ".config/gcloud",
  ".config/gh",
  ".config/glab-cli",
  ".config/op",
  ".op",
  ".azure",
  ".config/doctl",
  ".config/hub",
  ".kube",
  ".docker",
  ".netrc",
  ".psyche",
  ".Trash",
  // An install location the Mac helper launches apps from (`apps.open`): a bundle written there
  // would run unsandboxed behind a plain "Open" card.
  "Applications",
  // Shell and git configuration that runs code in the next shell or git command.
  ".config/fish",
  // `~/bin`, which shells put on PATH (review of #1294, round 4). Compared by name: a `~/bin`
  // that links elsewhere leaves the folders around its target pickable, and the target itself
  // is write-protected by its real path (`writeProtectedRoots`).
  "bin",
  ".config/git",
  // Binaries Psyche runs unsandboxed (the subscription CLIs, `op`): a read-write grant on one
  // would let `write_file` replace them, as `/opt/homebrew` would. The same list the CLI
  // resolver searches, so a new installer directory is refused as soon as it is searched.
  ...CLI_HOME_DIRS.map((segments) => segments.join("/")),
];

/**
 * Linux: the config, data and cache folders, refused wholesale as `~/Library` is on macOS. A file
 * written there runs code later: desktop entries, autostart, user services, Flatpak overrides,
 * Python `.pth` files, app plug-ins and start-up scripts, shell extensions, the terminal lists
 * and caches (review of #1294, round 4).
 */
const LINUX_HOME_SENSITIVE = [".config", ".local", ".cache"];

/** Linux: runtime and kernel file systems (`/run/user/<uid>` holds D-Bus services and units). */
const LINUX_SUBTREE_ROOTS = ["/run", "/proc", "/sys"];

/**
 * Linux: the places under `/run` that hold the owner's own files, lifted out of `/run`: removable
 * drives (udisks2 mounts them at `/run/media/<user>` on Fedora, Arch and openSUSE) and network
 * and phone mounts (GVFS, `/run/user/<uid>/gvfs`). The rest of `/run/user/<uid>` (D-Bus
 * services, user units, sockets) stays refused (review of #1294, round 5).
 */
export function linuxRunCarveOuts(): string[] {
  const out: string[] = [];
  try {
    const user = userInfo().username;
    if (/^[A-Za-z0-9._-]+$/.test(user) && !user.startsWith(".")) {
      out.push(posix.join("/run/media", user));
    }
  } catch {
    // No user name: no drive folder is lifted.
  }
  const uid = process.getuid?.();
  if (uid !== undefined) out.push(`/run/user/${uid}/gvfs`);
  return out;
}

/**
 * Under the home directory (macOS and Linux): places where a write runs code later, at login, in
 * the next shell, at an app launch or a git command. No agent write reaches them, whatever folder
 * is granted, so an older home-root share cannot plant a LaunchAgent, an rc file or an app bundle
 * (`persistenceRoots`). Reads are not affected.
 */
export const PERSISTENCE_HOME_PATHS: readonly string[] = [
  "Applications",
  "Library/LaunchAgents",
  "Library/LaunchDaemons",
  "Library/Services",
  "Library/Preferences",
  "Library/Scripts",
  "Library/Application Support/com.apple.backgroundtaskmanagementagent",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  ".zlogout",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".profile",
  ".config/fish",
  ".gitconfig",
  ".config/git",
  "bin",
  ".ssh",
  // Linux: autostart entries, user services and launcher entries.
  ".config/autostart",
  ".config/systemd",
  ".local/share/applications",
  // Linux: the other shell and session start-up files.
  ".zlogout",
  ".bash_logout",
  ".xprofile",
  ".xsessionrc",
  ".xinitrc",
  ".pam_environment",
];

/** The persistence locations under `home` (`PERSISTENCE_HOME_PATHS`); none on Windows. */
export function persistenceRoots(home: string = homedir()): string[] {
  if (process.platform === "win32") return [];
  return PERSISTENCE_HOME_PATHS.map((rel) => posix.join(resolve(home), rel));
}

/**
 * macOS, under the home directory: more places an agent write would run code later or change
 * how the owner's tools behave (#1427 review r1, finding 5). All of `~/Library` (Python `.pth`
 * files, plug-ins, QuickLook and Spotlight importers, Mail bundles, editor settings...), editor
 * extensions and the config of the owner's terminal, keyboard and editor apps.
 */
export const MAC_WRITE_PROTECTED_HOME_PATHS: readonly string[] = [
  "Library",
  // The owner's own programs on PATH (`~/bin/tool` would run as the owner from any shell).
  "bin",
  ".vscode/extensions",
  ".hammerspoon",
  ".config/karabiner",
  ".config/ghostty",
  ".config/nvim",
  ".config/zed",
];

/** Windows: what git runs on its own (`core.hooksPath`, `core.fsmonitor`, aliases) and `~/bin`. */
const WINDOWS_WRITE_PROTECTED_HOME_PATHS = ["bin", ".gitconfig", ".config/git"];

/**
 * Every place under `home` no agent write reaches, whatever folder is granted (an older home
 * share included): the persistence locations, everything refused as a share
 * (`HOME_SENSITIVE`), on macOS `MAC_WRITE_PROTECTED_HOME_PATHS`, on Linux `~/.config`,
 * `~/.local` and `~/.cache` wholesale, and on Windows only git's configuration and `~/bin`.
 * Writes to a dot entry directly in home are refused too (`assertNotProtected`'s `dotHome`).
 */
export function writeProtectedHomeRoots(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  // Windows: what git runs on its own and `~/bin` (review of #1294, rounds 4 to 6).
  if (platform === "win32")
    return WINDOWS_WRITE_PROTECTED_HOME_PATHS.map((rel) => win32.join(home, rel));
  const rels = new Set([
    ...PERSISTENCE_HOME_PATHS,
    ...HOME_SENSITIVE,
    ...(platform === "darwin" ? MAC_WRITE_PROTECTED_HOME_PATHS : []),
    // Linux: the config, data and cache folders wholesale, where a written file runs code later.
    ...(platform === "linux" ? LINUX_HOME_SENSITIVE : []),
  ]);
  return [...rels].map((rel) => posix.join(resolve(home), rel));
}

/**
 * Windows: the real long path of the owner's temp folder when it lies under `~\AppData` (the one
 * subtree root it opens), else undefined. Resolved by the OS, so a `PRANAV~1`-style short name in
 * `%TEMP%` becomes the long one, and compared without case like every Windows path here.
 */
function windowsTempDir(env: FolderAccessEnv, home: string): string | undefined {
  try {
    const real = canonicalHostPath(realpathSync.native(env.tempDir ?? tmpdir()), "win32");
    const appData = joinHostPath(home, "AppData");
    return !sameHostPath(real, appData) && isUnderHostPath(real, appData) ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A POSIX path as APFS compares names by default: compatibility-normalized (`ſ` is `s`, `ﬁ` is
 * `fi`, the Kelvin sign is `K`, NFD is NFC) and case-folded. Over-folding only refuses more.
 * The same fold as `@psyche/files`' `foldPathName`.
 */
function foldName(p: string): string {
  return p.normalize("NFKC").toLowerCase().toUpperCase().toLowerCase().normalize("NFKC");
}

function under(child: string, root: string): boolean {
  if (root === "/") return !isWin32HostPath(child);
  return isUnderHostPath(child, root);
}

/** The roots a pick may not equal or contain (and, for subtree roots, lie under). */
export function sensitiveRoots(env: FolderAccessEnv = {}): { exact: string[]; subtree: string[] } {
  const win = process.platform === "win32";
  const linux = !win && (env.platform ?? process.platform) === "linux";
  const home = resolve(env.home ?? homedir());
  const subtree = new Set<string>(win ? windowsSubtreeRoots() : SUBTREE_ROOTS);
  if (linux) for (const root of LINUX_SUBTREE_ROOTS) subtree.add(root);
  for (const rel of win ? WINDOWS_HOME_SENSITIVE : HOME_SENSITIVE)
    subtree.add(joinHostPath(home, rel));
  if (linux) for (const rel of LINUX_HOME_SENSITIVE) subtree.add(joinHostPath(home, rel));
  if (env.psycheHome !== undefined) subtree.add(resolve(env.psycheHome));
  for (const p of env.protectedRoots ?? []) subtree.add(resolve(p));
  return { exact: [...(win ? windowsExactRoots() : EXACT_ROOTS), home], subtree: [...subtree] };
}

/**
 * Whether a folder that is already granted lies inside a system root (`/usr`, `/opt`, `/System`,
 * `C:\\Windows`...), which `refuseFolder` would refuse today. Checked when a grant is used and
 * listed, so a grant made before a root was refused (`/opt/homebrew`) stops covering anything.
 * Narrower than `refuseFolder` on purpose: the home root and `$PSYCHE_HOME` keep their meaning
 * for grants made earlier. Also covers the CLI binary folders in home (`~/.local/bin`...).
 */
export function inSystemRoot(given: string, env: FolderAccessEnv = {}): boolean {
  let real: string;
  try {
    real = canonicalHostPath(given);
  } catch {
    return false;
  }
  if (isMacMagicPath(real, env.platform)) return true;
  const ci = env.caseInsensitive ?? process.platform === "darwin";
  const fold = (p: string): string => (ci && !isWin32HostPath(p) ? foldName(p) : p);
  const win = process.platform === "win32";
  const linux = !win && (env.platform ?? process.platform) === "linux";
  const roots = win ? windowsSubtreeRoots() : SUBTREE_ROOTS;
  if (roots.some((r) => under(fold(real), fold(r)))) return true;
  if (linux && LINUX_SUBTREE_ROOTS.some((r) => under(real, r))) {
    if (!linuxRunCarveOuts().some((c) => under(real, c))) return true;
  }
  // The CLI binary folders in home (`~/.local/bin`...), and a folder around one (`~/.local`), but
  // not home itself or above: an older home grant keeps its meaning (see above).
  const home = fold(resolve(env.home ?? homedir()));
  const folded = fold(real);
  return CLI_HOME_DIRS.some((segments) => {
    const root = fold(joinHostPath(resolve(env.home ?? homedir()), segments.join("/")));
    return under(folded, root) || (under(root, folded) && !under(home, folded));
  });
}

/** A path in one spelling for comparing places: canonical, firmlinks and `/private` aliases removed. */
function placeSpelling(p: string): string {
  let c = p;
  try {
    c = canonicalHostPath(p, isWin32HostPath(p) ? "win32" : undefined);
  } catch {
    /* keep as given */
  }
  if (isWin32HostPath(c)) return c;
  c = c.replace(/^\/System\/Volumes\/Data(?=\/|$)/, "") || "/";
  return c.replace(/^\/(tmp|var|etc)(?=\/|$)/, "/private/$1");
}

/**
 * Whether two paths name the same place up to spelling: `/tmp` `/var` `/etc` resolving under
 * `/private`, the firmlinked `/System/Volumes/Data/...` form, and case where the disk ignores it
 * (always on Windows, on macOS by default).
 */
export function sameRootSpelling(a: string, b: string, env: FolderAccessEnv = {}): boolean {
  const x = placeSpelling(a);
  const y = placeSpelling(b);
  if (isWin32HostPath(x) || isWin32HostPath(y)) return sameHostPath(x, y);
  const ci = env.caseInsensitive ?? process.platform === "darwin";
  return ci ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** The same place without folding case on POSIX (a link to a sibling that differs only in case). */
function samePlaceExact(a: string, b: string): boolean {
  const x = placeSpelling(a);
  const y = placeSpelling(b);
  return isWin32HostPath(x) || isWin32HostPath(y) ? sameHostPath(x, y) : x === y;
}

function hostBasename(p: string): string {
  return isWin32HostPath(p) ? win32.basename(p) : posix.basename(p);
}

/**
 * Whether a granted root now leads somewhere else than its (real) parent folder plus its own
 * name: a root swapped for a link. Only spelling moves are benign (`sameRootSpelling`). It cannot
 * see a swapped parent (the parent is resolved now too); `grantedRootRefused` compares with the
 * real path recorded at grant time for that.
 */
export function rootMoved(
  stored: string,
  real: string,
  realParent: string,
  env: FolderAccessEnv = {},
): boolean {
  return !sameRootSpelling(real, joinHostPath(realParent, hostBasename(stored)), env);
}

/** What a granted root is on disk now. */
export interface RootFacts {
  /** Its real path; undefined when it does not exist (ENOENT). */
  real?: string;
  /** The stored path itself is a symlink (`lstat`), whatever it points at. */
  link: boolean;
}

/**
 * Looks a granted root up without blocking the event loop (`fs.promises`, the native realpath, on
 * the libuv pool). A missing path gives no `real`; any other failure throws, and the caller
 * treats the root as refused for now (a hung or broken mount leaves its real place unknown).
 */
export async function lookupRootFacts(stored: string): Promise<RootFacts> {
  const missing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === "ENOENT";
  let real: string | undefined;
  try {
    real = await realpath(stored);
  } catch (err) {
    if (!missing(err)) throw err;
  }
  let link = false;
  try {
    link = (await lstat(stored)).isSymbolicLink();
  } catch (err) {
    if (!missing(err)) throw err;
  }
  return { ...(real === undefined ? {} : { real }), link };
}

/**
 * Whether a granted root (Settings or one conversation's) covers nothing now. Owner decision
 * 2026-11-19: a root that leads to any other folder than where it was granted stops counting,
 * even a shareable one. In order:
 * - inside a system root (`inSystemRoot`), as stored or by its real path;
 * - a dangling link;
 * - its real path is not just another spelling of the stored one and a grant there would be
 *   refused (`refuseFolder`: home, `~/Library`, `~/.ssh`, Psyche's data), whatever else says;
 * - the stored path itself is a link that leads anywhere but its own place (case counts here, so
 *   a link to a sibling on a case-sensitive volume is caught);
 * - the real path differs from the one `recorded` when it was granted (up to spelling), which
 *   also catches a parent swapped for a link;
 * - an old grant with nothing recorded whose real path is not the stored one (up to spelling):
 *   nothing says where it was granted, so it waits for the owner to confirm it again
 *   (`grantedRootMoved`).
 * A root that does not exist is not refused, and an unmoved old home-root grant keeps working.
 */
export function grantedRootRefused(
  stored: string,
  facts: RootFacts,
  recorded: string | undefined,
  env: FolderAccessEnv = {},
): boolean {
  if (inSystemRoot(stored, env)) return true;
  const real = facts.real;
  if (real === undefined) return facts.link;
  if (inSystemRoot(real, env)) return true;
  if (!sameRootSpelling(real, stored, env) && refuseFolder(real, env) !== undefined) return true;
  if (facts.link && !samePlaceExact(stored, real)) return true;
  return !sameRootSpelling(real, recorded ?? stored, env);
}

/**
 * The place an older grant (nothing `recorded`) now leads to, when that is the only reason it
 * does not count and the owner may confirm it again there: a plain folder (not itself a link)
 * whose real path differs from the stored one, outside every system root and every place a grant
 * would be refused. Undefined otherwise.
 */
export function grantedRootMoved(
  stored: string,
  facts: RootFacts,
  recorded: string | undefined,
  env: FolderAccessEnv = {},
): string | undefined {
  const real = facts.real;
  if (recorded !== undefined || real === undefined || facts.link) return undefined;
  if (sameRootSpelling(real, stored, env) || inSystemRoot(stored, env)) return undefined;
  if (inSystemRoot(real, env) || refuseFolder(real, env) !== undefined) return undefined;
  return real;
}

export type FolderRefusal = "sensitive_root" | "contains_sensitive_root" | "not_absolute";

/**
 * Why a normalised, real absolute path may not be granted, or `undefined` when it may. `/`, the
 * home root, `~/Library`, `~/.ssh` and `~/.psyche` are refused; so is any folder that contains
 * one of them (the home root contains `~/.ssh`). A folder inside home such as `~/Projects` passes.
 * On Windows the same holds for drive and share roots, `C:\Users`, the system folders and
 * `~\AppData`, compared without case; a name Win32 would rewrite (`.ssh.`, `DOCUME~1`) is refused.
 * The owner's `%TEMP%` inside AppData is shareable, as `/tmp` and `$TMPDIR` are on macOS.
 */
export function refuseFolder(given: string, env: FolderAccessEnv = {}): FolderRefusal | undefined {
  let real: string;
  try {
    real = canonicalHostPath(given);
  } catch {
    return "not_absolute";
  }
  // On Windows a folder is a drive or UNC path: a POSIX path names nothing there.
  if (process.platform === "win32" && !isWin32HostPath(real)) return "not_absolute";
  // `/.nofollow/<abs>`, `/.vol/..`, `/.resolve/..` (macOS) open another file past the checks below.
  if (isMacMagicPath(real, env.platform)) return "sensitive_root";
  if (process.platform === "win32" && windowsVolumeRefused(real)) return "sensitive_root";
  const roots = sensitiveRoots(env);
  // macOS: `/OPT/Homebrew` names `/opt/homebrew`, so a POSIX path is compared lower-cased.
  const ci = env.caseInsensitive ?? process.platform === "darwin";
  const fold = (p: string): string => (ci && !isWin32HostPath(p) ? foldName(p) : p);
  real = fold(real);
  const exact = roots.exact.map(fold);
  const subtree = roots.subtree.map(fold);
  if (exact.some((r) => sameHostPath(r, real))) return "sensitive_root";
  // Only the roots that contain the exempt folder are lifted for it: a CLI workdir is never an
  // opening into `~/.ssh` or `~/Library` (those do not contain it).
  // Linux: the owner's drives and network mounts under `/run` are lifted the same way.
  const linux = process.platform !== "win32" && (env.platform ?? process.platform) === "linux";
  const exempt = [...(env.ownDirs ?? []), ...(linux ? linuxRunCarveOuts() : [])];
  const own = exempt.map((d) => fold(resolve(d))).find((d) => under(real, d));
  // Its dot-folders hold the CLI's settings and tool token: never shared, even inside the exempt one.
  if (own !== undefined && real.slice(own.length + 1).startsWith(".")) return "sensitive_root";
  // Windows' temp folder lifts only `~\AppData`, and only for itself and what is inside it: the
  // rest of AppData (`Local\Temp2`, `Local\Psyche`) and a protected root inside Temp (a
  // `$PSYCHE_HOME` there) stay refused.
  const home = resolve(env.home ?? homedir());
  const temp = process.platform === "win32" ? windowsTempDir(env, home) : undefined;
  const appData = joinHostPath(home, "AppData");
  const inTemp = temp !== undefined && under(real, temp);
  for (const root of subtree) {
    if (!under(real, root)) continue;
    if (own !== undefined && under(own, root)) continue;
    if (inTemp && sameHostPath(root, appData)) continue;
    return "sensitive_root";
  }
  for (const root of [...exact, ...subtree]) {
    if (!sameHostPath(root, real) && under(root, real)) return "contains_sensitive_root";
  }
  return undefined;
}

/**
 * The real path of the folder the owner picked, refused when it is sensitive. Resolves `..` and
 * symlinks first, so a link to `~/.ssh` is judged as `~/.ssh`.
 */
export async function resolveFolderPick(raw: string, env: FolderAccessEnv = {}): Promise<string> {
  if (raw.includes("\0") || !isAbsoluteHostPath(raw)) {
    throw new PsycheError("invalid_params", "pick an absolute folder path");
  }
  let real: string;
  try {
    real = await realpath(resolve(raw));
    if (!(await stat(real)).isDirectory()) {
      throw new PsycheError("invalid_params", `${raw} is not a folder`);
    }
  } catch (err) {
    if (err instanceof PsycheError) throw err;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PsycheError("not_found", `${raw} does not exist`);
    }
    throw err;
  }
  // Protected roots are compared as real paths too (/private/var, a linked ~/.ssh).
  const protectedReal: string[] = [];
  for (const p of env.protectedRoots ?? []) {
    try {
      protectedReal.push(await realpath(p));
    } catch {
      // Not there: the written path is enough.
    }
  }
  const refusal = refuseFolder(real, {
    ...env,
    protectedRoots: [...(env.protectedRoots ?? []), ...protectedReal],
  });
  if (refusal !== undefined) {
    throw new PsycheError("forbidden", `${real} cannot be shared with the agent`, {
      details: { reason: refusal, path: real },
    });
  }
  return real;
}

const SENSITIVE_FILE_NAMES = new Set([
  ".zsh_history",
  ".bash_history",
  ".sh_history",
  ".python_history",
  ".node_repl_history",
  ".psql_history",
  ".pgpass",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".npmrc",
]);

/** Credential and history files that are refused wherever they sit. */
export function isSensitiveFileName(path: string): boolean {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (SENSITIVE_FILE_NAMES.has(name)) return true;
  return /[\\/]\.cargo[\\/]credentials[^\\/]*$/i.test(path);
}

/**
 * The real path of a FILE the owner attached to a chat message (a native pick or a drop). Same
 * checks as a folder pick: symlinks and `..` are resolved first, so a link to `~/.ssh/id_ed25519`
 * is judged as that file, and a file under a sensitive root is refused. Only regular files pass.
 */
export async function resolveFilePick(
  raw: string,
  env: FolderAccessEnv = {},
): Promise<{ path: string; size: number }> {
  if (raw.includes("\0") || !isAbsoluteHostPath(raw)) {
    throw new PsycheError("invalid_params", "attach a file by its absolute path");
  }
  let real: string;
  let size: number;
  let nlink: number;
  try {
    real = await realpath(resolve(raw));
    const st = await stat(real);
    if (!st.isFile()) throw new PsycheError("invalid_params", `${raw} is not a file`);
    size = st.size;
    nlink = st.nlink;
  } catch (err) {
    if (err instanceof PsycheError) throw err;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PsycheError("not_found", `${raw} does not exist`);
    }
    throw err;
  }
  const protectedReal: string[] = [];
  for (const p of env.protectedRoots ?? []) {
    try {
      protectedReal.push(await realpath(p));
    } catch {
      // Not there: the written path is enough.
    }
  }
  const refusal = refuseFolder(real, {
    ...env,
    protectedRoots: [...(env.protectedRoots ?? []), ...protectedReal],
  });
  if (refusal !== undefined) {
    throw new PsycheError("forbidden", `${real} cannot be shared with the agent`, {
      details: { reason: refusal, path: real },
    });
  }
  // Single files no folder grant could ever reach: credential and history files, and a hard link
  // (realpath cannot see that `~/Documents/x` is `~/.ssh/id_ed25519`).
  if (isSensitiveFileName(real) || nlink > 1) {
    throw new PsycheError("forbidden", `${real} cannot be shared with the agent`, {
      details: { reason: nlink > 1 ? "hard_link" : "sensitive_file", path: real },
    });
  }
  return { path: real, size };
}

/** What the Gateway made of the folder the agent named, shown on the card as the pre-filled pick. */
export type RequestedFolder =
  | { status: "ok"; path: string }
  | { status: "blocked"; path: string; reason: FolderRefusal }
  | { status: "missing" };

/**
 * Resolves the path the agent asked for (`~/` expanded, `..` and symlinks resolved). It must exist
 * and be a directory; a sensitive root is `blocked` (the card disables Allow and offers the
 * picker); anything else unusable is `missing` (the card falls back to the picker). The broker
 * re-resolves whatever the owner finally allows, so this is a preview, never a grant.
 */
export async function resolveRequestedFolder(
  raw: string,
  env: FolderAccessEnv = {},
): Promise<RequestedFolder> {
  const given = expandHome(raw, env);
  if (given.includes("\0") || !isAbsoluteHostPath(given)) return { status: "missing" };
  const real = await existingFolderFor(resolve(given));
  if (real === undefined) return { status: "missing" };
  const protectedReal: string[] = [];
  for (const p of env.protectedRoots ?? []) {
    try {
      protectedReal.push(await realpath(p));
    } catch {
      // Not there: the written path is enough.
    }
  }
  const reason = refuseFolder(real, {
    ...env,
    protectedRoots: [...(env.protectedRoots ?? []), ...protectedReal],
  });
  return reason === undefined
    ? { status: "ok", path: real }
    : { status: "blocked", path: real, reason };
}

/**
 * The folder a request names: the folder itself, the folder holding a file (a denied read of
 * `~/Downloads/a.pdf` asks for `~/Downloads`), or the folder a not-yet-existing file would be
 * created in. Anything else is undefined, so the card falls back to the picker.
 */
async function existingFolderFor(path: string): Promise<string | undefined> {
  try {
    const real = await realpath(path);
    return (await stat(real)).isDirectory() ? real : dirname(real);
  } catch {
    // A new file: its parent folder, when that exists.
  }
  try {
    const parent = await realpath(dirname(path));
    return (await stat(parent)).isDirectory() ? parent : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a folder the owner already granted (Settings, or this conversation) covers `path` at
 * `access`, so asking again would be asking for what they gave. A file or a not-yet-existing path
 * is covered when a granted folder contains it; a read-only grant does not cover a write.
 */
export function folderCovers(
  grants: readonly FolderGrantEntry[],
  path: string,
  access: "ro" | "rw",
): FolderGrantEntry | undefined {
  const canonical = (p: string): string | undefined => {
    try {
      return canonicalHostPath(p);
    } catch {
      return undefined;
    }
  };
  const target = canonical(path);
  if (target === undefined) return undefined;
  const best = grants
    .filter((g) => {
      const root = canonical(g.path);
      return root !== undefined && entryMatches({ ...g, path: root }, target);
    })
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (best === undefined) return undefined;
  return access === "rw" && best.mode !== "rw" ? undefined : best;
}

/** `~/x` (and `~\\x` on Windows) under the owner's home; anything else as given. */
function expandHome(raw: string, env: FolderAccessEnv): string {
  const tilde = raw.startsWith("~/") || (process.platform === "win32" && raw.startsWith("~\\"));
  return tilde ? joinHostPath(resolve(env.home ?? homedir()), raw.slice(2)) : raw;
}

/** Offers only `once` when the request comes from a tainted context (security §3.6). */
export function folderScopesOffered(taint: boolean): ("once" | "always")[] {
  return taint ? ["once"] : ["once", "always"];
}

/**
 * One folder of a Space (docs/design/spaces-2026.md §5.3), as the Gateway keeps it
 * (`space_folders`): the path the owner picked, the real path recorded when it was added, its
 * mode, and whether unattended runs may write there (`automations_write`, SP8).
 */
export interface SpaceFolderRecord {
  spaceId: string;
  spaceName: string;
  path: string;
  real: string;
  mode: "ro" | "rw";
  automationsWrite: boolean;
}

/** Where a thread's runs get their Space from (`PermissionBrokerOptions.spaces.spaceOf`). */
export type ThreadSpace =
  /** The thread is in this Space (a chat, or the automation it runs for). */
  | { spaceId: string; spaceName: string }
  /**
   * A subagent thread: it works in its parent run's Space, which the loop names at the run's
   * start (`bindRun`'s `parent`). Without that, the subagent's run gets no Space.
   */
  | { parentThreadId: string };

/**
 * What storing a card's pick did: `added` (the folder is in the Space at the pick's mode now), or
 * `not_raised` (the Space holds it read-only and lets automations write there, so a card does not
 * raise it to read & write: that is the Mac's own `spaces.folders.setMode`; nothing changed).
 */
export type SpaceFolderAdd = "added" | "not_raised";

/**
 * The third folder scope, "Allow in this Space", as the Gateway stores it. Reads are synchronous
 * (the Gateway's SQLite) and answer the live state, so a folder removed, a Space archived or
 * deleted stops counting on the next call. Any throw is taken as "no Space folders" (fail closed).
 */
export interface SpaceFolderSource {
  /** The Space a run in this thread works in, read once at the run's start (`bindRun`). */
  spaceOf(threadId: string): ThreadSpace | undefined;
  /** The folders of a Space that is not archived; none for an archived or deleted one. */
  folders(spaceId: string): readonly SpaceFolderRecord[];
  /** Every folder of every Space that is not archived (Settings' access list, the root looks). */
  all(): readonly SpaceFolderRecord[];
  /**
   * Stores an approved pick ("Allow in this Space"); throws when the Space is gone or archived.
   * Only ever widens a folder, and never to read & write where automations may write (SP8).
   */
  add(
    spaceId: string,
    entry: { path: string; real: string; mode: "ro" | "rw" },
    by: { deviceId?: string },
  ): SpaceFolderAdd | Promise<SpaceFolderAdd>;
  /** Removes one folder from a Space (the owner's revoke); true when it was there. */
  remove(spaceId: string, path: string): boolean | Promise<boolean>;
}

/**
 * The mode a Space folder has in one run: a chat uses the folder's own mode; an unattended run
 * (an automation) writes only where the owner turned on "Automations may change files here"
 * (SP8, SR4). Never wider than the folder's own mode.
 */
export function spaceFolderMode(
  folder: Pick<SpaceFolderRecord, "mode" | "automationsWrite">,
  unattended: boolean,
): "ro" | "rw" {
  return folder.mode === "rw" && (!unattended || folder.automationsWrite) ? "rw" : "ro";
}

/**
 * Settings path: throws `forbidden` when a folder the owner types or picks into
 * `permissions.policy.folders` is a sensitive root. A folder that does not exist yet is judged
 * by its normalised path. Returns the real path it judged, or undefined when the folder does not
 * exist yet: Settings records that one as where the folder was granted, so it is looked up once.
 */
export async function assertFolderGrantable(
  given: string,
  env: FolderAccessEnv = {},
): Promise<string | undefined> {
  const raw = expandHome(given, env);
  if (raw.includes("\0") || !isAbsoluteHostPath(raw)) {
    throw new PsycheError("invalid_params", "folder grants are absolute paths");
  }
  let real = resolve(raw);
  let exists = false;
  try {
    real = await realpath(real);
    exists = true;
  } catch (err) {
    // Not there (yet): the normalised path is judged. Any other failure (`/.vol/..` gives ENOENT
    // but opens; a loop; no permission) leaves the real path unknown, so nothing is granted.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new PsycheError("forbidden", `${real} cannot be shared with the agent`, {
        details: { reason: "sensitive_root", path: real },
      });
    }
  }
  const protectedReal: string[] = [];
  for (const p of env.protectedRoots ?? []) {
    try {
      protectedReal.push(await realpath(p));
    } catch {
      // Not there: the written path is enough.
    }
  }
  const refusal = refuseFolder(real, {
    ...env,
    protectedRoots: [...(env.protectedRoots ?? []), ...protectedReal],
  });
  if (refusal !== undefined) {
    throw new PsycheError("forbidden", `${real} cannot be shared with the agent`, {
      details: { reason: refusal, path: real },
    });
  }
  return exists ? real : undefined;
}
