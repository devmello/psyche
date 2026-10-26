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
  "permissions.request",
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
  "safari.tabs",
  "safari.current_tab",
  "safari.tab_text",
  "safari.add_reading_list",
  "chrome.tabs",
  "chrome.current_tab",
  "music.now_playing",
  "music.control",
  "music.search_library",
  "music.play",
  "contacts.search",
  "contacts.read",
  "contacts.create",
  "contacts.update",
  "notes.search",
  "notes.folders",
  "notes.append",
  "notes.update",
  "reminders.complete",
  "reminders.set_flagged",
  "reminders.delete",
  "calendar.free_busy",
  "calendar.delete_event",
  "mail.mailboxes",
  "mail.selected",
  "mail.reply_draft",
  "mail.forward_draft",
  "mail.send_draft",
  "mail.set_flags",
  "mail.move",
  "mail.save_attachments",
];

class FakeHelper implements AppleHelper {
  readonly nodeId = "node_mac";
  readonly calls: Invocation[] = [];
  capabilities: string[] = [...ALL];
  refuse: { code: string; message: string; details?: Record<string, unknown> } | undefined;
  /** What macOS says about the grant (#549); a denied probe fails like the helper does. */
  grant: "granted" | "denied" | "notDetermined" | "notRunning" = "granted";
  /**
   * What asking does while the grant is not determined (#570): the owner allows or denies the
   * prompt, or no prompt appears and the request resolves denied (the helper bug S14 chases).
   * Unset: asking changes nothing.
   */
  prompt: "granted" | "denied" | "none" | undefined;
  #ask(): string {
    if (this.grant !== "notDetermined" || this.prompt === undefined) return this.grant;
    if (this.prompt === "none") return "denied";
    this.grant = this.prompt;
    return this.grant;
  }
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
            { permission: "contacts", status: this.grant },
          ],
        },
      };
    }
    if (capability === "permissions.open_settings") return { ok: true, result: { opened: true } };
    if (capability === "permissions.request") {
      return { ok: true, result: { permission: "reminders", status: this.#ask() } };
    }
    if (this.refuse) return { ok: false, error: this.refuse };
    // The adapters' first Apple Event asks for Automation.
    if (this.grant === "notDetermined") this.#ask();
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
  it("lists the available catalogue entries, one per app", () => {
    const entries = appleFactories({ helper: () => undefined }).map((f) => f.entry);
    expect(entries.map((e) => [e.type, e.id, e.available])).toEqual([
      ["apple:notes", "apple-notes", true],
      ["apple:reminders", "apple-reminders", true],
      ["apple:calendar", "apple-calendar", true],
      ["apple:mail", "apple-mail", true],
      ["apple:contacts", "apple-contacts", true],
      ["apple:music", "apple-music", true],
      ["apple:safari", "apple-safari", true],
      ["chrome:tabs", "chrome-tabs", true],
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
      scopes: ["notes.list", "notes.read", "notes.search", "notes.folders"],
      config: { nodeId: "node_mac" },
    });
    expect([...tools.keys()].sort()).toEqual([
      "mcp__apple-1__notes_folders",
      "mcp__apple-1__notes_list",
      "mcp__apple-1__notes_read",
      "mcp__apple-1__notes_search",
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

  it("mail_search lists unread mail since a date: no query needed, filters go to the helper (#626)", async () => {
    const helper = new FakeHelper();
    const { registry, tools, run } = make(helper);
    await registry.connect({ catalogueId: "apple-mail", scopeMode: "read" });
    helper.calls.length = 0;
    const tool = tools.get("mcp__apple-1__mail_search") as unknown as {
      spec: { inputSchema: { required?: string[]; properties: Record<string, unknown> } };
    };
    expect(tool.spec.inputSchema.required ?? []).toEqual([]);
    expect(Object.keys(tool.spec.inputSchema.properties)).toEqual(
      expect.arrayContaining(["query", "unread", "since", "until", "from"]),
    );
    const params = { unread: true, since: "2026-10-24T00:00:00Z", from: "billing@", limit: 10 };
    await run("mcp__apple-1__mail_search")(params);
    expect(helper.calls).toEqual([{ capability: "mail.search", params }]);
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
    // Already denied: macOS will not ask again, so nothing is requested and nothing opens.
    expect(helper.calls.map((c) => c.capability)).toEqual(["permissions.status"]);
    expect(events.at(-1)).toMatchObject({ type: "status", status: "needs_auth" });
  });

  it("asks for Reminders when macOS has not decided, and connects when the owner allows it", async () => {
    const helper = new FakeHelper();
    helper.grant = "notDetermined";
    helper.prompt = "granted";
    const { registry } = reg(helper);
    const r = await registry.connect({ catalogueId: "apple-reminders", scopeMode: "read" });
    expect(r.status).toBe("connected");
    expect(helper.calls.map((c) => [c.capability, c.params])).toEqual([
      ["permissions.status", {}],
      ["permissions.request", { permission: "reminders" }],
      ["reminders.list_lists", {}],
    ]);
  });

  it("says what the helper reported when asking showed no prompt (#570)", async () => {
    const helper = new FakeHelper();
    helper.grant = "notDetermined";
    helper.prompt = "none";
    const { registry } = reg(helper);
    const r = await registry.connect({ catalogueId: "apple-reminders", scopeMode: "read" });
    expect(r.status).toBe("needs_auth");
    expect(r.config.permission).toMatchObject({
      kind: "reminders",
      state: "notDetermined",
      requested: true,
      reason: 'macOS answered "denied"',
    });
    // Check again asks again (still not decided), without opening System Settings.
    helper.calls.length = 0;
    helper.prompt = "granted";
    const again = await registry.connect({
      catalogueId: "apple-reminders",
      scopeMode: "read",
      connectorId: r.id,
      config: { permissionAction: "check" },
    });
    expect(again.status).toBe("connected");
    expect(again.config.permission).toBeNull();
    expect(helper.calls.map((c) => c.capability)).toEqual([
      "permissions.status",
      "permissions.request",
      "reminders.list_lists",
    ]);
  });

  it("asks for Automation through the probe, not permissions.request", async () => {
    const helper = new FakeHelper();
    helper.grant = "notDetermined";
    helper.prompt = "granted";
    const { registry } = reg(helper);
    const r = await registry.connect({ catalogueId: "apple-notes", scopeMode: "read" });
    expect(r.status).toBe("connected");
    expect(helper.calls.map((c) => c.capability)).toEqual(["permissions.status", "notes.list"]);
  });

  it("flips to connected on the next status check once the owner allows it", async () => {
    const helper = new FakeHelper();
    helper.grant = "notDetermined";
    const { registry, events } = reg(helper);
    const r = await registry.connect({ catalogueId: "apple-notes", scopeMode: "read" });
    expect(r.config.permission).toMatchObject({ state: "notDetermined", requested: true });
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

  it("Open System Settings opens the pane only when macOS denied it", async () => {
    const helper = new FakeHelper();
    helper.grant = "denied";
    const { registry } = reg(helper);
    const r = await registry.connect({ catalogueId: "apple-mail", scopeMode: "read" });
    helper.calls.length = 0;
    await registry.connect({
      catalogueId: "apple-mail",
      scopeMode: "read",
      connectorId: r.id,
      config: { permissionAction: "check" },
    });
    expect(helper.calls.map((c) => c.capability)).toEqual(["permissions.status"]);
    helper.calls.length = 0;
    await registry.connect({
      catalogueId: "apple-mail",
      scopeMode: "read",
      connectorId: r.id,
      config: { permissionAction: "open_settings" },
    });
    expect(helper.calls.map((c) => [c.capability, c.params])).toEqual([
      ["permissions.status", { automationTargets: ["com.apple.mail"] }],
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

describe("Apple Mail wave 1 (#639)", () => {
  const mailTool = (name: string) =>
    appleFactories({ helper: () => new FakeHelper() })[3]
      ?.create({ id: "apple-1", type: "apple:mail" } as never, {} as never)
      .tools()
      .find((t) => t.name === name);

  it("offers reads in read-only mode and the organize, draft and send tools in read and act", async () => {
    const read = make(new FakeHelper());
    await read.registry.connect({ catalogueId: "apple-mail", scopeMode: "read" });
    expect([...read.tools.keys()].sort()).toEqual(
      ["mail_mailboxes", "mail_read", "mail_search", "mail_selected"].map(
        (t) => `mcp__apple-1__${t}`,
      ),
    );
    const act = make(new FakeHelper());
    await act.registry.connect({ catalogueId: "apple-mail", scopeMode: "read_act" });
    expect([...act.tools.keys()]).toEqual(
      expect.arrayContaining(
        [
          "mail_reply_draft",
          "mail_forward_draft",
          "mail_send_draft",
          "mail_set_flags",
          "mail_move",
          "mail_save_attachments",
        ].map((t) => `mcp__apple-1__${t}`),
      ),
    );
    expect(appleCatalogueEntry("mail").actions.map((a) => [a.id, a.defaultRule])).toEqual([
      ["mail.read", "allow"],
      ["mail.draft", "ask"],
      ["mail.organize", "ask"],
      ["mail.send", "ask"],
    ]);
  });

  it("reading tools pass straight through and their output is untrusted", async () => {
    const helper = new FakeHelper();
    const { registry, run } = make(helper);
    await registry.connect({ catalogueId: "apple-mail", scopeMode: "read" });
    helper.calls.length = 0;
    const out = (await run("mcp__apple-1__mail_selected")({ limit: 5 })) as unknown as {
      provenance: string;
    };
    expect(out.provenance).toBe("untrusted");
    await run("mcp__apple-1__mail_mailboxes")({});
    expect(helper.calls).toEqual([
      { capability: "mail.selected", params: { limit: 5 } },
      { capability: "mail.mailboxes", params: {} },
    ]);
  });

  it("organizing asks: refused without an approval, sent to the helper with it", async () => {
    const helper = new FakeHelper();
    const flags = { ids: ["41", "42"], read: true };
    const first = make(helper);
    await first.registry.connect({ catalogueId: "apple-mail", scopeMode: "read_act" });
    helper.calls.length = 0;
    await expect(first.run("mcp__apple-1__mail_set_flags")(flags)).rejects.toMatchObject({
      code: "approval_required",
    });
    expect(helper.calls).toEqual([]);
    const desc = mailTool("mail_move")?.describeCall?.({ ids: ["41"], to: "archive" });
    expect(desc).toMatchObject({ kind: "connector_action", bindingFields: { tool: "mail_move" } });
    const approved = make(helper, {
      id: "ap_m",
      tool: "mcp__apple-1__mail_move",
      params: { ids: ["41"], to: "archive" },
      desc,
    });
    await approved.registry.connect({ catalogueId: "apple-mail", scopeMode: "read_act" });
    helper.calls.length = 0;
    await approved.run("mcp__apple-1__mail_move")({ ids: ["41"], to: "archive" });
    expect(helper.calls).toEqual([
      { capability: "mail.move", params: { ids: ["41"], to: "archive" }, approvalId: "ap_m" },
    ]);
    expect(approved.receipts).toMatchObject([{ kind: "mail.organize", outcome: "ok" }]);
  });

  it("mail_send_draft binds the draft's recipients, subject and body hash; another draft fails", async () => {
    const helper = new FakeHelper();
    const draft = {
      draftId: "d-7",
      to: ["Dana@Example.org"],
      cc: ["boss@example.org"],
      subject: "Re: Offsite",
      bodySha256: "sha256:aaa",
    };
    const desc = mailTool("mail_send_draft")?.describeCall?.(draft);
    expect(desc).toMatchObject({
      kind: "send_email",
      target: { kind: "recipient", value: "boss@example.org,dana@example.org" },
      bindingFields: {
        to: ["dana@example.org"],
        cc: ["boss@example.org"],
        subject: "Re: Offsite",
        bodyHash: "sha256:aaa",
        draftId: "d-7",
      },
    });
    const { registry, run } = make(helper, {
      id: "ap_s",
      tool: "mcp__apple-1__mail_send_draft",
      params: draft,
      desc,
    });
    await registry.connect({ catalogueId: "apple-mail", scopeMode: "read_act" });
    helper.calls.length = 0;
    await expect(
      run("mcp__apple-1__mail_send_draft")({ ...draft, bodySha256: "sha256:bbb" }),
    ).rejects.toMatchObject({ code: "binding_mismatch" });
    await expect(
      run("mcp__apple-1__mail_send_draft")({ ...draft, draftId: "d-8" }),
    ).rejects.toMatchObject({ code: "binding_mismatch" });
    expect(helper.calls).toEqual([]);
    await run("mcp__apple-1__mail_send_draft")(draft);
    expect(helper.calls).toEqual([
      { capability: "mail.send_draft", params: draft, approvalId: "ap_s" },
    ]);
  });

  it("the catalogue scopes list the new capabilities by mode", () => {
    const e = appleCatalogueEntry("mail");
    expect(e.scopes.read).toEqual(
      expect.arrayContaining(["mail.search", "mail.read", "mail.mailboxes", "mail.selected"]),
    );
    expect(e.scopes.read).not.toContain("mail.move");
    expect(e.scopes.read_act).toEqual(
      expect.arrayContaining([
        "mail.send_draft",
        "mail.set_flags",
        "mail.move",
        "mail.save_attachments",
      ]),
    );
  });
});

describe("Apple Reminders and Calendar wave 1 (#639)", () => {
  const toolOf = (app: number, type: string, name: string) =>
    appleFactories({ helper: () => new FakeHelper() })
      [app]?.create({ id: "apple-1", type } as never, {} as never)
      .tools()
      .find((t) => t.name === name);

  it("adds delete groups that always ask, and keeps reads allowed", () => {
    expect(
      appleCatalogueEntry("reminders").actions.map((a) => [a.id, a.sideEffect, a.defaultRule]),
    ).toEqual([
      ["reminders.read", "read", "allow"],
      ["reminders.write", "write", "ask"],
      ["reminders.delete", "destructive", "ask"],
    ]);
    expect(
      appleCatalogueEntry("calendar").actions.map((a) => [a.id, a.sideEffect, a.approvalKind]),
    ).toEqual([
      ["calendar.read", "read", undefined],
      ["calendar.write", "write", "calendar_write"],
      ["calendar.delete", "destructive", "calendar_write"],
    ]);
  });

  it("reminders_list takes the due / overdue / flagged / text filters straight to the helper", async () => {
    const helper = new FakeHelper();
    const { registry, run } = make(helper);
    await registry.connect({ catalogueId: "apple-reminders", scopeMode: "read" });
    helper.calls.length = 0;
    const params = { dueToday: true, completed: false, flagged: true, query: "dentist" };
    await run("mcp__apple-1__reminders_list")(params);
    expect(helper.calls).toEqual([{ capability: "reminders.list", params }]);
  });

  it("reminders_create carries a mail link, an alarm and a recurrence; complete and delete ask", async () => {
    const create = toolOf(1, "apple:reminders", "reminders_create");
    expect(Object.keys((create?.inputSchema as { properties: object }).properties)).toEqual(
      expect.arrayContaining(["url", "alarm", "recurrence"]),
    );
    const helper = new FakeHelper();
    const { registry, run } = make(helper);
    await registry.connect({ catalogueId: "apple-reminders", scopeMode: "read_act" });
    await expect(run("mcp__apple-1__reminders_complete")({ id: "R1" })).rejects.toMatchObject({
      code: "approval_required",
    });
    await expect(run("mcp__apple-1__reminders_delete")({ id: "R1" })).rejects.toMatchObject({
      code: "approval_required",
    });
    const del = toolOf(1, "apple:reminders", "reminders_delete");
    expect(del?.sideEffect).toBe("destructive");
  });

  it("calendar_free_busy is a read; calendar_delete_event binds calendar_write and asks", async () => {
    const helper = new FakeHelper();
    const { registry, run } = make(helper);
    await registry.connect({ catalogueId: "apple-calendar", scopeMode: "read_act" });
    helper.calls.length = 0;
    const window = { from: "2026-10-26T00:00:00Z", to: "2026-10-31T00:00:00Z" };
    await run("mcp__apple-1__calendar_free_busy")(window);
    expect(helper.calls).toEqual([{ capability: "calendar.free_busy", params: window }]);
    expect(
      toolOf(2, "apple:calendar", "calendar_delete_event")?.describeCall?.({ id: "E1" }),
    ).toMatchObject({
      kind: "calendar_write",
      bindingFields: { tool: "calendar_delete_event" },
    });
    await expect(run("mcp__apple-1__calendar_delete_event")({ id: "E1" })).rejects.toMatchObject({
      code: "approval_required",
    });
    // Read-only connections never get the delete tool.
    const ro = make(new FakeHelper());
    await ro.registry.connect({ catalogueId: "apple-calendar", scopeMode: "read" });
    expect([...ro.tools.keys()]).not.toContain("mcp__apple-1__calendar_delete_event");
    expect([...ro.tools.keys()]).toContain("mcp__apple-1__calendar_free_busy");
  });

  it("the event tools say invitations go by mail", () => {
    expect(toolOf(2, "apple:calendar", "calendar_create_event")?.description).toMatch(
      /invitations go out by mail/,
    );
  });
});

describe("Apple Notes wave 1 (#639)", () => {
  const notesTool = (name: string) =>
    appleFactories({ helper: () => new FakeHelper() })[0]
      ?.create({ id: "apple-1", type: "apple:notes" } as never, {} as never)
      .tools()
      .find((t) => t.name === name);

  it("searches and lists folders as reads; append and update are an edit group that asks", async () => {
    expect(appleCatalogueEntry("notes").actions.map((a) => [a.id, a.defaultRule])).toEqual([
      ["notes.read", "allow"],
      ["notes.create", "ask"],
      ["notes.edit", "ask"],
    ]);
    const helper = new FakeHelper();
    const { registry, run } = make(helper);
    await registry.connect({ catalogueId: "apple-notes", scopeMode: "read_act" });
    helper.calls.length = 0;
    await run("mcp__apple-1__notes_search")({
      query: "offsite",
      modifiedSince: "2026-10-01T00:00:00Z",
    });
    expect(helper.calls).toEqual([
      {
        capability: "notes.search",
        params: { query: "offsite", modifiedSince: "2026-10-01T00:00:00Z" },
      },
    ]);
    await expect(
      run("mcp__apple-1__notes_append")({ id: "n1", text: "Decided: Lisbon" }),
    ).rejects.toMatchObject({ code: "approval_required" });
  });

  it("notes_update is bound to the note and the body the agent read", async () => {
    const edit = { id: "n1", previousBodySha256: "sha256:old", body: "New plan" };
    const desc = notesTool("notes_update")?.describeCall?.(edit);
    expect(desc).toMatchObject({
      kind: "connector_action",
      bindingFields: { tool: "notes_update", noteId: "n1", previousBodySha256: "sha256:old" },
    });
    const helper = new FakeHelper();
    const { registry, run } = make(helper, {
      id: "ap_n",
      tool: "mcp__apple-1__notes_update",
      params: edit,
      desc,
    });
    await registry.connect({ catalogueId: "apple-notes", scopeMode: "read_act" });
    helper.calls.length = 0;
    // Another base body (the note changed since it was read) is another approval.
    await expect(
      run("mcp__apple-1__notes_update")({ ...edit, previousBodySha256: "sha256:newer" }),
    ).rejects.toMatchObject({ code: "binding_mismatch" });
    await run("mcp__apple-1__notes_update")(edit);
    expect(helper.calls).toEqual([
      { capability: "notes.update", params: edit, approvalId: "ap_n" },
    ]);
  });

  it("notes_create can ask for Markdown", () => {
    const props = (
      notesTool("notes_create")?.inputSchema as { properties: Record<string, unknown> }
    ).properties;
    expect(props.format).toEqual({ type: "string", enum: ["text", "markdown"] });
  });
});

describe("Apple Contacts wave 1 (#639)", () => {
  it("is a single-instance Apple app whose grant is Contacts access", async () => {
    const e = appleCatalogueEntry("contacts");
    expect(e).toMatchObject({
      type: "apple:contacts",
      id: "apple-contacts",
      vendor: "Apple",
      singleInstance: true,
    });
    expect(e.actions.map((a) => [a.id, a.defaultRule])).toEqual([
      ["contacts.read", "allow"],
      ["contacts.write", "ask"],
    ]);
    const helper = new FakeHelper();
    helper.grant = "denied";
    const { registry } = make(helper);
    const r = await registry.connect({ catalogueId: "apple-contacts", scopeMode: "read" });
    expect(r.status).toBe("needs_auth");
    expect(r.config.permission).toMatchObject({
      kind: "contacts",
      settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts",
    });
  });

  it("looks people up as a read and adds them only with an approval", async () => {
    const helper = new FakeHelper();
    const { registry, run } = make(helper);
    await registry.connect({ catalogueId: "apple-contacts", scopeMode: "read_act" });
    helper.calls.length = 0;
    await run("mcp__apple-1__contacts_search")({ query: "Dana" });
    expect(helper.calls).toEqual([{ capability: "contacts.search", params: { query: "Dana" } }]);
    await expect(
      run("mcp__apple-1__contacts_create")({
        givenName: "Dana",
        emails: [{ label: "work", value: "dana@example.org" }],
      }),
    ).rejects.toMatchObject({ code: "approval_required" });
    await expect(
      run("mcp__apple-1__contacts_update")({
        id: "C1",
        addPhones: [{ label: "mobile", value: "+1 555 0100" }],
      }),
    ).rejects.toMatchObject({ code: "approval_required" });
  });
});

describe("Music and Spotify wave 1 (#639)", () => {
  it("reads now-playing and searches the library; playback control is allowed by default", async () => {
    const e = appleCatalogueEntry("music");
    expect(e.actions.map((a) => [a.id, a.sideEffect, a.defaultRule])).toEqual([
      ["music.read", "read", "allow"],
      ["music.control", "write", "allow"],
    ]);
    const helper = new FakeHelper();
    const { registry, run } = make(helper);
    await registry.connect({ catalogueId: "apple-music", scopeMode: "read_act" });
    helper.calls.length = 0;
    await run("mcp__apple-1__music_now_playing")({});
    await run("mcp__apple-1__music_search_library")({ query: "focus", kind: "playlist" });
    // No approval needed: the matrix allows playback (no data leaves the Mac).
    await run("mcp__apple-1__music_control")({ action: "pause", app: "spotify" });
    await run("mcp__apple-1__music_play")({ kind: "playlist", id: "PL1", shuffle: true });
    expect(helper.calls.map((c) => c.capability)).toEqual([
      "music.now_playing",
      "music.search_library",
      "music.control",
      "music.play",
    ]);
  });

  it("read-only connections get no playback control", async () => {
    const { registry, tools } = make(new FakeHelper());
    await registry.connect({ catalogueId: "apple-music", scopeMode: "read" });
    expect([...tools.keys()].sort()).toEqual([
      "mcp__apple-1__music_now_playing",
      "mcp__apple-1__music_search_library",
    ]);
  });
});

describe("Safari and Chrome wave 1 (#639)", () => {
  it("Safari reads tabs and page text (untrusted) and adds to the Reading List with an approval", async () => {
    const helper = new FakeHelper();
    const { registry, run } = make(helper);
    await registry.connect({ catalogueId: "apple-safari", scopeMode: "read_act" });
    helper.calls.length = 0;
    const out = (await run("mcp__apple-1__safari_tab_text")({ maxLength: 5000 })) as unknown as {
      provenance: string;
    };
    expect(out.provenance).toBe("untrusted");
    expect(helper.calls).toEqual([{ capability: "safari.tab_text", params: { maxLength: 5000 } }]);
    await expect(
      run("mcp__apple-1__safari_add_reading_list")({ url: "https://example.org/a" }),
    ).rejects.toMatchObject({ code: "approval_required" });
  });

  it("Chrome is a Google connector over the same helper route, read-only", async () => {
    const e = appleCatalogueEntry("chrome");
    expect(e).toMatchObject({
      type: "chrome:tabs",
      id: "chrome-tabs",
      vendor: "Google",
      singleInstance: true,
    });
    expect(e.scopes.read_act).toEqual(["chrome.tabs", "chrome.current_tab"]);
    const helper = new FakeHelper();
    helper.grant = "denied";
    const { registry } = make(helper);
    const r = await registry.connect({ catalogueId: "chrome-tabs", scopeMode: "read" });
    expect(r.config.permission).toMatchObject({ kind: "automation", target: "com.google.Chrome" });
  });
});
