import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  type Stats,
  statSync,
} from "node:fs";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import {
  type AgentToolRegistration,
  defineTool,
  GIT_DRIVER_QUERY,
  gitDriverOverrides,
  type ToolRunContext,
} from "@psyche/agent-core";
import { createScratchDir, defaultDenyRead, scratchReadRules } from "@psyche/mcp-host";
import {
  classifyHostCommand,
  type FolderAccessEnv,
  type FolderGrantEntry,
  grantedRootRefused,
  hostProgramCoverage,
  lookupRootFacts,
  operandsInside,
  programName,
  READ_ONLY_RULE,
  type RootFacts,
  SYSTEM_BIN_DIRS,
} from "@psyche/permissions";
import {
  type AuditLog,
  EXEC_DEFAULT_TIMEOUT_MS,
  EXEC_OUTPUT_CAP_BYTES,
  type PermissionBroker,
  PsycheError,
  type ToolResult,
} from "@psyche/protocol";
import { hostWords } from "@psyche/protocol/host-words";
import { type CliDriver, type CliResult, nodeCliDriver } from "@psyche/sandbox";
import { Type } from "@sinclair/typebox";
import { folderAccessEnv } from "./protected-paths.ts";
import type { SrtResolver } from "./srt.ts";

/**
 * `exec_host`, "Run commands on this Mac" (security §5.4): one argv on the owner's own Mac, in a
 * folder the owner granted. Off by default (`exec.execHostEnabled`); every call asks on the Mac
 * (device-only), answered `once` or `always` bound to the exact argv, cwd, env subset and the
 * resolved executable's SHA-256 (30 days). A tainted turn is offered `once` only (§3.6). The card
 * may also offer "Always allow <program> in <folder>" (`packages/permissions/src/host-program.ts`,
 * 90 days): keyed on the binary's real path and hash, any arguments only for tools that cannot run
 * other code, otherwise the exact argv; the run re-hashes the binary and stays under srt.
 *
 * The command runs under srt with Psyche's deny profile (§5.3: the vault, state, audit, browser
 * profiles, `~/.ssh`, Keychains) and may write only to its granted folder (when that grant is
 * read-write) and a scratch directory. Only when the owner types `UNSANDBOXED` on the card does
 * one approved run go without srt; when srt is missing, that is the card's only way to run.
 * Bounded like `exec`: a timeout, 128 KB per stream, output masked with the vault's redactor,
 * the process group killed on Esc / Stop.
 *
 * Read-only commands (`classifyHostCommand`: `date`, `ls`, `cat`, `wc`…, and the read-only git
 * subcommands, run hardened: see `readOnlyGitInvocation`) are a `read`:
 * the broker runs them without a card for an untainted owner turn outside `manual` mode
 * (`exec.readOnlyWithoutAsking`, on by default). They take the system binary only (SIP-protected
 * folders) and `PATH` limited to them, regular-file operands that stay inside the cwd after
 * symlinks, no env and no network, and run under srt with nothing writable but the scratch
 * directory, at most 15 s and two at a time, checked again right before the run. Each such run
 * is audited before it starts (`exec_host.read_only_run`) and when it ends (`….done`).
 */

export const UNSANDBOXED_WORD = "UNSANDBOXED";
/** A read-only command run without a card: at most this long, and this many at once. */
export const READ_ONLY_TIMEOUT_MS = 15_000;
export const READ_ONLY_CONCURRENCY = 2;

/**
 * Prefixed to every git that `exec_host` runs, carded or not (security §5.4): git runs programs
 * its config names, which an earlier write could have set. fsmonitor, hooks, the pager, an
 * external diff, signature display and gpg are off; `gitDriverOverrides` adds every filter, diff
 * and merge driver the repository's config defines. A side effect, and the safer default: an
 * approved `git commit` runs no hooks and cannot GPG-sign; the owner can in their own terminal.
 */
export const EXEC_HOST_GIT_HARDENING = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.pager=cat",
  "-c",
  "diff.external=",
  "-c",
  "log.showSignature=false",
  "-c",
  "gpg.program=/usr/bin/false",
  "-c",
  "gpg.ssh.program=/usr/bin/false",
  "-c",
  "gpg.x509.program=/usr/bin/false",
] as const;

/**
 * Windows' `EXEC_HOST_GIT_HARDENING`. `/dev/null` there is a path on the current drive (whose
 * root a standard user may create folders in), so hooks point at a folder under System32 that
 * does not exist and only an administrator could create, and gpg at a program that does not
 * exist there either: signing fails as `/usr/bin/false` makes it fail on a Mac.
 */
export function windowsGitHardening(env: NodeJS.ProcessEnv = process.env): string[] {
  const sys = win32.join(env.SystemRoot ?? "C:\\Windows", "System32");
  const none = win32.join(sys, "psyche-disabled");
  const nogpg = win32.join(sys, "psyche-disabled.exe");
  return [
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.hooksPath=${none}`,
    "-c",
    "core.pager=cat",
    "-c",
    "diff.external=",
    "-c",
    "log.showSignature=false",
    "-c",
    `gpg.program=${nogpg}`,
    "-c",
    `gpg.ssh.program=${nogpg}`,
    "-c",
    `gpg.x509.program=${nogpg}`,
  ];
}

function gitHardening(platform: NodeJS.Platform): readonly string[] {
  return platform === "win32" ? windowsGitHardening() : EXEC_HOST_GIT_HARDENING;
}

export function isGit(
  executable: string,
  argv0: string | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (platform === "win32") {
    const name = (p: string) =>
      win32
        .basename(p)
        .toLowerCase()
        .replace(/\.exe$/, "");
    return name(executable) === "git" || (argv0 !== undefined && name(argv0) === "git");
  }
  // APFS folds case, and `ſ` folds to `s`: `GIT` is git and must get the same hardening.
  return programName(executable) === "git" || (argv0 !== undefined && programName(argv0) === "git");
}

/** The `-c` pairs that switch off the drivers the repository's config defines (config only). */
function gitDriversOff(
  git: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  globals: readonly string[] = [],
): Promise<string[]> {
  return new Promise((done, fail) => {
    execFile(
      git,
      [...gitHardening(platform), ...globals, ...GIT_DRIVER_QUERY],
      { cwd, env, timeout: 5_000, maxBuffer: 256 * 1024, windowsHide: true },
      (err, stdout) => {
        // Exit 1 means none are defined. Any other failure means the config could not be read,
        // so the drivers it names cannot be switched off: the command does not run.
        const code = (err as { code?: unknown } | null)?.code;
        if (err !== null && code !== 1) {
          fail(
            new PsycheError(
              "unavailable",
              "git's config could not be read; the command was not run",
            ),
          );
          return;
        }
        try {
          done(gitDriverOverrides(String(stdout ?? "")));
        } catch (e) {
          fail(e); // a driver name `-c` cannot carry: fail closed
        }
      },
    );
  });
}

/** What git itself resolves from `cwd`: the git dir and the work tree, both absolute. */
function gitProbe(
  git: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  hardening: readonly string[],
): Promise<{ gitDir: string; top: string } | undefined> {
  return new Promise((done) => {
    execFile(
      git,
      [...hardening, "rev-parse", "--absolute-git-dir", "--show-toplevel"],
      { cwd, env, timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true },
      (err, stdout) => {
        const lines = String(stdout ?? "")
          .split("\n")
          .filter((l) => l !== "");
        if (err !== null || lines.length !== 2) return done(undefined);
        try {
          done({
            gitDir: realpathSync(lines[0] as string),
            top: realpathSync(lines[1] as string),
          });
        } catch {
          done(undefined);
        }
      },
    );
  });
}

/**
 * Is the repository git opened from here one a quiet run may read? Its git dir is a plain
 * `.git` directly under its work tree (so cwd is not itself a git dir, whose own config git would
 * use), both lie inside the shared folder, its config redirects nothing, it borrows no object
 * stores (alternates) and it has no submodules.
 */
export function quietGitRepoOk(
  probe: { gitDir: string; top: string },
  realCwd: string,
  folderReal: string,
): boolean {
  const { gitDir, top } = probe;
  if (basename(gitDir) !== ".git" || dirname(gitDir) !== top) return false;
  if (!under(top, folderReal) || !under(realCwd, top)) return false;
  if (lstatSync(gitDir, { throwIfNoEntry: false })?.isDirectory() !== true) return false;
  try {
    const config = readFileSync(join(gitDir, "config"), "utf8");
    if (config.length > 1_000_000 || GIT_CONFIG_REDIRECT.test(config)) return false;
  } catch {
    return false;
  }
  if (lstatSync(join(gitDir, "commondir"), { throwIfNoEntry: false }) !== undefined) return false;
  const objects = join(gitDir, "objects");
  if (
    lstatSync(join(objects, "info", "http-alternates"), { throwIfNoEntry: false }) !== undefined
  ) {
    return false;
  }
  // Any alternates at all ask: a store inside the folder can name further stores outside it.
  if (lstatSync(join(objects, "info", "alternates"), { throwIfNoEntry: false }) !== undefined) {
    return false;
  }
  // Submodules ask: `.gitmodules` (a committed file) can set `submodule.<name>.ignore = none`,
  // and git then recurses with the submodule's own config, whose drivers are never checked.
  if (lstatSync(join(top, ".gitmodules"), { throwIfNoEntry: false }) !== undefined) return false;
  if (lstatSync(join(gitDir, "modules"), { throwIfNoEntry: false }) !== undefined) return false;
  return true;
}
const MAX_TIMEOUT_MS = 10 * 60_000;
const ENV_NAME = "^[A-Z][A-Z0-9_]{0,63}$";
/** Bare argv[0] is looked up here only, never in a PATH the agent supplies (CVE-2026-24763). */
export const SAFE_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];
/** Env names the agent may not set: they change what runs or where it loads code from. */
const RESERVED_ENV =
  /^(PATH|HOME|TMPDIR|SHELL|USER|LOGNAME|DYLD_.*|LD_.*|NODE_OPTIONS|BASH_ENV|ENV|PYTHONSTARTUP|PSYCHE_.*)$/;
/**
 * Windows adds the names its own `PATH`-like lookups and profile folders use (names are
 * case-insensitive there, so the upper-case spelling the schema allows is the same variable).
 */
const RESERVED_ENV_WINDOWS =
  /^(PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|USERPROFILE|HOMEDRIVE|HOMEPATH|USERNAME|USERDOMAIN|TEMP|TMP|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMW6432|COMMONPROGRAMFILES|PSMODULEPATH)$/;

/**
 * Windows' `SAFE_PATH`: its own folders (admin-only, like the SIP folders), then PowerShell 7,
 * Git for Windows and Node under Program Files (admin-only, like Homebrew's prefix is not).
 * Only `.exe` / `.com` files are taken from them: a `.cmd` / `.bat` would need cmd.exe, which
 * re-reads the arguments as a command line.
 */
export function windowsSafePath(env: NodeJS.ProcessEnv = process.env): string[] {
  const root = env.SystemRoot ?? "C:\\Windows";
  const pf = env.ProgramFiles ?? "C:\\Program Files";
  return [
    win32.join(root, "System32"),
    root,
    win32.join(root, "System32", "Wbem"),
    win32.join(root, "System32", "WindowsPowerShell", "v1.0"),
    win32.join(root, "System32", "OpenSSH"),
    win32.join(pf, "PowerShell", "7"),
    win32.join(pf, "Git", "cmd"),
    win32.join(pf, "nodejs"),
  ];
}

/** Extensions Windows starts without a shell, in `PATHEXT` order (`.com`, `.exe`). */
function directExtensions(env: NodeJS.ProcessEnv = process.env): string[] {
  const listed = (env.PATHEXT ?? ".COM;.EXE")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e === ".exe" || e === ".com");
  return listed.length > 0 ? [...new Set(listed)] : [".com", ".exe"];
}

const BATCH = new Set([".cmd", ".bat"]);

/** Where srt is, or why it is not: the Gateway's one resolver (`compose/srt.ts`). */
export type SrtStatus = { path: string } | { missing: true; reason: string };
export type SrtLookup = Pick<SrtResolver, "resolve">;

/**
 * The last answer, for the card (`describeCall` is synchronous), refreshed on every look; a run
 * always waits for a fresh one.
 */
export function cachedSrt(resolver: SrtLookup): {
  known(): SrtStatus;
  fresh(): Promise<SrtStatus>;
} {
  let last: SrtStatus | undefined;
  const fresh = async () => {
    last = await resolver.resolve();
    return last;
  };
  void fresh().catch(() => undefined);
  return {
    known() {
      void fresh().catch(() => undefined);
      return last ?? { missing: true, reason: "the sandbox is still being checked" };
    },
    fresh,
  };
}

export interface ExecHostDeps {
  broker: Pick<PermissionBroker, "get"> & Partial<Pick<PermissionBroker, "listGrants">>;
  vault: { redact(text: string): string };
  /** The live granted folders for a conversation (Settings plus this chat's Allow once). */
  folders(threadId: string): readonly FolderGrantEntry[];
  /**
   * A live look at a granted root (the broker's `lookRootNow`): one lookup in flight per path
   * shared with the broker's cache, bounded by a timeout, so a hung mount holds one libuv thread
   * per path, not one per call. Undefined: the root cannot be read now (refused). Without it
   * (tests) each call looks the roots up itself.
   */
  lookRoot?(path: string): Promise<RootFacts | undefined>;
  srt: SrtLookup;
  /** `$PSYCHE_HOME`: denied to the command; its settings and scratch live under it. */
  home: string;
  driver?: CliDriver;
  /** The owner's home folder (tests). */
  userHome?: string;
  /** Records each read-only run the broker let through without a card, before it starts. */
  audit?: Pick<AuditLog, "append">;
  /** Tests: a shorter cap than `READ_ONLY_TIMEOUT_MS`. */
  readOnlyTimeoutMs?: number;
  /** Whose rules apply (tests; default this process's platform). */
  platform?: NodeJS.Platform;
}

/**
 * The whole environment of a host command on Windows (the Mac's `PATH`, `HOME`, `USER`,
 * `TMPDIR`, `LANG` counterpart): `PATH` limited to `windowsSafePath`, `PATHEXT` to what starts
 * without a shell, the system folders programs need to load at all, the owner's profile
 * folders, and the scratch folder as `TEMP` / `TMP`. Nothing else of the Gateway's own.
 */
export function windowsHostEnv(
  userHome: string,
  user: string,
  scratch: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const root = env.SystemRoot ?? "C:\\Windows";
  const keep = [
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "CommonProgramW6432",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "OS",
  ];
  const out: Record<string, string> = {
    PATH: windowsSafePath(env).join(";"),
    PATHEXT: ".COM;.EXE",
    SystemRoot: root,
    windir: root,
    SystemDrive: env.SystemDrive ?? root.slice(0, 2),
    ComSpec: win32.join(root, "System32", "cmd.exe"),
    USERPROFILE: userHome,
    HOMEDRIVE: win32.parse(userHome).root.replace(/\\$/, ""),
    HOMEPATH: userHome.slice(win32.parse(userHome).root.length - 1),
    USERNAME: user,
    APPDATA: win32.join(userHome, "AppData", "Roaming"),
    LOCALAPPDATA: win32.join(userHome, "AppData", "Local"),
    TEMP: scratch,
    TMP: scratch,
  };
  for (const k of keep) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

interface Resolved {
  executable: string;
  sha256: string;
}

/** Per-binary hash cache keyed by inode, size and mtime, so a changed binary is hashed again. */
const hashes = new Map<string, { key: string; sha256: string }>();

function statKey(st: Stats): string {
  return `${st.ino}:${st.size}:${st.mtimeMs}`;
}

function sha256Of(path: string): string {
  const st = statSync(path);
  const key = statKey(st);
  const hit = hashes.get(path);
  if (hit?.key === key) return hit.sha256;
  const sha256 = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  hashes.set(path, { key, sha256 });
  return sha256;
}

/**
 * Windows: a path (a drive letter or a separator) is taken as given, a bare name is looked up
 * in `path` only. Either way a name without an extension tries `PATHEXT`'s `.com` and `.exe`,
 * and only such a file runs; a batch file is refused, never handed to cmd.exe.
 */
function resolveWindowsExecutable(argv0: string, cwd: string, path: readonly string[]): Resolved {
  const isPath = /[\\/]/.test(argv0) || /^[A-Za-z]:/.test(argv0);
  const bases = isPath
    ? [win32.isAbsolute(argv0) ? argv0 : win32.resolve(cwd, argv0)]
    : path.map((d) => win32.join(d, argv0));
  const exts = directExtensions();
  let batch: string | undefined;
  for (const base of bases) {
    const ext = win32.extname(base).toLowerCase();
    const tries =
      ext === "" ? [...exts.map((e) => base + e), `${base}.cmd`, `${base}.bat`] : [base];
    for (const c of tries) {
      let real: string;
      try {
        real = realpathSync.native(c);
        if (!statSync(real).isFile()) continue;
      } catch {
        continue;
      }
      const realExt = win32.extname(real).toLowerCase();
      if (BATCH.has(realExt)) {
        batch ??= real;
        continue;
      }
      if (realExt !== ".exe" && realExt !== ".com") continue;
      return { executable: real, sha256: sha256Of(real) };
    }
  }
  if (batch !== undefined) {
    throw new PsycheError(
      "invalid_params",
      `${argv0} is a batch file (${batch}); Windows runs those through cmd.exe, which reads the arguments again as a command line. Run the program it starts, or name cmd.exe yourself`,
    );
  }
  throw new PsycheError(
    "not_found",
    isPath
      ? `${argv0} is not a program (.exe or .com)`
      : `${argv0} is not in ${path.join(";")}; give its absolute path`,
  );
}

/** argv[0] → the real file that runs: absolute, cwd-relative (`./x`), or from `SAFE_PATH`. */
export function resolveExecutable(
  argv0: string,
  cwd: string,
  path?: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Resolved {
  if (platform === "win32") {
    return resolveWindowsExecutable(argv0, cwd, path ?? windowsSafePath());
  }
  path ??= SAFE_PATH;
  const candidates = argv0.includes("/")
    ? [isAbsolute(argv0) ? argv0 : resolve(cwd, argv0)]
    : path.map((d) => join(d, argv0));
  for (const c of candidates) {
    let real: string;
    try {
      // `.native` returns the file system's own spelling (`/bin/ſh` is `/bin/sh`).
      real = realpathSync.native(c);
      if (!statSync(real).isFile()) continue;
      accessSync(real, constants.X_OK);
    } catch {
      continue;
    }
    return { executable: real, sha256: sha256Of(real) };
  }
  throw new PsycheError(
    "not_found",
    argv0.includes("/")
      ? `${argv0} is not an executable file`
      : `${argv0} is not in ${SAFE_PATH.join(":")}; give its absolute path`,
  );
}

/** Browser profiles beyond `defaultDenyRead`'s Chrome, Firefox and Safari. */
function browserProfiles(home: string): string[] {
  const s = (...p: string[]) => join(home, "Library", "Application Support", ...p);
  return [
    s("BraveSoftware"),
    s("Microsoft Edge"),
    s("Arc"),
    s("Chromium"),
    s("Vivaldi"),
    join(home, "Library", "Containers", "com.apple.Safari"),
  ];
}

/**
 * Other places the owner's files and every app's temp files live: a program-grant run reads none
 * of them (a link inside the folder could point there). Its own scratch directory is re-allowed.
 */
const CONFINED_DENY_READ = [
  "/Volumes",
  "/tmp",
  "/private/tmp",
  "/var/folders",
  "/private/var/folders",
  "/Users/Shared",
];

/**
 * The srt profile of one host command (security §5.3): Psyche's deny-read list, writes only to
 * the scratch directory and a read-write granted folder, network only to `allowedDomains`
 * through srt's proxies, every documented escape hatch off.
 */
export function execHostSrtSettings(input: {
  psycheHome: string;
  userHome: string;
  scratch: string;
  writable: readonly string[];
  allowedDomains: readonly string[];
  /** A program-grant run reads nothing of the owner's home or `/Volumes` but this folder. */
  confineRead?: string;
}): Record<string, unknown> {
  const h = (...p: string[]) => join(input.userHome, ...p);
  const scratch = scratchReadRules(input.psycheHome, input.scratch);
  return {
    filesystem: {
      denyRead: [
        ...new Set([
          // The MCP list is rooted at this process's home; re-rooted at the owner's.
          ...defaultDenyRead(input.psycheHome).map((p) =>
            p.startsWith(`${homedir()}/`) ? join(input.userHome, p.slice(homedir().length + 1)) : p,
          ),
          join(input.psycheHome, "vault"),
          join(input.psycheHome, "state"),
          join(input.psycheHome, "audit"),
          join(input.psycheHome, "browser", "profiles"),
          h(".ssh"),
          h("Library", "Keychains"),
          ...browserProfiles(input.userHome),
          ...scratch.denyRead,
          ...(input.confineRead === undefined ? [] : [input.userHome, ...CONFINED_DENY_READ]),
        ]),
      ],
      allowRead: [
        ...scratch.allowRead,
        ...(input.confineRead === undefined ? [] : [input.confineRead]),
      ],
      allowWrite: [input.scratch, ...input.writable],
      denyWrite: [
        input.psycheHome,
        h(".ssh"),
        h("Library", "Keychains"),
        h("Library", "Application Support", "Psyche"),
      ],
    },
    network: {
      allowedDomains: [...input.allowedDomains],
      deniedDomains: [],
      allowUnixSockets: [],
      allowLocalBinding: false,
    },
    enableWeakerNestedSandbox: false,
    allowNestedUserNamespaces: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
  };
}

/** A folder without its trailing separator (a root such as `/` or `C:\` keeps it). */
function trimSep(p: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    const n = win32.normalize(p);
    return /^[A-Za-z]:\\$/.test(n) || /^\\\\[^\\]+\\[^\\]+\\$/.test(n) ? n : n.replace(/\\+$/, "");
  }
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * Whether `path` is `root` or inside it. Windows compares without case (`C:\Users` is
 * `c:\users`) and with either separator; elsewhere byte for byte with `/`.
 */
export function within(path: string, root: string, platform = process.platform): boolean {
  if (platform === "win32") {
    const p = win32.normalize(path).toLowerCase();
    const r = trimSep(root, platform).toLowerCase();
    return p === r || p.startsWith(r.endsWith("\\") ? r : `${r}\\`);
  }
  return path === root || path.startsWith(`${root}/`);
}

function folderOf(
  path: string,
  folders: readonly FolderGrantEntry[],
  platform: NodeJS.Platform = process.platform,
): FolderGrantEntry | undefined {
  let best: FolderGrantEntry | undefined;
  for (const f of folders) {
    // An attached file is not a place to run in.
    if (f.file === true) continue;
    const root = trimSep(f.path, platform);
    if (within(path, root, platform)) {
      if (best === undefined || root.length > best.path.length) best = { ...f, path: root };
      else if (root.length === best.path.length && f.mode === "rw") best = { ...f, path: root };
    }
  }
  return best;
}

/** A granted folder holding `cwd` after symlinks resolve; the error names what is missing. */
async function grantedFolder(
  cwd: string,
  folders: readonly FolderGrantEntry[],
  platform: NodeJS.Platform = process.platform,
  env: FolderAccessEnv = {},
  look: (path: string) => Promise<RootFacts | undefined> = (path) =>
    lookupRootFacts(path).catch(() => undefined),
): Promise<{ real: string; folder: FolderGrantEntry }> {
  let real: string;
  try {
    real = await realpath(cwd);
  } catch {
    throw new PsycheError("not_found", `${cwd} does not exist`);
  }
  // Each granted root is looked up now (the broker's answer can be seconds old), and
  // judged by `grantedRootRefused`: inside a system folder, leading to a place a grant would be
  // refused (home, ~/Library, ~/.ssh, Psyche's data), or anywhere else than where it was granted
  // (its recorded real path; a swapped parent too), it covers nothing. Spelling moves (case,
  // /tmp -> /private/tmp, the firmlinked Data volume) and an unmoved root keep their meaning, so
  // an old home-root grant still works. A root whose real path cannot be read is left out.
  const resolvedFolders = (
    await Promise.all(
      folders.map(async (f): Promise<FolderGrantEntry | undefined> => {
        const facts = await look(f.path);
        if (facts === undefined) return undefined;
        if (grantedRootRefused(f.path, facts, f.real, env)) return undefined;
        return { ...f, path: facts.real ?? f.path };
      }),
    )
  ).filter((f): f is FolderGrantEntry => f !== undefined);
  const folder = folderOf(real, resolvedFolders, platform);
  if (folder === undefined) {
    throw new PsycheError("forbidden", `${real} is outside every granted folder`, {
      details: { missing: { need: "folder", path: real, access: "read_write" } },
    });
  }
  return { real, folder };
}

function envList(env: Record<string, string>): string[] {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** Config that makes a repository read outside its own folder, or pulls in other config files. */
const GIT_CONFIG_REDIRECT = /^\s*(worktree\s*=|\[\s*include)/im;

/**
 * The root of the repository git would find from `realCwd`: the nearest `.git` going up, which
 * must be a plain directory (not a file or symlink that points the repository elsewhere) whose
 * config neither sets `core.worktree` nor includes other files. `undefined` means git there is
 * not read-only: it asks. (security §5.4: a hostile checkout must not steer a quiet git.)
 */
export function gitRepoRoot(realCwd: string): string | undefined {
  for (let dir = realCwd; ; dir = dirname(dir)) {
    // A directory that looks like a bare repository (or is a `.git` itself) is a git dir to
    // git's discovery, with its own config: not a plain checkout.
    if (
      lstatSync(join(dir, "HEAD"), { throwIfNoEntry: false }) !== undefined &&
      lstatSync(join(dir, "objects"), { throwIfNoEntry: false }) !== undefined &&
      lstatSync(join(dir, "refs"), { throwIfNoEntry: false }) !== undefined
    ) {
      return undefined;
    }
    const dotGit = join(dir, ".git");
    const st = lstatSync(dotGit, { throwIfNoEntry: false });
    if (st !== undefined) {
      if (!st.isDirectory()) return undefined;
      try {
        const config = readFileSync(join(dotGit, "config"), "utf8");
        if (config.length > 1_000_000 || GIT_CONFIG_REDIRECT.test(config)) return undefined;
      } catch {
        return undefined;
      }
      return dir;
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** Recorded on a quiet read-only git's audit events. */
export const GIT_AUDIT_REASON = "remembered: read-only git";

/** Subcommands whose output goes through diff machinery: their drivers are switched off too. */
const GIT_DIFFING = new Set(["diff", "log", "show"]);

/**
 * The env and argv of a read-only git (security §5.4), on top of `EXEC_HOST_GIT_HARDENING` and
 * the repository's driver overrides: no system or global config (`GIT_CONFIG_NOSYSTEM`,
 * `GIT_CONFIG_GLOBAL`), no pager (`GIT_PAGER`, `--no-pager`, which also beats `pager.<cmd>`), no
 * optional locks (status does not rewrite the index), no prompts, no repository discovery above
 * the granted folder, submodules ignored (their config and drivers are not the ones checked),
 * and no external diff or textconv driver whatever the config says.
 */
export function readOnlyGitInvocation(
  args: readonly string[],
  folderRoot: string | undefined,
): { env: Record<string, string>; globals: string[]; args: string[] } {
  const [sub, ...rest] = args;
  return {
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_PAGER: "cat",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      ...(folderRoot === undefined ? {} : { GIT_CEILING_DIRECTORIES: dirname(folderRoot) }),
    },
    globals: ["--no-pager", "-c", "diff.ignoreSubmodules=all", "-c", "diff.submodule=short"],
    args: [
      ...(sub === undefined ? [] : [sub]),
      ...(sub !== undefined && GIT_DIFFING.has(sub) ? ["--no-ext-diff", "--no-textconv"] : []),
      ...(sub === "status" || sub === "diff" ? ["--ignore-submodules=all"] : []),
      ...rest,
    ],
  };
}

/** Read-only programs that read their operands' contents: those must be regular files. */
const READS_CONTENT = new Set(["cat", "head", "tail", "wc", "file"]);

/**
 * The read-only class with what needs the file system (security §5.4): Apple's binary from the
 * SIP-protected folders (never Homebrew's, which a same-user process could swap), and every file
 * operand inside the real cwd after symlinks. No operand is a FIFO, socket or device (a read
 * would hang or touch hardware); `cat`, `head`, `tail`, `wc` and `file` read regular files only.
 * A missing operand is checked by name: the command only fails on it, and the run checks again.
 */
export function readOnlyHost(
  p: HostParams,
  platform: NodeJS.Platform = process.platform,
): Resolved | undefined {
  // Windows has no host sandbox to keep a command read-only: every command there asks.
  if (platform === "win32") return undefined;
  if (Object.keys(p.env ?? {}).length > 0 || (p.allowedDomains ?? []).length > 0) return undefined;
  const c = classifyHostCommand(p.argv, p.cwd);
  if (!c.readOnly) return undefined;
  let cwd: string;
  let resolved: Resolved;
  try {
    cwd = realpathSync(p.cwd);
    resolved = resolveExecutable(c.program, p.cwd, SYSTEM_BIN_DIRS);
  } catch {
    return undefined;
  }
  if (!SYSTEM_BIN_DIRS.some((d) => under(resolved.executable, d))) return undefined;
  if (c.program === "git") {
    if (gitRepoRoot(cwd) === undefined) return undefined;
    // /usr/bin/git is Apple's shim: without the Command Line Tools (or Xcode) it pops an
    // install dialog, so the quiet path is not taken and the normal approval path applies.
    if (
      platform === "darwin" &&
      !existsSync("/Library/Developer/CommandLineTools/usr/bin/git") &&
      !existsSync("/Applications/Xcode.app/Contents/Developer/usr/bin/git")
    ) {
      return undefined;
    }
  }
  for (const operand of c.paths) {
    const abs = resolve(cwd, operand);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      real = abs;
    }
    if (!under(real, cwd)) return undefined;
    const st = statSync(real, { throwIfNoEntry: false });
    if (st !== undefined && !st.isFile() && (READS_CONTENT.has(c.program) || !st.isDirectory())) {
      return undefined;
    }
    // A hard link is one name for a file that may live outside the folder: realpath cannot tell.
    if (st?.isFile() === true && st.nlink > 1) return undefined;
  }
  return resolved;
}

/** What the card shows and what an `always` grant binds (security §3.5, §5.4). */
function describe(p: HostParams, platform: NodeJS.Platform) {
  const readOnly = readOnlyHost(p, platform);
  const resolved = readOnly ?? resolveExecutable(p.argv[0] as string, p.cwd, undefined, platform);
  const env = envList(p.env ?? {});
  const domains = [...(p.allowedDomains ?? [])].sort();
  return { resolved, env, domains, readOnly: readOnly !== undefined };
}

const Input = Type.Object({
  argv: Type.Array(Type.String({ maxLength: 8192 }), { minItems: 1, maxItems: 256 }),
  cwd: Type.String({
    minLength: 1,
    maxLength: 1024,
    description: "Absolute folder to run in; it must be inside a folder the owner granted",
  }),
  env: Type.Optional(
    Type.Record(Type.String({ pattern: ENV_NAME }), Type.String({ maxLength: 8192 }), {
      description:
        "Extra environment; shown on the card. PATH, HOME and loader variables are fixed",
    }),
  ),
  allowedDomains: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 253, pattern: "^[A-Za-z0-9.*-]+$" }), {
      maxItems: 32,
      description: "Hosts the command may reach (npm, git); none by default",
    }),
  ),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_TIMEOUT_MS })),
});
type HostParams = {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  allowedDomains?: string[];
  timeoutMs?: number;
};

function checkParams(p: HostParams, platform: NodeJS.Platform): void {
  if (platform === "win32") {
    // A drive-letter or UNC path: a rooted `\x` would mean "on whatever drive is current".
    if (!/^[A-Za-z]:[\\/]/.test(p.cwd) && !/^\\\\[^\\/]+[\\/][^\\/]+/.test(p.cwd)) {
      throw new PsycheError("invalid_params", "cwd must be an absolute path with a drive letter");
    }
  } else if (!isAbsolute(p.cwd)) {
    throw new PsycheError("invalid_params", "cwd must be an absolute path");
  }
  for (const [k, v] of Object.entries(p.env ?? {})) {
    if (RESERVED_ENV.test(k) || (platform === "win32" && RESERVED_ENV_WINDOWS.test(k))) {
      throw new PsycheError("invalid_params", `env ${k} is fixed`);
    }
    // Host commands get no vault secrets: placeholders stay a container (`exec`) feature.
    if (v.includes("{{cred:")) {
      throw new PsycheError("invalid_params", `env ${k}: no vault placeholders on the host`);
    }
  }
}

/** Was this run approved with `UNSANDBOXED` typed on its card (once only, never a grant)? */
async function approvedUnsandboxed(
  deps: ExecHostDeps,
  ctx: ToolRunContext,
  sha256: string,
): Promise<boolean> {
  if (ctx.approvalId === undefined) {
    // A standing `always` grant: bound to the binary hash, never unsandboxed.
    const key = ctx.authority?.grantKey;
    if (key !== undefined && !key.includes(sha256)) {
      throw new PsycheError("binding_mismatch", "the executable changed since it was approved");
    }
    return false;
  }
  const a = await deps.broker.get(ctx.approvalId);
  const details = (a?.details ?? {}) as { executableSha256?: unknown; unsandboxed?: unknown };
  if (details.executableSha256 !== sha256) {
    throw new PsycheError("binding_mismatch", "the executable changed since it was approved");
  }
  return details.unsandboxed === true && a?.scopeGranted === "once";
}

export function execHostTool(deps: ExecHostDeps): AgentToolRegistration {
  const driver = deps.driver ?? nodeCliDriver;
  const platform = deps.platform ?? process.platform;
  const windows = platform === "win32";
  const userHome = deps.userHome ?? homedir();
  const sandbox = cachedSrt(deps.srt);
  /** Read-only runs without a card in flight now (`READ_ONLY_CONCURRENCY`). */
  let quietRunning = 0;
  return defineTool({
    name: "exec_host",
    description: windows
      ? "Run one Windows program (an argv array, no shell string: argv[0] is a .exe by absolute path or a name found in Windows' own folders, Git or Node; .cmd/.bat files are refused) on the owner's own PC, in a folder they granted, for their own files and projects (build, test, git). Prefer `exec` (the sandbox) whenever the work does not need the owner's real files. Windows has no sandbox for commands on the PC itself, so every call asks the owner on their card, showing the exact argv, cwd, env and executable, and runs only if they type UNSANDBOXED there (once). It gets no secrets. It is off until the owner turns it on: when a call is denied because it is off, or the cwd is outside granted folders, use request_permission with the `missing` object from the error, then retry."
      : "Run one command (an argv array, no shell string) on the owner's own computer, in a folder they granted, for their own files and projects (build, test, git, scripts). Prefer `exec` (the sandbox container) whenever the work does not need the owner's real files. Calls ask the owner on their Mac, showing the exact argv, cwd, env and executable; read-only commands (date, pwd, whoami, uname, ls, cat, head, tail, wc, file, stat, which on files in the cwd, and git status, log, diff, show, branch (list only), rev-parse, ls-files, blame, remote -v with no option before the subcommand, in a repository inside the folder) with no env and no allowedDomains run without asking unless the turn read untrusted content; every other git command and everything else asks. It runs under srt (no secrets, no network unless `allowedDomains`). It is off until the owner turns it on: when a call is denied because it is off, or the cwd is outside granted folders, use request_permission with the `missing` object from the error, then retry.",
    input: Input,
    // The broker lowers a call to `read` only when it re-checks the read-only class itself
    // (`describeCall` names it in `meta`); the tool as such stays `destructive`.
    sideEffect: "destructive",
    provenanceOut: "untrusted",
    describeCall: (p) => {
      checkParams(p, platform);
      const described = describe(p, platform);
      const { resolved, env, domains } = described;
      // No audit log, no quiet path: the run must be recorded before it starts.
      const readOnly = described.readOnly && deps.audit !== undefined;
      const srt = sandbox.known();
      const command = p.argv.join(" ");
      // Without srt nothing runs without a card (the sandbox is what keeps it read-only); the card
      // still reads as a read.
      // A standing program grant ("Always allow <program> in <folder>") needs the binary the
      // Gateway resolved and the real cwd, and a sandbox to run in: never on Windows or without srt.
      let cwdReal: string | undefined;
      try {
        cwdReal = realpathSync(p.cwd);
      } catch {
        cwdReal = undefined;
      }
      const hostProgram =
        !windows && "path" in srt && hostProgramCoverage(p.argv, resolved.executable) === "any"
          ? {
              executable: resolved.executable,
              sha256: resolved.sha256,
              ...(cwdReal === undefined ? {} : { cwdReal }),
            }
          : undefined;
      const meta = {
        ...(readOnly
          ? {
              hostCommand: "read_only" as const,
              ...("missing" in srt ? { hostSandbox: "missing" as const } : {}),
            }
          : {}),
        ...(hostProgram === undefined ? {} : { hostProgram }),
      };
      return {
        kind: "exec_host",
        ...(Object.keys(meta).length > 0 ? { meta } : {}),
        target: { kind: "command", value: command.slice(0, 1000) },
        summary: `Run \`${command.slice(0, 80)}\` on ${hostWords().thisDevice}`,
        details: {
          argv: p.argv,
          cwd: p.cwd,
          env,
          executable: resolved.executable,
          executableSha256: resolved.sha256,
          allowedDomains: domains,
          sandbox: "path" in srt ? "srt" : "missing",
          ...("missing" in srt ? { sandboxMissingReason: srt.reason } : {}),
          // Windows: there is no sandbox to set up for host commands; only the typed word runs it.
          ...(windows ? { hostSandbox: "none" } : {}),
          unsandboxedWord: UNSANDBOXED_WORD,
          ...(readOnly ? { readOnly: true } : {}),
        },
        // Security §3.5 exec_host fields: exact argv, cwd, env subset, binary and its hash.
        bindingFields: {
          argv: p.argv,
          cwd: p.cwd,
          env: { ...(p.env ?? {}) },
          executable: resolved.executable,
          executableSha256: resolved.sha256,
          network: domains.length === 0 ? "none" : "proxy",
        },
        grantKey: `exec_host|${JSON.stringify([p.argv, p.cwd, env, resolved.executable, resolved.sha256, domains])}`,
      };
    },
    async run(p, ctx) {
      checkParams(p, platform);
      // A quiet run takes its slot before the first await, so runs racing through the checks
      // never make a third; every exit releases it.
      const quiet = ctx.approvalId === undefined && ctx.authority?.rule === READ_ONLY_RULE;
      // A standing program grant ("Always allow <program> in <folder>") authorized this run?
      const program = quiet ? undefined : await programGrantOf(ctx);
      if (quiet || program !== undefined) {
        if (quietRunning >= READ_ONLY_CONCURRENCY) {
          throw new PsycheError(
            "unavailable",
            `${READ_ONLY_CONCURRENCY} read-only commands are already running; try again when one finishes`,
            { retryable: true },
          );
        }
        quietRunning++;
      }
      try {
        return await runHost(p, ctx, quiet, program);
      } finally {
        if (quiet || program !== undefined) quietRunning--;
      }
    },
  });

  /** The program grant (binary and folder) that authorized this run, if one did. */
  async function programGrantOf(
    ctx: ToolRunContext,
  ): Promise<{ executable: string; sha256: string; folder: string } | undefined> {
    const id = ctx.authority?.grantId;
    if (ctx.approvalId !== undefined || id === undefined) return undefined;
    // Fail closed: a standing grant authorized this run, and without the ledger we cannot tell
    // whether it was a program grant that must be confined.
    if (deps.broker.listGrants === undefined) {
      throw new PsycheError(
        "unavailable",
        "the grant ledger is not available; the command was not run",
      );
    }
    const grants = await deps.broker.listGrants({ kind: "exec_host" });
    const g = grants.find((x) => x.id === id);
    if (g === undefined) {
      throw new PsycheError("forbidden", "the grant that allowed this command is not live");
    }
    const h = (g.subject as { hostProgram?: Record<string, unknown> }).hostProgram;
    if (h === undefined || h === null) return undefined;
    if (
      typeof h.executable !== "string" ||
      typeof h.sha256 !== "string" ||
      typeof h.folder !== "string"
    ) {
      throw new PsycheError("forbidden", "the program grant is malformed");
    }
    return { executable: h.executable, sha256: h.sha256, folder: h.folder };
  }

  async function runHost(
    p: HostParams,
    ctx: ToolRunContext,
    quietRun: boolean,
    program?: { executable: string; sha256: string; folder: string },
  ): Promise<ToolResult> {
    const quiet = quietRun;
    // A program-grant run has the quiet class's limits: audited first, 15 s, two at a time.
    const limited = quietRun || program !== undefined;
    const { real, folder } = await grantedFolder(
      p.cwd,
      deps.folders(ctx.threadId),
      platform,
      // Home-relative refusals (~/Library, ~/.ssh, the CLI dirs) judged against the exec user's home.
      { ...folderAccessEnv(deps.home), home: userHome },
      deps.lookRoot === undefined
        ? undefined
        : (path) => deps.lookRoot?.(path) ?? Promise.resolve(undefined),
    );
    // Hashed again right before it runs: a binary swapped after approval does not run.
    const described = describe(p, platform);
    const { resolved, domains } = described;
    const readOnly = described.readOnly;
    let confineRead: string | undefined;
    if (program !== undefined) {
      // Everything decide checked is checked again against what is on disk now.
      let folderReal: string;
      try {
        folderReal = realpathSync.native(program.folder);
      } catch {
        throw new PsycheError("forbidden", "the folder of this program grant is gone");
      }
      if (
        resolved.executable !== program.executable ||
        resolved.sha256 !== program.sha256 ||
        !operandsInside(p.argv[0] as string, p.argv.slice(1), real, folderReal)
      ) {
        throw new PsycheError(
          "forbidden",
          "This command no longer fits its program grant (the binary changed, or a path leaves the folder); it was not run",
        );
      }
      confineRead = folderReal;
    }
    if (limited && deps.audit === undefined) {
      throw new PsycheError("forbidden", "Read-only commands run without a card only when audited");
    }
    if (quiet && !readOnly) {
      throw new PsycheError(
        "forbidden",
        "This command is no longer read-only (a file operand leaves the folder or the binary changed); it was not run",
      );
    }
    // A read-only git reads one repository, and it must be inside the granted folder: a folder
    // shared inside a bigger repository would otherwise expose the history above it.
    const readOnlyGit = readOnly && p.argv[0] === "git" && !windows;
    let gitFolderRoot: string | undefined;
    if (readOnlyGit) {
      let folderReal = folder.path;
      try {
        folderReal = realpathSync(folder.path);
      } catch {
        // Keep the granted spelling.
      }
      const root = gitRepoRoot(real);
      if (root !== undefined && under(root, folderReal)) gitFolderRoot = folderReal;
      else if (quiet) {
        throw new PsycheError(
          "forbidden",
          `The repository of ${real} is not inside the shared folder ${folder.path}; share the repository's own folder, or the command needs approval`,
        );
      }
    }
    const unsandboxed = await approvedUnsandboxed(deps, ctx, resolved.sha256);
    const srt = await sandbox.fresh();
    if (!unsandboxed && windows) {
      // No sandbox for host commands exists on Windows (the sandbox PC runs Linux, not this
      // PC's programs), so there is nothing to set up: only the typed word runs it.
      throw new PsycheError(
        "unavailable",
        `Windows has no sandbox for commands on this PC: it runs only when the owner types ${UNSANDBOXED_WORD} on its card`,
        { details: { reason: "no_host_sandbox" } },
      );
    }
    if (!unsandboxed && "missing" in srt) {
      throw new PsycheError(
        "unavailable",
        `${srt.reason}: set up the sandbox (request_permission with {"need": "sandbox"}), or the owner types ${UNSANDBOXED_WORD} on the card`,
        { details: { missing: { need: "sandbox" } } },
      );
    }
    if (unsandboxed && folder.mode !== "rw") {
      throw new PsycheError(
        "forbidden",
        `${folder.path} is granted read-only; an unsandboxed command needs a read-write folder`,
        { details: { missing: { need: "folder", path: folder.path, access: "read_write" } } },
      );
    }
    const dir = join(deps.home, "exec-host");
    const id = randomUUID();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Short on purpose: srt's mux sockets live in it and `sun_path` is 104 bytes.
    const scratch = await createScratchDir(dir);
    const settings = join(dir, `srt-${id}.json`);
    const cleanup = async () => {
      await rm(settings, { force: true });
      await rm(scratch, { recursive: true, force: true });
      await rm(dirname(settings), { recursive: false, force: true }).catch(() => undefined);
    };
    let user = "";
    try {
      user = userInfo().username;
    } catch {
      // No passwd entry; leave USER empty.
    }
    const env: NodeJS.ProcessEnv = windows
      ? { ...windowsHostEnv(userHome, user, scratch), ...(p.env ?? {}) }
      : {
          // A read-only command finds only Apple's programs (no Homebrew helper it might call).
          PATH: (readOnly ? SYSTEM_BIN_DIRS : SAFE_PATH).join(":"),
          HOME: userHome,
          USER: user,
          LOGNAME: user,
          LANG: "en_US.UTF-8",
          TMPDIR: scratch,
          ...(p.env ?? {}),
        };
    let file = resolved.executable;
    let args = p.argv.slice(1);
    // Every git, carded or not: no program its config names (security §5.4).
    if (isGit(resolved.executable, p.argv[0], platform)) {
      try {
        // A read-only git also gets no system/global config, no pager and no diff drivers; the
        // driver query runs with the same env, so it reads the same config the command will.
        const ro = readOnlyGit ? readOnlyGitInvocation(args, gitFolderRoot) : undefined;
        if (ro !== undefined) Object.assign(env, ro.env);
        if (ro !== undefined && quiet) {
          // Ask git itself which repository it opens from here (hardened like the run), and
          // require a plain checkout inside the folder: not a git dir embedded in the tree, whose
          // own config git would use instead of the one that was checked.
          const probe = await gitProbe(resolved.executable, real, env, [
            ...gitHardening(platform),
            ...ro.globals,
          ]);
          if (
            probe === undefined ||
            gitFolderRoot === undefined ||
            !quietGitRepoOk(probe, real, gitFolderRoot)
          ) {
            throw new PsycheError(
              "forbidden",
              "The repository git opens from here is not a plain checkout inside the shared folder (an embedded git dir, a redirecting config or outside alternates); the command needs approval",
            );
          }
        }
        args = [
          ...gitHardening(platform),
          ...(ro?.globals ?? []),
          ...(await gitDriversOff(resolved.executable, real, env, platform, ro?.globals)),
          ...(ro?.args ?? args),
        ];
      } catch (e) {
        await cleanup();
        throw e;
      }
    }
    if (!unsandboxed && "path" in srt) {
      const profile = execHostSrtSettings({
        psycheHome: deps.home,
        userHome,
        scratch,
        // Read-only: nothing writable but the scratch directory, whatever the folder's grant.
        writable: folder.mode === "rw" && !readOnly && program === undefined ? [folder.path] : [],
        ...(confineRead === undefined ? {} : { confineRead }),
        allowedDomains: readOnly ? [] : domains,
      });
      await writeFile(settings, JSON.stringify(profile), { mode: 0o600 });
      file = srt.path;
      args = ["--settings", settings, "--", resolved.executable, ...args];
    }
    const cap = deps.readOnlyTimeoutMs ?? READ_ONLY_TIMEOUT_MS;
    const timeoutMs = limited
      ? Math.min(p.timeoutMs ?? cap, cap)
      : (p.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS);
    let timedOut = false;
    let stopped = false;
    if (limited) {
      // Recorded before it starts: a run the audit log cannot record does not run.
      try {
        await deps.audit?.append({
          kind: program === undefined ? "exec_host.read_only_run" : "exec_host.program_run",
          actor: { type: "agent", runId: ctx.runId },
          subject: { runId: ctx.runId, threadId: ctx.threadId },
          data: {
            runKey: id,
            ...(readOnlyGit ? { reason: GIT_AUDIT_REASON } : {}),
            argv: p.argv,
            cwd: real,
            executable: resolved.executable,
            executableSha256: resolved.sha256,
          },
        });
      } catch {
        await cleanup();
        throw new PsycheError(
          "unavailable",
          "The audit log could not record this read-only command, so it was not run",
        );
      }
    }
    let result: CliResult | undefined;
    let auditFailed = false;
    let timer: NodeJS.Timeout | undefined;
    let kill: (() => void) | undefined;
    const onAbort = () => {
      stopped = true;
      kill?.();
    };
    try {
      // Inside the try: a start that throws still releases everything and records the end.
      const proc = driver.start(file, args, {
        cwd: real,
        env,
        maxBytes: EXEC_OUTPUT_CAP_BYTES,
        processGroup: true,
      });
      kill = () => proc.kill("SIGKILL");
      timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, timeoutMs);
      timer.unref();
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
      result = await proc.done;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      await cleanup();
      if (limited) {
        // The run's end, whatever happened; a failure to record it is reported, not dropped.
        try {
          await deps.audit?.append({
            kind:
              program === undefined ? "exec_host.read_only_run.done" : "exec_host.program_run.done",
            actor: { type: "agent", runId: ctx.runId },
            subject: { runId: ctx.runId, threadId: ctx.threadId },
            data: {
              runKey: id,
              ...(readOnlyGit ? { reason: GIT_AUDIT_REASON } : {}),
              exitCode: result?.exitCode ?? null,
              outcome:
                result === undefined
                  ? "error"
                  : timedOut || stopped
                    ? "uncertain"
                    : result.exitCode === 0
                      ? "ok"
                      : "failed",
              timedOut,
            },
          });
        } catch {
          auditFailed = true;
        }
      }
    }
    const redact = (b: Buffer) => deps.vault.redact(b.toString("utf8"));
    // An interrupted host command may have done part of its work: uncertain, never replayed.
    const outcome = timedOut || stopped ? "uncertain" : result.exitCode === 0 ? "ok" : "failed";
    return {
      output: {
        exitCode: result.exitCode,
        stdout: redact(result.stdout),
        stderr: redact(result.stderr),
        durationMs: result.durationMs,
        truncated: result.stdoutTruncated || result.stderrTruncated,
        timedOut,
        ...(stopped ? { stopped: true } : {}),
        sandboxed: !unsandboxed,
        executable: resolved.executable,
        cwd: real,
        outcome,
        ...(auditFailed ? { auditFailed: true } : {}),
      },
      provenance: "untrusted",
      ...(outcome === "ok" && !auditFailed ? {} : { isError: true }),
    };
  }
}
