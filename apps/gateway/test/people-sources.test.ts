import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConnectorRecord, toolName } from "@psyche/connectors";
import { setSetting } from "@psyche/db";
import type { ToolRegistration } from "@psyche/protocol";
import { FakeClock, FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { GRAPH_SETTING } from "../src/compose/people.ts";
import { cloudEvents, graphSourceAdapters } from "../src/compose/people-sources.ts";
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
    expect(adapters.map((a) => a.id)).toEqual(["contacts:ms-1", "calendar:ms-1"]);
    expect(await adapters[1]?.ownerIdentities?.()).toEqual({ emails: ["pat@kim.example"] });
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
    setSetting(c.db, GRAPH_SETTING, { enabled: true, sources: { mail: true } });
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
