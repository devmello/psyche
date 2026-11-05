import { getSetting } from "@psyche/db";
import type { PeerCheck } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_HELPER_STATUS_SETTING } from "../src/nodes/registry.ts";
import type { Gateway } from "../src/server.ts";
import {
  checkPeerOfFd,
  linuxPeerChecker,
  PACKAGED_ROOT,
  type PeerCheckDeps,
  parseSsUnix,
  socketInodeOf,
  startTimeOf,
} from "../src/transports/peer-check.ts";
import { FakeNode, type FakeNodeHandler } from "./fake-node.ts";
import { startTestGateway, type TestGateway } from "./helpers.ts";

/**
 * The Linux accept-time peer check (design §4.3): the parsers, the verdicts against a fixture
 * system, and the Gateway acting on a verdict (kind, status, refusal, pausing).
 */

const OURS = 1152354;
const THEIRS = 1147543;
const PID = 18156;

const SS = `Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port Process
u_str LISTEN 0 4096 /run/user/1000/psyche/node.sock 1147000 * 0 users:(("node",pid=900,fd=20))
u_str ESTAB 0 0 * ${THEIRS} * ${OURS} users:(("psyche-helper",pid=${PID},fd=3))
u_str ESTAB 0 0 /run/user/1000/psyche/node.sock ${OURS} * ${THEIRS} users:(("MainThread",pid=900,fd=22))
u_str ESTAB 0 0 * 5 * 6 users:(("weird )) name",pid=77,fd=4),("b",pid=78,fd=5))
garbage line
`;

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

/** A fixture system: files by path, processes by pid. */
function system(
  proc: Proc | undefined,
  opts: { ss?: string | Error; dirs?: Record<string, { uid: number; mode: number }> } = {},
): PeerCheckDeps & { calls: number } {
  const dirs = opts.dirs ?? {
    [PACKAGED_ROOT]: { uid: 0, mode: 0o040755 },
    "/usr/lib/psyche/resources": { uid: 0, mode: 0o040755 },
  };
  const state = { calls: 0 };
  const stat = (p: string) => {
    if (p === `/proc/${PID}/exe` && proc) {
      return { uid: proc.uid ?? 0, mode: proc.mode ?? 0o100755, dev: 1, ino: proc.ino ?? 10 };
    }
    if (proc?.exe === p) {
      return {
        uid: proc.uid ?? 0,
        mode: proc.mode ?? 0o100755,
        dev: 1,
        ino: proc.pathIno ?? proc.ino ?? 10,
      };
    }
    const d = dirs[p];
    if (d) return { ...d, dev: 1, ino: 99 };
    throw new Error(`ENOENT ${p}`);
  };
  return {
    get calls() {
      return state.calls;
    },
    async runSs() {
      state.calls++;
      const out = opts.ss ?? SS;
      if (out instanceof Error) throw out;
      return out;
    },
    async readlink(p) {
      if (p === "/proc/self/fd/22") return `socket:[${OURS}]`;
      if (p === `/proc/${PID}/exe` && proc?.exe) return proc.exe;
      const m = new RegExp(`^/proc/${PID}/fd/(\\d+)$`).exec(p);
      if (m && proc?.fds?.[Number(m[1])]) return proc.fds[Number(m[1])] as string;
      throw new Error(`ENOENT ${p}`);
    },
    async readdir(p) {
      if (p === `/proc/${PID}/fd` && proc?.fds) return proc.fds.map((_, i) => String(i));
      throw new Error(`EACCES ${p}`);
    },
    async readFile(p) {
      if (p === `/proc/${PID}/stat` && proc?.start) {
        return `${PID} (psyche-helper) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ${proc.start} 0`;
      }
      throw new Error(`ENOENT ${p}`);
    },
    async stat(p) {
      return stat(p);
    },
  };
}

const HELD = [`socket:[${THEIRS}]`];
const packaged: Proc = {
  start: "555",
  fds: HELD,
  exe: `${PACKAGED_ROOT}/resources/psyche-helper`,
  uid: 0,
};

describe("parsing ss and /proc", () => {
  it("reads rows, inodes and pids; skips what it cannot read", () => {
    const rows = parseSsUnix(SS);
    expect(rows).toContainEqual({ localInode: THEIRS, peerInode: OURS, pids: [PID] });
    expect(rows).toContainEqual({ localInode: OURS, peerInode: THEIRS, pids: [900] });
    // A process name with parentheses and quotes does not confuse the pid list.
    expect(rows).toContainEqual({ localInode: 5, peerInode: 6, pids: [77, 78] });
    expect(rows.every((r) => Number.isSafeInteger(r.localInode))).toBe(true);
  });
  it("reads socket inodes and start times", () => {
    expect(socketInodeOf("socket:[42]")).toBe(42);
    expect(socketInodeOf("/home/x/socket:[42]")).toBeUndefined();
    expect(socketInodeOf("pipe:[42]")).toBeUndefined();
    const stat = "123 (a b) c) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 0";
    expect(startTimeOf(stat)).toBe("987654");
    expect(startTimeOf("garbage")).toBeUndefined();
  });
});

describe("the verdict", () => {
  const verdict = (deps: PeerCheckDeps, fd: number | null = 22) =>
    checkPeerOfFd(fd ?? undefined, deps);

  it("root_owned: the packaged helper, root-owned, in root-owned directories", async () => {
    expect(await verdict(system(packaged))).toBe("root_owned");
  });
  it("user_owned: a helper binary the user owns (dev build, AppImage)", async () => {
    const dev = { ...packaged, exe: "/home/u/psyche/target/debug/psyche-helper", uid: 1000 };
    expect(await verdict(system(dev))).toBe("user_owned");
    const image = {
      ...packaged,
      exe: "/tmp/.mount_PsycheAB/usr/lib/psyche/psyche-helper",
      uid: 1000,
    };
    expect(await verdict(system(image))).toBe("user_owned");
  });
  it("mismatch: some other program", async () => {
    expect(await verdict(system({ ...packaged, exe: "/usr/bin/node", uid: 0 }))).toBe("mismatch");
    expect(await verdict(system({ ...packaged, exe: "/home/u/evil", uid: 1000 }))).toBe("mismatch");
  });
  it("never root_owned when anything about the package path is off", async () => {
    const loose = { ...packaged, mode: 0o100775 };
    expect(await verdict(system(loose))).toBe("unverified");
    // A user-writable directory on the way.
    const dirs = {
      [PACKAGED_ROOT]: { uid: 0, mode: 0o040755 },
      "/usr/lib/psyche/resources": { uid: 1000, mode: 0o040755 },
    };
    expect(await verdict(system(packaged, { dirs }))).toBe("unverified");
    const groupWritable = { ...dirs, "/usr/lib/psyche/resources": { uid: 0, mode: 0o040775 } };
    expect(await verdict(system(packaged, { dirs: groupWritable }))).toBe("unverified");
    // The path names another file than the one running (a mount over it).
    expect(await verdict(system({ ...packaged, pathIno: 11 }))).toBe("unverified");
    // Root-owned, named right, but outside the package.
    expect(await verdict(system({ ...packaged, exe: "/opt/x/psyche-helper" }))).toBe("unverified");
    // A look-alike path that only starts with the package name.
    expect(await verdict(system({ ...packaged, exe: "/usr/lib/psyche-evil/psyche-helper" }))).toBe(
      "unverified",
    );
    // The binary was replaced while running.
    expect(await verdict(system({ ...packaged, exe: `${packaged.exe} (deleted)` }))).toBe(
      "unverified",
    );
    // Not a regular file.
    expect(await verdict(system({ ...packaged, mode: 0o120755 }))).toBe("unverified");
  });
  it("unverified: it could not tell", async () => {
    expect(await verdict(system(packaged, { ss: new Error("no ss") }))).toBe("unverified");
    expect(await verdict(system(packaged), null)).toBe("unverified");
    expect(await verdict(system(packaged), -1)).toBe("unverified");
    expect(await verdict(system(packaged, { ss: "Netid\n" }))).toBe("unverified");
    // The peer already left: no process by that pid.
    expect(await verdict(system(undefined))).toBe("unverified");
    // The pid from ss does not hold the socket (pid reuse).
    expect(await verdict(system({ ...packaged, fds: ["socket:[1]"] }))).toBe("unverified");
    // Two holders of the socket.
    const shared = SS.replace(
      `("psyche-helper",pid=${PID},fd=3)`,
      `("a",pid=${PID},fd=3),("b",pid=5,fd=3)`,
    );
    expect(await verdict(system(packaged, { ss: shared }))).toBe("unverified");
    // Unreadable /proc/<pid> (another user's process).
    expect(await verdict(system({ start: "1", exe: packaged.exe }))).toBe("unverified");
  });
  it("unverified: a different process after the lookups (start time changes)", async () => {
    const deps = system(packaged);
    let reads = 0;
    const base = deps.readFile.bind(deps);
    deps.readFile = async (p) => {
      reads++;
      const text = await base(p);
      return reads > 1 ? text.replace(" 555 ", " 556 ") : text;
    };
    expect(await checkPeerOfFd(22, deps)).toBe("unverified");
  });
  it("the checker bounds time and queue and never passes on failure", async () => {
    const slow: PeerCheckDeps = { ...system(packaged), runSs: () => new Promise(() => {}) };
    const fake = { _handle: { fd: 22 } } as never;
    expect(await linuxPeerChecker({ deps: slow, timeoutMs: 20 })(fake)).toBe("unverified");
    expect(await linuxPeerChecker({ deps: system(packaged) })(fake)).toBe("root_owned");
    // No descriptor on the handle: unverified.
    expect(await linuxPeerChecker({ deps: system(packaged) })({} as never)).toBe("unverified");
    // Queue full: unverified without a lookup.
    const deps = system(packaged);
    const check = linuxPeerChecker({
      deps: { ...deps, runSs: () => new Promise(() => {}) },
      timeoutMs: 200,
      concurrency: 1,
      maxQueue: 0,
    });
    const first = check(fake);
    expect(await check(fake)).toBe("unverified");
    expect(await first).toBe("unverified");
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

async function startWith(check: () => Promise<PeerCheck>): Promise<Gateway> {
  t = await startTestGateway({ peerChecker: async () => check() });
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
    it(`${verdict}: a linux-helper with the secret is the Host helper, stored as host-helper, and the status says so`, async () => {
      const g = await startWith(async () => verdict);
      const n = await helper(g);
      expect(g.context.nodes.list().find((x) => x.id === n.nodeId)?.kind).toBe("host-helper");
      expect(g.context.nodes.isHostHelper(n.nodeId)).toBe(true);
      expect(g.context.nodes.hostHelper()?.info.id).toBe(n.nodeId);
      expect(statusOf(g)).toEqual({ ambiguous: false, helpers: 1, peerCheck: verdict });
      await n.close();
      expect(statusOf(g)).toEqual({ ambiguous: false, helpers: 0 });
    });
  }

  it("mismatch: refused, never a helper, whatever it presents", async () => {
    const g = await startWith(async () => "mismatch");
    await expect(helper(g)).rejects.toThrow(/not the Linux helper of this computer/);
    expect(g.context.nodes.hostHelpers()).toEqual([]);
  });

  it("a checker that throws is unverified, not a pass and not a crash", async () => {
    const g = await startWith(async () => {
      throw new Error("boom");
    });
    const n = await helper(g);
    expect(statusOf(g)?.peerCheck).toBe("unverified");
    expect(g.context.nodes.isHostHelper(n.nodeId)).toBe(true);
  });

  it("on a checked socket only the linux-helper family can be the Host helper", async () => {
    const g = await startWith(async () => "root_owned");
    for (const family of ["mac-helper", "win-helper"]) {
      await expect(helper(g, family)).rejects.toThrow(/not the Linux helper of this computer/);
    }
    expect(g.context.nodes.hostHelpers()).toEqual([]);
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
    t = await startTestGateway();
    const g = t.gateway;
    const n = await helper(g);
    expect(g.context.nodes.isHostHelper(n.nodeId)).toBe(true);
    expect(statusOf(g)?.peerCheck).toBeUndefined();
  });
});
