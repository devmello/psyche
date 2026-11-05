import { getSetting } from "@psyche/db";
import type { PeerCheck } from "@psyche/protocol";
import { LINUX_PACKAGED_HELPER_PATH } from "@psyche/protocol/platform";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_HELPER_STATUS_SETTING } from "../src/nodes/registry.ts";
import type { Gateway } from "../src/server.ts";
import {
  checkPeerOfFd,
  devMajorMinor,
  findSsPair,
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
  /** Extra per-thread fd tables (thread id to the sockets it holds). */
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
  comm?: string;
  maps?: string;
  environ?: string | null;
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
        return `Name:\tx\nUid:\t${o}\t${o}\t${o}\t${o}\nPPid:\t${proc.ppid ?? 1}\n`;
      }
      if (/\/comm$/.test(p)) {
        if (proc) return `${proc.comm ?? "x"}\n`;
        if (p === "/proc/1/comm") return "systemd\n";
      }
      if (/\/maps$/.test(p) && proc?.exe) return proc.maps ?? exeMaps(proc.exe, proc.ino ?? 10);
      if (/\/environ$/.test(p) && proc && proc.environ !== null) return proc.environ ?? "HOME=/x\0";
      if (/\/status$/.test(p) && p === "/proc/1/status")
        return "Name:\tsystemd\nUid:\t0\t0\t0\t0\nPPid:\t0\n";
      throw eErr("ENOENT");
    },
    async stat(p) {
      const proc = procOf(p);
      if (/\/exe$/.test(p) && proc) {
        return { uid: proc.uid ?? 0, mode: proc.mode ?? 0o100755, dev: DEV, ino: proc.ino ?? 10 };
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
    uid: () => 1000,
    now() {
      clock += opts.slowScan ? 2500 : 0;
      return clock;
    },
  };
}

const HELD = [`socket:[${THEIRS}]`];
const packaged: Proc = { start: "555", fds: HELD, exe: PACKAGED_HELPER, uid: 0 };
const only = (p: Proc) => ({ [PID]: p });
const check = (
  deps: PeerCheckDeps,
  fd: number | null = 22,
  options: { strictHidden?: boolean } = {},
): Promise<PeerResult> =>
  checkPeerOfFd(fd ?? undefined, deps, new AbortController().signal, options);
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
      major: 8,
      minor: 1,
      inode: 5,
      path: "/x/y",
    });
    expect(parseMaps("garbage")).toBeUndefined();
    expect(devMajorMinor(mkdev(8, 1))).toEqual({ major: 8, minor: 1 });
    expect(devMajorMinor(mkdev(259, 3))).toEqual({ major: 259, minor: 3 });
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

describe("injected libraries and the loader environment", () => {
  const run = (p: Proc, o: Parameters<typeof system>[1] = {}) => check(system(only(p), o));
  const withMap = (...lines: string[]) => ({
    ...packaged,
    maps: exeMaps(PACKAGED_HELPER, 10, lines),
  });

  it("a foreign library mapped executable makes the packaged helper a mismatch", async () => {
    const evil = "7f1000000000-7f1000100000 r-xp 00000000 08:01 888 /home/u/evil.so";
    expect(await run(withMap(evil))).toEqual({ check: "mismatch", reason: "foreign_mapping" });
    const tmp = "7f1000000000-7f1000100000 r-xp 00000000 08:01 888 /tmp/inject.so";
    expect((await run(withMap(tmp))).check).toBe("mismatch");
    const memfd = "7f1000000000-7f1000100000 r-xp 00000000 00:01 888 /memfd:payload (deleted)";
    expect((await run(withMap(memfd))).check).toBe("mismatch");
  });
  it("a library in a system directory must be root-owned, not writable, and the file mapped", async () => {
    const lib =
      "7f1000000000-7f1000100000 r-xp 00000000 08:01 888 /usr/lib/x86_64-linux-gnu/libz.so.1";
    const libs = (s: FileStat) => ({ ...GOOD_LIBS, "/usr/lib/x86_64-linux-gnu/libz.so.1": s });
    const good = { uid: 0, mode: 0o100644, dev: DEV, ino: 888 };
    expect((await run(withMap(lib), { libs: libs(good) })).check).toBe("root_owned");
    expect((await run(withMap(lib), { libs: libs({ ...good, uid: 1000 }) })).check).toBe(
      "mismatch",
    );
    expect((await run(withMap(lib), { libs: libs({ ...good, mode: 0o100666 }) })).check).toBe(
      "mismatch",
    );
    // The path now names another file than the one mapped (replaced, or a mount over it).
    expect((await run(withMap(lib), { libs: libs({ ...good, ino: 999 }) })).check).toBe("mismatch");
    expect((await run(withMap(lib), { libs: libs({ ...good, dev: mkdev(8, 2) }) })).check).toBe(
      "mismatch",
    );
    expect((await run(withMap(lib))).check).toBe("mismatch");
    expect(
      (await run(withMap(lib.replace("libz.so.1", "libz.so.1 (deleted)")), { libs: libs(good) }))
        .check,
    ).toBe("mismatch");
  });
  it("a library in the package directory counts as the package's own", async () => {
    const own = `${PACKAGED_ROOT}/resources/linux-helper/libhelper.so`;
    const line = `7f1000000000-7f1000100000 r-xp 00000000 08:01 888 ${own}`;
    const libs = { ...GOOD_LIBS, [own]: { uid: 0, mode: 0o100755, dev: DEV, ino: 888 } };
    expect((await run(withMap(line), { libs })).check).toBe("root_owned");
    expect(
      (
        await run(withMap(line), {
          libs: { ...libs, [own]: { uid: 1000, mode: 0o100755, dev: DEV, ino: 888 } },
        })
      ).check,
    ).toBe("mismatch");
  });
  it("non-executable file mappings are not code", async () => {
    const data = "7f1000000000-7f1000100000 r--p 00000000 08:01 888 /home/u/data.bin";
    expect((await run(withMap(data))).check).toBe("root_owned");
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
  it("a user-owned helper with a foreign mapping stays user_owned (the weak mode)", async () => {
    const dev = {
      ...packaged,
      exe: "/home/u/target/debug/psyche-helper",
      uid: 1000,
      maps: exeMaps("/home/u/target/debug/psyche-helper", 10, [
        "7f1000000000-7f1000100000 r-xp 00000000 08:01 888 /home/u/evil.so",
      ]),
      environ: "LD_PRELOAD=/home/u/evil.so\0",
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
    const threaded: Proc = { ...packaged, fds: [], taskFds: { 18200: HELD } };
    // The only holder is a thread table: the process is still the one holder.
    expect((await check(system(only(threaded)))).check).toBe("root_owned");
    // A second process that holds it only through a thread table is a second holder.
    const sneaky: Proc = { start: "700", fds: [], taskFds: { 19001: HELD }, exe: "/home/u/evil" };
    expect(await check(system({ [PID]: packaged, 19000: sneaky }))).toEqual({
      check: "unverified",
      reason: "many_holders",
    });
  });
  it("a hidden holder related to the helper (its non-dumpable fork) makes the answer unverified", async () => {
    // The child made itself non-dumpable (its fd table is EACCES) and keeps the socket; the
    // parent executed the real helper, which inherited it.
    const child: Proc = { hidden: true, start: "601", ppid: PID, comm: "evil" };
    expect(await check(system({ [PID]: { ...packaged, ppid: 5000 }, 18157: child }))).toEqual({
      check: "unverified",
      reason: "hidden_holder",
    });
    // The hidden process is the parent of the real helper.
    const parent: Proc = { hidden: true, start: "400", ppid: 5000, comm: "evil" };
    expect(await check(system({ [PID]: { ...packaged, ppid: 17000 }, 17000: parent }))).toEqual({
      check: "unverified",
      reason: "hidden_holder",
    });
    // A sibling under the same non-manager parent.
    const sibling: Proc = { hidden: true, start: "602", ppid: 5000, comm: "evil" };
    expect(
      (
        await check(
          system({
            [PID]: { ...packaged, ppid: 5000 },
            18158: sibling,
            5000: { ppid: 1, comm: "bash" },
          }),
        )
      ).reason,
    ).toBe("hidden_holder");
  });
  it("unrelated hidden daemons of the user, and other users' processes, do not block pairing", async () => {
    // gpg-agent, ssh-agent and Chromium's sandboxed processes are non-dumpable: a desktop has them.
    const agent: Proc = { hidden: true, start: "10", ppid: 1, comm: "gpg-agent" };
    const stranger: Proc = { hidden: true, start: "11", owner: 0, ppid: 1 };
    // Both run under the user's systemd, which the helper does too: not a relationship.
    const procs = {
      [PID]: { ...packaged, ppid: 2000 },
      2000: { ppid: 1, comm: "systemd" },
      3000: { ...agent, ppid: 2000 },
      3001: stranger,
    };
    expect((await check(system(procs))).check).toBe("root_owned");
    // The strict switch refuses any unreadable same-user table.
    expect(await check(system(procs), 22, { strictHidden: true })).toEqual({
      check: "unverified",
      reason: "hidden_holder",
    });
  });
  it("a thread's unreadable fd table counts as hidden", async () => {
    const holder: Proc = { ...packaged, ppid: 5000 };
    const hiddenThread: Proc = { start: "12", ppid: 5000, comm: "evil", fds: [], taskFds: {} };
    const dep = system({ [PID]: holder, 18159: hiddenThread, 5000: { ppid: 1, comm: "bash" } });
    const base = dep.readdir.bind(dep);
    dep.readdir = async (p) => {
      if (p === "/proc/18159/task") return ["18159", "18160"];
      if (p === "/proc/18159/task/18160/fd") throw eErr("EACCES");
      return base(p);
    };
    expect((await check(dep)).reason).toBe("hidden_holder");
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
