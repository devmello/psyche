import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  type AppleHelper,
  appleAppOf,
  appleCatalogueEntry,
  appleFactories,
  CalendarWatch,
  ConnectorRegistry,
  helperOffersApp,
} from "../../src/index.ts";

/**
 * Mail, Calendar, Contacts and Reminders on Windows: the same connectors over the Windows
 * helper, which serves them from classic Outlook (apps/win-helper `src/outlook/`). The fake
 * helper advertises what `psyche-helper --manifest` lists with classic Outlook installed.
 */

const OUTLOOK = [
  "mail.mailboxes",
  "mail.search",
  "mail.read",
  "mail.selected",
  "mail.draft",
  "mail.reply_draft",
  "mail.forward_draft",
  "mail.send_draft",
  "mail.send",
  "mail.move",
  "mail.set_flags",
  "mail.save_attachments",
  "calendar.list_calendars",
  "calendar.list_events",
  "calendar.create_event",
  "calendar.update_event",
  "calendar.delete_event",
  "calendar.free_busy",
  "calendar.watch",
  "contacts.list",
  "contacts.read",
  "contacts.search",
  "contacts.create",
  "contacts.update",
  "reminders.list_lists",
  "reminders.list",
  "reminders.create",
  "reminders.update",
  "reminders.complete",
  "reminders.delete",
  "reminders.set_flagged",
];
/** What the Windows helper always advertises (no Outlook needed). */
const BASE = [
  "permissions.status",
  "permissions.request",
  "permissions.open_settings",
  "apps.list",
  "computer.click",
  "files.trash",
  "files.move",
  "files.rename",
  "files.recent",
  "finder.list",
  "finder.reveal",
  "chrome.tabs",
  "chrome.current_tab",
  "health",
];

type Answer = Awaited<ReturnType<AppleHelper["invoke"]>>;

class WindowsHelper implements AppleHelper {
  readonly nodeId = "node_win";
  readonly platform = "windows" as const;
  capabilities: string[];
  readonly calls: { capability: string; params: unknown }[] = [];
  answers: Record<string, Answer> = {};
  constructor(outlook = true) {
    this.capabilities = outlook ? [...BASE, ...OUTLOOK] : [...BASE];
  }
  async invoke(capability: string, params: unknown): Promise<Answer> {
    this.calls.push({ capability, params });
    return this.answers[capability] ?? { ok: true, result: { capability } };
  }
}

const GUARD: Answer = {
  ok: false,
  error: {
    code: "forbidden",
    message: "Outlook would show a prompt",
    details: { reason: "outlook_object_model_guard", permission: "automation" },
  },
};

function make(helper: AppleHelper | undefined) {
  const tools = new Map<
    string,
    {
      spec: { description: string; inputSchema: Record<string, unknown> };
      execute: (...a: unknown[]) => Promise<unknown>;
    }
  >();
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
    broker: { get: async () => undefined, recordReceipt: async () => ({ id: "r1" }) } as never,
    approvalFor: () => undefined,
    newId: () => `apple-${++n}`,
  });
  const run = (name: string) => (params: unknown) => {
    const t = tools.get(name);
    if (t === undefined) throw new Error(`${name} is not registered`);
    return t.execute("c1", params, new AbortController().signal, () => {}) as Promise<{
      output: unknown;
    }>;
  };
  return { registry, tools, run };
}

describe("Outlook through the Windows helper", () => {
  it("lists Outlook's names, Microsoft as the vendor, under the same types", () => {
    const entries = appleFactories({ helper: () => new WindowsHelper() }).map((f) => f.entry);
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(
      ["apple-mail", "apple-calendar", "apple-contacts", "apple-reminders"].map((id) => {
        const e = byId.get(id);
        return [e?.type, e?.label, e?.vendor];
      }),
    ).toEqual([
      ["apple:mail", "Outlook Mail", "Microsoft"],
      ["apple:calendar", "Outlook Calendar", "Microsoft"],
      ["apple:contacts", "Outlook Contacts", "Microsoft"],
      ["apple:reminders", "Outlook Tasks", "Microsoft"],
    ]);
    for (const id of ["apple-mail", "apple-calendar", "apple-contacts", "apple-reminders"]) {
      const e = byId.get(id);
      expect(e?.description).not.toMatch(/Mac|Apple/);
      expect(e?.setupGuide).toBe("docs/guides/connectors.md#outlook-on-windows");
    }
    expect(byId.get("apple-files")?.label).toBe("Files on this PC");
  });

  it("keeps the Mac's catalogue as it was", () => {
    const mail = appleCatalogueEntry("mail");
    expect([mail.label, mail.vendor, mail.setupGuide]).toEqual([
      "Apple Mail",
      "Apple",
      "docs/guides/connectors.md#apple-apps-on-your-mac",
    ]);
    const entries = appleFactories({ helper: () => undefined }).map((f) => f.entry);
    expect(entries.find((e) => e.id === "apple-reminders")?.label).toBe("Apple Reminders");
  });

  it("is offered only while the helper serves Outlook (classic Outlook installed)", () => {
    const withOutlook = new WindowsHelper(true);
    const without = new WindowsHelper(false);
    for (const app of ["mail", "calendar", "contacts", "reminders"] as const) {
      expect(helperOffersApp(app, withOutlook), app).toBe(true);
      expect(helperOffersApp(app, without), app).toBe(false);
    }
    // Chrome tabs and shared folders need no Outlook; the Mac-only apps are never served.
    expect(helperOffersApp("chrome", without)).toBe(true);
    expect(helperOffersApp("files", without)).toBe(true);
    for (const app of ["notes", "music", "safari", "shortcuts", "things"] as const) {
      expect(helperOffersApp(app, withOutlook), app).toBe(false);
    }
    expect(helperOffersApp("mail", undefined)).toBe(false);
    expect(appleAppOf("apple-mail")).toBe("mail");
    expect(appleAppOf("chrome-tabs")).toBe("chrome");
    expect(appleAppOf("google")).toBeUndefined();
  });

  it("connects Mail by reading Outlook's folders, with no grant to ask for", async () => {
    const helper = new WindowsHelper();
    const { registry } = make(helper);
    const r = await registry.connect({ catalogueId: "apple-mail", scopeMode: "read" });
    expect(r).toMatchObject({
      type: "apple:mail",
      label: "Outlook Mail",
      status: "connected",
      account: "This PC",
      config: { nodeId: "node_win", platform: "windows", permission: null },
    });
    // `mail.selected` answers [] without starting Outlook: it would prove nothing.
    expect(helper.calls).toEqual([{ capability: "mail.mailboxes", params: {} }]);
  });

  it("says classic Outlook is needed when the helper serves none of it", async () => {
    const { registry } = make(new WindowsHelper(false));
    await expect(
      registry.connect({ catalogueId: "apple-calendar", scopeMode: "read" }),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("classic Outlook"),
      details: { reason: "needs_helper" },
    });
  });

  it("describes the tools as Outlook serves them: no message:// links, long ids, three emails", async () => {
    const helper = new WindowsHelper();
    const { registry, tools } = make(helper);
    for (const app of ["mail", "calendar", "contacts", "reminders"]) {
      await registry.connect({ catalogueId: `apple-${app}`, scopeMode: "read_act" });
    }
    const specs = [...tools.values()].map((t) => t.spec);
    expect(specs.length).toBeGreaterThan(20);
    for (const s of specs) {
      expect(s.description).not.toMatch(/message:\/\/|the Mail app|the Calendar app|on your Mac/);
    }
    const spec = (name: string) => [...tools.entries()].find(([k]) => k.endsWith(name))?.[1].spec;
    expect(spec("__mail_selected")?.description).toContain("Outlook");
    const props = (name: string) =>
      spec(name)?.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props("__mail_set_flags").ids).toMatchObject({ items: { maxLength: 4_000 } });
    expect(props("__contacts_create").emails).toMatchObject({ maxItems: 3 });
    expect(spec("__contacts_update")?.description).toContain("3 emails");
  });

  it("passes Outlook's search through as it is: source outlook, no links", async () => {
    const helper = new WindowsHelper();
    const result = {
      messages: [{ id: `ol1.${"A".repeat(300)}.${"B".repeat(60)}`, subject: "Invoice" }],
      truncated: false,
      source: "outlook",
    };
    helper.answers["mail.search"] = { ok: true, result };
    const { registry, run } = make(helper);
    await registry.connect({ catalogueId: "apple-mail", scopeMode: "read" });
    const out = await run("mcp__apple-1__mail_search")({ unread: true });
    expect(out.output).toEqual(result);
  });

  it("explains Outlook's object model guard instead of the Mac's Automation steps", async () => {
    const helper = new WindowsHelper();
    const { registry, run } = make(helper);
    await registry.connect({ catalogueId: "apple-mail", scopeMode: "read" });
    helper.answers["mail.read"] = GUARD;
    const err = await run("mcp__apple-1__mail_read")({ id: "ol1.x.y" }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "unavailable",
      message: expect.stringMatching(/^Outlook Mail: .*antivirus.*Trust Center/),
      details: { capability: "mail.read", reason: "outlook_object_model_guard" },
    });
    expect((err as Error).message).not.toMatch(/System Settings|Automation/);
    // Not a macOS grant the agent could ask the owner for.
    expect((err as { details: Record<string, unknown> }).details.missing).toBeUndefined();
  });

  it("waits on Outlook's guard at connect with Trust Center steps and no System Settings link", async () => {
    const helper = new WindowsHelper();
    helper.answers["reminders.list_lists"] = GUARD;
    const { registry } = make(helper);
    const r = await registry.connect({ catalogueId: "apple-reminders", scopeMode: "read" });
    expect(r.status).toBe("needs_auth");
    const permission = r.config.permission as Record<string, unknown>;
    expect(permission).toMatchObject({
      state: "denied",
      settingsPath: expect.stringContaining("Trust Center"),
      reason: expect.stringContaining("antivirus"),
    });
    expect(permission.settingsUrl).toBeUndefined();
    expect(permission.target).toBeUndefined();
    // Nothing to open in Windows Settings, and no permission request.
    expect(helper.calls.map((c) => c.capability)).toEqual(["reminders.list_lists"]);
    // Once Outlook answers, the next status check turns it Connected.
    delete helper.answers["reminders.list_lists"];
    expect(await registry.status(r.id)).toMatchObject({ status: "connected" });
  });
});

describe("calendar.watch", () => {
  /** A helper whose watch streams the given events, then ends (Outlook quit). */
  class WatchHelper implements AppleHelper {
    readonly nodeId = "node_win";
    readonly platform = "windows" as const;
    capabilities = ["calendar.watch"];
    subscriptions = 0;
    streams: unknown[][] = [];
    async invoke(
      _capability: string,
      _params: unknown,
      options: { signal?: AbortSignal; onEvent?: (data: unknown) => void },
    ): Promise<Answer> {
      this.subscriptions += 1;
      const events = this.streams.shift();
      if (events === undefined) {
        // Held open until the watch stops.
        await new Promise<void>((resolve) =>
          options.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { ok: false, error: { code: "cancelled", message: "aborted" } };
      }
      for (const e of events) options.onEvent?.(e);
      return { ok: true, result: { sent: events.length } };
    }
  }

  it("reports changes and subscribes again when the stream ends", async () => {
    const helper = new WatchHelper();
    helper.streams = [
      [{ type: "calendar.changed", at: "2026-11-05T10:00:00Z", coalesced: 2 }, { type: "other" }],
      [],
      [{ type: "calendar.changed", at: "2026-11-05T11:00:00Z", coalesced: 1 }],
    ];
    const changes: unknown[] = [];
    const waits: number[] = [];
    let t = 0;
    const watch = new CalendarWatch({
      helper: () => helper,
      onChange: (c) => changes.push(c),
      retryMs: 1_000,
      maxRetryMs: 4_000,
      now: () => t,
      wait: async (ms) => {
        waits.push(ms);
        t += ms;
      },
    });
    watch.start();
    await expect.poll(() => helper.subscriptions).toBe(4);
    await watch.stop();
    expect(changes).toEqual([
      { at: "2026-11-05T10:00:00Z", coalesced: 2 },
      { at: "2026-11-05T11:00:00Z", coalesced: 1 },
    ]);
    // Streams that end at once back off, doubling from 1 s, capped at 4 s.
    expect(waits).toEqual([2_000, 4_000, 4_000]);
  });

  it("subscribes only while a helper serves it and something listens", async () => {
    const helper = new WatchHelper();
    let wanted = false;
    let present = false;
    const waits: number[] = [];
    const watch = new CalendarWatch({
      helper: () => (present ? helper : undefined),
      wanted: async () => wanted,
      onChange: () => {},
      retryMs: 1_000,
      wait: async (ms) => {
        waits.push(ms);
        if (waits.length === 2) present = true;
        if (waits.length === 4) wanted = true;
      },
    });
    watch.start();
    await expect.poll(() => helper.subscriptions).toBe(1);
    expect(waits).toEqual([1_000, 1_000, 1_000, 1_000]);
    await watch.stop();
  });
});
