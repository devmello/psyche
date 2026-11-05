import { getSetting } from "@psyche/db";
import type { PeerCheck } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_HELPER_STATUS_SETTING } from "../src/nodes/registry.ts";
import type { Gateway } from "../src/server.ts";
import {
  checkPeerOfFd,
  linuxPeerChecker,
  PACKAGED_HELPER,
  PACKAGED_ROOT,
  type PeerCheckDeps,
  type PeerResult,
  packagedHelperInstalled,
  parseSsUnix,
  socketInodeOf,
  startTimeOf,
} from "../src/transports/peer-check.ts";
import { FakeNode, type FakeNodeHandler } from "./fake-node.ts";
import { startTestGateway, type TestGateway } from "./helpers.ts";

/**
 * The Linux accept-time peer check (design §4.3): the parsers, the verdicts against a fixture
 * system (including the attacks a same-user process can mount through `ss` output and through
 * sharing the socket), and the Gateway acting on a verdict (kind, status, refusal, pausing).
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

interface Proc {
  start?: string;
  fds?: string[];
  exe?: string;
  uid?: number;
  mode?: number;
  ino?: number;
  /** What the path in `exe` names in this namespace, when not the same file. */
  pathIno?: number;
}

type Dirs = Record<string, { uid: number; mode: number }>;

/** A fixture system: processes by pid, files by path. */
function system(
  procs: Record<number, Proc>,
  opts: { ss?: string | Error; dirs?: Dirs; slowScan?: boolean } = {},
): PeerCheckDeps {
  const dirs: Dirs = opts.dirs ?? {
    [PACKAGED_ROOT]: { uid: 0, mode: 0o040755 },
    [`${PACKAGED_ROOT}/resources`]: { uid: 0, mode: 0o040755 },
    [`${PACKAGED_ROOT}/resources/linux-helper`]: { uid: 0, mode: 0o040755 },
  };
  let clock = 0;
  const procOf = (path: string): Proc | undefined => {
    const m = /^\/proc\/(\d+)\//.exec(path);
    return m ? procs[Number(m[1])] : undefined;
  };
  return {
    async runSs() {
      const out = opts.ss ?? SS;
      if (out instanceof Error) throw out;
      return out;
    },
    async listPids() {
      return [...Object.keys(procs), "1"];
    },
    async readlink(p) {
      if (p === "/proc/self/fd/22") return `socket:[${OURS}]`;
      const proc = procOf(p);
      if (/\/exe$/.test(p) && proc?.exe) return proc.exe;
      const m = /^\/proc\/\d+\/fd\/(\d+)$/.exec(p);
      const target = m ? proc?.fds?.[Number(m[1])] : undefined;
      if (target !== undefined) return target;
      throw new Error(`ENOENT ${p}`);
    },
    async readdir(p) {
      const m = /^\/proc\/(\d+)\/fd$/.exec(p);
      const proc = m ? procs[Number(m[1])] : undefined;
      if (proc?.fds) return proc.fds.map((_, i) => String(i));
      throw new Error(`EACCES ${p}`);
    },
    async readFile(p) {
      const proc = procOf(p);
      if (/\/stat$/.test(p) && proc?.start) {
        return `1 (psyche-helper) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ${proc.start} 0`;
      }
      throw new Error(`ENOENT ${p}`);
    },
    async stat(p) {
      const proc = procOf(p);
      if (/\/exe$/.test(p) && proc) {
        return { uid: proc.uid ?? 0, mode: proc.mode ?? 0o100755, dev: 1, ino: proc.ino ?? 10 };
      }
      for (const candidate of Object.values(procs)) {
        if (candidate.exe === p) {
          return {
            uid: candidate.uid ?? 0,
            mode: candidate.mode ?? 0o100755,
            dev: 1,
            ino: candidate.pathIno ?? candidate.ino ?? 10,
          };
        }
      }
      const d = dirs[p];
      if (d) return { ...d, dev: 1, ino: 99 };
      throw new Error(`ENOENT ${p}`);
    },
    now() {
      clock += opts.slowScan ? 2000 : 0;
      return clock;
    },
  };
}

const HELD = [`socket:[${THEIRS}]`];
const packaged: Proc = { start: "555", fds: HELD, exe: PACKAGED_HELPER, uid: 0 };
const only = (p: Proc) => ({ [PID]: p });
const check = (deps: PeerCheckDeps, fd: number | null = 22): Promise<PeerResult> =>
  checkPeerOfFd(fd ?? undefined, deps);
const verdict = async (deps: PeerCheckDeps, fd?: number | null) => (await check(deps, fd)).check;

describe("parsing ss and /proc", () => {
  it("reads rows, inodes and pids", () => {
    const rows = parseSsUnix(SS);
    expect(rows).toContainEqual({ localInode: THEIRS, peerInode: OURS, pids: [PID] });
    expect(rows).toContainEqual({ localInode: OURS, peerInode: THEIRS, pids: [900] });
    expect(rows).toContainEqual({ localInode: 1147000, peerInode: 0, pids: [900] });
    expect(parseSsUnix(ssText())).toEqual([]);
  });
  it("rejects the whole output when anything does not fit the grammar", () => {
    const bad = [
      "",
      "not a header\n",
      // A socket path with spaces shifts the columns.
      ssText("u_str ESTAB 0 0 /tmp/a b/c.sock 7 * 8"),
      // A newline in a name splits one row into partial lines.
      ssText("u_str ESTAB 0 0 @", 'u_str ESTAB 0 0 * 1 * 2 users:(("x",pid=3,fd=1))', " 7 * 8"),
      ssText('u_str ESTAB 0 0 * 5 * 6 users:(("weird )) name",pid=77,fd=4)'),
      ssText("u_str ESTAB 0 0 * 5 * 6 extra"),
      ssText("u_str ESTAB 0 0 * 5 *"),
      ssText('u_str ESTAB 0 0 * 5 * 6 users:(("x",pid=3))'),
      // Repeated local inode.
      ssText("u_str ESTAB 0 0 * 5 * 6", "u_str ESTAB 0 0 * 5 * 7"),
      // Inode zero is not a socket.
      ssText("u_str ESTAB 0 0 * 0 * 7"),
    ];
    for (const text of bad) expect(parseSsUnix(text), JSON.stringify(text)).toBeUndefined();
  });
  it("reads socket inodes and start times", () => {
    expect(socketInodeOf("socket:[42]")).toBe(42);
    expect(socketInodeOf("/home/x/socket:[42]")).toBeUndefined();
    expect(socketInodeOf("pipe:[42]")).toBeUndefined();
    const stat = "123 (a b) c) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 0";
    expect(startTimeOf(stat)).toBe("987654");
    expect(startTimeOf("garbage")).toBeUndefined();
  });
  it("knows whether the packaged helper is installed", () => {
    expect(packagedHelperInstalled((p) => p === PACKAGED_HELPER)).toBe(true);
    expect(packagedHelperInstalled(() => false)).toBe(false);
  });
});

describe("the verdict", () => {
  it("root_owned: the packaged helper, root-owned, in root-owned directories", async () => {
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
    // Unreadable /proc/<pid> (another user's process): never a pass.
    expect(await verdict(system(only({ start: "1", exe: packaged.exe })))).toBe("unverified");
  });
  it("unverified: a different process after the lookups (start time changes)", async () => {
    const deps = system(only(packaged));
    let reads = 0;
    const base = deps.readFile.bind(deps);
    deps.readFile = async (p) => {
      reads++;
      const text = await base(p);
      return reads > 1 ? text.replace(" 555 ", " 556 ") : text;
    };
    expect((await check(deps)).reason).toBe("process_changed");
  });
});

describe("what a same-user process can do through ss and the socket", () => {
  const VICTIM = 4242;
  const victim: Proc = { ...packaged, start: "9", fds: ["socket:[1]"] };
  const evil: Proc = { ...packaged, exe: "/home/u/evil", uid: 1000 };

  it("a forged row in a socket name cannot redirect the check to another pid", async () => {
    // The attacker binds an abstract socket whose name holds a newline and a whole fake row that
    // blames a victim pid, and connects to us. ss prints the name raw.
    const ss = ssText(
      LISTEN,
      "u_str ESTAB 0 0 @",
      `u_str ESTAB 0 0 * ${THEIRS} * ${OURS} users:(("x",pid=${VICTIM},fd=1))`,
      " 31337 * 0",
      OUR_ROW,
    );
    expect(await check(system({ [PID]: evil, [VICTIM]: victim }, { ss }))).toEqual({
      check: "unverified",
      reason: "ss_unparsable",
    });
  });
  it("a well-formed forged row is not trusted either: inodes must be unique", async () => {
    const ss = ssText(
      LISTEN,
      THEIR_ROW(`("x",pid=${VICTIM},fd=1)`),
      `u_str ESTAB 0 0 * ${THEIRS} * ${OURS}`,
      OUR_ROW,
    );
    expect(await verdict(system({ [PID]: evil, [VICTIM]: victim }, { ss }))).toBe("unverified");
  });
  it("ss naming a victim while the kernel says another process holds the socket is no pass", async () => {
    const ss = ssText(LISTEN, THEIR_ROW(`("psyche-helper",pid=${VICTIM},fd=1)`), OUR_ROW);
    const procs = { [PID]: evil, [VICTIM]: { ...packaged, start: "9", fds: [] } };
    expect(await check(system(procs, { ss }))).toEqual({
      check: "unverified",
      reason: "ss_disagrees",
    });
  });
  it("a process name that breaks the row (quotes, parentheses) makes the answer unverified", async () => {
    const ss = ssText(LISTEN, THEIR_ROW('("a\\" ),(\\"b",pid=7,fd=1)'), OUR_ROW);
    expect(await verdict(system(only(packaged), { ss }))).toBe("unverified");
  });
  it("a client bound to a path with a space makes the answer unverified", async () => {
    const ss = ssText(
      LISTEN,
      `u_str ESTAB 0 0 /tmp/with space/c.sock ${THEIRS} * ${OURS} users:(("psyche-helper",pid=${PID},fd=3))`,
      OUR_ROW,
    );
    expect(await check(system(only(packaged), { ss }))).toEqual({
      check: "unverified",
      reason: "ss_unparsable",
    });
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
  it("a peer row that does not point back at our socket makes the answer unverified", async () => {
    const stray = `u_str ESTAB 0 0 * ${THEIRS} * 999 users:(("psyche-helper",pid=${PID},fd=3))`;
    const ss = ssText(LISTEN, stray, OUR_ROW);
    expect((await check(system(only(packaged), { ss }))).reason).toBe("peer_not_paired");
    const noOurRow = ssText(LISTEN, THEIR_ROW());
    expect((await check(system(only(packaged), { ss: noOurRow }))).reason).toBe(
      "socket_not_listed",
    );
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
  it("bounds time, and a missing descriptor is unverified", async () => {
    const slow: PeerCheckDeps = {
      ...system(only(packaged)),
      runSs: () => new Promise(() => {}),
    };
    expect(await linuxPeerChecker({ deps: slow, timeoutMs: 20 })(fake)).toEqual({
      check: "unverified",
      reason: "timeout",
    });
    const ok = (await linuxPeerChecker({ deps: system(only(packaged)) })(fake)) as PeerResult;
    expect(ok.check).toBe("root_owned");
    expect(await linuxPeerChecker({ deps: system(only(packaged)) })({} as never)).toEqual({
      check: "unverified",
      reason: "no_descriptor",
    });
  });
  it("a full queue answers busy without a lookup", async () => {
    const deps = system(only(packaged));
    const checker = linuxPeerChecker({
      deps: { ...deps, runSs: () => new Promise(() => {}) },
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
