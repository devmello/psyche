import { getSetting } from "@psyche/db";
import type { PeerCheck } from "@psyche/protocol";
import { LINUX_PACKAGED_HELPER_PATH } from "@psyche/protocol/platform";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_HELPER_STATUS_SETTING } from "../src/nodes/registry.ts";
import type { Gateway } from "../src/server.ts";
import {
  checkPeerOfFd,
  findSsPair,
  HELPER_READY_COMM,
  linuxPeerChecker,
  PACKAGED_HELPER,
  PACKAGED_ROOT,
  type PeerCheckDeps,
  type PeerResult,
  packagedHelperInstalled,
  parseMaps,
  setsLoaderEnv,
  socketInodeOf,
  startTimeOf,
} from "../src/transports/peer-check.ts";
import { FakeNode, type FakeNodeHandler } from "./fake-node.ts";
import { startTestGateway, type TestGateway } from "./helpers.ts";

/**
 * The Linux accept-time peer check (design §4.3): the parsers, the verdicts against a fixture
 * system (including the attacks a same-user process can mount through `ss` output, through
 * sharing the socket, through hidden fd tables and through injected libraries), and the Gateway
 * acting on a verdict (kind, status, refusal, pausing).
 */

const OURS = 1152354;
const THEIRS = 1147543;
const PID = 18156;
const HEADER = "Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port Process";

const ssText = (...rows: string[]) => `${[HEADER, ...rows].join("\n")}\n`;
const LISTEN =
  'u_str LISTEN 0 4096 /run/user/1000/psyche/node.sock 1147000 * 0 users:(("node",pid=900,fd=20))';
const THEIR_ROW = (pids = `("psyche-helper",pid=${PID},fd=3)`) =>
  `u_str ESTAB 0 0 * ${THEIRS} * ${OURS} users:(${pids})`;
const OUR_ROW = `u_str ESTAB 0 0 /run/user/1000/psyche/node.sock ${OURS} * ${THEIRS} users:(("MainThread",pid=900,fd=22))`;
const SS = ssText(LISTEN, THEIR_ROW(), OUR_ROW);

const mkdev = (major: number, minor: number) => (major << 8) | (minor & 0xff);
const DEV = mkdev(8, 1);
const LIBC = "/usr/lib/x86_64-linux-gnu/libc.so.6";
type FileStat = { uid: number; mode: number; dev: number; ino: number };
const GOOD_LIBS: Record<string, FileStat> = {
  [LIBC]: { uid: 0, mode: 0o100755, dev: DEV, ino: 777 },
};

interface Proc {
  start?: string;
  fds?: string[];
  /** Extra per-thread fd tables (thread id to the sockets it holds, by descriptor number). */
  taskFds?: Record<number, string[]>;
  /** The fd tables cannot be read (a non-dumpable process). */
  hidden?: boolean;
  exe?: string;
  uid?: number;
  mode?: number;
  ino?: number;
  /** What the path in `exe` names in this namespace, when not the same file. */
  pathIno?: number;
  /** The owner of the process (default 1000, the Gateway's user). */
  owner?: number;
  ppid?: number;
  /** Default: the helper's ready name for a process with an exe. */
  comm?: string;
  /** `State:` letter and `TracerPid` of /proc/<pid>/status. */
  state?: string;
  tracer?: number;
  maps?: string;
  environ?: string | null;
  /** What `map_files` shows for a mapped path, when the file was replaced since. */
  replaced?: Record<string, FileStat>;
}

type Dirs = Record<string, { uid: number; mode: number }>;

const exeMaps = (exe: string, ino = 10, extra: string[] = []) =>
  [
    `00400000-00500000 r-xp 00000000 08:01 ${ino} ${exe}`,
    `7f0000000000-7f0000200000 r-xp 00000000 08:01 777 ${LIBC}`,
    "7ffd00000000-7ffd00001000 r-xp 00000000 00:00 0 [vdso]",
    "7ffe00000000-7ffe00021000 rw-p 00000000 00:00 0 [stack]",
    ...extra,
  ].join("\n");

const eErr = (code: string) => Object.assign(new Error(code), { code });

/** A fixture system: processes by pid, files by path. */
function system(
  procs: Record<number, Proc>,
  opts: {
    ss?: string | Error;
    dirs?: Dirs;
    libs?: Record<string, FileStat>;
    slowScan?: boolean;
    runSs?: PeerCheckDeps["runSs"];
  } = {},
): PeerCheckDeps {
  const dirs: Dirs = opts.dirs ?? {
    [PACKAGED_ROOT]: { uid: 0, mode: 0o040755 },
    [`${PACKAGED_ROOT}/resources`]: { uid: 0, mode: 0o040755 },
    [`${PACKAGED_ROOT}/resources/linux-helper`]: { uid: 0, mode: 0o040755 },
  };
  const libs = opts.libs ?? GOOD_LIBS;
  let clock = 0;
  const procOf = (path: string): Proc | undefined => {
    const m = /^\/proc\/(\d+)\//.exec(path);
    return m ? procs[Number(m[1])] : undefined;
  };
  const commOf = (proc: Proc) => proc.comm ?? (proc.exe ? HELPER_READY_COMM : "x");
  return {
    runSs:
      opts.runSs ??
      (async () => {
        const out = opts.ss ?? SS;
        if (out instanceof Error) throw out;
        return out;
      }),
    async listPids() {
      return [...Object.keys(procs), "1"];
    },
    async readlink(p) {
      if (p === "/proc/self/fd/22") return `socket:[${OURS}]`;
      const proc = procOf(p);
      if (/\/exe$/.test(p) && proc?.exe) return proc.exe;
      const task = /^\/proc\/\d+\/task\/(\d+)\/fd\/(\d+)$/.exec(p);
      if (task) {
        const t = proc?.taskFds?.[Number(task[1])]?.[Number(task[2])];
        if (t !== undefined) return t;
      }
      const m = /^\/proc\/\d+\/fd\/(\d+)$/.exec(p);
      const target = m && !proc?.hidden ? proc?.fds?.[Number(m[1])] : undefined;
      if (target !== undefined) return target;
      throw eErr("ENOENT");
    },
    async readdir(p) {
      const task = /^\/proc\/(\d+)\/task$/.exec(p);
      if (task) {
        const proc = procs[Number(task[1])];
        if (!proc) throw eErr("ENOENT");
        return [task[1] as string, ...Object.keys(proc.taskFds ?? {})];
      }
      const tfd = /^\/proc\/(\d+)\/task\/(\d+)\/fd$/.exec(p);
      if (tfd) {
        const t = procs[Number(tfd[1])]?.taskFds?.[Number(tfd[2])];
        if (!t) throw eErr("ENOENT");
        return t.map((_, i) => String(i));
      }
      const m = /^\/proc\/(\d+)\/fd$/.exec(p);
      const proc = m ? procs[Number(m[1])] : undefined;
      if (!proc) throw eErr("ENOENT");
      if (proc.hidden) throw eErr("EACCES");
      return (proc.fds ?? []).map((_, i) => String(i));
    },
    async readFile(p) {
      const proc = procOf(p);
      if (/\/stat$/.test(p) && proc?.start) {
        return `1 (psyche-helper) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ${proc.start} 0`;
      }
      if (/\/status$/.test(p) && proc) {
        const o = proc.owner ?? 1000;
        return `Name:\tx\nState:\t${proc.state ?? "S"} (sleeping)\nTracerPid:\t${proc.tracer ?? 0}\nUid:\t${o}\t${o}\t${o}\t${o}\nPPid:\t${proc.ppid ?? 1}\n`;
      }
      if (/\/comm$/.test(p) && proc) return `${commOf(proc)}\n`;
      if (/\/maps$/.test(p) && proc?.exe) return proc.maps ?? exeMaps(proc.exe, proc.ino ?? 10);
      if (/\/environ$/.test(p) && proc && proc.environ !== null) return proc.environ ?? "HOME=/x\0";
      throw eErr("ENOENT");
    },
    async stat(p) {
      const proc = procOf(p);
      if (/\/exe$/.test(p) && proc) {
        return { uid: proc.uid ?? 0, mode: proc.mode ?? 0o100755, dev: DEV, ino: proc.ino ?? 10 };
      }
      // The file behind a mapping, as map_files shows it (the mapped file, not the path).
      const mf = /^\/proc\/\d+\/map_files\/([0-9a-f]+-[0-9a-f]+)$/.exec(p);
      if (mf && proc?.exe) {
        const line = (proc.maps ?? exeMaps(proc.exe, proc.ino ?? 10))
          .split("\n")
          .find((l) => l.startsWith(`${mf[1]} `));
        const path = line?.replace(/^\S+ \S+ \S+ \S+ \S+ */, "").replace(/ \(deleted\)$/, "");
        if (path === undefined) throw eErr("ENOENT");
        if (path === proc.exe) {
          return { uid: proc.uid ?? 0, mode: proc.mode ?? 0o100755, dev: DEV, ino: proc.ino ?? 10 };
        }
        const mapped = proc.replaced?.[path] ?? libs[path];
        if (!mapped) throw eErr("ENOENT");
        return mapped;
      }
      for (const candidate of Object.values(procs)) {
        if (candidate.exe === p) {
          return {
            uid: candidate.uid ?? 0,
            mode: candidate.mode ?? 0o100755,
            dev: DEV,
            ino: candidate.pathIno ?? candidate.ino ?? 10,
          };
        }
      }
      if (libs[p]) return libs[p] as FileStat;
      const d = dirs[p];
      if (d) return { ...d, dev: DEV, ino: 99 };
      throw eErr("ENOENT");
    },
    now() {
      clock += opts.slowScan ? 2500 : 0;
      return clock;
    },
  };
}

// Descriptors 0 to 2 are pipes, the socket is on fd 3 (a helper that opened it itself).
const HELD = ["pipe:[1]", "pipe:[2]", "pipe:[3]", `socket:[${THEIRS}]`];
const packaged: Proc = { start: "555", fds: HELD, exe: PACKAGED_HELPER, uid: 0 };
const only = (p: Proc) => ({ [PID]: p });
const check = (deps: PeerCheckDeps, fd: number | null = 22): Promise<PeerResult> =>
  checkPeerOfFd(fd ?? undefined, deps, new AbortController().signal);
const verdict = async (deps: PeerCheckDeps, fd?: number | null) => (await check(deps, fd)).check;

describe("parsing ss, /proc and maps", () => {
  it("finds our row and the peer's row", () => {
    expect(findSsPair(SS, OURS)).toEqual({ peerInode: THEIRS, pids: [PID] });
  });
  it("works when the Gateway's socket path has spaces (a PSYCHE_HOME with a space)", () => {
    const spaced = `u_str ESTAB 0 0 /home/my user/.psyche home/run/node.sock ${OURS} * ${THEIRS} users:(("MainThread",pid=900,fd=22))`;
    expect(findSsPair(ssText(LISTEN, THEIR_ROW(), spaced), OURS)).toEqual({
      peerInode: THEIRS,
      pids: [PID],
    });
    // The peer may be the one with a path, too.
    const theirSpaced = `u_str ESTAB 0 0 /tmp/a b/c.sock ${THEIRS} * ${OURS} users:(("psyche-helper",pid=${PID},fd=3))`;
    expect(findSsPair(ssText(theirSpaced, OUR_ROW), OURS)).toEqual({
      peerInode: THEIRS,
      pids: [PID],
    });
  });
  it("ignores lines about other sockets, however odd", () => {
    const odd = ssText(
      LISTEN,
      "complete garbage",
      "u_str ESTAB 0 0 @",
      " 31337 * 0",
      'u_str ESTAB 0 0 * 5 * 6 users:(("weird )) name",pid=77,fd=4)',
      "u_str ESTAB 0 0 /tmp/q r.sock 12 * 13",
      THEIR_ROW(),
      OUR_ROW,
    );
    expect(findSsPair(odd, OURS)).toEqual({ peerInode: THEIRS, pids: [PID] });
  });
  it("refuses when anything else mentions our inodes, or our rows do not fit", () => {
    const reason = (text: string) => (findSsPair(text, OURS) as { reason: string }).reason;
    // A forged row with a victim pid, well formed.
    expect(reason(ssText(THEIR_ROW(`("x",pid=4242,fd=1)`), THEIR_ROW(), OUR_ROW))).toBe(
      "ss_ambiguous",
    );
    // A badly formed line that mentions our inode (a name with a newline and our numbers).
    expect(reason(ssText(THEIR_ROW(), OUR_ROW, `u_str ESTAB 0 0 @ ${OURS} junk`))).toBe(
      "ss_ambiguous",
    );
    expect(reason(ssText(THEIR_ROW(), OUR_ROW, ` ${THEIRS} * ${OURS}`))).toBe("ss_ambiguous");
    // The peer's row names someone else, or is missing.
    expect(
      reason(ssText(`u_str ESTAB 0 0 * ${THEIRS} * 999 users:(("a",pid=1,fd=1))`, OUR_ROW)),
    ).toBe("peer_not_paired");
    expect(reason(ssText(OUR_ROW))).toBe("peer_not_paired");
    expect(reason(ssText(THEIR_ROW()))).toBe("ss_ambiguous");
    expect(reason(ssText())).toBe("socket_not_listed");
    // A process list that does not fit.
    expect(reason(ssText(THEIR_ROW(`("a" ),("b",pid=7,fd=1)`), OUR_ROW))).toBe("peer_not_paired");
    // Wrong header, or none.
    expect(reason("")).toBe("ss_unparsable");
    expect(reason(`not a header\n${THEIR_ROW()}\n${OUR_ROW}\n`)).toBe("ss_unparsable");
    // The peer inode is zero (it is gone).
    expect(reason(ssText(`u_str ESTAB 0 0 /x ${OURS} * 0`))).toBe("peer_gone");
  });
  it("reads socket inodes and start times", () => {
    expect(socketInodeOf("socket:[42]")).toBe(42);
    expect(socketInodeOf("/home/x/socket:[42]")).toBeUndefined();
    expect(socketInodeOf("pipe:[42]")).toBeUndefined();
    const stat = "123 (a b) c) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 0";
    expect(startTimeOf(stat)).toBe("987654");
    expect(startTimeOf("garbage")).toBeUndefined();
  });
  it("reads maps and the loader environment", () => {
    expect(parseMaps(exeMaps("/x/y", 5))?.[0]).toMatchObject({
      range: "00400000-00500000",
      inode: 5,
      path: "/x/y",
    });
    expect(parseMaps("garbage")).toBeUndefined();
    expect(setsLoaderEnv("HOME=/h\0PATH=/bin\0")).toBe(false);
    for (const name of ["LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH"]) {
      expect(setsLoaderEnv(`HOME=/h\0${name}=/tmp/x.so\0`)).toBe(true);
    }
    expect(setsLoaderEnv("MY_LD_PRELOAD=1\0")).toBe(false);
  });
  it("knows whether the packaged helper is installed, and shares the path with the protocol", () => {
    expect(packagedHelperInstalled((p) => p === PACKAGED_HELPER)).toBe(true);
    expect(packagedHelperInstalled(() => false)).toBe(false);
    expect(PACKAGED_HELPER).toBe(LINUX_PACKAGED_HELPER_PATH);
  });
});

describe("the verdict", () => {
  it("root_owned: the packaged helper, root-owned, in root-owned directories, clean", async () => {
    expect(await check(system(only(packaged)))).toEqual({
      check: "root_owned",
      reason: "packaged",
    });
  });
  it("user_owned: a helper binary the user owns (dev build, AppImage)", async () => {
    const dev = { ...packaged, exe: "/home/u/psyche/target/debug/psyche-helper", uid: 1000 };
    expect(await verdict(system(only(dev)))).toBe("user_owned");
    const image = {
      ...packaged,
      exe: "/tmp/.mount_PsycheAB/usr/lib/psyche/psyche-helper",
      uid: 1000,
      // An AppImage sets LD_LIBRARY_PATH and maps its own libraries: the weak mode allows it.
      environ: "LD_LIBRARY_PATH=/tmp/.mount_PsycheAB/usr/lib\0",
    };
    expect(await verdict(system(only(image)))).toBe("user_owned");
  });
  it("mismatch: some other program", async () => {
    expect(await verdict(system(only({ ...packaged, exe: "/usr/bin/node", uid: 0 })))).toBe(
      "mismatch",
    );
    expect(await verdict(system(only({ ...packaged, exe: "/home/u/evil", uid: 1000 })))).toBe(
      "mismatch",
    );
  });
  it("never root_owned when anything about the package path is off", async () => {
    const run = (p: Proc, o: Parameters<typeof system>[1] = {}) => verdict(system(only(p), o));
    expect(await run({ ...packaged, mode: 0o100775 })).toBe("unverified");
    const dirs: Dirs = {
      [PACKAGED_ROOT]: { uid: 0, mode: 0o040755 },
      [`${PACKAGED_ROOT}/resources`]: { uid: 1000, mode: 0o040755 },
      [`${PACKAGED_ROOT}/resources/linux-helper`]: { uid: 0, mode: 0o040755 },
    };
    expect(await run(packaged, { dirs })).toBe("unverified");
    const groupWritable: Dirs = {
      ...dirs,
      [`${PACKAGED_ROOT}/resources`]: { uid: 0, mode: 0o040775 },
    };
    expect(await run(packaged, { dirs: groupWritable })).toBe("unverified");
    // The path names another file than the one running (a mount over it).
    expect(await run({ ...packaged, pathIno: 11 })).toBe("unverified");
    // Root-owned, named right, but not at the packaged path.
    expect(await run({ ...packaged, exe: "/opt/x/psyche-helper" })).toBe("unverified");
    expect(await run({ ...packaged, exe: `${PACKAGED_ROOT}/psyche-helper` })).toBe("unverified");
    expect(await run({ ...packaged, exe: "/usr/lib/psyche-evil/psyche-helper" })).toBe(
      "unverified",
    );
    // The binary was replaced while running, or is not a regular file.
    expect(await run({ ...packaged, exe: `${PACKAGED_HELPER} (deleted)` })).toBe("unverified");
    expect(await run({ ...packaged, mode: 0o120755 })).toBe("unverified");
  });
  it("unverified: it could not tell", async () => {
    const deps = () => system(only(packaged));
    expect(await verdict(system(only(packaged), { ss: new Error("no ss") }))).toBe("unverified");
    expect(await verdict(deps(), null)).toBe("unverified");
    expect(await verdict(deps(), -1)).toBe("unverified");
    expect(await verdict(system(only(packaged), { ss: ssText() }))).toBe("unverified");
    // The peer already left: nobody holds the socket.
    expect(await check(system({}))).toEqual({ check: "unverified", reason: "peer_gone" });
    // A /proc/<pid> we cannot read at all: never a pass.
    expect(await verdict(system(only({ start: "1", exe: packaged.exe })))).toBe("unverified");
  });
  it("unverified: a different process after the lookups (start time changes)", async () => {
    const deps = system(only(packaged));
    let reads = 0;
    const base = deps.readFile.bind(deps);
    deps.readFile = async (p) => {
      const text = await base(p);
      if (!p.endsWith("/stat")) return text;
      reads++;
      return reads > 1 ? text.replace(" 555 ", " 556 ") : text;
    };
    expect((await check(deps)).reason).toBe("process_changed");
  });
});

describe("injected libraries, anonymous code and the loader environment", () => {
  const run = (p: Proc, o: Parameters<typeof system>[1] = {}) => check(system(only(p), o));
  const withMap = (...lines: string[]) => ({
    ...packaged,
    maps: exeMaps(PACKAGED_HELPER, 10, lines),
  });
  const LIB = "/usr/lib/x86_64-linux-gnu/libz.so.1";
  const libLine = (path = LIB, perms = "r-xp") =>
    `7f1000000000-7f1000100000 ${perms} 00000000 08:01 888 ${path}`;
  const goodLib: FileStat = { uid: 0, mode: 0o100644, dev: DEV, ino: 888 };
  const libs = (s: FileStat, path = LIB) => ({ ...GOOD_LIBS, [path]: s });

  it("a foreign library mapped executable makes the packaged helper a mismatch", async () => {
    expect(await run(withMap(libLine("/home/u/evil.so")))).toEqual({
      check: "mismatch",
      reason: "foreign_mapping",
    });
    expect((await run(withMap(libLine("/tmp/inject.so")))).check).toBe("mismatch");
    expect((await run(withMap(libLine("/memfd:payload (deleted)")))).check).toBe("mismatch");
    // A deleted file outside the system directories is not an upgrade, it is foreign.
    expect((await run(withMap(libLine("/home/u/x.so (deleted)")))).check).toBe("mismatch");
  });
  it("anonymous executable memory is refused, except the vdso and vsyscall", async () => {
    const anon = "7f2000000000-7f2000100000 rwxp 00000000 00:00 0";
    expect(await run(withMap(anon))).toEqual({ check: "mismatch", reason: "foreign_mapping" });
    expect(
      (await run(withMap("7f2000000000-7f2000100000 r-xp 00000000 00:00 0 [heap]"))).check,
    ).toBe("mismatch");
    const vsyscall = "ffffffffff600000-ffffffffff601000 --xp 00000000 00:00 0 [vsyscall]";
    expect((await run(withMap(vsyscall))).check).toBe("root_owned");
    // Non-executable anonymous memory is the heap and stacks: fine.
    expect((await run(withMap("7f2000000000-7f2000100000 rw-p 00000000 00:00 0"))).check).toBe(
      "root_owned",
    );
  });
  it("a system library must be root-owned and not writable", async () => {
    expect((await run(withMap(libLine()), { libs: libs(goodLib) })).check).toBe("root_owned");
    expect((await run(withMap(libLine()), { libs: libs({ ...goodLib, uid: 1000 }) })).check).toBe(
      "mismatch",
    );
    expect(
      (await run(withMap(libLine()), { libs: libs({ ...goodLib, mode: 0o100666 }) })).check,
    ).toBe("mismatch");
  });
  it("device numbers are compared through stat, so overlayfs and btrfs do not cause false alarms", async () => {
    // The maps line says 00:2e (what overlayfs prints) while stat says another device: the mapped
    // file and the named file are compared with stat, both agree.
    const line = `7f1000000000-7f1000100000 r-xp 00000000 00:2e 888 ${LIB}`;
    expect((await run(withMap(line), { libs: libs(goodLib) })).check).toBe("root_owned");
  });
  it("a library replaced since it was mapped is unverified (library_replaced), so the helper is restarted", async () => {
    const replaced = { ...withMap(libLine()), replaced: { [LIB]: { ...goodLib, ino: 111 } } };
    expect(await run(replaced, { libs: libs(goodLib) })).toEqual({
      check: "unverified",
      reason: "library_replaced",
    });
    // Another device for the same inode number.
    const otherDev = {
      ...withMap(libLine()),
      replaced: { [LIB]: { ...goodLib, dev: mkdev(8, 2) } },
    };
    expect((await run(otherDev, { libs: libs(goodLib) })).reason).toBe("library_replaced");
    // The path no longer exists, or the mapping says (deleted) in a system directory.
    expect((await run({ ...withMap(libLine()), replaced: { [LIB]: goodLib } })).reason).toBe(
      "library_replaced",
    );
    const deleted = withMap(libLine(`${LIB} (deleted)`));
    expect(await run(deleted, { libs: libs(goodLib) })).toEqual({
      check: "unverified",
      reason: "library_replaced",
    });
  });
  it("a mapping that cannot be inspected is unverified", async () => {
    const deps = system(only(withMap(libLine())), { libs: libs(goodLib) });
    const base = deps.stat.bind(deps);
    deps.stat = async (p) => {
      if (p.includes("/map_files/") && !p.includes("00400000")) throw eErr("EACCES");
      return base(p);
    };
    expect(await check(deps)).toEqual({ check: "unverified", reason: "image_unreadable" });
  });
  it("a library in the package directory counts as the package's own", async () => {
    const own = `${PACKAGED_ROOT}/resources/linux-helper/libhelper.so`;
    const mapped = withMap(libLine(own));
    expect((await run(mapped, { libs: libs(goodLib, own) })).check).toBe("root_owned");
    expect((await run(mapped, { libs: libs({ ...goodLib, uid: 1000 }, own) })).check).toBe(
      "mismatch",
    );
  });
  it("non-executable file mappings are not code", async () => {
    expect((await run(withMap(libLine("/home/u/data.bin", "r--p")))).check).toBe("root_owned");
  });
  it("any loader variable in the initial environment makes the packaged helper a mismatch", async () => {
    for (const name of ["LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH"]) {
      expect(await run({ ...packaged, environ: `HOME=/h\0${name}=/x\0` })).toEqual({
        check: "mismatch",
        reason: "loader_env",
      });
    }
  });
  it("maps or environ that cannot be read are unverified, never a pass", async () => {
    expect((await run({ ...packaged, environ: null })).reason).toBe("image_unreadable");
    expect((await run({ ...packaged, maps: "garbage" })).reason).toBe("image_unreadable");
  });
  it("a user-owned helper with a foreign mapping or anonymous code stays user_owned (the weak mode)", async () => {
    const exe = "/home/u/target/debug/psyche-helper";
    const dev = {
      ...packaged,
      exe,
      uid: 1000,
      maps: exeMaps(exe, 10, [
        libLine("/home/u/evil.so"),
        "7f2000000000-7f2000100000 rwxp 00000000 00:00 0",
      ]),
      environ: "LD_PRELOAD=/home/u/evil.so\0",
      comm: "psyche-helper",
    };
    expect((await run(dev)).check).toBe("user_owned");
  });
});

describe("start-up mark, tracing and inherited sockets", () => {
  const run = (p: Proc) => check(system(only(p)));

  it("the packaged helper must carry its ready name, on both looks", async () => {
    expect(await run({ ...packaged, comm: "psyche-helper" })).toEqual({
      check: "unverified",
      reason: "not_ready",
    });
    expect((await run({ ...packaged, comm: "evil" })).reason).toBe("not_ready");
    // The name changes between the two reads (a process still starting, or one that renamed).
    const deps = system(only(packaged));
    let reads = 0;
    const base = deps.readFile.bind(deps);
    deps.readFile = async (p) => {
      const text = await base(p);
      if (!p.endsWith("/comm")) return text;
      reads++;
      return reads > 1 ? "psyche-helper\n" : text;
    };
    expect((await check(deps)).reason).toBe("not_ready");
    expect(HELPER_READY_COMM.length).toBeLessThanOrEqual(15);
  });
  it("a stopped or traced helper is unverified", async () => {
    expect(await run({ ...packaged, state: "T" })).toEqual({
      check: "unverified",
      reason: "stopped_or_traced",
    });
    expect((await run({ ...packaged, state: "t" })).reason).toBe("stopped_or_traced");
    expect((await run({ ...packaged, tracer: 4321 })).reason).toBe("stopped_or_traced");
    // Stopped only at the second look.
    const deps = system(only(packaged));
    let reads = 0;
    const base = deps.readFile.bind(deps);
    deps.readFile = async (p) => {
      const text = await base(p);
      if (!p.endsWith("/status")) return text;
      reads++;
      return reads > 1 ? text.replace("State:\tS", "State:\tT") : text;
    };
    expect((await check(deps)).reason).toBe("stopped_or_traced");
  });
  it("a socket on stdin, stdout or stderr was made by the parent: unverified", async () => {
    for (const fd of [0, 1, 2]) {
      const fds = ["pipe:[1]", "pipe:[2]", "pipe:[3]", `socket:[${THEIRS}]`];
      fds[fd] = `socket:[${THEIRS}]`;
      fds[3] = "pipe:[9]";
      expect(await run({ ...packaged, fds })).toEqual({
        check: "unverified",
        reason: "inherited_socket",
      });
    }
    // Also through a thread's own table.
    const threaded = { ...packaged, fds: [], taskFds: { 18200: [`socket:[${THEIRS}]`] } };
    expect((await run(threaded)).reason).toBe("inherited_socket");
    // On fd 3 or higher it is the helper's own.
    expect((await run(packaged)).check).toBe("root_owned");
  });
  it("the marks do not apply to a development build (the weak mode records what it saw)", async () => {
    const dev = {
      ...packaged,
      exe: "/home/u/target/debug/psyche-helper",
      uid: 1000,
      comm: "cargo",
      state: "t",
    };
    expect((await run(dev)).check).toBe("user_owned");
  });
});

describe("what a same-user process can do through ss and the socket", () => {
  const VICTIM = 4242;
  const victim: Proc = { ...packaged, start: "9", fds: ["socket:[1]"] };
  const evil: Proc = { ...packaged, exe: "/home/u/evil", uid: 1000 };

  it("a forged row (well formed or not) cannot redirect the check to another pid", async () => {
    const forgedWellFormed = ssText(
      LISTEN,
      THEIR_ROW(`("x",pid=${VICTIM},fd=1)`),
      THEIR_ROW(),
      OUR_ROW,
    );
    expect(
      await check(system({ [PID]: evil, [VICTIM]: victim }, { ss: forgedWellFormed })),
    ).toEqual({
      check: "unverified",
      reason: "ss_ambiguous",
    });
    const forgedInName = ssText(
      LISTEN,
      "u_str ESTAB 0 0 @",
      `u_str ESTAB 0 0 * ${THEIRS} * ${OURS} users:(("x",pid=${VICTIM},fd=1))`,
      " 31337 * 0",
      OUR_ROW,
    );
    expect(
      (await check(system({ [PID]: evil, [VICTIM]: victim }, { ss: forgedInName }))).check,
    ).toBe("unverified");
  });
  it("ss naming a victim while the kernel says another process holds the socket is no pass", async () => {
    const ss = ssText(LISTEN, THEIR_ROW(`("psyche-helper",pid=${VICTIM},fd=1)`), OUR_ROW);
    const procs = { [PID]: evil, [VICTIM]: { ...packaged, start: "9", fds: [] } };
    expect(await check(system(procs, { ss }))).toEqual({
      check: "unverified",
      reason: "ss_disagrees",
    });
  });
  it("a client bound to a path with a space still has its pid found by the kernel (not forged)", async () => {
    const ss = ssText(
      LISTEN,
      `u_str ESTAB 0 0 /tmp/with space/c.sock ${THEIRS} * ${OURS} users:(("psyche-helper",pid=${PID},fd=3))`,
      OUR_ROW,
    );
    expect((await check(system(only(packaged), { ss }))).check).toBe("root_owned");
    expect((await check(system(only(evil), { ss }))).check).toBe("mismatch");
  });
  it("a fork (two processes hold the socket) makes the answer unverified", async () => {
    const child: Proc = { ...packaged, start: "600" };
    const both = ssText(
      LISTEN,
      THEIR_ROW(`("psyche-helper",pid=${PID},fd=3),("psyche-helper",pid=18157,fd=3)`),
      OUR_ROW,
    );
    expect(await check(system({ [PID]: packaged, 18157: child }, { ss: both }))).toEqual({
      check: "unverified",
      reason: "many_holders",
    });
    // Even when ss shows only one of them.
    expect(await check(system({ [PID]: packaged, 18157: child }))).toEqual({
      check: "unverified",
      reason: "many_holders",
    });
  });
  it("a copy of the socket in another thread's own fd table is found", async () => {
    const pad = ["pipe:[1]", "pipe:[2]", "pipe:[3]", `socket:[${THEIRS}]`];
    const threaded: Proc = { ...packaged, fds: [], taskFds: { 18200: pad } };
    // The only holder is a thread table: the process is still the one holder.
    expect((await check(system(only(threaded)))).check).toBe("root_owned");
    // A second process that holds it only through a thread table is a second holder.
    const sneaky: Proc = { start: "700", fds: [], taskFds: { 19001: pad }, exe: "/home/u/evil" };
    expect(await check(system({ [PID]: packaged, 19000: sneaky }))).toEqual({
      check: "unverified",
      reason: "many_holders",
    });
  });
  it("unreadable fd tables of other processes are ignored, whoever they are", async () => {
    // gpg-agent, Chromium's sandboxed processes, other users' processes, a fork of the helper
    // that went non-dumpable: no relatedness heuristic, so none of them blocks pairing.
    const procs = {
      [PID]: { ...packaged, ppid: 2000 },
      3000: { hidden: true, start: "10", ppid: 2000, comm: "gpg-agent" },
      3001: { hidden: true, start: "11", owner: 0, ppid: 1 },
      3002: { hidden: true, start: "12", ppid: PID, comm: "child" },
    };
    expect((await check(system(procs))).check).toBe("root_owned");
  });
  it("a thread's unreadable fd table is skipped too", async () => {
    const dep = system({ [PID]: packaged, 18159: { start: "12", fds: [], taskFds: {} } });
    const base = dep.readdir.bind(dep);
    dep.readdir = async (p) => {
      if (p === "/proc/18159/task") return ["18159", "18160"];
      if (p === "/proc/18159/task/18160/fd") throw eErr("EACCES");
      return base(p);
    };
    expect((await check(dep)).check).toBe("root_owned");
  });
  it("a /proc scan that runs out of time makes the answer unverified", async () => {
    expect(await check(system(only(packaged), { slowScan: true }))).toEqual({
      check: "unverified",
      reason: "scan_timeout",
    });
  });
});

describe("the checker's limits", () => {
  const fake = { _handle: { fd: 22 } } as never;
  const never = () => new Promise<string>(() => {});
  /** An ss that stops when told to. */
  const stoppable: PeerCheckDeps["runSs"] = (signal) =>
    new Promise<string>((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted"))),
    );

  it("bounds time, tells the work to stop, and a missing descriptor is unverified", async () => {
    let aborted = false;
    const deps = system(only(packaged), {
      runSs: (signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return stoppable(signal);
      },
    });
    expect(await linuxPeerChecker({ deps, timeoutMs: 20 })(fake)).toEqual({
      check: "unverified",
      reason: "timeout",
    });
    expect(aborted).toBe(true);
    const ok = (await linuxPeerChecker({ deps: system(only(packaged)) })(fake)) as PeerResult;
    expect(ok.check).toBe("root_owned");
    expect(await linuxPeerChecker({ deps: system(only(packaged)) })({} as never)).toEqual({
      check: "unverified",
      reason: "no_descriptor",
    });
  });
  it("frees the slot only when the work has stopped", async () => {
    // Work that ignores the abort keeps the one slot; the next connection is told busy.
    const stuck = linuxPeerChecker({
      deps: system(only(packaged), { runSs: never }),
      timeoutMs: 30,
      concurrency: 1,
      maxQueue: 0,
    });
    expect(((await stuck(fake)) as PeerResult).reason).toBe("timeout");
    expect(await stuck(fake)).toEqual({ check: "unverified", reason: "busy" });
    // Work that stops on abort frees it at once.
    const polite = linuxPeerChecker({
      deps: system(only(packaged), { runSs: stoppable }),
      timeoutMs: 30,
      concurrency: 1,
      maxQueue: 0,
    });
    expect(((await polite(fake)) as PeerResult).reason).toBe("timeout");
    await new Promise((r) => setTimeout(r, 20));
    expect(((await polite(fake)) as PeerResult).reason).toBe("timeout");
  });
  it("a full queue answers busy without a lookup", async () => {
    const checker = linuxPeerChecker({
      deps: system(only(packaged), { runSs: never }),
      timeoutMs: 200,
      concurrency: 1,
      maxQueue: 0,
    });
    const first = checker(fake);
    expect(await checker(fake)).toEqual({ check: "unverified", reason: "busy" });
    expect(((await first) as PeerResult).reason).toBe("timeout");
  });
});

const CAPS: FakeNodeHandler[] = [
  {
    capability: { name: "health", sideEffect: "none" as const, streaming: false },
    run: () => ({ ok: true }),
  },
];

let t: TestGateway | null = null;
const nodes: FakeNode[] = [];
afterEach(async () => {
  for (const n of nodes.splice(0)) await n.close().catch(() => undefined);
  await t?.cleanup();
  t = null;
});

interface StartOptions {
  required?: boolean;
  platform?: NodeJS.Platform;
}
async function startWith(
  result: () => Promise<PeerCheck | PeerResult>,
  opts: StartOptions = {},
): Promise<Gateway> {
  await t?.cleanup();
  t = await startTestGateway({
    peerChecker: async () => result(),
    peerCheckRequired: () => opts.required ?? false,
    hostPlatform: opts.platform ?? "linux",
  });
  return t.gateway;
}
async function helper(
  g: Gateway,
  family = "linux-helper",
  secret: string | null = g.handshakeSecret,
) {
  const n = await FakeNode.connect(g.config.nodeSocketPath, {
    origin: g.origin,
    ...(secret === null ? {} : { secret }),
    handlers: CAPS,
    deviceFamily: family,
  });
  nodes.push(n);
  return n;
}
const statusOf = (g: Gateway) =>
  getSetting(g.context.db, HOST_HELPER_STATUS_SETTING)?.value as Record<string, unknown>;

describe("the Gateway acts on the peer check", () => {
  for (const verdict of ["root_owned", "user_owned", "unverified"] as const) {
    it(`${verdict} (no packaged helper installed): a linux-helper with the secret is the Host helper, stored as host-helper`, async () => {
      const g = await startWith(async () => verdict);
      const n = await helper(g);
      expect(g.context.nodes.list().find((x) => x.id === n.nodeId)?.kind).toBe("host-helper");
      expect(g.context.nodes.isHostHelper(n.nodeId)).toBe(true);
      expect(g.context.nodes.hostHelper()?.info.id).toBe(n.nodeId);
      expect(statusOf(g)).toEqual({
        ambiguous: false,
        helpers: 1,
        peerCheck: verdict,
        peerCheckReason: "injected",
      });
      await n.close();
      expect(statusOf(g)).toEqual({ ambiguous: false, helpers: 0 });
    });
  }

  it("with the packaged helper installed, root_owned is the Host helper", async () => {
    const g = await startWith(async () => "root_owned", { required: true });
    const n = await helper(g);
    expect(g.context.nodes.isHostHelper(n.nodeId)).toBe(true);
  });

  for (const check of ["user_owned", "unverified", "mismatch"] as const) {
    it(`with the packaged helper installed, ${check} is refused and the status says why`, async () => {
      const g = await startWith(async () => ({ check, reason: "why" }), { required: true });
      await expect(helper(g)).rejects.toThrow(
        check === "mismatch" ? /not the Linux helper/ : /could not be verified \(.*: why\)/,
      );
      expect(g.context.nodes.hostHelpers()).toEqual([]);
      expect(statusOf(g)).toMatchObject({
        refused: { peerCheck: check, reason: "why", required: true },
      });
    });
  }

  it("mismatch is refused without a packaged helper too", async () => {
    const g = await startWith(async () => "mismatch");
    await expect(helper(g)).rejects.toThrow(/not the Linux helper of this computer/);
    expect(g.context.nodes.hostHelpers()).toEqual([]);
  });

  it("a refusal is recorded only for a process that held the secret", async () => {
    const g = await startWith(async () => "unverified", { required: true });
    await expect(helper(g, "linux-helper", "wrong")).rejects.toThrow(/could not be verified/);
    expect(statusOf(g)?.refused).toBeUndefined();
  });

  it("a checker that throws is unverified, and strict mode refuses it", async () => {
    const boom = async (): Promise<PeerCheck> => {
      throw new Error("boom");
    };
    const g = await startWith(boom);
    const n = await helper(g);
    expect(statusOf(g)?.peerCheck).toBe("unverified");
    expect(g.context.nodes.isHostHelper(n.nodeId)).toBe(true);
    const g2 = await startWith(boom, { required: true });
    await expect(helper(g2)).rejects.toThrow(/could not be verified/);
  });

  it("on a checked socket only the linux-helper family can be the Host helper", async () => {
    const g = await startWith(async () => "root_owned");
    for (const family of ["mac-helper", "win-helper"]) {
      await expect(helper(g, family)).rejects.toThrow(/not the Linux helper of this computer/);
    }
    expect(g.context.nodes.hostHelpers()).toEqual([]);
  });

  it("a linux-helper is not a Host helper on a macOS or Windows Gateway", async () => {
    for (const platform of ["darwin", "win32"] as const) {
      await t?.cleanup();
      t = await startTestGateway({ hostPlatform: platform });
      await expect(helper(t.gateway)).rejects.toThrow(/only on a Linux computer/);
      expect(t.gateway.context.nodes.hostHelpers()).toEqual([]);
    }
  });

  it("without the secret, or with a stale one, a linux-helper is refused and never paired", async () => {
    const g = await startWith(async () => "root_owned");
    for (const secret of [null, "stale"]) {
      await expect(helper(g, "linux-helper", secret)).rejects.toThrow(
        /stale or missing handshake secret/,
      );
    }
    expect(g.context.nodes.hostHelpers()).toEqual([]);
  });

  it("the socket is not read until the check has finished", async () => {
    let release: (v: PeerCheck) => void = () => {};
    const gate = new Promise<PeerCheck>((r) => {
      release = r;
    });
    const g = await startWith(() => gate);
    let done = false;
    const pending = helper(g).then((n) => {
      done = true;
      return n;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(done).toBe(false);
    release("user_owned");
    const n = await pending;
    expect(g.context.nodes.isHostHelper(n.nodeId)).toBe(true);
  });

  it("a Gateway with no checker leaves the node socket as it is (macOS, Windows, in-process)", async () => {
    await t?.cleanup();
    t = await startTestGateway();
    const g = t.gateway;
    const n = await helper(g);
    expect(g.context.nodes.isHostHelper(n.nodeId)).toBe(true);
    expect(statusOf(g)?.peerCheck).toBeUndefined();
  });
});
