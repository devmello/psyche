import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@psyche/db";
import type { VaultStatus } from "@psyche/protocol";
import { FakePermissionBroker } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { composeVault } from "../src/compose/vault.ts";
import { createLogger } from "../src/log.ts";
import { FakeNode, type FakeNodeHandler } from "./fake-node.ts";
import {
  adminClient,
  desktopClient,
  ik,
  startTestGateway,
  type TestClient,
  type TestGateway,
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
  return { gw, admin, logs, home };
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
});
