import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConnectorRecord, toolName } from "@psyche/connectors";
import { appendMessage, createThread, openDb, setSetting } from "@psyche/db";
import type { ToolRegistration } from "@psyche/protocol";
import { FakeClock, FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { GRAPH_SETTING } from "../src/compose/people.ts";
import { cloudEvents, graphSourceAdapters, parseAddresses } from "../src/compose/people-sources.ts";
import { silentLogger } from "../src/log.ts";

const NOW = Date.parse("2026-10-18T20:00:00Z");
const clock = new FakeClock(NOW);

const record = (id: string, type: string, account: string | null = null): ConnectorRecord => ({
  id,
  type,
  label: type,
  account,
  scopes: [],
  scopeMode: "read",
  actionMatrix: {},
  credentialId: null,
  status: "connected",
  config: {},
  lastSync: null,
  createdAt: new Date(NOW).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
});

/** Fake connector tools: `outputs[name]` is returned for every call; calls are recorded. */
function fakeTools(outputs: Record<string, (params: Record<string, unknown>) => unknown>) {
  const calls: { name: string; params: Record<string, unknown> }[] = [];
  return {
    calls,
    get(name: string): ToolRegistration | undefined {
      const out = outputs[name];
      if (out === undefined) return undefined;
      return {
        spec: { name } as ToolRegistration["spec"],
        async execute(_callId, params) {
          calls.push({ name, params: params as Record<string, unknown> });
          return { output: out(params as Record<string, unknown>), provenance: "untrusted" };
        },
      };
    },
  };
}

const APPLE_EVENTS = {
  events: [
    {
      id: "ev1",
      calendarId: "c",
      title: "Acme standup",
      start: "2026-10-20T16:00:00Z",
      end: "2026-10-20T16:30:00Z",
      allDay: false,
      recurring: false,
      url: "https://acme.example/standup",
      attendees: [
        { name: "Dana Fox", email: "dana@acme.com", status: "accepted", organizer: true },
        { name: "Sam Lee", email: "sam@acme.com", status: "accepted", organizer: false },
        { name: "Pat Kim", email: "pat@kim.example", status: "accepted", organizer: false },
        { name: "Room 4", email: null, status: "accepted", organizer: false },
      ],
    },
  ],
  provenance: "untrusted",
};
const GOOGLE_EVENTS = [
  {
    id: "g1",
    status: "confirmed",
    summary: "Budget review",
    start: { dateTime: "2026-10-21T17:00:00Z" },
    end: { dateTime: "2026-10-21T18:00:00Z" },
    organizer: "pat@kim.example",
    attendees: [
      { email: "pat@kim.example", responseStatus: "accepted" },
      { email: "nina@acme.com", responseStatus: "needsAction" },
    ],
    htmlLink: "https://calendar.google.com/event?eid=g1",
    updated: "2026-10-18T10:00:00Z",
  },
  {
    id: "g2",
    status: "cancelled",
    summary: "Old",
    start: { date: "2026-10-22" },
    organizer: "x@y.example",
    attendees: [],
  },
];

describe("people graph ingest adapters (#732)", () => {
  it("maps Apple Calendar events: organizer from the flag, rooms without email dropped", async () => {
    const tools = fakeTools({
      [toolName("apple-calendar-1", "calendar_list_events")]: () => APPLE_EVENTS,
    });
    const [adapter] = await graphSourceAdapters({
      connectors: async () => [record("apple-calendar-1", "apple:calendar")],
      tools,
      clock,
    });
    const pulled = await adapter?.pull(null, new AbortController().signal);
    expect(pulled?.events).toEqual([
      {
        source: "apple:calendar",
        id: "ev1",
        start: "2026-10-20T16:00:00Z",
        title: "Acme standup",
        organizer: { email: "dana@acme.com", name: "Dana Fox" },
        attendees: [
          { email: "sam@acme.com", name: "Sam Lee" },
          { email: "pat@kim.example", name: "Pat Kim" },
        ],
        link: "https://acme.example/standup",
      },
    ]);
    // First pass backfills 90 days; later passes re-read 2 days back, 14 ahead.
    const first = tools.calls[0]?.params;
    expect(first?.from).toBe(new Date(NOW - 90 * 86_400_000).toISOString());
    await adapter?.pull(pulled?.cursor, new AbortController().signal);
    expect(tools.calls[1]?.params.from).toBe(new Date(NOW - 2 * 86_400_000).toISOString());
    expect(tools.calls[1]?.params.to).toBe(new Date(NOW + 14 * 86_400_000).toISOString());
  });

  it("maps Google (bare array) and Microsoft ({events}) event views, cancelled as deleted", () => {
    const google = cloudEvents(GOOGLE_EVENTS, "google:calendar");
    expect(google[0]).toMatchObject({
      id: "g1",
      title: "Budget review",
      organizer: { email: "pat@kim.example" },
      attendees: [{ email: "nina@acme.com" }],
      link: "https://calendar.google.com/event?eid=g1",
    });
    expect(google[1]).toMatchObject({ id: "g2", start: "2026-10-22T00:00:00.000Z", deleted: true });
    expect(cloudEvents({ events: GOOGLE_EVENTS }, "microsoft:calendar")).toHaveLength(2);
    expect(cloudEvents({ nonsense: true }, "x")).toEqual([]);
  });

  it("reads contacts letter by letter, deduped, at most once a day", async () => {
    const tools = fakeTools({
      [toolName("apple-contacts-1", "contacts_search")]: (p) => ({
        contacts:
          p.query === "s"
            ? [
                {
                  id: "C1",
                  name: "Sam Lee",
                  organization: "Acme",
                  emails: ["sam@acme.com"],
                  phones: ["(415) 555-0100"],
                },
              ]
            : p.query === "a"
              ? [{ id: "C1", name: "Sam Lee", emails: ["sam@acme.com"], phones: [] }]
              : [],
      }),
    });
    const [adapter] = await graphSourceAdapters({
      connectors: async () => [record("apple-contacts-1", "apple:contacts")],
      tools,
      clock,
    });
    const pulled = await adapter?.pull(null, new AbortController().signal);
    expect(tools.calls).toHaveLength(26);
    expect(pulled?.contacts).toEqual([
      { id: "C1", name: "Sam Lee", emails: ["sam@acme.com"], phones: [] },
    ]);
    const again = await adapter?.pull(pulled?.cursor, new AbortController().signal);
    expect(again?.contacts).toBeUndefined();
    expect(tools.calls).toHaveLength(26);
  });

  it("offers no adapters for disconnected apps or apps without people data", async () => {
    const off = { ...record("google-1", "google"), status: "disconnected" as const };
    const adapters = await graphSourceAdapters({
      connectors: async () => [
        off,
        record("things-1", "things"),
        record("ms-1", "microsoft", "pat@kim.example"),
      ],
      tools: fakeTools({}),
      clock,
    });
    expect(adapters.map((a) => a.id)).toEqual(["contacts:ms-1", "calendar:ms-1", "mail:ms-1"]);
    expect(await adapters[1]?.ownerIdentities?.()).toEqual({ emails: ["pat@kim.example"] });
  });
});

describe("mail adapters (#732)", () => {
  const signal = new AbortController().signal;

  it("parses address headers without merging on display names", () => {
    expect(
      parseAddresses(
        'Sam Lee <sam@acme.com>, "Fox, Dana" <dana@acme.com>, nina@acme.com, not an address',
      ),
    ).toEqual([
      { email: "sam@acme.com", name: "Sam Lee" },
      { email: "dana@acme.com", name: "Fox, Dana" },
      { email: "nina@acme.com" },
    ]);
    expect(parseAddresses(["a@b.example", "C <c@d.example>"])).toEqual([
      { email: "a@b.example" },
      { email: "c@d.example", name: "C" },
    ]);
  });

  it("Apple Mail: senders from summaries, recipients only for the owner's sent mail", async () => {
    const tools = fakeTools({
      [toolName("apple-mail-1", "mail_search")]: () => ({
        messages: [
          {
            id: "1",
            mailbox: "INBOX",
            account: "iCloud",
            subject: "Kickoff notes",
            from: "Sam Lee <sam@acme.com>",
            date: "2026-10-17T09:00:00Z",
            read: true,
            link: "message://%3Ckick%40acme.com%3E",
          },
          {
            id: "2",
            mailbox: "Sent Messages",
            account: "iCloud",
            subject: "Re: Kickoff notes",
            from: "Pat Kim <pat@kim.example>",
            date: "2026-10-17T10:00:00Z",
            read: true,
          },
        ],
      }),
      [toolName("apple-mail-1", "mail_read")]: (p) => ({
        message: {
          summary: { id: p.id },
          to: ["Sam Lee <sam@acme.com>"],
          cc: [],
          body: "Thanks Sam, can you send the deck by Friday?",
        },
      }),
    });
    const [adapter] = await graphSourceAdapters({
      connectors: async () => [record("apple-mail-1", "apple:mail")],
      tools,
      clock,
    });
    const pulled = await adapter?.pull(null, signal);
    expect(pulled?.mails).toEqual([
      {
        source: "apple:mail",
        messageId: "kick@acme.com",
        date: "2026-10-17T09:00:00.000Z",
        from: { email: "sam@acme.com", name: "Sam Lee" },
        subject: "Kickoff notes",
        link: "message://%3Ckick%40acme.com%3E",
      },
      {
        source: "apple:mail",
        messageId: "2",
        date: "2026-10-17T10:00:00.000Z",
        from: { email: "pat@kim.example", name: "Pat Kim" },
        subject: "Re: Kickoff notes",
        to: [{ email: "sam@acme.com", name: "Sam Lee" }],
        cc: [],
        ownerSnippet: "Thanks Sam, can you send the deck by Friday?",
      },
    ]);
    expect(tools.calls.filter((c) => c.name.endsWith("mail_read"))).toHaveLength(1);
    expect(tools.calls[0]?.params.since).toBe(new Date(NOW - 30 * 86_400_000).toISOString());
    expect(pulled?.cursor).toEqual({ since: "2026-10-17T10:00:00.000Z" });
  });

  it("Gmail: reads threads for headers and resumes a backlog instead of skipping it", async () => {
    let page = 0;
    const tools = fakeTools({
      [toolName("google-1", "gmail_search_threads")]: (p) => {
        page++;
        const base = p.pageToken === undefined ? 0 : Number(p.pageToken);
        return {
          threads: Array.from({ length: 50 }, (_, i) => ({ id: `t${base + i}` })),
          nextPageToken: String(base + 50),
        };
      },
      [toolName("google-1", "gmail_read_thread")]: (p) => ({
        id: p.threadId,
        messages: [
          {
            id: `m-${p.threadId}`,
            threadId: p.threadId,
            from: "Nina Patel <nina@acme.com>",
            to: "pat@kim.example",
            cc: "",
            date: "Sat, 17 Oct 2026 09:00:00 +0000",
            subject: `About ${p.threadId}`,
            messageId: `<${p.threadId}@acme.com>`,
            body: "third-party body, never kept",
          },
        ],
      }),
    });
    const [, mail] = await graphSourceAdapters({
      connectors: async () => [record("google-1", "google", "pat@kim.example")],
      tools,
      clock,
    });
    expect(mail?.id).toBe("mail:google-1");
    const first = await mail?.pull(null, signal);
    expect(first?.mails).toHaveLength(50);
    expect(first?.mails?.[0]).toMatchObject({
      source: "google:mail",
      messageId: "t0@acme.com",
      from: { email: "nina@acme.com", name: "Nina Patel" },
      to: [{ email: "pat@kim.example" }],
      threadKey: "t0",
    });
    expect(JSON.stringify(first?.mails)).not.toContain("third-party body");
    expect(first?.cursor).toMatchObject({ resume: { all: "50" } });
    const second = await mail?.pull(first?.cursor, signal);
    expect(second?.mails?.[0]?.threadKey).toBe("t50");
    expect(page).toBe(2);
  });

  it("IMAP / Outlook: inbox and Sent, recipients from the summary, a missing Sent folder is fine", async () => {
    const tools = fakeTools({
      [toolName("imap-1", "mail_search_messages")]: (p) => {
        if (p.mailbox === "Sent") throw new Error("no such mailbox");
        return {
          messages: [
            {
              id: "42",
              mailbox: "INBOX",
              subject: "Invoice",
              from: "Rita Gomez <rita@buildright.example>",
              to: "Pat Kim <pat@kim.example>, Mo Chen <mo@studiomo.example>",
              date: "2026-10-16T08:00:00Z",
              snippet: "…",
              unread: false,
              flags: [],
            },
          ],
          nextPageToken: null,
        };
      },
    });
    const [adapter] = await graphSourceAdapters({
      connectors: async () => [record("imap-1", "imap", "pat@kim.example")],
      tools,
      clock,
    });
    const pulled = await adapter?.pull(null, signal);
    expect(pulled?.mails).toEqual([
      {
        source: "imap:mail",
        messageId: "42",
        date: "2026-10-16T08:00:00.000Z",
        from: { email: "rita@buildright.example", name: "Rita Gomez" },
        to: [
          { email: "pat@kim.example", name: "Pat Kim" },
          { email: "mo@studiomo.example", name: "Mo Chen" },
        ],
        subject: "Invoice",
      },
    ]);
    expect(pulled?.cursor).toEqual({ since: "2026-10-16T08:00:00.000Z" });
  });
});

describe("notes and chats adapters", () => {
  const signal = new AbortController().signal;

  it("Apple Notes: titles by folder since the cursor, resuming folders a pass did not reach", async () => {
    const folders = Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, name: `Folder ${i}` }));
    const tools = fakeTools({
      [toolName("apple-notes-1", "notes_folders")]: () => ({
        folders: [...folders, { id: "rd", name: "Recently Deleted" }],
      }),
      [toolName("apple-notes-1", "notes_search")]: (p) => ({
        notes: [
          {
            id: `n-${String(p.folder)}`,
            folder: p.folder,
            title: `${String(p.folder)}: Dana Fox`,
            modified: "2026-10-17T10:00:00Z",
            snippet: "pasted text, never kept",
          },
        ],
      }),
    });
    const [notes] = await graphSourceAdapters({
      connectors: async () => [record("apple-notes-1", "apple:notes")],
      tools,
      clock,
    });
    const first = await notes?.pull(null, signal);
    expect(first?.notes).toHaveLength(10);
    expect(first?.notes?.[0]).toEqual({
      source: "apple:notes",
      id: "n-Folder 0",
      title: "Folder 0: Dana Fox",
      modifiedAt: "2026-10-17T10:00:00.000Z",
    });
    expect(first?.cursor).toMatchObject({ pending: ["Folder 10", "Folder 11"] });
    const searched = tools.calls.filter((c) => c.name.endsWith("notes_search"));
    expect(searched[0]?.params.modifiedSince).toBe(new Date(NOW - 365 * 86_400_000).toISOString());
    expect(searched.some((c) => c.params.folder === "Recently Deleted")).toBe(false);
    const second = await notes?.pull(first?.cursor, signal);
    expect(second?.notes?.map((n) => n.id)).toEqual(["n-Folder 10", "n-Folder 11"]);
    expect(second?.cursor).toEqual({ since: "2026-10-17T10:00:00.000Z" });
  });

  it("chats: only the owner's own words in private chats, resuming a long backlog", () => {
    const db = openDb(":memory:");
    const say = (threadId: string, role: "user" | "agent", text: string, provenance = "owner") =>
      appendMessage(
        db,
        {
          threadId,
          role,
          blocks: [{ type: "text", md: text }] as never,
          provenance: provenance as never,
        },
        { expectedWriterRunId: null },
      );
    const main = createThread(db, { kind: "main", sessionKey: "owner:main" });
    say(main.id, "user", "Remind me to call Rita Gomez");
    say(main.id, "agent", "Sure, and Mo Chen?");
    say(main.id, "user", "forwarded: Omar Haddad says hi", "untrusted");
    const secret = createThread(db, { kind: "incognito", sessionKey: "owner:incognito" });
    say(secret.id, "user", "Dana Fox private");
    const channel = createThread(db, { kind: "main", sessionKey: "channel:telegram:x:dm:9" });
    say(channel.id, "user", "Dana Fox from a channel");
    return (async () => {
      const adapters = await graphSourceAdapters({
        connectors: async () => [],
        tools: fakeTools({}),
        clock: new FakeClock(Date.now()),
        db,
      });
      const chats = adapters.find((a) => a.id === "chats:psyche");
      const pulled = await chats?.pull(null, signal);
      expect(pulled?.chats?.map((c) => c.text)).toEqual(["Remind me to call Rita Gomez"]);
      expect(pulled?.chats?.[0]).toMatchObject({ threadId: main.id, link: `/chat/${main.id}` });
      const again = await chats?.pull(pulled?.cursor, signal);
      expect(again?.chats).toEqual([]);

      // 105 more chats: a pass reads 100 threads and the next one the other 5.
      for (let i = 0; i < 105; i++) {
        const t = createThread(db, { kind: "side", sessionKey: `owner:side:${i}` });
        say(t.id, "user", `note ${i}`);
      }
      const p1 = await chats?.pull(again?.cursor, signal);
      expect(p1?.chats).toHaveLength(100);
      expect(p1?.cursor).toHaveProperty("after");
      const p2 = await chats?.pull(p1?.cursor, signal);
      expect(p2?.chats).toHaveLength(5);
      expect(p2?.cursor).not.toHaveProperty("after");
      db.close();
    })();
  });
});

describe("the Gateway's deterministic pass", () => {
  let home = "";
  let composed: ComposedGateway | null = null;
  afterEach(async () => {
    await composed?.stop("test");
    composed = null;
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("polls only enabled sources and turns calendar attendees into people", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-people-poll-"));
    composed = await composeGateway({
      env: {},
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      timeZone: "UTC",
      clock,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    const c = composed;
    const tools = fakeTools({
      [toolName("google-1", "calendar_list_events")]: () => GOOGLE_EVENTS,
    });
    c.people.useSources(() =>
      graphSourceAdapters({
        connectors: async () => [record("google-1", "google", "pat@kim.example")],
        tools,
        clock,
      }),
    );
    // Off by default, then the graph on but calendar off: nothing is read.
    expect(await c.people.poll()).toBeUndefined();
    setSetting(c.db, GRAPH_SETTING, { enabled: true, sources: { contacts: true } });
    const none = await c.people.poll();
    expect(none?.adapters).toEqual([]);
    expect(tools.calls).toHaveLength(0);
    setSetting(c.db, GRAPH_SETTING, { enabled: true, sources: { calendar: true } });
    const report = await c.people.poll();
    expect(report?.adapters).toMatchObject([{ id: "calendar:google-1", ok: true }]);
    const nina = c.people.graph.resolveIdentifier("email", "nina@acme.com");
    expect(nina).toBeDefined();
    // The account address is the owner's: the owner is not modelled as an attendee.
    const pat = c.people.graph.resolveIdentifier("email", "pat@kim.example");
    expect(pat === undefined || c.people.graph.getEntity(pat)?.isOwner === true).toBe(true);
    expect(c.people.graph.interactions(nina ?? "")).toHaveLength(1);
  });
});

describe("messages source (#763)", () => {
  /** A fake Mac helper: `replies[capability]` answers each call; every call is recorded. */
  function fakeHelper(replies: Record<string, (params: Record<string, unknown>) => unknown>) {
    const calls: { capability: string; params: Record<string, unknown> }[] = [];
    return {
      calls,
      async invoke(capability: string, params: unknown) {
        calls.push({ capability, params: params as Record<string, unknown> });
        const reply = replies[capability];
        if (reply === undefined)
          return { ok: false, error: { code: "not_found" as const, message: "x" } };
        return { ok: true, result: reply(params as Record<string, unknown>) };
      },
    };
  }

  const ONE_TO_ONE = "iMessage;-;+15550001111";
  const GROUP = "iMessage;+;chat-group";
  const CHATS = {
    chats: [
      { chatId: ONE_TO_ONE, handles: ["+15550001111"], isGroup: false },
      { chatId: GROUP, handles: ["+15550002222", "pat@kim.example"], isGroup: true },
    ],
  };
  // `text` is what a body-returning read would add: the adapter must never copy it.
  const READ = {
    cursor: 12,
    hasMore: false,
    messages: [
      {
        chatId: ONE_TO_ONE,
        handle: "+15550001111",
        sentAt: "2026-10-18T15:00:00.000Z",
        direction: "in",
        text: "SECRET-1",
      },
      {
        chatId: ONE_TO_ONE,
        sentAt: "2026-10-18T16:00:00.000Z",
        direction: "out",
        text: "SECRET-2",
      },
      {
        chatId: GROUP,
        handle: "+15550002222",
        sentAt: "2026-10-18T17:00:00.000Z",
        direction: "in",
      },
    ],
  };

  it("reads metadata only and writes one interaction per conversation per day", async () => {
    const helper = fakeHelper({
      "messages.graph_chats": () => CHATS,
      "messages.graph_read": () => READ,
    });
    const [adapter] = await graphSourceAdapters({
      connectors: async () => [],
      tools: fakeTools({}),
      clock,
      messages: () => helper,
    });
    expect(adapter?.source).toBe("messages");
    const pull = await adapter?.pull(null, new AbortController().signal);
    expect(pull?.messages).toEqual([
      {
        source: "imessage",
        chatId: ONE_TO_ONE,
        date: "2026-10-18T16:00:00.000Z",
        handles: [{ value: "+15550001111" }],
        ownerSpoke: true,
        isGroup: false,
      },
      {
        source: "imessage",
        chatId: GROUP,
        date: "2026-10-18T17:00:00.000Z",
        handles: [{ value: "+15550002222" }, { value: "pat@kim.example" }],
        ownerSpoke: false,
        isGroup: true,
      },
    ]);
    expect(JSON.stringify(pull)).not.toContain("SECRET");
    expect(pull?.cursor).toEqual({ row: 12 });
    // The first pass reads the newest page, with no body flag and no cursor.
    expect(helper.calls).toEqual([
      { capability: "messages.graph_chats", params: { limit: 200 } },
      { capability: "messages.graph_read", params: { limit: 200 } },
    ]);
  });

  it("pages forward from the stored row, and throws while no helper is live", async () => {
    const helper = fakeHelper({
      "messages.graph_chats": () => CHATS,
      "messages.graph_read": (p) =>
        p.sinceCursor === 1
          ? { cursor: 5, hasMore: true, messages: [READ.messages[0]] }
          : { cursor: 9, hasMore: false, messages: [] },
    });
    const [adapter] = await graphSourceAdapters({
      connectors: async () => [],
      tools: fakeTools({}),
      clock,
      messages: () => helper,
    });
    const pull = await adapter?.pull({ row: 1 }, new AbortController().signal);
    expect(pull?.cursor).toEqual({ row: 9 });
    expect(helper.calls.slice(1).map((c) => c.params)).toEqual([
      { sinceCursor: 1, limit: 200 },
      { sinceCursor: 5, limit: 200 },
    ]);
    const offline = await graphSourceAdapters({
      connectors: async () => [],
      tools: fakeTools({}),
      clock,
      messages: () => undefined,
    });
    await expect(offline[0]?.pull(null, new AbortController().signal)).rejects.toThrow(
      "no Mac helper",
    );
  });

  it("is absent unless the Gateway wires a helper", async () => {
    const adapters = await graphSourceAdapters({
      connectors: async () => [],
      tools: fakeTools({}),
      clock,
    });
    expect(adapters.map((a) => a.source)).not.toContain("messages");
  });
});
