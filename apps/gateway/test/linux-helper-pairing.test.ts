import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting } from "@psyche/db";
import type { NodeClient } from "@psyche/protocol";
import { describeHostHelperConformance, LINUX_HELPER_L3_SPEC } from "@psyche/testing/conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOST_HELPER_STATUS_SETTING } from "../src/nodes/registry.ts";
import { linuxPeerChecker } from "../src/transports/peer-check.ts";
import { FakeNode } from "./fake-node.ts";
import { startTestGateway, type TestGateway, wsUrlOf } from "./helpers.ts";

/**
 * The real Rust helper (`apps/linux-helper`) against a real Gateway node socket, with the real
 * Linux peer check. Runs only on Linux and only when `PSYCHE_LINUX_HELPER_BIN` names the built
 * `psyche-helper`; `scripts/ci/linux-helper-conformance.sh` builds it and sets that. It proves:
 * the helper pairs by itself over `node.sock` as a `host-helper` with the handshake secret; the
 * accept-time peer check saw the helper binary; the host-helper conformance profile passes
 * against it; and a helper without the secret, another program claiming `linux-helper`, and a
 * `linux-helper` on the wrong transport are refused or `remote`.
 */

const BIN = process.env.PSYCHE_LINUX_HELPER_BIN;
const enabled = process.platform === "linux" && BIN !== undefined && existsSync(BIN);

const nodeIdOf = (g: TestGateway["gateway"]) => g.context.nodes.hostHelpers()[0]?.info.id;

async function until<T>(what: string, read: () => T | undefined, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!enabled)("the Linux helper pairs with a real Gateway", () => {
  let t: TestGateway;
  let dirs: string[] = [];
  const children: ChildProcess[] = [];

  const tmp = (prefix: string) => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  };

  /** The helper with its own state and HOME, pointed at a Gateway home (and so its secret). */
  const spawnHelper = (env: Record<string, string>): ChildProcess => {
    const state = tmp("psyche-helper-state-");
    const child = spawn(BIN as string, ["--idle-timeout", "0"], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: state,
        PSYCHE_HELPER_STATE: join(state, "state"),
        ...env,
      },
      stdio: "ignore",
    });
    children.push(child);
    return child;
  };

  beforeAll(async () => {
    t = await startTestGateway({ peerChecker: linuxPeerChecker() });
    spawnHelper({ PSYCHE_HOME: t.home });
    await until("the helper to pair", () => nodeIdOf(t.gateway));
  }, 30000);

  afterAll(async () => {
    for (const c of children) c.kill("SIGKILL");
    await t?.cleanup();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  it("pairs by itself over node.sock as the Host helper, stored as host-helper", () => {
    const { gateway } = t;
    const id = nodeIdOf(gateway) as string;
    expect(gateway.context.nodes.list().find((n) => n.id === id)?.kind).toBe("host-helper");
    expect(gateway.context.nodes.isHostHelper(id)).toBe(true);
    expect(gateway.context.nodes.transportOf(id)).toBe("unix");
    const device = t.gateway.context.db.sqlite
      .prepare("SELECT platform, role, scopes, device_family FROM devices WHERE id = ?")
      .get(gateway.context.nodes.hostHelpers()[0]?.info.deviceId);
    expect(device).toEqual({
      platform: "linux",
      role: "node",
      scopes: '["node"]',
      device_family: "linux-helper",
    });
  });

  it("the peer check saw the helper binary and recorded it in the status", () => {
    const status = getSetting(t.gateway.context.db, HOST_HELPER_STATUS_SETTING)?.value as {
      peerCheck?: string;
      helpers: number;
    };
    expect(status.helpers).toBe(1);
    // A build tree is not the packaged, root-owned helper. Run as root, the file is root-owned
    // outside /usr/lib/psyche, which cannot be vouched for.
    expect(status.peerCheck).toBe(process.getuid?.() === 0 ? "unverified" : "user_owned");
  });

  describeHostHelperConformance(
    "the Rust linux-helper (L3)",
    () => {
      const client = t.gateway.context.nodes.client(nodeIdOf(t.gateway) as string);
      if (client === undefined) throw new Error("helper not connected");
      return client satisfies NodeClient;
    },
    LINUX_HELPER_L3_SPEC,
  );

  it("a helper without the handshake secret is refused and never pairs", async () => {
    const before = t.gateway.context.db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM devices")
      .get() as { n: number };
    // Its own (empty) home: no run/handshake.secret to read; it dials this Gateway's socket.
    spawnHelper({
      PSYCHE_HOME: tmp("psyche-nohome-"),
      PSYCHE_NODE_SOCKET: t.gateway.config.nodeSocketPath,
    });
    await new Promise((r) => setTimeout(r, 2000));
    const after = t.gateway.context.db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM devices")
      .get() as {
      n: number;
    };
    expect(after.n).toBe(before.n);
    expect(t.gateway.context.nodes.hostHelpers()).toHaveLength(1);
  });

  it("another program claiming linux-helper with the right secret is refused: the peer check says mismatch", async () => {
    // This test process is `node`, not psyche-helper.
    await expect(
      FakeNode.connect(t.gateway.config.nodeSocketPath, {
        origin: t.gateway.origin,
        secret: t.gateway.handshakeSecret,
        handlers: [],
        deviceFamily: "linux-helper",
      }),
    ).rejects.toThrow(/not the Linux helper of this computer/);
    expect(t.gateway.context.nodes.hostHelpers()).toHaveLength(1);
  });

  it("a linux-helper on the wrong transport (the WebSocket) is remote, even with the secret", async () => {
    const n = await FakeNode.connectWs(wsUrlOf(t.gateway), {
      origin: t.gateway.origin,
      secret: t.gateway.handshakeSecret,
      handlers: [],
      deviceFamily: "linux-helper",
    });
    try {
      expect(t.gateway.context.nodes.list().find((x) => x.id === n.nodeId)?.kind).toBe("remote");
      expect(t.gateway.context.nodes.isHostHelper(n.nodeId)).toBe(false);
      expect(t.gateway.context.nodes.hostHelpers()).toHaveLength(1);
    } finally {
      await n.close();
    }
  });
});
