import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, readlink, stat } from "node:fs/promises";
import type { Socket } from "node:net";
import { basename, dirname } from "node:path";
import type { PeerCheck } from "@psyche/protocol";
import { LINUX_HELPER_READY_COMM, LINUX_PACKAGED_HELPER_PATH } from "@psyche/protocol/platform";

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
 *      `/proc/<pid>/task/<tid>/fd` that can be read is scanned for `socket:[A]`. Exactly one
 *      process may hold it, and it must be the pid `ss` named. Tables that cannot be read
 *      (other users', or a non-dumpable process of this user) are skipped: no heuristic about who
 *      is related to whom (a double fork or `systemd-run --user` reparents to systemd, and any
 *      process can name itself anything);
 *   4. that process must still hold the socket after we looked at it, with the same start time,
 *      and `/proc/<pid>/exe` (`stat`ed through the link, so it is the real file) says which file
 *      runs. For the packaged helper the process must also: not hold the socket on fd 0, 1 or 2
 *      (a parent that connected and then executed it left the socket on stdio); carry the name the
 *      helper gives itself once its start-up hardening is done (`LINUX_HELPER_READY_COMM`; before
 *      that it is still between `exec` and the descriptor cleanup); not be stopped, traced or have
 *      a tracer; map no anonymous executable memory (except `[vdso]` and `[vsyscall]`); map only
 *      files that are root-owned, not group- or world-writable, under a system library directory
 *      or the package (each by the inode `maps` prints, which must equal the inode its path names
 *      now; the device number is not compared, as btrfs and overlayfs print other numbers than
 *      `stat`, and `map_files` would need privileges the Gateway lacks); and not set
 *      `LD_PRELOAD`, `LD_AUDIT` or `LD_LIBRARY_PATH` in its initial
 *      environment; and live in the Gateway's own user and mount namespaces
 *      (`other_namespace` otherwise: a private mount could fake library inodes). The packaged,
 *      root-owned helper that passes is `root_owned`; another file
 *      named `psyche-helper` is `user_owned`; anything else is a `mismatch`. A system library
 *      replaced since it was mapped (an upgrade) is `unverified` with reason `library_replaced`:
 *      the helper keeps being refused until it restarts (its next launch, or
 *      `systemctl --user restart psyche-helper`).
 *
 * Everything that goes wrong is `unverified`, never `root_owned`: no `ss`, unparsable pairing rows,
 * a peer already gone, several or hidden holders, a timeout, an unreadable `/proc`, a deleted
 * binary.
 *
 * What this proves: that the peer is the root-owned packaged helper binary, running only its own
 * and the system's executable code, not stopped or traced, and not holding a socket its parent
 * made for it. What it does not: it is defence in depth against same-user impersonation, not a
 * boundary. A same-user process can ptrace its own child (Yama scope 1 allows that), or inject
 * code and clean up before the check, or patch the text of a mapped system library in place with
 * `mprotect` after the cleanup. None of that can be seen from outside. (A static helper would
 * remove loader-variable injection, but the helper must link C libraries such as PipeWire, so it
 * is dynamic.) Pid reuse cannot be closed
 * without a pidfd, which Node lacks. Security §1.3 accepts the same-user boundary: such an
 * attacker can also edit psyched's own unit. For AppImage and development installs the check
 * only records what it saw.
 */

/** The packaged install root (deb and rpm). */
export const PACKAGED_ROOT = "/usr/lib/psyche";
/** Where the packaged helper lives; shared with the desktop packaging through the protocol. */
export const PACKAGED_HELPER = LINUX_PACKAGED_HELPER_PATH;
/** The name the helper gives itself once its start-up hardening is done. */
export const HELPER_READY_COMM = LINUX_HELPER_READY_COMM;
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
  /** The mapping's address range, as `maps` prints it. */
  range: string;
  perms: string;
  inode: number;
  path: string;
}

/** Parses `/proc/<pid>/maps`; `undefined` if a line does not fit (then nothing is trusted). */
export function parseMaps(text: string): MapEntry[] | undefined {
  const entries: MapEntry[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const m = /^([0-9a-f]+-[0-9a-f]+) (\S{4}) [0-9a-f]+ [0-9a-f]+:[0-9a-f]+ (\d+) *(.*)$/.exec(
      line,
    );
    if (m === null) return undefined;
    entries.push({
      range: m[1] as string,
      perms: m[2] as string,
      inode: Number(m[3]),
      path: m[4] as string,
    });
  }
  return entries;
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
  /** The descriptor numbers through which it holds the inode (in any of its tables). */
  fdNumbers: number[];
}

/** Whether `pid` holds `inode` in any fd table, main or per-thread; and whether any was hidden. */
async function readFdTables(
  deps: PeerCheckDeps,
  pid: string,
  inode: number,
  c: Control,
): Promise<FdTables> {
  const out: FdTables = { holds: false, hidden: false, fdNumbers: [] };
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
      const chunk = fds.slice(i, i + FD_CHUNK);
      const targets = await Promise.all(
        chunk.map((fd) => deps.readlink(`${dir}/${fd}`).catch(() => undefined)),
      );
      targets.forEach((t, n) => {
        if (t === undefined || socketInodeOf(t) !== inode) return;
        out.holds = true;
        out.fdNumbers.push(Number(chunk[n]));
      });
    }
  }
  return out;
}

export interface ScanResult {
  holders: number[];
}

/**
 * Every process that holds `inode` open, from the kernel's fd tables (main and per-thread), in
 * bounded batches with the deadline checked inside the loops. Entries that cannot be read (other
 * users' processes, a process that just exited, a non-dumpable process) are skipped: deciding who
 * of the unreadable ones "must be related" is a heuristic a same-user process can sidestep (a
 * double fork, `systemd-run --user`, any process naming itself `systemd`) and one that could
 * refuse the real helper when Electron's sandboxed processes share an ancestor with it.
 */
export async function scanHolders(
  deps: PeerCheckDeps,
  inode: number,
  c: Control,
): Promise<ScanResult> {
  const holders: number[] = [];
  const pids = await deps.listPids();
  for (let i = 0; i < pids.length; i += PID_BATCH) {
    guard(deps, c);
    await Promise.all(
      pids.slice(i, i + PID_BATCH).map(async (pid) => {
        const t = await readFdTables(deps, pid, inode, c);
        if (t.holds) holders.push(Number(pid));
      }),
    );
  }
  return { holders };
}

/** A directory the user cannot write to: root-owned, a directory, not group- or world-writable. */
async function isRootControlledDir(deps: PeerCheckDeps, path: string): Promise<boolean> {
  const s = await deps.stat(path);
  return s.uid === 0 && (s.mode & S_IFMT) === S_IFDIR && (s.mode & GROUP_OTHER_WRITE) === 0;
}

const isCanonical = (path: string): boolean =>
  path.startsWith("/") && !path.split("/").some((part) => part === ".." || part === ".");

type ImageVerdict = "ok" | "foreign" | "replaced" | "unreadable";

/**
 * Judges the executable mappings of `pid`. Every executable mapping must be a file (anonymous
 * executable memory is refused, except `[vdso]` and `[vsyscall]`), and every file must be a
 * root-owned regular file, not group- or world-writable, under a system library directory (or the
 * package). The file is identified by the inode `maps` prints, which must equal the inode the
 * path names now. The device number is not compared: `maps` prints a different one than `stat` on
 * btrfs and overlayfs. (`/proc/<pid>/map_files` would give the mapped file itself, but following
 * it needs CAP_SYS_ADMIN or CAP_CHECKPOINT_RESTORE, which the Gateway does not have.) A system
 * library replaced since it was mapped (an upgrade; a `(deleted)` file in a system directory) is
 * `replaced`, not foreign. The executable itself is judged separately and skipped here.
 */
async function mappingsAreSystem(
  deps: PeerCheckDeps,
  entries: MapEntry[],
  exe: { path: string; ino: number },
): Promise<ImageVerdict> {
  const seen = new Set<string>();
  let replaced = false;
  for (const e of entries) {
    if (e.perms[2] !== "x") continue;
    if (e.inode === 0) {
      if (e.path === "[vdso]" || e.path === "[vsyscall]") continue;
      return "foreign";
    }
    if (e.path === "" || seen.has(`${e.path}:${e.inode}`)) continue;
    seen.add(`${e.path}:${e.inode}`);
    if (e.path === exe.path && e.inode === exe.ino) continue;
    const deleted = e.path.endsWith(" (deleted)");
    const path = deleted ? e.path.slice(0, -" (deleted)".length) : e.path;
    if (!isCanonical(path) || !SYSTEM_LIBRARY_DIRS.some((dir) => path.startsWith(dir))) {
      return "foreign";
    }
    if (deleted) {
      replaced = true;
      continue;
    }
    let named: Awaited<ReturnType<PeerCheckDeps["stat"]>>;
    try {
      named = await deps.stat(path);
    } catch (err) {
      if (gone(err)) {
        replaced = true;
        continue;
      }
      return "unreadable";
    }
    if (named.ino !== e.inode) {
      replaced = true;
      continue;
    }
    if (named.uid !== 0 || (named.mode & S_IFMT) !== S_IFREG) return "foreign";
    if ((named.mode & GROUP_OTHER_WRITE) !== 0) return "foreign";
  }
  return replaced ? "replaced" : "ok";
}

/** What `/proc/<pid>/status` and `comm` say about the process right now. */
interface ProcState {
  comm: string;
  state: string;
  tracer: number;
}

async function procState(deps: PeerCheckDeps, pid: number): Promise<ProcState | undefined> {
  const status = await deps.readFile(`/proc/${pid}/status`);
  const comm = (await deps.readFile(`/proc/${pid}/comm`)).replace(/\n$/, "");
  const state = /^State:\s+(\S)/m.exec(status)?.[1];
  const tracer = /^TracerPid:\s+(\d+)/m.exec(status)?.[1];
  if (state === undefined || tracer === undefined) return undefined;
  return { comm, state, tracer: Number(tracer) };
}

/**
 * Whether `pid` is in the Gateway's own user and mount namespaces. Inside a private user and mount
 * namespace a process can mount a filesystem with inode numbers of its choosing over a system
 * library path, which would make the inode comparison of the mapped libraries meaningless. The
 * packaged units have no namespace sandboxing, so the real helper shares both namespaces.
 *
 * Revisit this if psyched's own unit ever gains `PrivateTmp`, `Protect*` or `PrivateUsers`: the
 * Gateway would then sit in other namespaces than a helper started outside the unit, and every
 * real helper would be `unverified` (`other_namespace`).
 */
async function namespaceOf(
  deps: PeerCheckDeps,
  pid: number,
): Promise<"same" | "other_namespace" | "namespace_unreadable"> {
  try {
    for (const kind of ["user", "mnt"]) {
      const theirs = await deps.readlink(`/proc/${pid}/ns/${kind}`);
      const ours = await deps.readlink(`/proc/self/ns/${kind}`);
      if (theirs !== ours) return "other_namespace";
    }
    return "same";
  } catch {
    return "namespace_unreadable";
  }
}

/** A running (not stopped or traced) helper that has finished its start-up hardening. */
function startedUp(st: ProcState | undefined): PeerResult | undefined {
  if (st === undefined) return unverified("process_unreadable");
  if (st.state === "T" || st.state === "t" || st.tracer !== 0)
    return unverified("stopped_or_traced");
  if (st.comm !== HELPER_READY_COMM) return unverified("not_ready");
  return undefined;
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
  const first = await readFdTables(deps, String(pid), peerInode, c);
  if (first.hidden) return unverified("hidden_holder");
  if (!first.holds) return unverified("peer_left");
  // A socket on stdin, stdout or stderr was made by a parent that connected and then executed us.
  if (first.fdNumbers.some((n) => n <= 2)) return unverified("inherited_socket");
  const stateBefore = await procState(deps, pid);

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

  // Same process after the lookups, still holding the socket, still in the same state.
  const startAfter = startTimeOf(await deps.readFile(`${proc}/stat`));
  if (startAfter !== startBefore) return unverified("process_changed");
  const second = await readFdTables(deps, String(pid), peerInode, c);
  if (second.hidden || !second.holds) return unverified("peer_left");
  if (second.fdNumbers.some((n) => n <= 2)) return unverified("inherited_socket");
  const stateAfter = await procState(deps, pid);

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
    // In our own user and mount namespaces (a private mount could fake the libraries' inodes).
    const ns = await namespaceOf(deps, pid);
    if (ns !== "same") return unverified(ns);
    // The real helper, but is it past its start-up, untraced, and running only its own and the
    // system's code?
    const notUp = startedUp(stateBefore) ?? startedUp(stateAfter);
    if (notUp !== undefined) return notUp;
    if (setsLoaderEnv(environ)) return { check: "mismatch", reason: "loader_env" };
    const image = await mappingsAreSystem(deps, maps, { path: exePath, ino: exe.ino });
    if (image === "foreign") return { check: "mismatch", reason: "foreign_mapping" };
    if (image === "replaced") return unverified("library_replaced");
    if (image === "unreadable") return unverified("image_unreadable");
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
): Promise<PeerResult> {
  const c: Control = { signal, deadline: deps.now() + SCAN_BUDGET_MS };
  try {
    if (fd === undefined || !Number.isInteger(fd) || fd < 0) return unverified("no_descriptor");
    const ours = socketInodeOf(await deps.readlink(`/proc/self/fd/${fd}`));
    if (ours === undefined) return unverified("not_a_socket");
    const pair = findSsPair(await deps.runSs(signal), ours);
    if ("reason" in pair) return unverified(pair.reason);

    // Who holds the other end: the kernel's fd tables decide, `ss` only has to agree.
    const { holders } = await scanHolders(deps, pair.peerInode, c);
    if (holders.length !== 1)
      return unverified(holders.length === 0 ? "peer_gone" : "many_holders");
    const pid = holders[0] as number;
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
    const work = checkPeerOfFd(fd, deps, abort.signal).catch(
      (): PeerResult => unverified("check_failed"),
    );
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
