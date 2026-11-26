import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertDevice } from "@psyche/db";
import { Methods } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { type EntityDeviceFacts, gateMemoryEntities } from "../src/compose/memory-chunks.ts";
import type { Call, HandlerDef } from "../src/context.ts";
import { silentLogger } from "../src/log.ts";
import { handshake, ik, newDeviceKey, TestClient, wsUrlOf } from "./helpers.ts";

/**
 * Every `memory.entities.*` method is the desktop app and Host CLI only (owner rule: remote
 * viewers cannot open Memory). One row per method and caller: must-refuse (phone, remote Mac,
 * web viewer, read-only, unpaired) and must-pass (desktop shell, Host CLI).
 */

const call = (identity: Record<string, unknown>, origin: string | null = null, peer = true): Call =>
  ({ identity, ...(peer ? { conn: { peer: { origin } } } : {}) }) as unknown as Call;
const WRITE = ["operator.read", "operator.write"];
const dev = (platform: string, family: string | null, extra = {}): EntityDeviceFacts =>
  ({ platform, family, paired: true, revoked: false, ...extra }) as EntityDeviceFacts;
const DEVICES: Record<string, EntityDeviceFacts> = {
  dev_ios: dev("ios", "ios"),
  dev_mac: dev("macos", "desktop"),
  dev_web: dev("web", "web"),
  dev_webfam: dev("macos", "web"),
  dev_ro: dev("ios", "ios"),
  dev_pending: dev("ios", "ios", { paired: false }),
  dev_revoked: dev("ios", "ios", { revoked: true }),
  dev_oldmac: dev("macos", null), // paired before the family column existed
  dev_oldios: dev("ios", null),
  dev_toaster: dev("ios", "toaster"),
  dev_cli: dev("macos", "cli"),
};
const client = (deviceId: string, extra: Record<string, unknown> = {}) => ({
  role: "client",
  deviceId,
  scopes: WRITE,
  ...extra,
});
/** `remote` rows are paired devices: `memory.entities.export` is the desktop and Host CLI only. */
const MUST_PASS = [
  ["desktop shell", call({ role: "client", desktopShell: true }), false],
  ["Host CLI", call({ role: "client", localHostCli: true }), false],
  ["iOS phone", call(client("dev_ios")), true],
  ["remote Mac", call(client("dev_mac")), true],
  [
    "remote Mac admin",
    call(client("dev_mac", { scopes: ["operator.read", "operator.admin"] })),
    true,
  ],
  ["remote Mac paired before families (null, macos)", call(client("dev_oldmac")), true],
] as const;
const MUST_REFUSE = [
  ["web shell (family web)", call(client("dev_web")), "web_shell"],
  ["web platform with a native family", call(client("dev_webfam")), "web_shell"],
  ["Origin present, family ios", call(client("dev_ios"), "https://evil.example"), "web_shell"],
  ["Origin present, family desktop", call(client("dev_mac"), "http://localhost:5173"), "web_shell"],
  ["family toaster", call(client("dev_toaster")), "not_desktop"],
  ["family cli (remote, not the Host CLI)", call(client("dev_cli")), "not_desktop"],
  ["null family on a non-macOS platform", call(client("dev_oldios")), "not_desktop"],
  ["null family with an Origin", call(client("dev_oldmac"), "https://evil.example"), "web_shell"],
  ["no peer record", call(client("dev_ios"), null, false), "not_desktop"],
  ["read-only device", call(client("dev_ro", { scopes: ["operator.read"] })), "not_desktop"],
  ["pairing-pending", call(client("dev_pending")), "not_desktop"],
  ["revoked", call(client("dev_revoked")), "not_desktop"],
  ["unpaired (unknown id)", call(client("dev_x")), "not_desktop"],
  ["no device id", call({ role: "client", scopes: WRITE }), "not_desktop"],
  [
    "designated person / node",
    call({ role: "node", deviceId: "dev_ios", scopes: WRITE }),
    "not_desktop",
  ],
] as const;

/** Also gated: the graph's map and admin writes, and the anchors (not `memory.loops.*`). */
const EXTRA = [
  "memory.graph.map",
  "memory.graph.forgetAll",
  "memory.graph.deleteSource",
  "memory.graph.blocklist.list",
  "memory.graph.blocklist.add",
  "memory.graph.blocklist.remove",
  "memory.anchors.list",
  "memory.anchors.add",
  "memory.anchors.remove",
];
const NAMES = [...Object.keys(Methods).filter((n) => n.startsWith("memory.entities.")), ...EXTRA];
const DESKTOP_ONLY = "memory.entities.export";

type Run = (c: Call, p: unknown) => Promise<unknown>;

function build() {
  const run = vi.fn(async () => ({ ok: true }));
  const handlers: Record<string, HandlerDef> = {};
  for (const n of NAMES) handlers[n] = { run } as unknown as HandlerDef;
  handlers["memory.loops.list"] = { run } as unknown as HandlerDef;
  gateMemoryEntities(handlers, (id) => DEVICES[id]);
  const go = (name: string, c: Call) => (handlers[name] as unknown as { run: Run }).run(c, {});
  return { run, go };
}

describe("memory.entities.* per connection (handlers)", () => {
  it("covers every method the protocol declares (guards the table)", () => {
    expect(NAMES.length).toBeGreaterThanOrEqual(28);
    for (const n of ["create", "update", "merge", "forget", "split", "facts.set", "edges.set"])
      expect(NAMES).toContain(`memory.entities.${n}`);
  });

  for (const name of NAMES) {
    for (const [who, c, remote] of MUST_PASS) {
      if (remote && name === DESKTOP_ONLY) {
        it(`${name}: ${who} is refused (desktop and Host CLI only)`, async () => {
          const { go, run } = build();
          await expect(go(name, c)).rejects.toMatchObject({
            code: "forbidden",
            details: { reason: "not_desktop" },
          });
          expect(run).not.toHaveBeenCalled();
        });
        continue;
      }
      it(`${name}: ${who} passes`, async () => {
        const { go, run } = build();
        await expect(go(name, c)).resolves.toEqual({ ok: true });
        expect(run).toHaveBeenCalledTimes(1);
      });
    }
    for (const [who, c, reason] of MUST_REFUSE)
      it(`${name}: ${who} is refused and nothing runs`, async () => {
        const { go, run } = build();
        await expect(go(name, c)).rejects.toMatchObject({
          code: "forbidden",
          details: { reason: name === DESKTOP_ONLY ? expect.any(String) : reason },
        });
        expect(run).not.toHaveBeenCalled();
      });
  }

  it("leaves other methods alone (memory.loops.list still reaches a read-only device)", async () => {
    const { go, run } = build();
    await go("memory.loops.list", MUST_REFUSE[9][1]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

/** A paired device of this family and platform with write scope, as pairing leaves it. */
async function pairedDevice(
  gw: ComposedGateway["gateway"],
  family: string,
  platform: "ios" | "macos",
): Promise<TestClient> {
  const key = newDeviceKey();
  const deviceId = `${family}-${Math.random().toString(36).slice(2)}`;
  insertDevice(gw.context.db, {
    id: deviceId,
    name: `${family} device`,
    platform,
    role: "client",
    publicKey: key.publicKey,
    scopes: ["operator.read", "operator.write"],
    pairedAt: new Date().toISOString(),
    deviceFamily: family,
  });
  const c = await TestClient.open(wsUrlOf(gw));
  const r = await handshake(c, gw.origin, { key, deviceId, deviceFamily: family, platform });
  expect((r.verifyRes?.payload as { phase?: string } | undefined)?.phase).toBe("paired");
  return c;
}

describe("memory.entities.* through the composed Gateway", () => {
  it("the phone creates and reads a person; a web-family device is refused", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-entviewer-"));
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db") },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    const phone = await pairedDevice(composed.gateway, "ios", "ios");
    // The `web` platform can no longer connect, so the browser shell is a web-family Mac row.
    const web = await pairedDevice(composed.gateway, "web", "macos");
    clients.push(phone, web);
    const made = await phone.request(
      "memory.entities.create",
      { kind: "person", name: "Dana Whitfield" },
      ik(),
    );
    expect(made.ok).toBe(true);
    const id = (made.payload as { entity: { id: string } }).entity.id;
    const read = await phone.request("memory.entities.get", { id }, ik());
    expect(read.ok).toBe(true);
    for (const [method, params] of [
      ["memory.entities.create", { kind: "person", name: "Sam Rivera" }],
      ["memory.entities.get", { id }],
    ] as const) {
      const res = await web.request(method, params, ik());
      expect(res.ok, method).toBe(false);
      const err = res.error as { code: string; details?: { reason?: string } };
      expect(err.code, method).toBe("forbidden");
      expect(err.details?.reason, method).toBe("web_shell");
    }
  });
});
