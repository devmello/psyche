import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, readlink, stat } from "node:fs/promises";
import type { Socket } from "node:net";
import { basename, dirname } from "node:path";
import type { PeerCheck } from "@psyche/protocol";
import { LINUX_PACKAGED_HELPER_PATH } from "@psyche/protocol/platform";

/**
 * The accept-time peer check for the Linux helper (linux-desktop design §4.3).
 *
 * The node socket is 0600 and the helper presents the per-launch handshake secret, but both only
 * prove "some process of this user". The Mac gets the connecting process from the kernel; Node has
 * no `getsockopt(SO_PEERCRED)`, so the peer is found the long way round:
 *
 *   1. our end of the accepted connection is a file descriptor; `/proc/self/fd/<fd>` names its
 *      socket inode G;
 *   2. `ss -xnp` pairs sockets: exactly two lines may mention G or the other end's inode A, our
 *      row (local G, peer A) and the peer's row (local A, peer G). `ss` prints socket paths and
 *      process names raw, so its output is attacker-influenced text: a third line that mentions
 *      either inode, or a row that does not fit the grammar, makes the answer `unverified`. Lines
 *      about other sockets are none of our business and are ignored. `ss` is only used for this
 *      pairing and as a cross-check;
 *   3. who holds A comes from the kernel's fd tables, not from `ss`: every `/proc/<pid>/fd` and
 *      `/proc/<pid>/task/<tid>/fd` is scanned for `socket:[A]`. Exactly one process may hold it,
 *      and it must be the pid `ss` named. A same-user process whose fd table cannot be read (a
 *      non-dumpable one can hide a copy of the socket) that is related to the holder is a hidden
 *      holder: `unverified`;
 *   4. that process must still hold the socket after we looked at it, with the same start time,
 *      and `/proc/<pid>/exe` (`stat`ed through the link, so it is the real file) says which file
 *      runs. Its executable mappings (`/proc/<pid>/maps`) must all be root-owned system libraries
 *      or the package's own files, and its initial environment must not set `LD_PRELOAD`,
 *      `LD_AUDIT` or `LD_LIBRARY_PATH`. The packaged, root-owned helper with clean mappings is
 *      `root_owned`; another file named `psyche-helper` is `user_owned`; anything else is a
 *      `mismatch`.
 *
 * Everything that goes wrong is `unverified`, never `root_owned`: no `ss`, unparsable pairing rows,
 * a peer already gone, several or hidden holders, a timeout, an unreadable `/proc`, a deleted
 * binary.
 *
 * What this proves: which binary FILE is running as the peer, and that no foreign library is
 * mapped executable into it. It does not prove the code in that process is unmodified: a same-user
 * process may `ptrace` it where Yama allows (`kernel.yama.ptrace_scope` 1 limits ptrace to
 * descendants, so a parent can). Pid reuse cannot be closed completely without a pidfd, which
 * Node lacks; the holder scan, the start-time and the second look shrink that window, they do not
 * remove it. This is the accepted same-user boundary (security §1.3); the check is defence in
 * depth for packaged installs, not a seal.
 */

/** The packaged install root (deb and rpm). */
export const PACKAGED_ROOT = "/usr/lib/psyche";
/** Where the packaged helper lives; shared with the desktop packaging through the protocol. */
export const PACKAGED_HELPER = LINUX_PACKAGED_HELPER_PATH;
/** The binary's name, in the package and in a build tree. */
export const HELPER_BINARY_NAME = "psyche-helper";
/** Directories whose root-owned files may be mapped executable into the helper. */
export const SYSTEM_LIBRARY_DIRS = [
  "/usr/lib/",
  "/lib/",
  "/usr/lib64/",
  "/lib64/",
  "/usr/libexec/",
];
/** Environment variables with which a library or loader path reaches a process. */
const LOADER_ENV = ["LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH"];

/** A verdict and the machine reason behind it, for logs and `devices.hostHelper.status`. */
export interface PeerResult {
  check: PeerCheck;
  reason: string;
}

const unverified = (reason: string): PeerResult => ({ check: "unverified", reason });

/** The pair of `ss -xnp` rows for one connection. */
export interface SsPair {
  /** The other end's inode (A). */
  peerInode: number;
  /** The pids `ss` printed for A's row. */
  pids: number[];
}

const ENTRY = String.raw`\("[^"\r]*",pid=\d+,fd=\d+\)`;
const TAIL = String.raw`(?: +users:\(${ENTRY}(?:,${ENTRY})*\))? *`;
const HEAD = String.raw`^u_(?:str|dgr|seq) +\S+ +\d+ +\d+ +`;
const HEADER =
  /^Netid +State +Recv-Q +Send-Q +Local Address:Port +Peer Address:Port(?: +Process)? *$/;

const mentions = (line: string, inode: number): boolean =>
  new RegExp(`(?:^| )${inode}(?: |$)`).test(line);

/**
 * Finds the two rows of our connection in `ss -xnp` output, or says why not (`reason`).
 *
 * Addresses may contain spaces (a `PSYCHE_HOME` with a space gives a socket path with one), so the
 * rows are matched with the known inode numbers as anchors, not by splitting columns. Exactly two
 * lines may mention G or A: our row and the peer's row. A third (a forged row, a socket whose name
 * holds a newline and our numbers) or one that does not fit makes the answer unverified. Lines
 * that mention neither inode are ignored, so an unrelated socket with a strange name cannot stop
 * the helper from pairing.
 */
export function findSsPair(text: string, ours: number): SsPair | { reason: string } {
  const lines = text.split("\n");
  if (lines[0] === undefined || !HEADER.test(lines[0])) return { reason: "ss_unparsable" };
  const body = lines.slice(1).filter((l) => l !== "");
  const withOurs = body.filter((l) => mentions(l, ours));
  if (withOurs.length === 0) return { reason: "socket_not_listed" };
  const ourRow = new RegExp(`${HEAD}.+? +${ours} +.+? +(\\d+)${TAIL}$`);
  const mine = withOurs.filter((l) => ourRow.test(l));
  if (mine.length !== 1) return { reason: "ss_ambiguous" };
  const peerInode = Number(ourRow.exec(mine[0] as string)?.[1]);
  if (!Number.isSafeInteger(peerInode) || peerInode === 0) return { reason: "peer_gone" };
  if (peerInode === ours) return { reason: "ss_ambiguous" };
  const peerRow = new RegExp(`${HEAD}.+? +${peerInode} +.+? +${ours}${TAIL}$`);
  const theirs = body.filter((l) => mentions(l, peerInode));
  // Our row mentions A too; every other line that mentions A or G must be the peer's one row.
  const others = new Set([...withOurs, ...theirs].filter((l) => l !== mine[0]));
  if (others.size !== 1) return { reason: others.size === 0 ? "peer_not_paired" : "ss_ambiguous" };
  const peerLine = [...others][0] as string;
  if (!peerRow.test(peerLine)) return { reason: "peer_not_paired" };
  const pids: number[] = [];
  for (const p of peerLine.matchAll(/,pid=(\d+),fd=\d+\)/g)) pids.push(Number(p[1]));
  return { peerInode, pids };
}

/** The inode in a `/proc/<pid>/fd/<n>` link target (`socket:[1152354]`), or `undefined`. */
export function socketInodeOf(linkTarget: string): number | undefined {
  const m = /^socket:\[(\d+)\]$/.exec(linkTarget);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * The start time (field 22) of a process from the text of `/proc/<pid>/stat`. The command name is
 * in parentheses and may itself contain spaces and parentheses, so it is skipped from the last `)`.
 */
export function startTimeOf(statText: string): string | undefined {
  const close = statText.lastIndexOf(")");
  if (close === -1) return undefined;
  const fields = statText
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const start = fields[19];
  return start !== undefined && /^\d+$/.test(start) ? start : undefined;
}

/** One line of `/proc/<pid>/maps`. */
export interface MapEntry {
  perms: string;
  major: number;
  minor: number;
  inode: number;
  path: string;
}

/** Parses `/proc/<pid>/maps`; `undefined` if a line does not fit (then nothing is trusted). */
export function parseMaps(text: string): MapEntry[] | undefined {
  const entries: MapEntry[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const m = /^[0-9a-f]+-[0-9a-f]+ (\S{4}) [0-9a-f]+ ([0-9a-f]+):([0-9a-f]+) (\d+) *(.*)$/.exec(
      line,
    );
    if (m === null) return undefined;
    entries.push({
      perms: m[1] as string,
      major: Number.parseInt(m[2] as string, 16),
      minor: Number.parseInt(m[3] as string, 16),
      inode: Number(m[4]),
      path: m[5] as string,
    });
  }
  return entries;
}

/** The `major:minor` of a `st_dev` value, as Linux encodes it. */
export function devMajorMinor(dev: number): { major: number; minor: number } {
  const d = BigInt(dev);
  const major = ((d >> 8n) & 0xfffn) | ((d >> 32n) & ~0xfffn);
  const minor = (d & 0xffn) | ((d >> 12n) & ~0xffn);
  return { major: Number(major), minor: Number(minor) };
}

/** Whether the initial environment (`/proc/<pid>/environ`) sets a loader variable. */
export function setsLoaderEnv(environ: string): boolean {
  return environ.split("\0").some((kv) => LOADER_ENV.some((name) => kv.startsWith(`${name}=`)));
}

/** What the checker needs from the system; tests pass fixtures. */
export interface PeerCheckDeps {
  /** `ss -xnp` output. Rejects when `ss` is missing, fails, times out or is aborted. */
  runSs(signal: AbortSignal): Promise<string>;
  /** The numeric entries of `/proc` (process ids). */
  listPids(): Promise<string[]>;
  readlink(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  /** `stat` (following links) with the owner, mode and identity of the real file. */
  stat(path: string): Promise<{ uid: number; mode: number; dev: number; ino: number }>;
  /** The Gateway's own user id: a hidden holder only matters when it is this user's. */
  uid(): number;
  /** Milliseconds, for the scan's time budget. */
  now(): number;
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const GROUP_OTHER_WRITE = 0o022;

const SS_CANDIDATES = ["/usr/bin/ss", "/bin/ss", "/usr/sbin/ss", "/sbin/ss"];

/** The real system, with `ss` found at a fixed path (never through a `PATH` the peer could shape). */
export const systemPeerCheckDeps: PeerCheckDeps = {
  runSs: (signal) =>
    new Promise<string>((resolve, reject) => {
      const ss = SS_CANDIDATES.find((p) => existsSync(p));
      if (ss === undefined) return reject(new Error("ss not found"));
      execFile(
        ss,
        ["-xnp"],
        {
          encoding: "utf8",
          timeout: 1500,
          maxBuffer: 16 * 1024 * 1024,
          env: { LC_ALL: "C" },
          signal,
        },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    }),
  listPids: async () => (await readdir("/proc")).filter((n) => /^\d+$/.test(n)),
  readlink: (p) => readlink(p),
  readdir: (p) => readdir(p),
  readFile: (p) => readFile(p, "utf8"),
  stat: async (p) => {
    const s = await stat(p);
    return { uid: s.uid, mode: s.mode, dev: s.dev, ino: s.ino };
  },
  uid: () => process.getuid?.() ?? -1,
  now: () => Date.now(),
};

/** How long the `/proc` scan may take before the answer is `unverified`. */
export const SCAN_BUDGET_MS = 2000;
/** Processes read at once, and fd entries resolved at once: the scan is bounded, not a flood. */
const PID_BATCH = 16;
const FD_CHUNK = 256;

class Aborted extends Error {}

const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code;
/** The process (or thread) exited while we looked: nothing to see, nothing hidden. */
const gone = (e: unknown): boolean => codeOf(e) === "ENOENT" || codeOf(e) === "ESRCH";

interface Control {
  signal: AbortSignal;
  deadline: number;
}

/** Throws when the check was abandoned or the scan's time is up. */
function guard(deps: PeerCheckDeps, c: Control): void {
  if (c.signal.aborted || deps.now() > c.deadline) throw new Aborted();
}

interface FdTables {
  holds: boolean;
  /** Some fd table of this process (or one of its threads) could not be read. */
  hidden: boolean;
}

/** Whether `pid` holds `inode` in any fd table, main or per-thread; and whether any was hidden. */
async function readFdTables(
  deps: PeerCheckDeps,
  pid: string,
  inode: number,
  c: Control,
): Promise<FdTables> {
  const out: FdTables = { holds: false, hidden: false };
  const dirs = [`/proc/${pid}/fd`];
  try {
    for (const tid of await deps.readdir(`/proc/${pid}/task`)) {
      if (tid !== pid) dirs.push(`/proc/${pid}/task/${tid}/fd`);
    }
  } catch (e) {
    if (!gone(e)) out.hidden = true;
  }
  for (const dir of dirs) {
    let fds: string[];
    try {
      fds = await deps.readdir(dir);
    } catch (e) {
      if (!gone(e)) out.hidden = true;
      continue;
    }
    for (let i = 0; i < fds.length; i += FD_CHUNK) {
      guard(deps, c);
      const targets = await Promise.all(
        fds
          .slice(i, i + FD_CHUNK)
          .map((fd) => deps.readlink(`${dir}/${fd}`).catch(() => undefined)),
      );
      if (targets.some((t) => t !== undefined && socketInodeOf(t) === inode)) out.holds = true;
    }
  }
  return out;
}

/** `Uid:` and `PPid:` of a process from `/proc/<pid>/status`; `undefined` if it is gone. */
async function statusOf(
  deps: PeerCheckDeps,
  pid: number,
): Promise<{ uids: number[]; ppid: number } | undefined> {
  let text: string;
  try {
    text = await deps.readFile(`/proc/${pid}/status`);
  } catch (e) {
    if (gone(e)) return undefined;
    // Unreadable status of some process: treat it as ours and related, never as nothing.
    return { uids: [deps.uid()], ppid: -1 };
  }
  const uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(text);
  const ppid = /^PPid:\s+(\d+)/m.exec(text);
  if (uid === null || ppid === null) return { uids: [deps.uid()], ppid: -1 };
  return { uids: [1, 2, 3, 4].map((i) => Number(uid[i])), ppid: Number(ppid[1]) };
}

/** `pid` and its ancestors (never past 64 levels), as a set. */
async function lineageOf(deps: PeerCheckDeps, pid: number): Promise<Set<number>> {
  const seen = new Set<number>();
  let at = pid;
  for (let i = 0; i < 64 && at > 0 && !seen.has(at); i++) {
    seen.add(at);
    at = (await statusOf(deps, at))?.ppid ?? 0;
  }
  return seen;
}

/** A service manager or init: related to everything of the user, so it proves nothing. */
async function isManager(deps: PeerCheckDeps, pid: number): Promise<boolean> {
  if (pid === 1) return true;
  try {
    return (await deps.readFile(`/proc/${pid}/comm`)).trim() === "systemd";
  } catch {
    return false;
  }
}

export interface ScanResult {
  holders: number[];
  /** Same-user processes whose fd tables could not be read, and that are not unrelated. */
  hiddenRelated: number[];
}

/**
 * Every process that holds `inode` open, from the kernel's fd tables (main and per-thread), in
 * bounded batches with the deadline checked inside the loops. Entries that cannot be read are
 * skipped, except that a same-user process whose table is unreadable and that is related to the
 * holder (an ancestor, a descendant, or one sharing an ancestor other than init and the user's
 * systemd) is reported: a fork that made itself non-dumpable can keep a copy of the socket hidden
 * while the parent executes the real helper. Other users' processes and unrelated same-user
 * daemons (gpg-agent, Chromium's sandboxed processes) are not reported: they cannot have inherited
 * this socket from the connecting process. `strictHidden` reports every unreadable same-user
 * process instead.
 */
export async function scanHolders(
  deps: PeerCheckDeps,
  inode: number,
  c: Control,
  strictHidden = false,
): Promise<ScanResult> {
  const holders: number[] = [];
  const unreadable: number[] = [];
  const pids = await deps.listPids();
  for (let i = 0; i < pids.length; i += PID_BATCH) {
    guard(deps, c);
    await Promise.all(
      pids.slice(i, i + PID_BATCH).map(async (pid) => {
        const t = await readFdTables(deps, pid, inode, c);
        if (t.holds) holders.push(Number(pid));
        else if (t.hidden) unreadable.push(Number(pid));
      }),
    );
  }
  const holder = holders.length === 1 ? (holders[0] as number) : undefined;
  const hiddenRelated: number[] = [];
  if (unreadable.length > 0) {
    const holderLine = holder === undefined ? undefined : await lineageOf(deps, holder);
    for (const pid of unreadable) {
      guard(deps, c);
      const st = await statusOf(deps, pid);
      if (st === undefined || !st.uids.includes(deps.uid())) continue;
      if (strictHidden || holder === undefined) {
        hiddenRelated.push(pid);
        continue;
      }
      const common = [...(await lineageOf(deps, pid))].filter((p) => holderLine?.has(p));
      let related = false;
      for (const p of common) {
        if (!(await isManager(deps, p))) {
          related = true;
          break;
        }
      }
      if (related) hiddenRelated.push(pid);
    }
  }
  return { holders, hiddenRelated };
}

/** A directory the user cannot write to: root-owned, a directory, not group- or world-writable. */
async function isRootControlledDir(deps: PeerCheckDeps, path: string): Promise<boolean> {
  const s = await deps.stat(path);
  return s.uid === 0 && (s.mode & S_IFMT) === S_IFDIR && (s.mode & GROUP_OTHER_WRITE) === 0;
}

const isCanonical = (path: string): boolean =>
  path.startsWith("/") && !path.split("/").some((part) => part === ".." || part === ".");

/**
 * Whether every file-backed executable mapping is a root-owned, not group- or world-writable
 * regular file under a system library directory (or the package), identified by device and inode
 * from `stat`, not just by path. The executable itself is judged separately. Anonymous mappings
 * (the stack guard, the vdso, the heap) are not files and are skipped.
 */
async function mappingsAreSystem(
  deps: PeerCheckDeps,
  entries: MapEntry[],
  exe: { dev: number; ino: number },
): Promise<boolean> {
  const exeDev = devMajorMinor(exe.dev);
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.perms[2] !== "x" || e.inode === 0 || e.path === "") continue;
    if (e.inode === exe.ino && e.major === exeDev.major && e.minor === exeDev.minor) continue;
    const key = `${e.major}:${e.minor}:${e.inode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (e.path.endsWith(" (deleted)") || !isCanonical(e.path)) return false;
    if (!SYSTEM_LIBRARY_DIRS.some((dir) => e.path.startsWith(dir))) return false;
    let s: Awaited<ReturnType<PeerCheckDeps["stat"]>>;
    try {
      s = await deps.stat(e.path);
    } catch {
      return false;
    }
    const dev = devMajorMinor(s.dev);
    if (s.ino !== e.inode || dev.major !== e.major || dev.minor !== e.minor) return false;
    if (s.uid !== 0 || (s.mode & S_IFMT) !== S_IFREG || (s.mode & GROUP_OTHER_WRITE) !== 0) {
      return false;
    }
  }
  return true;
}

/** Whether `pid` still holds `inode` by its own tables (main and threads). Hidden is not a yes. */
async function stillHolds(
  deps: PeerCheckDeps,
  pid: number,
  inode: number,
  c: Control,
): Promise<boolean | "hidden"> {
  const t = await readFdTables(deps, String(pid), inode, c);
  if (t.hidden) return "hidden";
  return t.holds;
}

/**
 * Decides for the process `pid` that holds the peer end of the connection (inode `peerInode`).
 * Anything unexpected throws or returns `unverified`; the caller turns a throw into `unverified`.
 */
async function judgePid(
  deps: PeerCheckDeps,
  pid: number,
  peerInode: number,
  c: Control,
): Promise<PeerResult> {
  const proc = `/proc/${pid}`;
  const startBefore = startTimeOf(await deps.readFile(`${proc}/stat`));
  if (startBefore === undefined) return unverified("process_unreadable");
  const first = await stillHolds(deps, pid, peerInode, c);
  if (first === "hidden") return unverified("hidden_holder");
  if (!first) return unverified("peer_left");

  const exePath = await deps.readlink(`${proc}/exe`);
  // The real file the process runs (through the magic link), not whatever the path names today.
  const exe = await deps.stat(`${proc}/exe`);

  // What is mapped executable into it, and what the loader was told at exec.
  let maps: MapEntry[] | undefined;
  let environ: string;
  try {
    maps = parseMaps(await deps.readFile(`${proc}/maps`));
    environ = await deps.readFile(`${proc}/environ`);
  } catch {
    return unverified("image_unreadable");
  }
  if (maps === undefined) return unverified("image_unreadable");

  // Same process after the lookups, and still holding the socket.
  const startAfter = startTimeOf(await deps.readFile(`${proc}/stat`));
  if (startAfter !== startBefore) return unverified("process_changed");
  if ((await stillHolds(deps, pid, peerInode, c)) !== true) return unverified("peer_left");

  // The kernel marks a replaced or removed binary; what it ran is no longer what the path holds.
  if (exePath.endsWith(" (deleted)")) return unverified("binary_replaced");
  if (!exePath.startsWith("/") || (exe.mode & S_IFMT) !== S_IFREG) {
    return unverified("exe_unreadable");
  }
  if (basename(exePath) !== HELPER_BINARY_NAME) return { check: "mismatch", reason: "not_helper" };

  if (exePath === PACKAGED_HELPER && exe.uid === 0) {
    // The path must name this very file here too (a mount over the path shows another file), the
    // file must not be user-writable, and no directory up to the root may be.
    const named = await deps.stat(exePath);
    if (named.dev !== exe.dev || named.ino !== exe.ino) return unverified("path_remounted");
    if ((exe.mode & GROUP_OTHER_WRITE) !== 0) return unverified("helper_writable");
    for (let dir = dirname(exePath); ; dir = dirname(dir)) {
      if (!(await isRootControlledDir(deps, dir))) return unverified("dir_writable");
      if (dir === PACKAGED_ROOT) break;
    }
    // The real helper, but is it running only its own and the system's code?
    if (setsLoaderEnv(environ)) return { check: "mismatch", reason: "loader_env" };
    if (!(await mappingsAreSystem(deps, maps, exe))) {
      return { check: "mismatch", reason: "foreign_mapping" };
    }
    return { check: "root_owned", reason: "packaged" };
  }
  // A root-owned file elsewhere is not something we can vouch for.
  if (exe.uid === 0) return unverified("root_owned_outside_package");
  return { check: "user_owned", reason: "user_binary" };
}

/**
 * The peer check for a connection whose server-side descriptor is `fd`. Never throws: any failure
 * is `unverified`. `signal` abandons the work (the checker's timeout): the scan stops at its next
 * step and `ss` is killed.
 */
export async function checkPeerOfFd(
  fd: number | undefined,
  deps: PeerCheckDeps = systemPeerCheckDeps,
  signal: AbortSignal = new AbortController().signal,
  options: { strictHidden?: boolean } = {},
): Promise<PeerResult> {
  const c: Control = { signal, deadline: deps.now() + SCAN_BUDGET_MS };
  try {
    if (fd === undefined || !Number.isInteger(fd) || fd < 0) return unverified("no_descriptor");
    const ours = socketInodeOf(await deps.readlink(`/proc/self/fd/${fd}`));
    if (ours === undefined) return unverified("not_a_socket");
    const pair = findSsPair(await deps.runSs(signal), ours);
    if ("reason" in pair) return unverified(pair.reason);

    // Who holds the other end: the kernel's fd tables decide, `ss` only has to agree.
    const { holders, hiddenRelated } = await scanHolders(
      deps,
      pair.peerInode,
      c,
      options.strictHidden === true,
    );
    if (holders.length !== 1)
      return unverified(holders.length === 0 ? "peer_gone" : "many_holders");
    const pid = holders[0] as number;
    if (hiddenRelated.length > 0) return unverified("hidden_holder");
    const ssPids = [...new Set(pair.pids)];
    if (ssPids.length !== 1 || ssPids[0] !== pid) return unverified("ss_disagrees");
    return await judgePid(deps, pid, pair.peerInode, c);
  } catch (e) {
    return unverified(e instanceof Aborted ? "scan_timeout" : "check_failed");
  }
}

/** Runs the check for an accepted socket. A bare verdict (a test double) has no reason. */
export type PeerChecker = (socket: Socket) => Promise<PeerCheck | PeerResult>;

/** Normalizes what a checker returned. */
export function peerResultOf(v: PeerCheck | PeerResult): PeerResult {
  return typeof v === "string" ? { check: v, reason: "injected" } : v;
}

export interface LinuxPeerCheckerOptions {
  deps?: PeerCheckDeps;
  /** The whole check is abandoned (as `unverified`) after this long. Default 3 s. */
  timeoutMs?: number;
  /** Checks running at once; more wait. Default 4. */
  concurrency?: number;
  /** Connections waiting; more are `unverified` (reason `busy`) without a lookup. Default 16. */
  maxQueue?: number;
  /** Treat every unreadable same-user fd table as a hidden holder, related or not. */
  strictHidden?: boolean;
}

/**
 * The peer checker the Gateway uses on Linux. Bounded: a same-user process that opens many
 * connections cannot make the Gateway run many scans at once. After the timeout the answer is
 * `unverified` and the work is told to stop (the `AbortSignal` ends `ss` and the scan at its next
 * step); the concurrency slot is freed only when that work has actually stopped, so abandoned
 * scans cannot pile up. A same-user process can still keep the checker busy so a real helper is
 * told `busy`; it could deny service in many other ways. The socket's descriptor comes from the
 * handle; if Node stops exposing it, every peer is `unverified`.
 */
export function linuxPeerChecker(options: LinuxPeerCheckerOptions = {}): PeerChecker {
  const deps = options.deps ?? systemPeerCheckDeps;
  const timeoutMs = options.timeoutMs ?? 3000;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const maxQueue = options.maxQueue ?? 16;
  let running = 0;
  const waiting: Array<() => void> = [];

  const acquire = (): Promise<void> | undefined => {
    if (running < concurrency) {
      running++;
      return Promise.resolve();
    }
    if (waiting.length >= maxQueue) return undefined;
    return new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next === undefined) running--;
    else next();
  };

  return async (socket: Socket): Promise<PeerResult> => {
    const slot = acquire();
    if (slot === undefined) return unverified("busy");
    await slot;
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const handle = (socket as unknown as { _handle?: { fd?: unknown } })._handle;
    const fd = typeof handle?.fd === "number" ? handle.fd : undefined;
    const work = checkPeerOfFd(fd, deps, abort.signal, {
      strictHidden: options.strictHidden === true,
    }).catch((): PeerResult => unverified("check_failed"));
    // The slot goes back when the work has really stopped, not when the answer was given.
    void work.finally(release);
    const timeout = new Promise<PeerResult>((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve(unverified("timeout"));
      }, timeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

/** Whether the packaged helper is installed, which makes the peer check strict. */
export function packagedHelperInstalled(exists: (path: string) => boolean = existsSync): boolean {
  return exists(PACKAGED_HELPER);
}

/**
 * The checker the real Gateway process installs: the Linux one on Linux, none elsewhere (the Mac
 * and Windows helpers are not checked this way). Library users and tests that start a Gateway in
 * process pass their own, or none.
 */
export function defaultPeerChecker(
  platform: NodeJS.Platform = process.platform,
): PeerChecker | undefined {
  return platform === "linux" ? linuxPeerChecker() : undefined;
}
