import { existsSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { getDevice, listDevices } from "@psyche/db";
import { afterEach, describe, expect, it } from "vitest";
import { GUEST_NODE_KIND } from "../src/nodes/registry.ts";
import { GuestSockets } from "../src/nodes/guest-sockets.ts";
import { FakeNode, type FakeNodeHandler, pairNodeDevice } from "./fake-node.ts";
import { newDeviceKey, startTestGateway, type TestGateway } from "./helpers.ts";

/**
 * The per-container guest socket of a separate desktop: who can pair on it, as what, and what
 * closing it does. The Gateway side of docs/design/linux-desktop-2026.md §8.3.
 */

let t: TestGateway | null = null;
let guests: GuestSockets | null = null;
const nodes: FakeNode[] = [];

afterEach(async () => {
  for (const n of nodes.splice(0)) await n.close().catch(() => undefined);
  guests?.closeAll();
  guests = null;
  await t?.cleanup();
  t = null;
});

const CAPS: FakeNodeHandler[] = ["computer.ax_tree", "dictation.target", "notify.show"].map(
  (name) => ({
    capability: { name, sideEffect: "read" as const, streaming: false },
    run: () => ({ who: name }),
  }),
);

async function start(opts: { now?: () => number } = {}) {
  t = await startTestGateway();
  guests = new GuestSockets({
    ctx: t.gateway.context,
    home: t.home,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { g: t.gateway, guests };
}

async function pairWith(
  socketPath: string,
  token: string | undefined,
  over: { family?: string; deviceId?: string; origin: string },
): Promise<FakeNode> {
  const n = await FakeNode.connect(socketPath, {
    origin: over.origin,
    handlers: CAPS,
    key: newDeviceKey(),
    deviceId: over.deviceId ?? `guest-${Math.random().toString(36).slice(2)}`,
    deviceFamily: over.family ?? "linux-helper",
    ...(token === undefined ? {} : { secret: token }),
  });
  nodes.push(n);
  return n;
}

describe("a separate desktop's socket", () => {
  it("is mode 0600, named for the container, and gone when closed", async () => {
    const { guests } = await start();
    const { socketPath } = await guests.open("main");
    expect(socketPath).toMatch(/run\/guest-main\.sock$/);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    guests.close("main");
    expect(existsSync(socketPath)).toBe(false);
  });

  it("pairs the helper with this container's token, as a guest bound to the container", async () => {
    const { g, guests } = await start();
    const { socketPath, token } = await guests.open("main");
    expect(guests.clientFor("main")).toBeUndefined();
    const n = await pairWith(socketPath, token, { origin: g.origin });
    const info = g.context.nodes.list().find((x) => x.id === n.nodeId);
    expect(info?.kind).toBe(GUEST_NODE_KIND);
    expect(g.context.nodes.transportOf(n.nodeId)).toBe("container-guest");
    expect(guests.clientFor("main")?.nodeId).toBe(n.nodeId);
    expect(guests.isGuestNode(n.nodeId)).toBe(true);
    // The Gateway names the device and gives it the node scope only.
    const dev = getDevice(g.context.db, info?.deviceId ?? "");
    expect(dev?.name).toBe("Separate desktop (main)");
    expect(dev?.scopes).toEqual(["node"]);
    // And the call goes through.
    const r = await guests.clientFor("main")?.invoke("computer.ax_tree", {});
    expect(r).toMatchObject({ ok: true });
  });

  it("refuses a missing, wrong or empty token", async () => {
    const { g, guests } = await start();
    const { socketPath, token } = await guests.open("main");
    for (const bad of [undefined, "x".repeat(43), `${token}x`, token.slice(1)]) {
      await expect(pairWith(socketPath, bad, { origin: g.origin })).rejects.toThrow(/did not pair/);
    }
    // An empty one never even gets a challenge.
    await expect(pairWith(socketPath, "", { origin: g.origin })).rejects.toThrow();
    // The right one still works afterwards (four bad tries so far, under the limit).
    await pairWith(socketPath, token, { origin: g.origin });
  });

  it("closes the socket after five wrong tokens", async () => {
    const { g, guests } = await start();
    const { socketPath, token } = await guests.open("main");
    for (let i = 0; i < 5; i++) {
      await expect(pairWith(socketPath, "nope", { origin: g.origin })).rejects.toThrow(
        /did not pair/,
      );
    }
    await new Promise((r) => setTimeout(r, 120));
    expect(guests.isOpen("main")).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
    expect(guests.clientFor("main")).toBeUndefined();
    expect(token.length).toBeGreaterThan(0);
  });

  it("a token works once: a second helper with the same token is refused", async () => {
    const { g, guests } = await start();
    const { socketPath, token } = await guests.open("main");
    await pairWith(socketPath, token, { origin: g.origin });
    await expect(pairWith(socketPath, token, { origin: g.origin })).rejects.toThrow(/did not pair/);
  });

  it("the same identity cannot pair again, even with a token", async () => {
    const { g, guests } = await start();
    const { socketPath } = await guests.open("main");
    const key = newDeviceKey();
    pairNodeDevice(g, "old-guest", key);
    const { token } = await guests.open("main");
    await expect(
      FakeNode.connect(socketPath, {
        origin: g.origin,
        handlers: CAPS,
        key,
        deviceId: "old-guest",
        secret: token,
      }),
    ).rejects.toThrow(/did not pair/);
  });

  it("another container's token does not work here, and neither does a restarted container's old one", async () => {
    const { g, guests } = await start();
    const a = await guests.open("aaa");
    const b = await guests.open("bbb");
    await expect(pairWith(b.socketPath, a.token, { origin: g.origin })).rejects.toThrow(
      /did not pair/,
    );
    await expect(pairWith(a.socketPath, b.token, { origin: g.origin })).rejects.toThrow(
      /did not pair/,
    );
    const again = await guests.open("aaa");
    expect(again.token).not.toBe(a.token);
    await expect(pairWith(again.socketPath, a.token, { origin: g.origin })).rejects.toThrow(
      /did not pair/,
    );
    await pairWith(again.socketPath, again.token, { origin: g.origin });
    expect(guests.clientFor("bbb")).toBeUndefined();
  });

  it("a token expires", async () => {
    let now = 1_000_000;
    const { g, guests } = await start({ now: () => now });
    const { socketPath, token } = await guests.open("main");
    now += 121_000;
    await expect(pairWith(socketPath, token, { origin: g.origin })).rejects.toThrow(/did not pair/);
  });

  it("whatever family the guest declares, it is never the Host's helper", async () => {
    const { g, guests } = await start();
    for (const [i, family] of [
      "mac-helper",
      "win-helper",
      "linux-helper",
      "host-helper",
    ].entries()) {
      const id = `fam${i}`;
      const { socketPath, token } = await guests.open(id);
      const n = await pairWith(socketPath, token, { origin: g.origin, family });
      expect(g.context.nodes.isHostHelper(n.nodeId)).toBe(false);
      expect(g.context.nodes.hostHelper()).toBeUndefined();
      expect(g.context.nodes.hostHelper("computer.ax_tree")).toBeUndefined();
      expect(g.context.nodes.hostHelpers()).toEqual([]);
      expect(g.context.nodes.list().find((x) => x.id === n.nodeId)?.kind).toBe(GUEST_NODE_KIND);
    }
  });

  it("the token is no way onto the Gateway's own sockets", async () => {
    const { g, guests } = await start();
    const { token } = await guests.open("main");
    for (const path of [
      g.config.nodeSocketPath,
      ...(g.config.guestSocketPath ? [g.config.guestSocketPath] : []),
    ]) {
      for (const family of ["linux-helper", "mac-helper", "vm-guest", "psyche-node"]) {
        await expect(
          FakeNode.connect(path, {
            origin: g.origin,
            handlers: CAPS,
            secret: token,
            deviceFamily: family,
          }),
        ).rejects.toThrow();
      }
    }
    expect(g.context.nodes.hostHelper()).toBeUndefined();
  });

  it("a node paired elsewhere is never returned for a container, even if it declares a guest family", async () => {
    const { g, guests } = await start();
    await guests.open("main");
    const other = await FakeNode.connectRemote(g, { handlers: CAPS, deviceFamily: "vm-guest" });
    nodes.push(other);
    expect(guests.clientFor("main")).toBeUndefined();
    expect(guests.isGuestNode(other.nodeId)).toBe(false);
  });

  it("closing revokes the device, drops the connection and voids the token", async () => {
    const { g, guests } = await start();
    const { socketPath, token } = await guests.open("main");
    const n = await pairWith(socketPath, token, { origin: g.origin });
    const deviceId = g.context.nodes.list().find((x) => x.id === n.nodeId)?.deviceId ?? "";
    guests.close("main");
    expect(guests.clientFor("main")).toBeUndefined();
    expect(getDevice(g.context.db, deviceId)?.revokedAt).not.toBeNull();
    expect(listDevices(g.context.db).some((d) => d.id === deviceId)).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(g.context.nodes.isLive(n.nodeId)).toBe(false);
    await expect(
      new Promise((resolve, reject) => {
        const s = createConnection(socketPath);
        s.once("connect", resolve);
        s.once("error", reject);
      }),
    ).rejects.toThrow();
  });

  it("opening again forgets the previous start's revoked identity", async () => {
    const { g, guests } = await start();
    const first = await guests.open("main");
    const n = await pairWith(first.socketPath, first.token, { origin: g.origin });
    const deviceId = g.context.nodes.list().find((x) => x.id === n.nodeId)?.deviceId ?? "";
    await guests.open("main");
    expect(getDevice(g.context.db, deviceId)).toBeUndefined();
  });

  it("revokeStale revokes helpers left by a Gateway that crashed", async () => {
    const { g, guests } = await start();
    const { socketPath, token } = await guests.open("main");
    const n = await pairWith(socketPath, token, { origin: g.origin });
    const deviceId = g.context.nodes.list().find((x) => x.id === n.nodeId)?.deviceId ?? "";
    const fresh = new GuestSockets({ ctx: g.context, home: t?.home ?? "" });
    expect(fresh.revokeStale()).toBe(1);
    expect(getDevice(g.context.db, deviceId)?.revokedAt).not.toBeNull();
  });

  it("refuses ids that could escape the run folder", async () => {
    const { guests } = await start();
    for (const bad of ["../x", "a/b", "A", "", "x".repeat(17)]) {
      await expect(guests.open(bad)).rejects.toThrow();
    }
  });
});
