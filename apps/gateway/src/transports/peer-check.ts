import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, readlink, stat } from "node:fs/promises";
import type { Socket } from "node:net";
import { basename, dirname } from "node:path";
import type { PeerCheck } from "@psyche/protocol";

/**
 * The accept-time peer check for the Linux helper (linux-desktop design §4.3).
 *
 * The node socket is 0600 and the helper presents the per-launch handshake secret, but both only
 * prove "some process of this user". The Mac gets the connecting process from the kernel; Node has
 * no `getsockopt(SO_PEERCRED)`, so the peer is found the long way round:
 *
 *   1. our end of the accepted connection is a file descriptor; `/proc/self/fd/<fd>` names its
 *      socket inode G;
 *   2. `ss -xnp` pairs sockets: G's row names the other end A, and A's row must name G back. `ss`
 *      prints socket paths and process names raw, so its output is attacker-influenced text: it
 *      is parsed strictly (every line must fully match the row grammar, else nothing is trusted),
 *      inodes must be unique, and it is only ever used for that pairing and as a cross-check;
 *   3. who holds A comes from the kernel's own table, not from `ss`: every `/proc/<pid>/fd` is
 *      scanned for `socket:[A]`. Exactly one process must hold it, and it must be the pid `ss`
 *      named too;
 *   4. that process must still hold the socket after we looked at it, with the same start time,
 *      and `/proc/<pid>/exe` (`stat`ed through the link, so it is the real file) says which file
 *      runs: the packaged, root-owned helper is `root_owned`, another file named `psyche-helper`
 *      is `user_owned`, anything else is a `mismatch`.
 *
 * Everything that goes wrong is `unverified`, never `root_owned`: no `ss`, output that does not
 * parse, a peer already gone, several holders, a timeout, an unreadable `/proc`, a deleted binary.
 *
 * What this proves: which binary FILE is running as the peer. It does not prove that the code in
 * that process is unmodified: a library preloaded into it runs before `main`, and a same-user
 * process may `ptrace` it where Yama allows (`kernel.yama.ptrace_scope` 1 limits ptrace to
 * descendants). Pid reuse cannot be closed completely without a pidfd, which Node lacks; the
 * holder scan, the start-time and the second look shrink that window, they do not remove it. The
 * helper refuses to start with `LD_PRELOAD` or `LD_AUDIT` set. This is the accepted same-user
 * boundary (security §1.3); the check is defence in depth for packaged installs, not a seal.
 */

/** The packaged install root (deb and rpm). */
export const PACKAGED_ROOT = "/usr/lib/psyche";
/** Where the packaged helper lives (`apps/desktop/src/platform/install-kind.ts`). */
export const PACKAGED_HELPER = `${PACKAGED_ROOT}/resources/linux-helper/psyche-helper`;
/** The binary's name, in the package and in a build tree. */
export const HELPER_BINARY_NAME = "psyche-helper";

/** A verdict and the machine reason behind it, for logs and `devices.hostHelper.status`. */
export interface PeerResult {
  check: PeerCheck;
  reason: string;
}

const unverified = (reason: string): PeerResult => ({ check: "unverified", reason });

/** One row of `ss -xnp` (a Unix socket). */
export interface SsRow {
  localInode: number;
  peerInode: number;
  pids: number[];
}

const ENTRY = String.raw`\("[^"\r]*",pid=\d+,fd=\d+\)`;
const ROW = new RegExp(
  String.raw`^(?:u_str|u_dgr|u_seq) +\S+ +\d+ +\d+ +\S+ +(\d+) +\S+ +(\d+)(?: +users:\(${ENTRY}(?:,${ENTRY})*\))? *$`,
);
const HEADER =
  /^Netid +State +Recv-Q +Send-Q +Local Address:Port +Peer Address:Port(?: +Process)? *$/;

/**
 * Parses `ss -xnp` output strictly. The first line must be the exact header and every other
 * non-empty line must fully match the row grammar (one line, the exact columns, a process list of
 * well-formed entries), or the whole output is rejected (`undefined`). A socket path or a process
 * name holding a newline, spaces or quotes therefore cannot smuggle a row in or shift the columns:
 * what it breaks it breaks for everyone, and the answer is `unverified`. Local inodes must be
 * unique.
 */
export function parseSsUnix(text: string): SsRow[] | undefined {
  const lines = text.split("\n");
  if (lines[0] === undefined || !HEADER.test(lines[0])) return undefined;
  const rows: SsRow[] = [];
  const seen = new Set<number>();
  for (const line of lines.slice(1)) {
    if (line === "") continue;
    const m = ROW.exec(line);
    if (m === null) return undefined;
    const localInode = Number(m[1]);
    const peerInode = Number(m[2]);
    if (!Number.isSafeInteger(localInode) || !Number.isSafeInteger(peerInode)) return undefined;
    if (localInode === 0 || seen.has(localInode)) return undefined;
    seen.add(localInode);
    const pids: number[] = [];
    for (const p of line.matchAll(/,pid=(\d+),fd=\d+\)/g)) pids.push(Number(p[1]));
    rows.push({ localInode, peerInode, pids });
  }
  return rows;
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

/** What the checker needs from the system; tests pass fixtures. */
export interface PeerCheckDeps {
  /** `ss -xnp` output. Rejects when `ss` is missing, fails or times out. */
  runSs(): Promise<string>;
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
  runSs: () =>
    new Promise<string>((resolve, reject) => {
      const ss = SS_CANDIDATES.find((p) => existsSync(p));
      if (ss === undefined) return reject(new Error("ss not found"));
      execFile(
        ss,
        ["-xnp"],
        { encoding: "utf8", timeout: 1500, maxBuffer: 16 * 1024 * 1024, env: { LC_ALL: "C" } },
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
export const SCAN_BUDGET_MS = 1500;

/**
 * Every process that holds `inode` open, from the kernel's fd tables. Entries that cannot be read
 * (other users' processes, a process that just exited) are skipped. `undefined` when the time
 * budget runs out: a partial scan proves nothing about who else holds it.
 */
async function holdersOf(deps: PeerCheckDeps, inode: number): Promise<number[] | undefined> {
  const deadline = deps.now() + SCAN_BUDGET_MS;
  const holders: number[] = [];
  for (const pid of await deps.listPids()) {
    if (deps.now() > deadline) return undefined;
    let fds: string[];
    try {
      fds = await deps.readdir(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    const targets = await Promise.all(
      fds.map((fd) => deps.readlink(`/proc/${pid}/fd/${fd}`).catch(() => undefined)),
    );
    if (targets.some((t) => t !== undefined && socketInodeOf(t) === inode)) {
      holders.push(Number(pid));
    }
  }
  return holders;
}

/** Whether `pid` still holds `inode`, by its own fd table. Rejects when that cannot be read. */
async function holdsSocket(deps: PeerCheckDeps, pid: number, inode: number): Promise<boolean> {
  const dir = `/proc/${pid}/fd`;
  for (const fd of await deps.readdir(dir)) {
    let target: string;
    try {
      target = await deps.readlink(`${dir}/${fd}`);
    } catch {
      continue; // closed while we looked
    }
    if (socketInodeOf(target) === inode) return true;
  }
  return false;
}

/** A directory the user cannot write to: root-owned, a directory, not group- or world-writable. */
async function isRootControlledDir(deps: PeerCheckDeps, path: string): Promise<boolean> {
  const s = await deps.stat(path);
  return s.uid === 0 && (s.mode & S_IFMT) === S_IFDIR && (s.mode & GROUP_OTHER_WRITE) === 0;
}

/**
 * Decides for the process `pid` that holds the peer end of the connection (inode `peerInode`).
 * Anything unexpected throws or returns `unverified`; the caller turns a throw into `unverified`.
 */
async function judgePid(deps: PeerCheckDeps, pid: number, peerInode: number): Promise<PeerResult> {
  const proc = `/proc/${pid}`;
  const startBefore = startTimeOf(await deps.readFile(`${proc}/stat`));
  if (startBefore === undefined) return unverified("process_unreadable");
  if (!(await holdsSocket(deps, pid, peerInode))) return unverified("peer_left");

  const exePath = await deps.readlink(`${proc}/exe`);
  // The real file the process runs (through the magic link), not whatever the path names today.
  const exe = await deps.stat(`${proc}/exe`);

  // Same process after the lookups, and still holding the socket.
  const startAfter = startTimeOf(await deps.readFile(`${proc}/stat`));
  if (startAfter !== startBefore) return unverified("process_changed");
  if (!(await holdsSocket(deps, pid, peerInode))) return unverified("peer_left");

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
    return { check: "root_owned", reason: "packaged" };
  }
  // A root-owned file elsewhere is not something we can vouch for.
  if (exe.uid === 0) return unverified("root_owned_outside_package");
  return { check: "user_owned", reason: "user_binary" };
}

/**
 * The peer check for a connection whose server-side descriptor is `fd`. Never throws: any failure
 * is `unverified`.
 */
export async function checkPeerOfFd(
  fd: number | undefined,
  deps: PeerCheckDeps = systemPeerCheckDeps,
): Promise<PeerResult> {
  try {
    if (fd === undefined || !Number.isInteger(fd) || fd < 0) return unverified("no_descriptor");
    const ours = socketInodeOf(await deps.readlink(`/proc/self/fd/${fd}`));
    if (ours === undefined) return unverified("not_a_socket");
    const rows = parseSsUnix(await deps.runSs());
    if (rows === undefined) return unverified("ss_unparsable");

    // Our row, then the other end's row, which must point back at us.
    const mine = rows.filter((r) => r.localInode === ours);
    const theirInode = mine[0]?.peerInode;
    if (mine.length !== 1 || theirInode === undefined) return unverified("socket_not_listed");
    if (theirInode === 0) return unverified("peer_gone");
    const theirs = rows.filter((r) => r.localInode === theirInode);
    if (theirs.length !== 1 || theirs[0]?.peerInode !== ours) return unverified("peer_not_paired");

    // Who holds the other end: the kernel's fd tables decide, `ss` only has to agree.
    const holders = await holdersOf(deps, theirInode);
    if (holders === undefined) return unverified("scan_timeout");
    if (holders.length !== 1)
      return unverified(holders.length === 0 ? "peer_gone" : "many_holders");
    const pid = holders[0] as number;
    const ssPids = [...new Set(theirs[0]?.pids ?? [])];
    if (ssPids.length !== 1 || ssPids[0] !== pid) return unverified("ss_disagrees");
    return await judgePid(deps, pid, theirInode);
  } catch {
    return unverified("check_failed");
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
 * connections cannot make the Gateway run many `ss` at once, and none waits longer than the
 * timeout. A same-user process can still keep the checker busy so a real helper is told `busy`;
 * it could deny service in many other ways, and the answer stays `unverified`, never a pass. The
 * socket's descriptor comes from the handle; if Node stops exposing it, every peer is
 * `unverified`.
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
    let timer: NodeJS.Timeout | undefined;
    try {
      const handle = (socket as unknown as { _handle?: { fd?: unknown } })._handle;
      const fd = typeof handle?.fd === "number" ? handle.fd : undefined;
      const timeout = new Promise<PeerResult>((resolve) => {
        timer = setTimeout(() => resolve(unverified("timeout")), timeoutMs);
        timer.unref();
      });
      return await Promise.race([checkPeerOfFd(fd, deps), timeout]);
    } catch {
      return unverified("check_failed");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      release();
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
