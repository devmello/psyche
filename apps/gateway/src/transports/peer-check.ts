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
 *      socket inode;
 *   2. `ss -xnp` lists every Unix socket with its inode, the inode of the other end and the
 *      processes that hold it: the row whose peer inode is ours is the connecting side;
 *   3. that process must be the only holder, must still hold the socket after we looked at it,
 *      and must be the same process (same start time) before and after;
 *   4. `/proc/<pid>/exe` names what it runs and, `stat`ed directly, the real file (not a path
 *      that could be remounted or swapped): a root-owned helper under `/usr/lib/psyche` is
 *      `root_owned`, another file named `psyche-helper` is `user_owned`, anything else is a
 *      `mismatch`.
 *
 * Everything that goes wrong is `unverified`, never `root_owned`: a failed lookup, a peer that
 * already left, a timeout, an unreadable `/proc`, a deleted binary, several processes sharing the
 * socket. `root_owned` is only returned when every step positively agreed.
 *
 * Residual (stated in the design doc): the process holding the socket is not necessarily the one
 * writing to it (a process can hand a descriptor to another, or exec after connecting), and pid
 * reuse cannot be closed completely without a pidfd, which Node does not offer. The fd-table and
 * start-time re-checks make a swap in the few milliseconds between lookup and verdict much harder;
 * they do not make it impossible. The check is defence in depth for packaged installs, not a seal
 * against a same-user attacker who can also ptrace the real helper.
 */

/** The packaged helper lives here (deb and rpm install under `/usr/lib/psyche`). */
export const PACKAGED_ROOT = "/usr/lib/psyche";
/** The binary's name, in the package and in a build tree. */
export const HELPER_BINARY_NAME = "psyche-helper";

/** One row of `ss -xnp` (a connected Unix socket). */
export interface SsRow {
  localInode: number;
  peerInode: number;
  pids: number[];
}

/**
 * Parses `ss -xnp` output. Row shape (columns are separated by spaces, the process list is last):
 * `u_str ESTAB 0 0 /run/node.sock 1152354 * 1147543 users:(("name",pid=18117,fd=22))`.
 * The local address of an unnamed socket is `*`. A process name may hold spaces, quotes and
 * parentheses, so pids are taken from the `pid=` fields of the `users:(...)` tail only. Rows that
 * do not parse are skipped, never guessed at.
 */
export function parseSsUnix(text: string): SsRow[] {
  const rows: SsRow[] = [];
  for (const line of text.split("\n")) {
    const users = line.indexOf(" users:((");
    const head = users === -1 ? line : line.slice(0, users);
    const tail = users === -1 ? "" : line.slice(users);
    const match = /^u_\w+\s+\S+\s+\d+\s+\d+\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s*$/.exec(head.trim());
    if (match === null) continue;
    const localInode = Number(match[2]);
    const peerInode = Number(match[4]);
    if (!Number.isSafeInteger(localInode) || !Number.isSafeInteger(peerInode)) continue;
    const pids: number[] = [];
    for (const m of tail.matchAll(/,pid=(\d+),fd=\d+\)/g)) pids.push(Number(m[1]));
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
  readlink(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  /** `stat` (following links) with the owner, mode and identity of the real file. */
  stat(path: string): Promise<{ uid: number; mode: number; dev: number; ino: number }>;
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
  readlink: (p) => readlink(p),
  readdir: (p) => readdir(p),
  readFile: (p) => readFile(p, "utf8"),
  stat: async (p) => {
    const s = await stat(p);
    return { uid: s.uid, mode: s.mode, dev: s.dev, ino: s.ino };
  },
};

/** `/usr/lib/psyche/...` as a canonical path: no `.` or `..`, nothing outside the root. */
function underPackagedRoot(path: string): boolean {
  if (!path.startsWith(`${PACKAGED_ROOT}/`)) return false;
  return !path.split("/").some((part) => part === ".." || part === ".");
}

/** The pids that hold `inode` open, as seen in their fd table. Rejects when the table cannot be read. */
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
async function judgePid(deps: PeerCheckDeps, pid: number, peerInode: number): Promise<PeerCheck> {
  const proc = `/proc/${pid}`;
  const startBefore = startTimeOf(await deps.readFile(`${proc}/stat`));
  if (startBefore === undefined) return "unverified";
  // The pid from `ss` is a hint. It must still own the socket right now.
  if (!(await holdsSocket(deps, pid, peerInode))) return "unverified";

  const exePath = await deps.readlink(`${proc}/exe`);
  // The real file the process runs (through the magic link), not whatever the path names today.
  const exe = await deps.stat(`${proc}/exe`);

  // Same process after the lookups, and still holding the socket.
  const startAfter = startTimeOf(await deps.readFile(`${proc}/stat`));
  if (startAfter !== startBefore) return "unverified";
  if (!(await holdsSocket(deps, pid, peerInode))) return "unverified";

  // The kernel marks a replaced or removed binary; what it ran is no longer what the path holds.
  if (exePath.endsWith(" (deleted)")) return "unverified";
  if (!exePath.startsWith("/") || (exe.mode & S_IFMT) !== S_IFREG) return "unverified";
  if (basename(exePath) !== HELPER_BINARY_NAME) return "mismatch";

  if (exe.uid === 0 && underPackagedRoot(exePath)) {
    // The path must name this very file here too (a mount over the path shows another file), the
    // file must not be user-writable, and no directory up to the root may be.
    const named = await deps.stat(exePath);
    if (named.dev !== exe.dev || named.ino !== exe.ino) return "unverified";
    if ((exe.mode & GROUP_OTHER_WRITE) !== 0) return "unverified";
    for (let dir = dirname(exePath); ; dir = dirname(dir)) {
      if (!(await isRootControlledDir(deps, dir))) return "unverified";
      if (dir === PACKAGED_ROOT) break;
    }
    return "root_owned";
  }
  // A root-owned file outside the package is not something we can vouch for.
  if (exe.uid === 0) return "unverified";
  return "user_owned";
}

/**
 * The peer check for a connection whose server-side descriptor is `fd`. Never throws: any failure
 * is `unverified`.
 */
export async function checkPeerOfFd(
  fd: number | undefined,
  deps: PeerCheckDeps = systemPeerCheckDeps,
): Promise<PeerCheck> {
  try {
    if (fd === undefined || !Number.isInteger(fd) || fd < 0) return "unverified";
    const ours = socketInodeOf(await deps.readlink(`/proc/self/fd/${fd}`));
    if (ours === undefined) return "unverified";
    const rows = parseSsUnix(await deps.runSs());
    // Rows whose other end is our socket are the connecting side (ours has `localInode === ours`).
    const mine = rows.filter((r) => r.peerInode === ours && r.localInode !== ours);
    if (mine.length !== 1) return "unverified";
    const peer = mine[0];
    const pids = [...new Set(peer?.pids ?? [])];
    // Several holders (a forked child, a passed descriptor): we cannot say which one is speaking.
    if (peer === undefined || pids.length !== 1) return "unverified";
    return await judgePid(deps, pids[0] as number, peer.localInode);
  } catch {
    return "unverified";
  }
}

/** Runs the check for an accepted socket. */
export type PeerChecker = (socket: Socket) => Promise<PeerCheck>;

export interface LinuxPeerCheckerOptions {
  deps?: PeerCheckDeps;
  /** The whole check is abandoned (as `unverified`) after this long. Default 3 s. */
  timeoutMs?: number;
  /** Checks running at once; more wait. Default 4. */
  concurrency?: number;
  /** Connections waiting; more are `unverified` without a lookup. Default 16. */
  maxQueue?: number;
}

/**
 * The peer checker the Gateway uses on Linux. Bounded: a same-user process that opens many
 * connections cannot make the Gateway run many `ss` at once, and none waits longer than the
 * timeout. The socket's descriptor comes from the handle; if Node stops exposing it, every peer
 * is `unverified` (never a pass).
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

  return async (socket: Socket): Promise<PeerCheck> => {
    const slot = acquire();
    if (slot === undefined) return "unverified";
    await slot;
    let timer: NodeJS.Timeout | undefined;
    try {
      const handle = (socket as unknown as { _handle?: { fd?: unknown } })._handle;
      const fd = typeof handle?.fd === "number" ? handle.fd : undefined;
      const timeout = new Promise<PeerCheck>((resolve) => {
        timer = setTimeout(() => resolve("unverified"), timeoutMs);
        timer.unref();
      });
      return await Promise.race([checkPeerOfFd(fd, deps), timeout]);
    } catch {
      return "unverified";
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      release();
    }
  };
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
