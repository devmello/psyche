import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppleHelper,
  appleFactories,
  type ConnectorRecord,
  canonicalJSON,
  describeWithRule,
  MemoryConnectorStore,
  sha256,
  toolName,
} from "@psyche/connectors";
import { APPLE_APP_ACTIONS, type PolicyContext } from "@psyche/permissions";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  brokerConnectors,
  brokerLiftedFloors,
  ownerLiftedFloors,
  ownerMatrices,
} from "../src/compose/connector-matrix.ts";
import { composeConnectors } from "../src/compose/connectors.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * #747: Settings → Connectors' Allow / Ask / Deny per action group reaches the Permission
 * Broker (and the connector executor's own matrix), under the hard floors.
 */

const AT = "2026-10-25T10:00:00.000Z";
const record = (over: Partial<ConnectorRecord>): ConnectorRecord => ({
  id: "apple-mail",
  type: "apple:mail",
  label: "Apple Mail",
  account: "This Mac",
  scopes: [],
  scopeMode: "read_act",
  actionMatrix: {},
  credentialId: null,
  status: "connected",
  config: {},
  lastSync: null,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const helper: AppleHelper = {
  nodeId: "node_mac",
  capabilities: [
    "mail.search",
    "mail.set_flags",
    "mail.send",
    "shortcuts.run",
    "permissions.status",
  ],
  invoke: async (capability) =>
    capability === "permissions.status"
      ? { ok: true, result: { automation: { "com.apple.mail": "granted" } } }
      : { ok: true, result: {} },
};

const CTX: PolicyContext = {
  threadId: "thr_main",
  runId: "run_1",
  taskId: "task_1",
  permissionMode: "balanced",
  taint: false,
};

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** An Apple tool call as the agent loop would put it to the broker. */
function intent(rec: ConnectorRecord, tool: string, params: Record<string, unknown>) {
  const factory = appleFactories({ helper: () => helper }).find((f) => f.entry.type === rec.type);
  const t = factory
    ?.create(rec, undefined as never)
    .tools()
    .find((x) => x.name === tool);
  if (t === undefined) throw new Error(`no tool ${tool} for ${rec.type}`);
  const desc = describeWithRule(rec.id, t, params);
  return {
    tool: toolName(rec.id, t.name),
    sideEffect: t.sideEffect,
    params,
    paramsHash: sha256(canonicalJSON(params)),
    ...(desc.kind === undefined ? {} : { kind: desc.kind }),
    ...(desc.target === undefined ? {} : { target: desc.target }),
    ...(desc.connectorRule === undefined ? {} : { connectorRule: desc.connectorRule }),
    toolCallId: `tc_${tool}`,
  };
}

describe("connector action matrix → broker (#747)", () => {
  it("applies the owner's Settings rules to the broker and the executor", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-matrix-"));
    const store = new MemoryConnectorStore();
    const mail = record({});
    const shortcuts = record({
      id: "apple-shortcuts",
      type: "apple:shortcuts",
      label: "Shortcuts",
      config: { shortcutRules: { S1: "off", S2: "allow" } },
    });
    await store.put(mail);
    await store.put(shortcuts);
    composed = await composeGateway({
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      parts: [(s) => composeConnectors(s, { store, appleHelper: () => helper, syncIntervalMs: 0 })],
    });
    const c = composed;
    const owner = await adminClient(c.gateway);
    clients.push(owner);
    const flags = intent(mail, "mail_set_flags", { ids: ["m1"], read: true });

    // Before any rule: the mode default asks, not the unknown-MCP-tier floor.
    await until(() => c.broker.policy.connectors?.["apple-shortcuts"] !== undefined);
    expect(await c.broker.decide(flags, CTX)).toMatchObject({
      decision: "ask",
      rule: "mode:balanced/write",
    });

    // What Settings → Connectors writes when the owner sets Organize mail to Allow.
    await owner.call(
      "settings.set",
      {
        key: "permissions.connectors.apple-mail",
        value: { "mail.read": "allow", "mail.organize": "allow", "mail.send": "ask" },
      },
      ik(),
    );
    await until(() => c.broker.policy.connectors?.["apple-mail"]?.["mail.organize"] === "allow");
    expect(await c.broker.decide(flags, CTX)).toMatchObject({
      decision: "allow",
      rule: "connector:apple-mail/mail.organize",
    });
    // The executor follows too, so the allowed call is not refused there for want of a card.
    await until(
      async () => (await store.get("apple-mail"))?.actionMatrix["mail.organize"] === "allow",
    );
    // Direct helper calls (`node.mail.set_flags`) follow the same group.
    expect(c.broker.policy.connectors?.["apple.mail"]).toMatchObject({ "mail.organize": "allow" });
    const nodeParams = { tool: "node.mail.set_flags", target: null };
    expect(
      await c.broker.decide(
        {
          tool: "node.mail.set_flags",
          sideEffect: "write",
          params: nodeParams,
          paramsHash: sha256(JSON.stringify(nodeParams)),
        },
        CTX,
      ),
    ).toMatchObject({ decision: "allow", rule: "connector:apple.mail/mail.organize" });

    // Sends always ask, whatever the matrix says.
    const send = intent(mail, "mail_send", { to: ["a@example.com"], subject: "Hi", body: "x" });
    expect((await c.broker.decide(send, CTX)).decision).toBe("ask");

    // Deny refuses, with a receipt naming the rule.
    await owner.call(
      "settings.set",
      { key: "permissions.connectors.apple-mail", value: { "mail.organize": "deny" } },
      ik(),
    );
    await until(() => c.broker.policy.connectors?.["apple-mail"]?.["mail.organize"] === "deny");
    expect(await c.broker.decide(flags, CTX)).toMatchObject({ decision: "deny" });
    expect(await c.broker.listReceipts({ toolCallId: "tc_mail_set_flags" })).toMatchObject([
      { kind: "mail.organize", payload: { rule: "connector:apple-mail/mail.organize" } },
    ]);

    // A shortcut turned off is refused before any card (by the connector, #727, and the broker
    // has `shortcuts.run/S1: deny` too); one the owner allowed runs without a card.
    expect(() => intent(shortcuts, "shortcuts_run", { id: "S1" })).toThrow(
      /turned this shortcut off/,
    );
    expect(c.broker.policy.connectors?.["apple-shortcuts"]).toMatchObject({
      "shortcuts.run/S1": "deny",
      "shortcuts.run/S2": "allow",
    });
    const allowed = await c.broker.decide(intent(shortcuts, "shortcuts_run", { id: "S2" }), CTX);
    expect(allowed).toMatchObject({
      decision: "allow",
      rule: "connector:apple-shortcuts/shortcuts.run/S2",
    });
    // Any other shortcut is destructive: a card.
    const other = await c.broker.decide(intent(shortcuts, "shortcuts_run", { id: "S3" }), CTX);
    expect(other).toMatchObject({ decision: "ask" });
  });

  it("a read from a list the owner marked theirs does not taint, so the Allow write runs without a card (§3.6)", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-matrix-"));
    const store = new MemoryConnectorStore();
    const reminders = record({
      id: "apple-reminders",
      type: "apple:reminders",
      label: "Reminders",
      config: { trustedSources: ["L1"] },
    });
    await store.put(reminders);
    const remindersHelper: AppleHelper = {
      nodeId: "node_mac",
      capabilities: ["reminders.list", "reminders.list_lists", "reminders.create"],
      invoke: async (capability, params) => {
        if (capability === "reminders.list_lists") {
          return {
            ok: true,
            result: {
              lists: [
                { id: "L1", title: "Home", source: "iCloud", writable: true },
                { id: "L2", title: "Work", source: "iCloud", writable: true },
              ],
            },
          };
        }
        const ids = (params as { listIds?: string[] }).listIds ?? ["L1", "L2"];
        return {
          ok: true,
          result: { reminders: ids.map((listId) => ({ id: `r-${listId}`, listId, title: "x" })) },
        };
      },
    };
    composed = await composeGateway({
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      parts: [
        (s) =>
          composeConnectors(s, { store, appleHelper: () => remindersHelper, syncIntervalMs: 0 }),
      ],
    });
    const c = composed;
    const owner = await adminClient(c.gateway);
    clients.push(owner);
    await owner.call(
      "settings.set",
      {
        key: "permissions.connectors.apple-reminders",
        value: { "reminders.read": "allow", "reminders.write": "allow" },
      },
      ik(),
    );
    await until(
      () => c.broker.policy.connectors?.["apple-reminders"]?.["reminders.write"] === "allow",
    );
    const tools = appleFactories({ helper: () => remindersHelper })
      .find((f) => f.entry.type === "apple:reminders")
      ?.create(reminders, undefined as never)
      .tools();
    const list = tools?.find((t) => t.name === "reminders_list");
    if (list === undefined) throw new Error("no reminders_list");
    const read = async (listIds: string[]) =>
      (await list.execute({ listIds }, { signal: new AbortController().signal } as never)) as {
        provenance?: string;
      };
    const create = intent(reminders, "reminders_create", { title: "Call dentist" });

    const trusted = await read(["L1"]);
    expect(trusted.provenance).toBe("trusted");
    expect(
      await c.broker.decide(create, { ...CTX, taint: trusted.provenance === "untrusted" }),
    ).toMatchObject({
      decision: "allow",
      rule: "connector:apple-reminders/reminders.write",
    });

    // A mixed read (trusted plus untrusted list) taints: the write asks.
    const mixed = await read(["L1", "L2"]);
    expect(mixed.provenance).toBe("untrusted");
    expect(
      (await c.broker.decide(create, { ...CTX, taint: mixed.provenance === "untrusted" })).decision,
    ).toBe("ask");
  });

  it("a new permissions.policy keeps the owner's Settings rules", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-matrix-"));
    const store = new MemoryConnectorStore();
    await store.put(record({}));
    composed = await composeGateway({
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      parts: [(s) => composeConnectors(s, { store, appleHelper: () => helper, syncIntervalMs: 0 })],
    });
    const c = composed;
    const owner = await adminClient(c.gateway);
    clients.push(owner);
    await owner.call(
      "settings.set",
      { key: "permissions.connectors.apple-mail", value: { "mail.organize": "deny" } },
      ik(),
    );
    await until(() => c.broker.policy.connectors?.["apple-mail"]?.["mail.organize"] === "deny");
    await owner.call("settings.set", { key: "permissions.policy", value: { allow: [] } }, ik());
    expect(c.broker.policy.connectors?.["apple-mail"]).toMatchObject({ "mail.organize": "deny" });
  });

  it("layers Settings rules over permissions.policy, mirrors Apple apps, maps shortcut rules", () => {
    const owner = ownerMatrices({
      "permissions.connectors.apple-mail": { "mail.organize": "allow", junk: 3 },
      "permissions.connectors.gmail": { "gmail.send": "deny" },
      "permissions.policy": {},
    });
    expect(
      brokerConnectors({ gmail: { "gmail.read": "ask" } }, owner, [
        record({}),
        record({ id: "things", type: "things", config: {} }),
        record({
          id: "sc",
          type: "apple:shortcuts",
          config: { shortcutRules: { A: "off", B: "x" } },
        }),
      ]),
    ).toEqual({
      gmail: { "gmail.read": "ask", "gmail.send": "deny" },
      "apple-mail": { "mail.organize": "allow" },
      "apple.mail": { "mail.organize": "allow" },
      sc: { "shortcuts.run/A": "deny" },
    });
  });

  it("lifted floors come only from the confirmed setting, mirrored for Apple apps (§3.12)", () => {
    const owner = ownerLiftedFloors({
      "permissions.liftedFloors.apple-notes": ["notes.delete", "notes.delete", 3],
      "permissions.liftedFloors.gmail": "gmail.send",
      "permissions.connectors.apple-notes": { "notes.delete": "allow" },
    });
    expect(brokerLiftedFloors(owner, [record({ id: "apple-notes", type: "apple:notes" })])).toEqual(
      { "apple-notes": ["notes.delete"], "apple.notes": ["notes.delete"] },
    );
  });

  it("an echoed catalogue default is not a choice: neither side flips (music, reads)", () => {
    // Settings saves the whole matrix; music.control's default allow is echoed, not chosen.
    const defaults = (type: string) =>
      type === "apple:music" ? { "music.control": "allow", "music.read": "allow" } : undefined;
    const music = record({ id: "apple-music", type: "apple:music" });
    const echoed = ownerMatrices({
      "permissions.connectors.apple-music": { "music.control": "allow", "music.read": "allow" },
    });
    const out = brokerConnectors(undefined, echoed, [music], defaults);
    expect(out["apple-music"]).toEqual({});
    expect(out["apple.music"]).toEqual({});
    const changed = ownerMatrices({
      "permissions.connectors.apple-music": { "music.control": "ask", "music.read": "deny" },
    });
    expect(brokerConnectors(undefined, changed, [music], defaults)).toEqual({
      "apple-music": { "music.control": "ask", "music.read": "deny" },
      "apple.music": { "music.control": "ask", "music.read": "deny" },
    });
  });

  it("every Apple connector tool's group matches its APPLE_APP_ACTIONS row (no drift)", () => {
    let checked = 0;
    for (const f of appleFactories({ helper: () => helper })) {
      const tools = f
        .create(record({ id: f.entry.id, type: f.entry.type }), undefined as never)
        .tools();
      for (const t of tools) {
        // Tool `mail_set_flags` is helper capability `mail.set_flags`.
        const row = APPLE_APP_ACTIONS[t.name.replace("_", ".")];
        if (row === undefined) continue;
        expect({ tool: t.name, group: row.group }).toEqual({ tool: t.name, group: t.action });
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });
});
