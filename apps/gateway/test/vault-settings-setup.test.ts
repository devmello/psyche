import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, updateDevice } from "@psyche/db";
import type { VaultStatus } from "@psyche/protocol";
import { FakePermissionBroker } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { composeVault } from "../src/compose/vault.ts";
import { createLogger } from "../src/log.ts";
import { FakeNode, type FakeNodeHandler } from "./fake-node.ts";
import {
  adminClient,
  desktopClient,
  handshake,
  ik,
  newDeviceKey,
  startTestGateway,
  TestClient,
  type TestGateway,
  wsUrlOf,
} from "./helpers.ts";

/**
 * Settings → Credentials sets the vault up and confirms its recovery key later, through the same
 * `vault.setup` / `vault.confirmRecovery` onboarding uses. These pin the Gateway side of that:
 * once only, admin only, checked on the Gateway, and the key never in a response or log.
 */

const TEST_ARGON2 = { memory: 64, passes: 1, parallelism: 1 };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function keychainHelper(): FakeNodeHandler[] {
  const items = new Map<string, string>();
  const key = (p: { service: string; account: string }) => `${p.service}|${p.account}`;
  return [
    {
      capability: { name: "keychain.set", sideEffect: "write" },
      run: (p) => {
        const params = p as { service: string; account: string; value: string };
        items.set(key(params), params.value);
        return {};
      },
    },
    {
      capability: { name: "vault.unlock", sideEffect: "write" },
      run: (p) => {
        const value = items.get(key(p as { service: string; account: string }));
        if (value === undefined) throw new Error("not found");
        return { value };
      },
    },
    { capability: { name: "keychain.delete", sideEffect: "destructive" }, run: () => ({}) },
    {
      capability: { name: "keychain.status", sideEffect: "read" },
      run: () => ({ dataProtectionKeychain: "available", accessGroup: "test", biometry: true }),
    },
  ];
}

async function start() {
  const home = mkdtempSync(join(tmpdir(), "psyche-gw-vault-settings-"));
  const logs: string[] = [];
  const db = openDb(join(home, "psyche.db"));
  let t: TestGateway | undefined;
  const vault = composeVault(
    {
      home,
      db,
      permissions: new FakePermissionBroker(),
      audit: { append: async () => undefined } as never,
      clock: { now: () => Date.now() },
      publish: (event, payload) => t?.gateway.bus.publish(event, payload),
    },
    { argon2: TEST_ARGON2, platform: "darwin" },
  );
  t = await startTestGateway({
    home,
    db,
    broker: new FakePermissionBroker(),
    logger: createLogger((line) => logs.push(line), "debug"),
    handlers: vault.handlers,
  });
  vault.attach(t.gateway.context.nodes);
  const gw = t;
  const helper = await FakeNode.connect(gw.gateway.config.nodeSocketPath, {
    origin: gw.gateway.origin,
    secret: gw.gateway.handshakeSecret,
    handlers: keychainHelper(),
  });
  cleanups.push(async () => {
    helper.close();
    await gw.gateway.stop("test");
    vault.stop();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const admin: TestClient = await adminClient(gw.gateway);
  cleanups.push(() => admin.close());
  return { gw, admin, logs, home, db };
}

describe("vault set up and recovery confirmed from Settings", () => {
  it("creates the vault once; a second setup is refused and keeps the first key", async () => {
    const { admin, logs, home } = await start();
    const before = await admin.call<{ status: VaultStatus }>("vault.status", {});
    expect(before.status.state).toBe("uninitialized");

    const first = await admin.call<{ recoveryKey: string; status: VaultStatus }>(
      "vault.setup",
      { slot: "keychain" },
      ik(),
    );
    expect(first.status.state).toBe("unlocked");
    expect(first.status.recoveryConfirmed).toBe(false);

    const again = await admin.request("vault.setup", { slot: "keychain" }, ik());
    expect(again.ok).toBe(false);
    expect((again.error as { code?: string } | undefined)?.code).toBe("conflict");
    expect(JSON.stringify(again)).not.toContain(first.recoveryKey);

    // The first vault is untouched: still its key, still unconfirmed.
    const after = await admin.call<{ status: VaultStatus }>("vault.status", {});
    expect(after.status.recoveryConfirmed).toBe(false);
    expect(JSON.stringify(after)).not.toContain(first.recoveryKey);
    expect(logs.join("\n")).not.toContain(first.recoveryKey);
    expect(readFileSync(join(home, "vault", "slots.json"), "utf8")).not.toContain(
      first.recoveryKey,
    );
  });

  it("confirms with the right last group, refuses wrong ones, and stores neither", async () => {
    const { admin, logs, home } = await start();
    const created = await admin.call<{ recoveryKey: string }>(
      "vault.setup",
      { slot: "keychain" },
      ik(),
    );
    const last = created.recoveryKey.split("-").at(-1) ?? "";
    const wrong = last.startsWith("A") ? `B${last.slice(1)}` : `A${last.slice(1)}`;

    const bad = await admin.request("vault.confirmRecovery", { lastGroup: wrong }, ik());
    expect(bad.ok).toBe(false);
    expect((bad.error as { code?: string } | undefined)?.code).toBe("invalid_params");
    const still = await admin.call<{ status: VaultStatus }>("vault.status", {});
    expect(still.status.recoveryConfirmed).toBe(false);

    const ok = await admin.call<{ status: VaultStatus }>(
      "vault.confirmRecovery",
      { lastGroup: last },
      ik(),
    );
    expect(ok.status.recoveryConfirmed).toBe(true);
    // The result carries status only: no key, no group.
    expect(Object.keys(ok)).toEqual(["status"]);
    expect(JSON.stringify(ok)).not.toContain(created.recoveryKey);

    const all = logs.join("\n");
    expect(all).not.toContain(created.recoveryKey);
    expect(all).not.toContain(last);
    expect(all).not.toContain(wrong);
    // Neither the typed words nor the key are written to the slot file.
    const slots = readFileSync(join(home, "vault", "slots.json"), "utf8");
    expect(slots).not.toContain(last);
    expect(slots).not.toContain(wrong);
    expect(slots).not.toContain("recoveryCheck");
  });

  it("refuses setup and confirmation from a device without the admin scope", async () => {
    const { gw, admin } = await start();
    const created = await admin.call<{ recoveryKey: string }>(
      "vault.setup",
      { slot: "keychain" },
      ik(),
    );
    const last = created.recoveryKey.split("-").at(-1) ?? "";
    const plain = await desktopClient(gw.gateway);
    cleanups.push(() => plain.close());

    const setup = await plain.request("vault.setup", { slot: "keychain" }, ik());
    expect(setup.ok).toBe(false);
    expect((setup.error as { code?: string } | undefined)?.code).toBe("forbidden");
    const confirm = await plain.request("vault.confirmRecovery", { lastGroup: last }, ik());
    expect(confirm.ok).toBe(false);
    expect((confirm.error as { code?: string } | undefined)?.code).toBe("forbidden");

    const after = await admin.call<{ status: VaultStatus }>("vault.status", {});
    expect(after.status.recoveryConfirmed).toBe(false);
  });

  it("keeps no key material in the idempotency row of vault.setup, and a retry still replays", async () => {
    const { admin, db } = await start();
    const key = ik();
    const created = await admin.call<{ recoveryKey: string; status: VaultStatus }>(
      "vault.setup",
      { slot: "keychain" },
      key,
    );
    // Positive control: the caller got the key in the answer.
    expect(created.recoveryKey).toMatch(/^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);
    const rows = db.sqlite
      .prepare("SELECT result FROM gateway_idempotency WHERE method = ?")
      .all("vault.setup") as { result: string }[];
    expect(rows).toHaveLength(1);
    const stored = rows[0]?.result ?? "";
    expect(stored).not.toContain(created.recoveryKey);
    for (const group of created.recoveryKey.split("-")) expect(stored).not.toContain(group);
    expect(JSON.parse(stored).recoveryKey).toBe("");
    // The same key replays the stored answer (status intact), not a second vault.
    const replay = await admin.call<{ recoveryKey: string; status: VaultStatus }>(
      "vault.setup",
      { slot: "keychain" },
      key,
    );
    expect(replay.status.state).toBe("unlocked");
    expect(replay.recoveryKey).toBe("");
  });

  it("the migration blanks a recovery key an older Gateway stored in a vault.setup row", async () => {
    const { db } = await start();
    const old = JSON.stringify({ status: { state: "unlocked" }, recoveryKey: "AAAA-BBBB-CCCC" });
    const other = JSON.stringify({ recoveryKey: "keep-me-alone" });
    const insert = db.sqlite.prepare(
      "INSERT INTO gateway_idempotency (id, device_id, method, idempotency_key, params_hash, result, created_at) VALUES (?, 'd', ?, ?, 'h', ?, '2026-11-01T00:00:00.000Z')",
    );
    insert.run("old1", "vault.setup", "k1", old);
    insert.run("old2", "other.method", "k2", other);
    const sql = readFileSync(
      join(
        __dirname,
        "../../../packages/db/migrations/202611271000_gateway_blank-vault-setup-replay.sql",
      ),
      "utf8",
    );
    db.sqlite.exec(sql);
    const get = (id: string) =>
      (
        db.sqlite.prepare("SELECT result FROM gateway_idempotency WHERE id = ?").get(id) as {
          result: string;
        }
      ).result;
    expect(get("old1")).not.toContain("AAAA-BBBB-CCCC");
    expect(JSON.parse(get("old1")).status.state).toBe("unlocked");
    // Only vault.setup rows are touched.
    expect(get("old2")).toBe(other);
  });

  it("shows the recovery key again to an admin while unlocked, never to others, and never stores or logs it", async () => {
    const { gw, admin, logs, home } = await start();
    const created = await admin.call<{ recoveryKey: string }>(
      "vault.setup",
      { slot: "keychain" },
      ik(),
    );
    // A plain read (no idempotency key): the result is not kept in the idempotency table.
    const shown = await admin.call<{ recoveryKey: string | null }>("vault.recoveryKey", {});
    expect(shown.recoveryKey).toBe(created.recoveryKey);
    const status = await admin.call<{ status: VaultStatus }>("vault.status", {});
    expect(status.status.recoveryKeyStored).toBe(true);
    expect(JSON.stringify(status)).not.toContain(created.recoveryKey);

    const plain = await desktopClient(gw.gateway);
    cleanups.push(() => plain.close());
    const refused = await plain.request("vault.recoveryKey", {});
    expect(refused.ok).toBe(false);
    expect((refused.error as { code?: string } | undefined)?.code).toBe("forbidden");
    expect(JSON.stringify(refused)).not.toContain(created.recoveryKey);

    // Locked: nothing is shown.
    await admin.call("vault.lock", {}, ik());
    const locked = await admin.request("vault.recoveryKey", {});
    expect(locked.ok).toBe(false);
    expect(JSON.stringify(locked)).not.toContain(created.recoveryKey);

    expect(logs.join("\n")).not.toContain(created.recoveryKey);
    expect(readFileSync(join(home, "vault", "slots.json"), "utf8")).not.toContain(
      created.recoveryKey,
    );
  });

  it("shows the recovery key only on the Host: a remote admin device and a phone are refused", async () => {
    const { gw, admin } = await start();
    const created = await admin.call<{ recoveryKey: string }>(
      "vault.setup",
      { slot: "keychain" },
      ik(),
    );
    // A remote admin (paired, no handshake secret: not the desktop shell), and a phone.
    for (const platform of ["macos", "ios"] as const) {
      const key = newDeviceKey();
      const deviceId = `remote-${platform}-${Math.random().toString(36).slice(2)}`;
      (await desktopClient(gw.gateway, key, deviceId, platform)).close();
      updateDevice(gw.gateway.context.db, deviceId, {
        scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
      });
      const remote = await TestClient.open(wsUrlOf(gw.gateway));
      cleanups.push(() => remote.close());
      const r = await handshake(remote, gw.gateway.origin, { key, deviceId, platform });
      expect((r.verifyRes?.payload as { phase?: string } | undefined)?.phase).toBe("paired");

      const refused = await remote.request("vault.recoveryKey", {});
      expect(refused.ok, platform).toBe(false);
      expect((refused.error as { code?: string } | undefined)?.code).toBe("forbidden");
      expect(JSON.stringify(refused)).not.toContain(created.recoveryKey);
      // It is told there is nothing to offer, so it shows no "Save your recovery key" card.
      const status = await remote.call<{ status: VaultStatus }>("vault.status", {});
      expect(status.status.recoveryKeyStored).toBe(false);
    }
    // Positive control: the desktop on the Host reads it and is told the key is there.
    const shown = await admin.call<{ recoveryKey: string | null }>("vault.recoveryKey", {});
    expect(shown.recoveryKey).toBe(created.recoveryKey);
    const hostStatus = await admin.call<{ status: VaultStatus }>("vault.status", {});
    expect(hostStatus.status.recoveryKeyStored).toBe(true);
  });

  it("sets the idle auto-lock for an admin; a device without admin is refused and nothing changes", async () => {
    const { gw, admin } = await start();
    await admin.call("vault.setup", { slot: "keychain" }, ik());

    const set = await admin.call<{ status: VaultStatus }>(
      "vault.setAutoLock",
      { minutes: 30 },
      ik(),
    );
    expect(set.status.autoLockMinutes).toBe(30);

    const plain = await desktopClient(gw.gateway);
    cleanups.push(() => plain.close());
    const refused = await plain.request("vault.setAutoLock", { minutes: null }, ik());
    expect(refused.ok).toBe(false);
    expect((refused.error as { code?: string } | undefined)?.code).toBe("forbidden");
    const still = await admin.call<{ status: VaultStatus }>("vault.status", {});
    expect(still.status.autoLockMinutes).toBe(30);

    // Out-of-range minutes are refused by the protocol, before the handler runs.
    const bad = await admin.request("vault.setAutoLock", { minutes: 0 }, ik());
    expect(bad.ok).toBe(false);
    expect((bad.error as { code?: string } | undefined)?.code).toBe("invalid_params");

    // "Never" is the owner's explicit choice from an admin device.
    const never = await admin.call<{ status: VaultStatus }>(
      "vault.setAutoLock",
      { minutes: null },
      ik(),
    );
    expect(never.status.autoLockMinutes).toBeNull();
  });
});
