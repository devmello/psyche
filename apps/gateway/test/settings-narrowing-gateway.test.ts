import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting, setSetting, updateDevice } from "@psyche/db";
import type { PresenceVerifier } from "@psyche/permissions";
import type { DeviceScope } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { desktopClient, ik, newDeviceKey, type TestClient } from "./helpers.ts";

/**
 * A security-setting change that only narrows what the agent may do applies at once from an
 * admin device: no card, but the same admin requirement, the seal and an audit row. A widening or
 * mixed change still raises the card.
 */

const clients: TestClient[] = [];
let composed: ComposedGateway | null = null;
let home = "";

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed?.gateway.context.db.close();
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

const touchId: PresenceVerifier = {
  verify: async (assertion, challenge) => assertion.signature === `signed:${challenge}`,
};
const DEVICE = "admin-narrowing";
const ADMIN: DeviceScope[] = [
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.admin",
];

async function boot() {
  home = mkdtempSync(join(tmpdir(), "psyche-narrowing-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    presence: touchId,
  });
  const key = newDeviceKey();
  (await desktopClient(composed.gateway, key, DEVICE)).close();
  const db = composed.gateway.context.db;
  updateDevice(db, DEVICE, { scopes: ADMIN });
  const admin = await desktopClient(composed.gateway, key, DEVICE);
  clients.push(admin);
  const seed = (k: string, v: unknown) => setSetting(db, k, v);
  const stored = (k: string) => getSetting(db, k)?.value;
  return { key, db, admin, seed, stored };
}

const set = (c: TestClient, key: string, value: unknown) =>
  c.request("settings.set", { key, value }, ik());
const carded = (res: unknown) =>
  expect(res).toMatchObject({ ok: false, error: { code: "approval_required" } });

const FOLDERS = {
  folders: [
    { path: "/a", mode: "rw" },
    { path: "/b", mode: "ro" },
  ],
};

describe("narrowing security settings skip the card", () => {
  it("folder policy: removal and rw to ro apply at once; adding or ro to rw raises the card", async () => {
    const { admin, seed, stored } = await boot();
    seed("permissions.policy", FOLDERS);

    const narrowed = { folders: [{ path: "/a", mode: "ro" }] };
    expect(await set(admin, "permissions.policy", narrowed)).toMatchObject({ ok: true });
    expect(stored("permissions.policy")).toEqual(narrowed);

    // Positive control: widening the same setting still raises the card, and writes nothing.
    carded(await set(admin, "permissions.policy", FOLDERS));
    carded(await set(admin, "permissions.policy", { folders: [{ path: "/a", mode: "rw" }] }));
    expect(stored("permissions.policy")).toEqual(narrowed);
  });

  it("a mixed change (one folder removed, one made rw) raises the card", async () => {
    const { admin, seed, stored } = await boot();
    seed("permissions.policy", FOLDERS);
    carded(await set(admin, "permissions.policy", { folders: [{ path: "/b", mode: "rw" }] }));
    expect(stored("permissions.policy")).toEqual(FOLDERS);
  });

  it("computer use: off and a lower tier apply at once; on and a higher tier need the card", async () => {
    const { admin, seed, stored } = await boot();
    seed("computerUse.enabled", true);
    seed("computerUse.apps", [{ id: "com.apple.Notes", name: "Notes", tier: "interact" }]);

    expect(
      await set(admin, "computerUse.apps", [
        { id: "com.apple.Notes", name: "Notes", tier: "read" },
      ]),
    ).toMatchObject({ ok: true });
    expect(await set(admin, "computerUse.enabled", false)).toMatchObject({ ok: true });
    expect(stored("computerUse.enabled")).toBe(false);

    carded(await set(admin, "computerUse.enabled", true));
    carded(
      await set(admin, "computerUse.apps", [
        { id: "com.apple.Notes", name: "Notes", tier: "click" },
      ]),
    );
    expect(stored("computerUse.enabled")).toBe(false);
  });

  it("connector matrix toward deny applies at once; toward allow needs the card", async () => {
    const { admin, seed, stored } = await boot();
    seed("permissions.connectors.gmail", { send: "ask", read: "allow" });
    expect(
      await set(admin, "permissions.connectors.gmail", { send: "deny", read: "ask" }),
    ).toMatchObject({ ok: true });
    carded(await set(admin, "permissions.connectors.gmail", { send: "ask", read: "ask" }));
    expect(stored("permissions.connectors.gmail")).toEqual({ send: "deny", read: "ask" });
  });

  it("channel allowFrom removal and a stricter dmPolicy apply at once; the reverse needs the card", async () => {
    const { admin, seed } = await boot();
    seed("channels.telegram.allowFrom", ["1", "2"]);
    seed("channels.telegram.dmPolicy", "pairing");
    expect(await set(admin, "channels.telegram.allowFrom", ["2"])).toMatchObject({ ok: true });
    expect(await set(admin, "channels.telegram.dmPolicy", "allowlist")).toMatchObject({
      ok: true,
    });
    carded(await set(admin, "channels.telegram.allowFrom", ["2", "3"]));
    carded(await set(admin, "channels.telegram.dmPolicy", "open"));
  });

  it("devices, vault, gateway and identity links always raise the card", async () => {
    const { admin, seed } = await boot();
    for (const [key, before, after] of [
      ["vault.autoLock", 10, 5],
      ["gateway.lan", { enabled: true }, { enabled: false }],
      ["identityLinks", { a: ["b"] }, {}],
    ] as const) {
      seed(key, before);
      carded(await set(admin, key, after));
    }
  });

  it("malformed or unknown values raise the card", async () => {
    const { admin, seed } = await boot();
    seed("computerUse.enabled", true);
    carded(await set(admin, "computerUse.enabled", "false"));
    seed("permissions.policy", FOLDERS);
    carded(await set(admin, "permissions.policy", { folders: "none" }));
    carded(await set(admin, "permissions.policy", { folders: [], bogus: true }));
    carded(await set(admin, "permissions.somethingNew", false));
  });

  it("a device without operator.admin is refused, even for a narrowing change", async () => {
    const { key, db, seed, stored } = await boot();
    seed("computerUse.enabled", true);
    updateDevice(db, DEVICE, { scopes: ["operator.read", "operator.write"] });
    const weak = await desktopClient(composed?.gateway as never, key, DEVICE);
    clients.push(weak);
    expect(await set(weak, "computerUse.enabled", false)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(stored("computerUse.enabled")).toBe(true);
  });

  it("a narrowing change is audited, noted as narrowing", async () => {
    const { admin, seed } = await boot();
    seed("computerUse.enabled", true);
    seed("permissions.connectors.gmail", { send: "ask" });
    expect(await set(admin, "computerUse.enabled", false)).toMatchObject({ ok: true });
    carded(await set(admin, "permissions.connectors.gmail", { send: "allow" }));

    let changes: { target: { object?: string }; note?: string }[] = [];
    for (let i = 0; i < 50 && changes.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      changes = (
        await admin.call<{ changes: typeof changes }>(
          "audit.changes",
          { categories: ["setting"] },
          ik(),
        )
      ).changes;
    }
    const row = changes.find((c) => c.target.object === "computerUse.enabled");
    expect(row).toMatchObject({ note: "narrowing: true" });
    // The refused widening wrote no row.
    expect(changes.some((c) => c.target.object === "permissions.connectors.gmail")).toBe(false);
  });
});
