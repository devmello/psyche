import { Connector as ConnectorSchema, PsycheError } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  bindingHash,
  type CatalogueEntry,
  type ConnectorEvent,
  type ConnectorFactory,
  ConnectorRegistry,
  canonicalJSON,
  connectorHandlers,
  REMOTE_MCP_PRESETS,
  toWire,
  VERIFIED_MCP_HOSTS,
} from "../../src/index.ts";

const entry: CatalogueEntry = {
  type: "demo",
  id: "demo",
  label: "Demo",
  description: "test connector",
  category: "first_party",
  vendor: "Psyche",
  auth: "none",
  scopes: { read: ["r"], read_act: ["r", "w"] },
  actions: [
    { id: "demo.read", title: "Read", sideEffect: "read", defaultRule: "allow" },
    {
      id: "demo.write",
      title: "Write",
      sideEffect: "write",
      approvalKind: "connector_action",
      defaultRule: "ask",
    },
    { id: "demo.delete", title: "Delete", sideEffect: "destructive", defaultRule: "ask" },
  ],
  available: true,
};

function demoFactory(accounts: string[]): ConnectorFactory {
  return {
    entry,
    create: (record) => ({
      id: record.id,
      type: "demo",
      async connect(input) {
        return {
          account: accounts.shift() ?? "a@example.com",
          scopes: entry.scopes[input.scopeMode],
        };
      },
      async disconnect() {},
      actions: () => entry.actions,
      tools: () => [
        {
          name: "read",
          action: "demo.read",
          description: "r",
          inputSchema: { type: "object" },
          sideEffect: "read",
          execute: async () => ({ output: "ok", provenance: "untrusted" }),
        },
        {
          name: "write",
          action: "demo.write",
          description: "w",
          inputSchema: { type: "object" },
          sideEffect: "write",
          execute: async () => {
            throw new Error("network died");
          },
        },
      ],
      async health() {
        return { ok: true, status: "connected", checkedAt: 0 };
      },
    }),
  };
}

const make = (accounts = ["a@example.com"]) => {
  const events: ConnectorEvent[] = [];
  const registry = new ConnectorRegistry({
    factories: [demoFactory(accounts)],
    extraCatalogue: REMOTE_MCP_PRESETS,
    context: {
      clock: new FakeClock(),
      fetch,
      tokens: { load: async () => undefined, save: async () => {}, clear: async () => {} },
    },
    onEvent: (e) => events.push(e),
    newId: () => "demo-1",
  });
  return { registry, events };
};

describe("binding hash", () => {
  it("is order-independent, NFC-normalized and refuses ambiguous values", () => {
    expect(canonicalJSON({ b: 1, a: "é" })).toBe('{"a":"é","b":1}');
    expect(bindingHash("k", { a: 1, b: 2 })).toBe(bindingHash("k", { b: 2, a: 1 }));
    expect(bindingHash("k", { a: 1 })).not.toBe(bindingHash("j", { a: 1 }));
    expect(() => canonicalJSON({ x: Number.NaN })).toThrow();
    expect(() => canonicalJSON({ x: new Map() })).toThrow();
    expect(() => canonicalJSON({ é: 1, é: 2 })).toThrow(/collide/);
  });
});

describe("ConnectorRegistry", () => {
  it("connects with default matrix, lists catalogue presets, and refuses unknown connectors", async () => {
    const { registry } = make();
    const r = await registry.connect({ catalogueId: "demo", scopeMode: "read_act" });
    expect(r).toMatchObject({
      status: "connected",
      account: "a@example.com",
      actionMatrix: { "demo.read": "allow", "demo.write": "ask" },
    });
    expect(Value.Check(ConnectorSchema, toWire(r))).toBe(true);
    expect(registry.catalogue().map((e) => e.id)).toEqual([
      "demo",
      "slack",
      "notion",
      "linear",
      "github",
    ]);
    expect([...VERIFIED_MCP_HOSTS]).toContain("mcp.slack.com");
    await expect(
      registry.connect({ catalogueId: "slack", scopeMode: "read" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("emits invalidated on disconnect, account change and narrowing to read-only", async () => {
    const { registry, events } = make(["a@example.com", "a@example.com", "b@example.com"]);
    await registry.connect({ catalogueId: "demo", scopeMode: "read_act" });
    await registry.connect({ catalogueId: "demo", scopeMode: "read", connectorId: "demo-1" });
    await registry.connect({ catalogueId: "demo", scopeMode: "read", connectorId: "demo-1" });
    await registry.disconnect("demo-1");
    expect(
      events
        .filter((e) => e.type === "invalidated")
        .map((e) => e.type === "invalidated" && e.reason),
    ).toEqual(["scope_changed", "account_changed", "disconnected"]);
    await expect(registry.sync("demo-1")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("records an uncertain receipt when a write throws mid-flight", async () => {
    const receipts: unknown[] = [];
    const tools = new Map<string, { execute: (...a: unknown[]) => Promise<unknown> }>();
    const registry = new ConnectorRegistry({
      factories: [demoFactory([])],
      context: {
        clock: new FakeClock(),
        fetch,
        tokens: { load: async () => undefined, save: async () => {}, clear: async () => {} },
      },
      tools: {
        list: () => [],
        get: () => undefined,
        register: (r) => {
          tools.set(r.spec.name, r as never);
          return () => tools.delete(r.spec.name);
        },
      },
      broker: {
        verifyBinding: async () => ({ ok: true, approval: {} }),
        recordReceipt: async (i: unknown) => {
          receipts.push(i);
          return { id: "r1" };
        },
      } as never,
      approvalFor: () => "ap_1",
      newId: () => "demo-1",
    });
    await registry.connect({ catalogueId: "demo", scopeMode: "read_act" });
    await expect(
      tools.get("mcp__demo-1__write")?.execute("c1", {}, new AbortController().signal, () => {}),
    ).rejects.toThrow("network died");
    expect(receipts).toMatchObject([
      { kind: "demo.write", outcome: "uncertain", toolCallId: "c1" },
    ]);
  });
});

describe("connectors.* handlers", () => {
  it("validate params and return protocol-shaped connectors", async () => {
    const { registry } = make();
    const h = connectorHandlers(registry);
    expect((await h["connectors.catalogue"]({})).entries.length).toBe(5);
    const { connector } = await h["connectors.connect"]({
      catalogueId: "demo",
      scopeMode: "read_act",
    });
    expect(connector.id).toBe("demo-1");
    expect((await h["connectors.list"]({})).connectors).toHaveLength(1);
    expect(await h["connectors.status"]({ connectorId: "demo-1" })).toMatchObject({ ok: true });
    const set = await h["connectors.setMatrix"]({
      connectorId: "demo-1",
      matrix: { "demo.write": "deny" },
    });
    expect(set.connector.actionMatrix["demo.write"]).toBe("deny");
    await expect(
      h["connectors.setMatrix"]({ connectorId: "demo-1", matrix: { "demo.delete": "allow" } }),
    ).rejects.toMatchObject({ code: "policy_denied" });
    await expect(
      h["connectors.connect"]({ catalogueId: "demo", scopeMode: "write" }),
    ).rejects.toBeInstanceOf(PsycheError);
    expect((await h["connectors.disconnect"]({ connectorId: "demo-1" })).connector.status).toBe(
      "disconnected",
    );
  });
});

describe("write enforcement fails closed", () => {
  const setup = (opts: {
    approvalFor?: () => string | undefined;
    broker?: unknown;
    describe?: boolean;
  }) => {
    const tools = new Map<string, { execute: (...a: unknown[]) => Promise<unknown> }>();
    const verified: string[] = [];
    const factory: ConnectorFactory = {
      entry,
      create: (record) => ({
        id: record.id,
        type: "demo",
        connect: async () => ({ account: "a@example.com", scopes: [] }),
        disconnect: async () => {},
        actions: () => entry.actions,
        tools: () => [
          {
            name: "sneaky",
            action: "demo.read",
            description: "declared read, but this call deletes",
            inputSchema: { type: "object" },
            sideEffect: "read",
            ...(opts.describe === true
              ? { describeCall: () => ({ sideEffect: "destructive" as const }) }
              : {}),
            execute: async () => ({ output: "done", provenance: "untrusted" }),
          },
          {
            name: "write",
            action: "demo.write",
            description: "w",
            inputSchema: { type: "object" },
            sideEffect: "write",
            execute: async () => ({ output: "written", provenance: "untrusted" }),
          },
        ],
        health: async () => ({ ok: true, status: "connected", checkedAt: 0 }),
      }),
    };
    const registry = new ConnectorRegistry({
      factories: [factory],
      context: {
        clock: new FakeClock(),
        fetch,
        tokens: { load: async () => undefined, save: async () => {}, clear: async () => {} },
      },
      tools: {
        list: () => [],
        get: () => undefined,
        register: (r) => {
          tools.set(r.spec.name, r as never);
          return () => tools.delete(r.spec.name);
        },
      },
      ...(opts.broker === undefined
        ? {}
        : {
            broker: {
              verifyBinding: async (_id: string, hash: string) => {
                verified.push(hash);
                return { ok: true, approval: {} };
              },
              recordReceipt: async () => ({ id: "r" }),
            } as never,
          }),
      ...(opts.approvalFor === undefined ? {} : { approvalFor: opts.approvalFor }),
      newId: () => "demo-1",
    });
    const call = (name: string) =>
      registry
        .connect({ catalogueId: "demo", scopeMode: "read_act" })
        .then(() =>
          tools
            .get(`mcp__demo-1__${name}`)
            ?.execute("c", { x: 1 }, new AbortController().signal, () => {}),
        );
    return { call, verified };
  };

  it("an ask write with no approval resolver is refused", async () => {
    await expect(setup({}).call("write")).rejects.toMatchObject({ code: "approval_required" });
  });

  it("an approval without a broker to verify it is refused", async () => {
    await expect(setup({ approvalFor: () => "ap" }).call("write")).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("a write without describeCall is still verified, against the connector_action fallback", async () => {
    const { call, verified } = setup({ approvalFor: () => "ap", broker: true });
    await expect(call("write")).resolves.toMatchObject({ output: "written" });
    expect(verified).toEqual([
      bindingHash("connector_action", {
        connectorId: "demo-1",
        tool: "write",
        paramsHash: bindingHash("params", { x: 1 }),
      }),
    ]);
  });

  it("describeCall can raise a read tool to destructive, which then needs an approval", async () => {
    await expect(setup({ describe: true }).call("sneaky")).rejects.toMatchObject({
      code: "approval_required",
    });
    await expect(setup({}).call("sneaky")).resolves.toMatchObject({ output: "done" });
  });
});
