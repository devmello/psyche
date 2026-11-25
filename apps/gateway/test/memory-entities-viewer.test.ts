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

const call = (identity: Record<string, unknown>): Call => ({ identity }) as unknown as Call;
const WRITE = ["operator.read", "operator.write"];
const dev = (id: string, platform: string, family: string | null, extra = {}): EntityDeviceFacts =>
  ({ platform, family, paired: true, revoked: false, ...extra }) as EntityDeviceFacts;
const DEVICES: Record<string, EntityDeviceFacts> = {
  dev_ios: dev("dev_ios", "ios", "ios"),
  dev_mac: dev("dev_mac", "macos", "desktop"),
  dev_web: dev("dev_web", "web", "web"),
  dev_webfam: dev("dev_webfam", "macos", "web"),
  dev_ro: dev("dev_ro", "ios", "ios"),
  dev_pending: dev("dev_pending", "ios", "ios", { paired: false }),
  dev_revoked: dev("dev_revoked", "ios", "ios", { revoked: true }),
  dev_nofamily: dev("dev_nofamily", "ios", null),
};
const MUST_PASS = [
  ["desktop shell", call({ role: "client", desktopShell: true })],
  ["Host CLI", call({ role: "client", localHostCli: true })],
  ["iOS phone", call({ role: "client", deviceId: "dev_ios", scopes: WRITE })],
  ["remote Mac", call({ role: "client", deviceId: "dev_mac", scopes: WRITE })],
  [
    "remote Mac admin",
    call({ role: "client", deviceId: "dev_mac", scopes: ["operator.read", "operator.admin"] }),
  ],
] as const;
const MUST_REFUSE = [
  ["web shell", call({ role: "client", deviceId: "dev_web", scopes: WRITE }), "web_shell"],
  ["web family", call({ role: "client", deviceId: "dev_webfam", scopes: WRITE }), "web_shell"],
  [
    "read-only device",
    call({ role: "client", deviceId: "dev_ro", scopes: ["operator.read"] }),
    "not_desktop",
  ],
  [
    "pairing-pending",
    call({ role: "client", deviceId: "dev_pending", scopes: WRITE }),
    "not_desktop",
  ],
  ["revoked", call({ role: "client", deviceId: "dev_revoked", scopes: WRITE }), "not_desktop"],
  [
    "device with no family",
    call({ role: "client", deviceId: "dev_nofamily", scopes: WRITE }),
    "not_desktop",
  ],
  [
    "unpaired (unknown id)",
    call({ role: "client", deviceId: "dev_x", scopes: WRITE }),
    "not_desktop",
  ],
  ["no device id", call({ role: "client", scopes: WRITE }), "not_desktop"],
  [
    "designated person / node",
    call({ role: "node", deviceId: "dev_ios", scopes: WRITE }),
    "not_desktop",
  ],
] as const;

const NAMES = Object.keys(Methods).filter((n) => n.startsWith("memory.entities."));

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
    expect(NAMES.length).toBeGreaterThanOrEqual(19);
    for (const n of ["create", "update", "merge", "forget", "split", "facts.set", "edges.set"])
      expect(NAMES).toContain(`memory.entities.${n}`);
  });

  for (const name of NAMES) {
    for (const [who, c] of MUST_PASS)
      it(`${name}: ${who} passes`, async () => {
        const { go, run } = build();
        await expect(go(name, c)).resolves.toEqual({ ok: true });
        expect(run).toHaveBeenCalledTimes(1);
      });
    for (const [who, c, reason] of MUST_REFUSE)
      it(`${name}: ${who} is refused and nothing runs`, async () => {
        const { go, run } = build();
        await expect(go(name, c)).rejects.toMatchObject({
          code: "forbidden",
          details: { reason },
        });
        expect(run).not.toHaveBeenCalled();
      });
  }

  it("leaves other methods alone (memory.loops.list still reaches a read-only device)", async () => {
    const { go, run } = build();
    await go("memory.loops.list", MUST_REFUSE[2][1]);
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
  platform: "ios" | "web",
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
  it("the phone creates and reads a person; the web shell is refused", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-entviewer-"));
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    const phone = await pairedDevice(composed.gateway, "ios", "ios");
    const web = await pairedDevice(composed.gateway, "web", "web");
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
