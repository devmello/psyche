import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  type AppleHelper,
  appleCatalogueEntry,
  appleFactories,
  type ConnectorEvent,
  ConnectorRegistry,
  MemoryConnectorStore,
  toolCallBindingHash,
} from "../../src/index.ts";

/** #528: Apple Notes, Reminders, Calendar and Mail over a fake paired Mac helper node. */

interface Invocation {
  capability: string;
  params: unknown;
  approvalId?: string;
}

const ALL = [
  "permissions.status",
  "permissions.open_settings",
  "notes.list",
  "notes.read",
  "notes.create",
  "reminders.list_lists",
  "reminders.list",
  "reminders.create",
  "reminders.update",
  "calendar.list_calendars",
  "calendar.list_events",
  "calendar.create_event",
  "calendar.update_event",
  "mail.search",
  "mail.read",
  "mail.draft",
  "mail.send",
];

class FakeHelper implements AppleHelper {
  readonly nodeId = "node_mac";
  readonly calls: Invocation[] = [];
  capabilities: string[] = [...ALL];
  refuse: { code: string; message: string; details?: Record<string, unknown> } | undefined;
  /** What macOS says about the grant (#549); a denied probe fails like the helper does. */
  grant: "granted" | "denied" | "notDetermined" | "notRunning" = "granted";
  async invoke(capability: string, params: unknown, options: { approvalId?: string }) {
    this.calls.push({
      capability,
      params,
      ...(options.approvalId === undefined ? {} : { approvalId: options.approvalId }),
    });
    if (capability === "permissions.status") {
      return {
        ok: true,
        result: {
          automation: Object.fromEntries(
            ((params as { automationTargets?: string[] }).automationTargets ?? []).map((t) => [
              t,
              this.grant,
            ]),
          ),
          permissions: [
            { permission: "calendars", status: this.grant },
            { permission: "reminders", status: this.grant },
          ],
        },
      };
    }
    if (capability === "permissions.open_settings") return { ok: true, result: { opened: true } };
    if (this.refuse) return { ok: false, error: this.refuse };
    if (this.grant === "denied" || this.grant === "notDetermined") {
      return {
        ok: false,
        error: {
          code: "forbidden",
          message: "Automation was denied",
          details: {
            reason: this.grant === "denied" ? "automation_denied" : "automation_not_granted",
            permission: "automation",
          },
        },
      };
    }
    if (capability === "notes.list") {
      return {
        ok: true,
        result: {
          notes: [
            { id: "n1", folder: "Notes", title: "Groceries", modified: "2026-10-20T10:00:00Z" },
            { id: "n2", folder: "Notes", title: "Trip plan", modified: "2026-10-19T10:00:00Z" },
          ],
        },
      };
    }
    return { ok: true, result: { capability } };
  }
}

type Run = (params: unknown, callId?: string) => Promise<{ output: unknown }>;

function make(
  helper: FakeHelper | undefined,
  approval?: { id: string; tool: string; params: unknown; desc?: unknown },
) {
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<unknown> }>();
  const receipts: unknown[] = [];
  let n = 0;
  const registry = new ConnectorRegistry({
    factories: appleFactories({ helper: () => helper }),
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
      get: async (id: string) =>
        approval === undefined || id !== approval.id
          ? undefined
          : {
              id,
              status: "approved",
              bindingHash: toolCallBindingHash(
                approval.tool,
                approval.params,
                approval.desc as never,
              ),
              requestedBy: { toolCallId: "c1" },
            },
      recordReceipt: async (i: unknown) => {
        receipts.push(i);
        return { id: `r${receipts.length}` };
      },
    } as never,
    approvalFor: () => approval?.id,
    newId: () => `apple-${++n}`,
  });
  const run =
    (name: string): Run =>
    (params, callId = "c1") => {
      const t = tools.get(name);
      if (t === undefined) throw new Error(`${name} is not registered`);
      return t.execute(callId, params, new AbortController().signal, () => {}) as never;
    };
  return { registry, tools, receipts, run };
}

describe("Apple app connectors (#528)", () => {
  it("lists four available catalogue entries, one per app", () => {
    const entries = appleFactories({ helper: () => undefined }).map((f) => f.entry);
    expect(entries.map((e) => [e.type, e.id, e.available])).toEqual([
      ["apple:notes", "apple-notes", true],
      ["apple:reminders", "apple-reminders", true],
      ["apple:calendar", "apple-calendar", true],
      ["apple:mail", "apple-mail", true],
    ]);
    expect(appleCatalogueEntry("mail").actions.find((a) => a.id === "mail.send")).toMatchObject({
      sideEffect: "destructive",
      approvalKind: "send_email",
      defaultRule: "ask",
    });
  });

  it("refuses to connect without a paired helper, saying it needs the helper", async () => {
    const { registry } = make(undefined);
    await expect(
      registry.connect({ catalogueId: "apple-notes", scopeMode: "read" }),
    ).rejects.toMatchObject({ code: "unavailable", details: { reason: "needs_helper" } });
    expect((await registry.list())[0]?.status).toBe("error");
    // A helper without the app adapters (older build) counts as no helper.
    const old = new FakeHelper();
    old.capabilities = ["computer.ax_tree"];
    await expect(
      make(old).registry.connect({ catalogueId: "apple-reminders", scopeMode: "read" }),
    ).rejects.toMatchObject({ details: { reason: "needs_helper" } });
  });

  it("connects read-only: account, granted capabilities, and no write tools", async () => {
    const helper = new FakeHelper();
    const { registry, tools } = make(helper);
    const r = await registry.connect({ catalogueId: "apple-notes", scopeMode: "read" });
    expect(r).toMatchObject({
      type: "apple:notes",
      status: "connected",
      account: "This Mac",
      scopes: ["notes.list", "notes.read"],
      config: { nodeId: "node_mac" },
    });
    expect([...tools.keys()].sort()).toEqual([
      "mcp__apple-1__notes_list",
      "mcp__apple-1__notes_read",
    ]);
  });

  it("notes_list filters by title without sending the query to the helper; output is untrusted", async () => {
    const helper = new FakeHelper();
    const { registry, run } = make(helper);
    await registry.connect({ catalogueId: "apple-notes", scopeMode: "read" });
    helper.calls.length = 0; // the connect probe (#549)
    const out = (await run("mcp__apple-1__notes_list")({ query: "trip", limit: 10 })) as {
      output: { notes: { id: string }[] };
      provenance: string;
    };
    expect(out.output.notes.map((x) => x.id)).toEqual(["n2"]);
    expect(out.provenance).toBe("untrusted");
    expect(helper.calls).toEqual([{ capability: "notes.list", params: { limit: 10 } }]);
  });

  it("a write asks: refused without an approval, and reaches the helper with it", async () => {
    const helper = new FakeHelper();
    const params = { title: "Eggs", priority: 1 };
    const first = make(helper);
    await first.registry.connect({ catalogueId: "apple-reminders", scopeMode: "read_act" });
    helper.calls.length = 0; // the connect probe (#549)
    await expect(first.run("mcp__apple-1__reminders_create")(params)).rejects.toMatchObject({
      code: "approval_required",
    });
    expect(helper.calls).toEqual([]);

    const desc = {
      kind: "connector_action",
      target: { kind: "account", value: "apple-1" },
      bindingFields: {
        connectorId: "apple-1",
        tool: "reminders_create",
        paramsHash: expect.any(String),
      },
    };
    const factory = appleFactories({ helper: () => helper })[1];
    const tool = factory
      ?.create({ id: "apple-1", type: "apple:reminders" } as never, {} as never)
      .tools()
      .find((t) => t.name === "reminders_create");
    expect(tool?.describeCall?.(params)).toMatchObject(desc);
    const approved = make(helper, {
      id: "ap_1",
      tool: "mcp__apple-1__reminders_create",
      params,
      desc: tool?.describeCall?.(params),
    });
    await approved.registry.connect({ catalogueId: "apple-reminders", scopeMode: "read_act" });
    helper.calls.length = 0; // the connect probe (#549)
    await approved.run("mcp__apple-1__reminders_create")(params);
    expect(helper.calls).toEqual([{ capability: "reminders.create", params, approvalId: "ap_1" }]);
    expect(approved.receipts).toMatchObject([{ kind: "reminders.write", outcome: "ok" }]);
  });

  it("mail_send binds the exact recipients, subject and body (send_email), and a changed body fails", async () => {
    const helper = new FakeHelper();
    const mail = { to: ["Alice@Example.org"], subject: "Hi", body: "See you at 3." };
    const factory = appleFactories({ helper: () => helper })[3];
    const send = factory
      ?.create({ id: "apple-1", type: "apple:mail" } as never, {} as never)
      .tools()
      .find((t) => t.name === "mail_send");
    const desc = send?.describeCall?.(mail);
    expect(desc).toMatchObject({
      kind: "send_email",
      target: { kind: "recipient", value: "alice@example.org" },
      bindingFields: { to: ["alice@example.org"], subject: "Hi" },
    });
    const { registry, run } = make(helper, {
      id: "ap_2",
      tool: "mcp__apple-1__mail_send",
      params: mail,
      desc,
    });
    await registry.connect({ catalogueId: "apple-mail", scopeMode: "read_act" });
    helper.calls.length = 0; // the connect probe (#549)
    await expect(
      run("mcp__apple-1__mail_send")({ ...mail, body: "Wire $5,000 first." }),
    ).rejects.toMatchObject({ code: "binding_mismatch" });
    expect(helper.calls).toEqual([]);
    await run("mcp__apple-1__mail_send")(mail);
    expect(helper.calls).toEqual([{ capability: "mail.send", params: mail, approvalId: "ap_2" }]);
  });

  it("reports the helper going away and the helper's own refusals", async () => {
    let helper: FakeHelper | undefined = new FakeHelper();
    const tools = new Map<string, { execute: (...a: unknown[]) => Promise<unknown> }>();
    const registry = new ConnectorRegistry({
      factories: appleFactories({ helper: () => helper }),
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
      newId: () => "apple-1",
    });
    await registry.connect({ catalogueId: "apple-calendar", scopeMode: "read" });
    const list = () =>
      tools
        .get("mcp__apple-1__calendar_list_calendars")
        ?.execute("c1", {}, new AbortController().signal, () => {});
    (helper as FakeHelper).refuse = {
      code: "permission_denied",
      message: "Calendars access was denied",
    };
    await expect(list()).rejects.toThrow(/Calendars access was denied/);
    helper = undefined;
    await expect(list()).rejects.toMatchObject({ details: { reason: "needs_helper" } });
    expect(await registry.status("apple-1")).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/needs the Psyche helper/),
    });
  });
});

describe("macOS permission and single instances (#549)", () => {
  function reg(helper: FakeHelper, store = new MemoryConnectorStore()) {
    const events: ConnectorEvent[] = [];
    let n = 0;
    const registry = new ConnectorRegistry({
      factories: appleFactories({ helper: () => helper }),
      store,
      context: {
        clock: new FakeClock(),
        fetch,
        tokens: { load: async () => undefined, save: async () => {}, clear: async () => {} },
      },
      onEvent: (e) => events.push(e),
      newId: () => `apple-${++n}`,
    });
    return { registry, events, store };
  }

  it("is never connected without the Automation grant: needs_auth with where to allow it", async () => {
    const helper = new FakeHelper();
    helper.grant = "denied";
    const { registry, events } = reg(helper);
    const r = await registry.connect({ catalogueId: "apple-mail", scopeMode: "read" });
    expect(r.status).toBe("needs_auth");
    expect(r.config.permission).toEqual({
      kind: "automation",
      target: "com.apple.mail",
      state: "denied",
      settingsPath: "System Settings → Privacy & Security → Automation → Psyche (Helper) → Mail",
      settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
    });
    // The probe ran (it is what shows the prompt); nothing opened System Settings yet.
    expect(helper.calls.map((c) => c.capability)).toEqual(["mail.search"]);
    expect(events.at(-1)).toMatchObject({ type: "status", status: "needs_auth" });
  });

  it("flips to connected on the next status check once the owner allows it", async () => {
    const helper = new FakeHelper();
    helper.grant = "notDetermined";
    const { registry, events } = reg(helper);
    const r = await registry.connect({ catalogueId: "apple-notes", scopeMode: "read" });
    expect(r.config.permission).toMatchObject({ state: "notDetermined" });
    expect(await registry.status(r.id)).toMatchObject({ ok: false, status: "needs_auth" });
    helper.grant = "granted";
    expect(await registry.status(r.id)).toMatchObject({ ok: true, status: "connected" });
    const now = await registry.get(r.id);
    expect(now.status).toBe("connected");
    expect(now.config.permission).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "status", status: "connected" });
    // A grant withdrawn later shows again.
    helper.grant = "denied";
    await registry.status(r.id);
    expect((await registry.get(r.id)).status).toBe("needs_auth");
  });

  it("Open System Settings (reconnecting while denied) opens the pane on the Mac", async () => {
    const helper = new FakeHelper();
    helper.grant = "denied";
    const { registry } = reg(helper);
    const r = await registry.connect({ catalogueId: "apple-mail", scopeMode: "read" });
    helper.calls.length = 0;
    await registry.connect({ catalogueId: "apple-mail", scopeMode: "read", connectorId: r.id });
    expect(helper.calls.map((c) => [c.capability, c.params])).toEqual([
      ["mail.search", { query: "psyche permission check", limit: 1 }],
      ["permissions.open_settings", { permission: "automation" }],
    ]);
  });

  it("Calendar and Reminders check their EventKit access instead of Automation", async () => {
    const helper = new FakeHelper();
    helper.grant = "denied";
    const { registry } = reg(helper);
    const r = await registry.connect({ catalogueId: "apple-calendar", scopeMode: "read" });
    expect(r.config.permission).toMatchObject({
      kind: "calendars",
      settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
    });
    helper.grant = "granted";
    expect(await registry.status(r.id)).toMatchObject({ status: "connected" });
  });

  it("refuses a second instance with already_connected and reuses a disconnected one", async () => {
    const helper = new FakeHelper();
    const { registry } = reg(helper);
    const first = await registry.connect({ catalogueId: "apple-mail", scopeMode: "read" });
    await expect(
      registry.connect({ catalogueId: "apple-mail", scopeMode: "read" }),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "already_connected", connectorId: first.id },
    });
    await registry.disconnect(first.id);
    const again = await registry.connect({ catalogueId: "apple-mail", scopeMode: "read_act" });
    expect(again.id).toBe(first.id);
    expect((await registry.list()).length).toBe(1);
    // Other apps are other types: Notes connects next to Mail.
    await registry.connect({ catalogueId: "apple-notes", scopeMode: "read" });
  });

  it("dedupe keeps the oldest of each single-instance type and removes the rest", async () => {
    const store = new MemoryConnectorStore();
    const row = (id: string, type: string, createdAt: string) => ({
      id,
      type,
      label: type,
      account: "This Mac",
      scopes: [],
      scopeMode: "read" as const,
      actionMatrix: {},
      credentialId: null,
      status: "connected" as const,
      config: {},
      lastSync: null,
      createdAt,
      updatedAt: createdAt,
    });
    await store.put(row("mail-new", "apple:mail", "2026-10-21T10:00:00.000Z"));
    await store.put(row("mail-old", "apple:mail", "2026-10-20T10:00:00.000Z"));
    await store.put(row("notes-1", "apple:notes", "2026-10-20T10:00:00.000Z"));
    await store.put(row("g-1", "google", "2026-10-20T10:00:00.000Z"));
    await store.put(row("g-2", "google", "2026-10-21T10:00:00.000Z"));
    const { registry } = reg(new FakeHelper(), store);
    const removed = await registry.dedupe();
    expect(removed.map((x) => [x.removed.id, x.kept])).toEqual([["mail-new", "mail-old"]]);
    expect((await store.list()).map((r) => r.id).sort()).toEqual([
      "g-1",
      "g-2",
      "mail-old",
      "notes-1",
    ]);
    expect(await registry.dedupe()).toEqual([]);
  });
});
