import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Connector,
  ConnectorContext,
  ConnectorFactory,
  ConnectorRecord,
  ConnectorStore,
} from "@psyche/connectors";
import { openDb } from "@psyche/db";
import type { CredentialMeta, CredentialUse, EventPayload, VaultStatus } from "@psyche/protocol";
import { FakeModelProvider, FakePermissionBroker } from "@psyche/testing";
import { SecretRedactor, type Vault } from "@psyche/vault";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeConnectors, composeGateway } from "../src/compose/index.ts";
import { composeVault, maskingLogger, vaultHandlers } from "../src/compose/vault.ts";
import { createLogger } from "../src/log.ts";
import { FakeNode, type FakeNodeHandler } from "./fake-node.ts";
import { adminClient, ik, startTestGateway, type TestClient, type TestGateway } from "./helpers.ts";

const TEST_ARGON2 = { memory: 64, passes: 1, parallelism: 1 };
const PASSWORD = "correct-horse-battery-staple-91";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** The Mac helper's keychain capabilities, backed by a map (the KEK never leaves it in clear). */
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

describe("vault.* through the dispatcher (keychain slot via the Mac helper)", () => {
  it("is wired end to end: status, setup, add, list, uses, events; no secret in any log", async () => {
    // The vault's meta mirror shares the Gateway's database; handlers are read at start, so
    // the vault is composed first and reaches the helper once `attach` hands it the registry.
    const home = mkdtempSync(join(tmpdir(), "psyche-gw-vault-"));
    const logs: string[] = [];
    const broker = new FakePermissionBroker();
    const db = openDb(join(home, "psyche.db"));
    let t: TestGateway | undefined;
    const vault = composeVault(
      {
        home,
        db,
        permissions: broker,
        audit: { append: async () => undefined } as never,
        clock: { now: () => Date.now() },
        publish: (event, payload) => t?.gateway.bus.publish(event, payload),
      },
      { argon2: TEST_ARGON2 },
    );
    t = await startTestGateway({
      home,
      db,
      broker,
      logger: createLogger((line) => logs.push(line), "debug"),
      handlers: vault.handlers,
    });
    vault.attach(t.gateway.context.nodes);
    const gw = t;
    cleanups.push(() => gw.cleanup());
    expect(vault.slot).toBe("keychain");

    const admin: TestClient = await adminClient(gw.gateway);
    cleanups.push(() => admin.close());

    // No helper yet: the keychain slot is unavailable, setup fails without touching anything.
    const before = await admin.call<{ status: VaultStatus }>("vault.status", {});
    expect(before.status.state).toBe("uninitialized");
    const noHelper = await admin.request("vault.setup", { slot: "keychain" }, ik());
    expect(noHelper.ok).toBe(false);

    const helper = await FakeNode.connect(gw.gateway.config.nodeSocketPath, {
      origin: gw.gateway.origin,
      secret: gw.gateway.handshakeSecret,
      handlers: keychainHelper(),
    });
    cleanups.push(() => helper.close());

    // The wrong slot for this Gateway is refused.
    const wrong = await admin.request("vault.setup", { slot: "key_file" }, ik());
    expect((wrong.error as { code?: string } | undefined)?.code).toBe("invalid_params");

    const created = await admin.call<{ recoveryKey: string; status: VaultStatus }>(
      "vault.setup",
      { slot: "keychain" },
      ik(),
    );
    expect(created.status.state).toBe("unlocked");
    expect(helper.invocations.map((i) => i.capability)).toContain("keychain.set");
    await admin.call(
      "vault.confirmRecovery",
      { lastGroup: created.recoveryKey.split("-").at(-1) },
      ik(),
    );

    const added = await admin.call<{ credential: CredentialMeta }>(
      "vault.add",
      {
        kind: "login",
        name: "Example",
        bindings: [{ origin: "https://example.com" }],
        secret: { username: "owner@example.com", password: PASSWORD },
      },
      ik(),
    );
    expect(added.credential.slug).toBeTruthy();
    const updated = await admin.waitForEvent(
      (f) =>
        f.event === "credential.updated" &&
        (f.payload as EventPayload<"credential.updated">).credentialId === added.credential.id,
    );
    expect(JSON.stringify(updated)).not.toContain(PASSWORD);

    const listed = await admin.call<{ credentials: CredentialMeta[] }>("vault.list", {});
    expect(listed.credentials.map((c) => c.id)).toEqual([added.credential.id]);
    expect(JSON.stringify(listed)).not.toContain(PASSWORD);
    const uses = await admin.call<{ uses: CredentialUse[] }>("vault.uses", {
      credentialId: added.credential.id,
      limit: 50,
    });
    expect(uses.uses).toEqual([]);

    // A failing vault.add (refused data) never echoes its params into logs either.
    const refused = await admin.request(
      "vault.add",
      {
        kind: "note",
        name: "card",
        bindings: [],
        secret: { text: `${"4242 ".repeat(4)}${PASSWORD}` },
      },
      ik(),
    );
    expect(refused.ok).toBe(false);

    await admin.call("vault.lock", {}, ik());
    await admin.waitForEvent((f) => f.event === "vault.locked");
    const unlocked = await admin.call<{ status: VaultStatus }>(
      "vault.unlock",
      { reason: "test" },
      ik(),
    );
    expect(unlocked.status.state).toBe("unlocked");
    await admin.waitForEvent((f) => f.event === "vault.unlocked");

    const all = logs.join("\n");
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(created.recoveryKey);
    expect(all).not.toContain("owner@example.com");
    vault.stop();
  });

  it("keeps keychain.* and vault.unlock out of nodes.invoke", async () => {
    const home = mkdtempSync(join(tmpdir(), "psyche-gw-vault-"));
    const gw = await startTestGateway({ home, broker: new FakePermissionBroker() });
    cleanups.push(() => gw.cleanup());
    const helper = await FakeNode.connect(gw.gateway.config.nodeSocketPath, {
      origin: gw.gateway.origin,
      secret: gw.gateway.handshakeSecret,
      handlers: keychainHelper(),
    });
    cleanups.push(() => helper.close());
    const admin = await adminClient(gw.gateway);
    cleanups.push(() => admin.close());
    for (const capability of [
      "keychain.set",
      "keychain.status",
      "keychain.delete",
      "keychain.retrieve",
      "vault.unlock",
    ]) {
      const res = await admin.request(
        "nodes.invoke",
        { nodeId: helper.nodeId, capability, params: {} },
        ik(),
      );
      expect((res.error as { code?: string } | undefined)?.code, capability).toBe("forbidden");
    }
    expect(helper.invocations).toEqual([]);
  });
});

describe("secret hygiene around the vault handlers", () => {
  it("replaces a raw error from a secret-bearing method with a fixed message", async () => {
    const vault = {
      add: async () => {
        throw new Error(`could not store ${PASSWORD}`);
      },
    } as unknown as Vault;
    const add = vaultHandlers(vault)["vault.add"];
    const err = await Promise.resolve()
      .then(() =>
        add?.run(
          {} as never,
          {
            kind: "login",
            name: "x",
            bindings: [],
            secret: { password: PASSWORD },
          } as never,
        ),
      )
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("vault.add failed");
  });

  it("masks values the vault handed out in every log field", () => {
    const lines: string[] = [];
    const redactor = new SecretRedactor();
    redactor.add(ACCESS, { sticky: true });
    const log = maskingLogger(
      createLogger((l) => lines.push(l), "debug"),
      redactor,
    );
    log.log("warn", `token ${ACCESS}`, { detail: `Bearer ${ACCESS}`, n: 1 });
    expect(lines.join("")).not.toContain(ACCESS);
  });
});

/** Connector records that outlive one Gateway (the `connectors` table stand-in). */
class SharedStore implements ConnectorStore {
  readonly rows = new Map<string, ConnectorRecord>();
  async get(id: string) {
    const r = this.rows.get(id);
    return r === undefined ? undefined : structuredClone(r);
  }
  async list() {
    return [...this.rows.values()].map((r) => structuredClone(r));
  }
  async put(record: ConnectorRecord) {
    this.rows.set(record.id, structuredClone(record));
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
}

const ACCESS = "ya29.fake-access-token-0123456789abcdef";
const REFRESH = "1//fake-refresh-token-0123456789abcdef";

/** A connector that reuses stored tokens on reconnect and mints them otherwise. */
function fakeFactory(seen: string[]): ConnectorFactory {
  return {
    entry: {
      type: "fake",
      id: "fake",
      label: "Fake",
      description: "test connector",
      category: "first_party",
      vendor: "test",
      auth: "oauth",
      scopes: { read: ["r"], read_act: ["r", "w"] },
      actions: [],
      available: true,
    },
    create(record: ConnectorRecord, ctx: ConnectorContext): Connector {
      return {
        id: record.id,
        type: "fake",
        async connect() {
          const stored = await ctx.tokens.load(record.id);
          if (stored === undefined) {
            await ctx.tokens.save(record.id, {
              accessToken: ACCESS,
              refreshToken: REFRESH,
              expiresAt: Date.now() + 3_600_000,
              scope: "r",
              tokenType: "Bearer",
            });
            seen.push("saved");
          } else {
            seen.push(stored.accessToken === ACCESS ? "loaded" : "wrong");
          }
          return { account: "owner@example.com", scopes: ["r"] };
        },
        async disconnect() {},
        actions: () => [],
        tools: () => [],
        async health() {
          return { ok: true, status: "connected", checkedAt: Date.now() };
        },
      };
    },
  };
}

describe("connector tokens in the composed Gateway's vault (G13)", () => {
  let home = "";
  let keyFile = "";
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "psyche-compose-vault-"));
    keyFile = join(home, "vault.key");
    writeFileSync(keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
    const dir = home;
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  });

  async function boot(store: SharedStore, seen: string[], logs: string[]) {
    let registry: ReturnType<typeof composeConnectors>["registry"] | undefined;
    const composed: ComposedGateway = await composeGateway({
      env: { PSYCHE_VAULT_KEY_FILE: keyFile },
      logger: createLogger((line) => logs.push(line), "debug"),
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      vault: { keyFile, argon2: TEST_ARGON2 },
      parts: [
        (s) => {
          const part = composeConnectors(s, {
            factories: [fakeFactory(seen)],
            store,
            syncIntervalMs: 0,
          });
          registry = part.registry;
          return part;
        },
      ],
    });
    if (registry === undefined) throw new Error("connectors part not mounted");
    return { composed, registry };
  }

  it("saves tokens as a vault item, loads them after a restart, and revokes on disconnect", async () => {
    const store = new SharedStore();
    const seen: string[] = [];
    const logs: string[] = [];

    const first = await boot(store, seen, logs);
    expect(first.composed.vault.primarySlot).toBe("key_file");
    await first.composed.vault.setup();
    const record = await first.registry.connect({ catalogueId: "fake", scopeMode: "read" });
    expect(seen).toEqual(["saved"]);
    const item = first.composed.vault.connectorItem(record.id);
    expect(item?.kind).toBe("oauth_token");
    expect(item?.ownerConnectorId).toBe(record.id);
    await first.composed.stop("restart");

    const second = await boot(store, seen, logs);
    cleanups.push(() => second.composed.stop("test"));
    expect(second.composed.vault.status().state).toBe("locked");
    await second.composed.vault.unlock("test");
    await second.registry.connect({
      catalogueId: "fake",
      scopeMode: "read",
      connectorId: record.id,
    });
    expect(seen).toEqual(["saved", "loaded"]);
    const uses = second.composed.vault.uses(item?.id ?? "", 50);
    expect(uses.some((u) => u.executor === "connector")).toBe(true);

    // Disconnect revokes the item; credential.updated {change: "revoked"} reaches the bus.
    const frames: string[] = [];
    const unsubscribe = second.composed.gateway.bus.subscribe(["operator.read"], (f) => {
      frames.push(f);
    });
    await second.registry.disconnect(record.id);
    unsubscribe();
    const revoked = frames
      .map((f) => JSON.parse(f) as { event?: string; payload?: Record<string, unknown> })
      .find((f) => f.event === "credential.updated");
    expect(revoked?.payload).toMatchObject({
      credentialId: item?.id,
      change: "revoked",
      ownerConnectorId: record.id,
    });
    expect(second.composed.vault.connectorItem(record.id)).toBeUndefined();
    expect((await second.registry.get(record.id)).status).toBe("disconnected");

    const all = logs.join("\n");
    expect(all).not.toContain(ACCESS);
    expect(all).not.toContain(REFRESH);
  });

  it("disconnects the connector when its token is revoked in the vault", async () => {
    const store = new SharedStore();
    const seen: string[] = [];
    const { composed, registry } = await boot(store, seen, []);
    cleanups.push(() => composed.stop("test"));
    await composed.vault.setup();
    const record = await registry.connect({ catalogueId: "fake", scopeMode: "read" });
    const item = composed.vault.connectorItem(record.id);
    if (item === undefined) throw new Error("no connector item");
    await composed.vault.revoke(item.id, record.id, "revoked");
    await expect.poll(async () => (await registry.get(record.id)).status).toBe("disconnected");
  });
});
