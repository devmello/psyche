import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectorRecord } from "@psyche/connectors";
import { appleAdapters, type SourceAdapter } from "@psyche/search";
import { FakeModelProvider } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { composeGateway } from "../src/compose/index.ts";
import { appleSearchSeams } from "../src/compose/search-apple.ts";
import { appleWorkSources } from "../src/compose/work.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient } from "./helpers.ts";

/**
 * Search's Mail, Calendar and Reminders sources (and Memory → Work's reminders) on a host without
 * the Apple apps: on Windows they read Outlook through the Windows helper when it is connected,
 * else the Microsoft 365 and Google connections, and Notes and Messages are not offered at all.
 * Reminders read every backend, To Do included, on any host.
 */

const NOW = Date.UTC(2026, 10, 5, 18, 0, 0);
type Obj = Record<string, unknown>;

const rec = (id: string, type: string, account: string | null): ConnectorRecord => ({
  id,
  type,
  label: type === "google" ? "Google" : type === "microsoft" ? "Microsoft 365" : "Apple Reminders",
  account,
  scopes: [],
  scopeMode: "read",
  actionMatrix: {},
  credentialId: null,
  status: "connected",
  config: {},
  lastSync: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

function seams(
  records: ConnectorRecord[],
  tools: Record<string, (p: Obj) => unknown>,
  platform: string,
) {
  const calls: { name: string; params: Obj }[] = [];
  const s = appleSearchSeams({
    connectors: async () => records,
    tools: {
      get: (name: string) => {
        const fn = tools[name];
        if (fn === undefined) return undefined;
        return {
          spec: { name } as never,
          execute: async (_id: string, params: unknown) => {
            calls.push({ name, params: params as Obj });
            return { output: fn(params as Obj), provenance: "untrusted" as const };
          },
        } as never;
      },
    },
    messages: () => undefined,
    platform,
    now: () => NOW,
  });
  return { s, calls };
}

const signal = new AbortController().signal;
const byId = (adapters: SourceAdapter[], id: string) =>
  adapters.find((a) => a.id === id) as SourceAdapter;

const OUTLOOK_INBOX = [
  {
    id: "m1",
    subject: "Q4 roadmap",
    from: "Maya <maya@example.com>",
    to: "owner@contoso.example",
    date: "2026-11-05T15:00:00Z",
  },
  // Newer than the search's `until`: Outlook's day-wide range is cut back.
  { id: "m-late", subject: "Too new", from: "x@example.com", date: "2026-11-05T19:00:00Z" },
];
const OUTLOOK_SENT = [
  {
    id: "m2",
    subject: "Re: Q4 roadmap",
    from: "Owner <owner@contoso.example>",
    to: "maya@example.com",
    date: "2026-11-05T16:00:00Z",
  },
];

const TOOLS: Record<string, (p: Obj) => unknown> = {
  "mcp__ms-1__mail_search_messages": (p) => ({
    messages: p.mailbox === "sent" ? OUTLOOK_SENT : OUTLOOK_INBOX,
    nextPageToken: null,
  }),
  "mcp__ms-1__mail_read_message": (p) => ({
    from: "Maya <maya@example.com>",
    to: "owner@contoso.example",
    cc: "",
    body: `body of ${String(p.id)}`,
  }),
  "mcp__ms-1__calendar_list_events": () => ({
    events: [
      {
        id: "e1",
        status: "confirmed",
        summary: "Dentist",
        description: "Bring the form",
        location: "Main St",
        start: { dateTime: "2026-11-06T17:00:00Z" },
        end: { dateTime: "2026-11-06T18:00:00Z" },
        organizer: "owner@contoso.example",
        attendees: [{ email: "dr@example.com", responseStatus: "accepted" }],
        htmlLink: "https://outlook.office.com/calendar/item/e1",
      },
      {
        id: "gone",
        status: "cancelled",
        summary: "x",
        start: { dateTime: "2026-11-07T17:00:00Z" },
      },
    ],
  }),
  "mcp__ms-1__reminders_list": (p) => ({
    reminders: [
      {
        id: "L1|t1",
        listId: "L1",
        list: "Tasks",
        title: "Renew passport",
        due: "2026-11-07T08:00:00Z",
        completed: false,
        shared: false,
        source: "Microsoft To Do",
      },
      {
        id: "L2|t2",
        listId: "L2",
        list: "Family",
        title: "Book flights",
        due: null,
        completed: false,
        shared: true,
        source: "Microsoft To Do",
      },
    ].filter((r) => p.completed !== true || r.completed),
  }),
  "mcp__ms-1__reminders_list_lists": () => ({
    lists: [{ id: "L1", title: "Tasks", shared: false, source: "Microsoft To Do" }],
  }),
  "mcp__google-1__gmail_search_threads": () => ({
    threads: [
      {
        id: "th1",
        subject: "Dinner",
        from: "Ana <ana@example.com>",
        date: "Thu, 05 Nov 2026 12:00:00 +0000",
        labelIds: ["INBOX"],
      },
    ],
    nextPageToken: null,
  }),
  "mcp__google-1__gmail_read_thread": () => ({
    messages: [{ from: "Ana <ana@example.com>", to: "owner@gmail.example", body: "Friday?" }],
  }),
  "mcp__google-1__calendar_list_events": () => ({ events: [] }),
};

describe("Search sources on Windows", () => {
  it("offers no Notes or Messages row, and says what would feed the others", async () => {
    const { s } = seams([], {}, "win32");
    await s.refresh();
    const adapters = appleAdapters(s.deps);
    expect(adapters.map((a) => a.id)).toEqual(["mail", "calendar", "reminders", "contacts"]);
    expect(byId(adapters, "mail").unavailable()).toMatch(/Outlook.*Microsoft 365 or Google/);
    expect(byId(adapters, "reminders").unavailable()).toMatch(/Microsoft To Do/);
    expect(byId(adapters, "contacts").unavailable()).toMatch(/classic Outlook/);
    // macOS keeps every source and its wording.
    const mac = seams([], {}, "darwin");
    await mac.s.refresh();
    const macAdapters = appleAdapters(mac.s.deps);
    expect(macAdapters.map((a) => a.id)).toContain("notes");
    expect(macAdapters.map((a) => a.id)).toContain("messages");
    expect(byId(macAdapters, "mail").unavailable()).toBe("Apple apps are not connected");
  });

  it("reads Outlook (Microsoft 365) and Gmail mail into the Mail source with the same provenance rules", async () => {
    const { s, calls } = seams(
      [
        rec("ms-1", "microsoft", "owner@contoso.example"),
        rec("google-1", "google", "owner@gmail.example"),
      ],
      TOOLS,
      "win32",
    );
    await s.refresh();
    const mail = byId(appleAdapters(s.deps), "mail");
    expect(mail.unavailable()).toBeUndefined();
    const page = await mail.pull(null, { signal, limit: 25 });
    expect(page.items.map((i) => [i.title, i.provenance])).toEqual([
      ["Re: Q4 roadmap", "owner"],
      ["Q4 roadmap", "untrusted"],
      ["Dinner", "untrusted"],
    ]);
    expect(page.items.find((i) => i.title === "Q4 roadmap")?.text).toContain("body of m1");
    expect(page.items.find((i) => i.title === "Dinner")?.text).toContain("Friday?");
    expect(page.items.some((i) => i.title === "Too new")).toBe(false);
    // Outlook searches the inbox and Sent, a day wider each way than the window.
    const searches = calls.filter((c) => c.name === "mcp__ms-1__mail_search_messages");
    expect(searches.map((c) => c.params.mailbox)).toEqual([undefined, "sent"]);
    expect(searches[0]?.params.before).toBe("2026-11-06T18:00:00.000Z");
    // Reads go back to the connection the row came from.
    expect(
      calls.filter((c) => c.name === "mcp__ms-1__mail_read_message").map((c) => c.params),
    ).toEqual([{ id: "m2" }, { id: "m1" }]);
    expect(calls.find((c) => c.name === "mcp__google-1__gmail_read_thread")?.params).toEqual({
      threadId: "th1",
    });
  });

  it("reads Outlook and Google calendars into the Calendar source; a cloud event is never owner content", async () => {
    const { s } = seams([rec("ms-1", "microsoft", "owner@contoso.example")], TOOLS, "win32");
    await s.refresh();
    const cal = byId(appleAdapters(s.deps), "calendar");
    const page = await cal.pull({ w: 4 }, { signal, limit: 50 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      nativeId: "ms-1|e1",
      title: "Dentist",
      provenance: "untrusted",
    });
    expect(page.items[0]?.text).toContain("Where: Main St");
    expect(page.items[0]?.parties).toContain("dr@example.com");
  });

  it("an Outlook (Windows helper) connection wins over the cloud for Mail", async () => {
    const tools = {
      ...TOOLS,
      "mcp__apple-mail-1__mail_search": () => ({ messages: [] }),
    };
    const { s, calls } = seams(
      [
        rec("apple-mail-1", "apple:mail", "This PC"),
        rec("ms-1", "microsoft", "owner@contoso.example"),
      ],
      tools,
      "win32",
    );
    await s.refresh();
    await byId(appleAdapters(s.deps), "mail").pull(null, { signal, limit: 25 });
    expect(calls.map((c) => c.name)).toEqual(["mcp__apple-mail-1__mail_search"]);
  });

  it("does not read cloud mail into Search on a Mac", async () => {
    const { s } = seams([rec("ms-1", "microsoft", "owner@contoso.example")], TOOLS, "darwin");
    await s.refresh();
    expect(s.deps.call("mail")).toBeUndefined();
    expect(s.deps.call("calendar")).toBeUndefined();
  });
});

describe("Reminders from Microsoft To Do", () => {
  it("feeds the Reminders source on any host; attested own rows are owner content, shared ones are not", async () => {
    for (const platform of ["win32", "darwin"]) {
      const { s } = seams([rec("ms-1", "microsoft", "owner@contoso.example")], TOOLS, platform);
      await s.refresh();
      const page = await byId(appleAdapters(s.deps), "reminders").pull(null, { signal, limit: 50 });
      expect(page.items.map((i) => [i.title, i.provenance])).toEqual([
        ["Renew passport", "owner"],
        ["Book flights", "untrusted"],
      ]);
      expect(page.items[0]?.text).toContain("List: Tasks");
    }
  });

  it("merges Outlook or Apple Reminders with To Do, once per task, paged across both", async () => {
    const tools = {
      ...TOOLS,
      "mcp__apple-reminders-1__reminders_list": (p: Obj) => ({
        reminders:
          p.completed === true
            ? []
            : [
                // The same task, synced from Outlook into To Do: listed once.
                {
                  id: "OL-1",
                  listId: "OL",
                  list: "Tasks",
                  title: "renew passport",
                  due: "2026-11-07T08:00:00Z",
                  completed: false,
                },
                {
                  id: "OL-2",
                  listId: "OL",
                  list: "Tasks",
                  title: "Water plants",
                  due: "2026-11-06T08:00:00Z",
                  completed: false,
                },
              ],
      }),
      "mcp__apple-reminders-1__reminders_list_lists": () => ({
        lists: [{ id: "OL", title: "Tasks" }],
      }),
    };
    const { s } = seams(
      [
        rec("apple-reminders-1", "apple:reminders", "This PC"),
        rec("ms-1", "microsoft", "owner@contoso.example"),
      ],
      tools,
      "win32",
    );
    await s.refresh();
    const call = s.deps.call("reminders");
    if (call === undefined) throw new Error("no reminders");
    const all = (await call("reminders_list", { completed: false, limit: 500 }, signal)) as {
      reminders: Obj[];
    };
    expect(all.reminders.map((r) => r.title)).toEqual([
      "Water plants",
      "renew passport",
      "Book flights",
    ]);
    const second = (await call(
      "reminders_list",
      { completed: false, limit: 1, offset: 1 },
      signal,
    )) as {
      reminders: Obj[];
    };
    expect(second.reminders.map((r) => r.title)).toEqual(["renew passport"]);
    const lists = (await call("reminders_list_lists", {}, signal)) as { lists: Obj[] };
    expect(lists.lists.map((l) => l.id)).toEqual(["OL", "L1"]);
  });

  it("reaches Memory → Work with the list's name and the owner-content check", async () => {
    const { s } = seams([rec("ms-1", "microsoft", "owner@contoso.example")], TOOLS, "win32");
    await s.refresh();
    const work = appleWorkSources(s, () => []);
    const rows = await work.reminders([], signal);
    expect(rows.map((r) => [r.title, r.listTitle, r.trusted])).toEqual([
      ["Renew passport", "Tasks", true],
      ["Book flights", "Family", false],
    ]);
    // Settings → Memory → Work offers To Do's lists to track (`memory.work.lists`).
    expect(await work.lists?.(signal)).toEqual([
      { id: "L1", name: "Tasks", shared: false, source: "Microsoft To Do" },
    ]);
  });

  it("memory.work.lists answers from every Reminders backend through the Gateway", async () => {
    const home = mkdtempSync(join(tmpdir(), "psyche-win-"));
    const composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    try {
      const owner = await adminClient(composed.gateway);
      const res = await owner.call<{ lists: unknown[] }>("memory.work.lists", {});
      // Nothing connected here: no lists, and no error.
      expect(res.lists).toEqual([]);
      owner.close();
    } finally {
      await composed.stop("test");
    }
  });
});
