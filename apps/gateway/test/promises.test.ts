import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolName } from "@psyche/connectors";
import { openDb, setSetting } from "@psyche/db";
import {
  computeNudges,
  GraphStore,
  type LaneItem,
  nudgeEligible,
  type PromiseRow,
} from "@psyche/memory";
import type { ToolLookup } from "@psyche/proactive";
import type { Notification } from "@psyche/protocol";
import { FakeClock, FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { readMailItems } from "../src/compose/promise-mail-source.ts";
import {
  admitNudges,
  decideWarning,
  PROMISE_SETTING_DEFAULTS,
  promiseSettings,
  warningAt,
} from "../src/compose/promises.ts";
import { silentLogger } from "../src/log.ts";
import { desktopClient, ik, remoteClient, type TestClient } from "./helpers.ts";

/**
 * The promise ledger in the Gateway (docs/design/promise-ledger-2026.md section 11, wave W4):
 * mail in, a promise opens, the warning at the right time with quiet hours respected, broken,
 * nudge-eligible, auto done; the limits; no model call without candidates; the brief; the Keep in
 * touch lines; replay safety; and the same handlers through the real connection for a desktop
 * shell and a remote device.
 */

const T0 = Date.parse("2026-11-24T10:00:00.000Z"); // Tuesday
const at = (iso: string): number => Date.parse(iso);

let composed: ComposedGateway | null = null;
let home = "";
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed?.gateway.context.db.close();
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

const OWNER_QUOTE = "I'll send you the Q3 deck by Friday";
const THEIR_QUOTE = "I will send the signed contract by Wednesday";

/** A model that answers from the snippets it is shown: it finds two promises in two sentences. */
function lanePromises(): FakeModelProvider {
  const provider = new FakeModelProvider();
  const answer = (request: { messages: { parts: { text?: string }[] }[] }) => {
    const text = request.messages[0]?.parts[0]?.text ?? "";
    const json = JSON.parse(text.slice(text.indexOf("\n") + 1, text.lastIndexOf("\n"))) as {
      groups: { snippets: { id: string; text: string }[] }[];
    };
    const items: unknown[] = [];
    for (const g of json.groups)
      for (const s of g.snippets) {
        const mine = s.text.includes("Q3 deck");
        const theirs = s.text.includes("signed contract");
        if (!mine && !theirs) continue;
        items.push({
          snippet: s.id,
          kind: "new",
          same_as: null,
          promiser: mine ? "owner" : "counterpart",
          promisee: mine ? "counterpart" : "owner",
          what: mine ? "send Sam the Q3 deck" : "send the signed contract",
          action: "send",
          quote: mine ? OWNER_QUOTE : THEIR_QUOTE,
          due: {
            text: mine ? "by Friday" : "by Wednesday",
            date: null,
            time: null,
            kind: "explicit",
            confidence: 0.9,
          },
          update: { type: null, new_due: null },
          confidence: 0.9,
        });
      }
    return [
      { type: "text_delta" as const, text: JSON.stringify({ items }) },
      {
        type: "usage" as const,
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
      },
      { type: "finish" as const, reason: "stop" as const },
    ];
  };
  // Every call gets its own answer: the script is never exhausted into the "ok" default.
  provider.script(Array.from({ length: 20 }, () => answer));
  return provider;
}

async function boot(provider: FakeModelProvider, start = T0) {
  home = mkdtempSync(join(tmpdir(), "psyche-promises-"));
  const clock = new FakeClock(start);
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    timeZone: "UTC",
    clock,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider, model: "fake/model" },
  });
  const db = composed.gateway.context.db;
  const set = (key: string, value: unknown) => void setSetting(db, key, value);
  set("memory.everything", { enabled: true, model: { default: { kind: "cloud" } } });
  set("promises.enabled", true);
  set("promises.sources.mail", true);
  set("notifications.quietHours.enabled", true);
  set("notifications.quietHours.start", "21:00");
  set("notifications.quietHours.end", "09:30");
  const graph = composed.people.graph;
  graph.createEntity({ kind: "person", name: "Dev Owner", isOwner: true });
  const sam = graph.createEntity({
    kind: "person",
    name: "Sam Lee",
    identifiers: [{ kind: "email", value: "sam@example.com" }],
  }).id;
  const notices: Notification[] = [];
  composed.notifier.subscribe((e) => {
    if (e.type === "created") notices.push(e.notification);
  });
  return { clock, db, graph, sam, notices, p: composed.promises };
}

const mailItems = (sam: string): LaneItem[] => [
  {
    source: "mail",
    sourceRef: "message:<m1@example.com>",
    threadId: "thread-1",
    author: "owner",
    counterpartId: sam,
    counterpartLabel: "Sam Lee",
    sentAt: new Date(T0).toISOString(),
    text: `Hi Sam, ${OWNER_QUOTE}.`,
  },
  {
    source: "mail",
    sourceRef: "message:<m2@example.com>",
    threadId: "thread-2",
    author: "counterpart",
    counterpartId: sam,
    counterpartLabel: "Sam Lee",
    sentAt: new Date(T0).toISOString(),
    text: `${THEIR_QUOTE}.`,
  },
];

describe("end to end over fake connectors", () => {
  it("mail in, promise opens, warning at its time, broken, nudge-eligible, auto done", async () => {
    const provider = lanePromises();
    const { clock, graph, sam, notices, p } = await boot(provider);
    p.useSources({ mail: async () => mailItems(sam) });

    // Mail in: the owner's mail and Sam's are read apart (two calls), two promises. The owner's own words open theirs; Sam's wait.
    const scan = await p.scan();
    expect(scan).toMatchObject({ items: 2, calls: 2, created: 2 });
    expect(provider.requests).toHaveLength(2);
    const rows = p.store().list("all");
    const mine = rows.find((r) => r.direction === "i_owe") as PromiseRow;
    const theirs = rows.find((r) => r.direction === "waiting_on") as PromiseRow;
    expect(mine).toMatchObject({ status: "open", dueAt: "2026-11-27T17:00:00.000Z" });
    expect(theirs.status).toBe("suggested");
    p.store().act(theirs.id, { action: "confirm" });
    // The same mail again costs no second call: its snippets were seen.
    p.useSources({ mail: async () => [] });

    // Thursday 16:07: the sweep marks the warning, but a promise due Friday 17:00 warns at 09:00
    // on Friday, and 09:00 is inside quiet hours (21:00 to 09:30): nothing yet.
    clock.set(at("2026-11-26T16:07:00.000Z"));
    await p.sweep();
    expect(notices.filter((n) => n.kind === "promise_due")).toHaveLength(0);
    clock.set(at("2026-11-27T09:07:00.000Z"));
    await p.sweep();
    expect(notices.filter((n) => n.kind === "promise_due")).toHaveLength(0);
    // Friday 10:07: out of quiet hours, before the due time: one warning, once.
    clock.set(at("2026-11-27T10:07:00.000Z"));
    // Sam's contract was due Wednesday: late by Friday 06:00, so it is broken and offered.
    await p.sweep();
    await p.sweep();
    const due = notices.filter((n) => n.kind === "promise_due");
    expect(due).toHaveLength(1);
    expect(due[0]?.route).toBe(`/promises/${mine.id}`);
    expect(due[0]?.body).toContain("Q3 deck");
    const theirsNow = p.store().get(theirs.id) as PromiseRow;
    expect(theirsNow.status).toBe("broken");
    expect(nudgeEligible(theirsNow, clock.now())).toBe(true);
    expect(p.offers().map((o) => o.id)).toEqual([theirs.id]);

    // Sam sends the contract: an attachment in the thread closes it by itself.
    p.useEvidence(async (q) => ({
      sent:
        q.person.entityId === sam
          ? [
              {
                at: at("2026-11-27T11:00:00.000Z"),
                channel: "mail",
                ref: "mail:m9",
                threadKey: "thread-2",
                fromOwner: false,
                toEntityIds: [],
                fromEntityId: sam,
                attachments: ["signed-contract.pdf"],
                links: [],
              },
            ]
          : [],
      replies: [],
      events: [],
    }));
    clock.set(at("2026-11-27T11:30:00.000Z"));
    const swept = await p.sweep();
    expect(swept.done).toBeGreaterThanOrEqual(1);
    expect(p.store().get(theirs.id)).toMatchObject({ status: "done", closedBy: "auto" });
    expect(p.offers()).toEqual([]);
    // Their promise closing never touched the owner's own, still open.
    expect(p.store().get(mine.id)?.status).toBe("open");
    expect(graph.getEntity(sam)).toBeDefined();
  });

  it("zero candidates make no model call", async () => {
    const provider = lanePromises();
    const { sam, p } = await boot(provider);
    const chatter: LaneItem[] = [
      {
        source: "mail",
        sourceRef: "message:<c1@example.com>",
        threadId: "t",
        author: "owner",
        counterpartId: sam,
        counterpartLabel: "Sam Lee",
        sentAt: new Date(T0).toISOString(),
        text: "Thanks for lunch, see you at the offsite. It was lovely.",
      },
    ];
    p.useSources({ mail: async () => chatter });
    const r = await p.scan();
    expect(r).toMatchObject({ items: 1, calls: 0, created: 0 });
    expect(provider.requests).toHaveLength(0);
    // Positive control: a promise sentence does reach the model.
    p.useSources({ mail: async () => mailItems(sam).slice(0, 1) });
    await p.scan();
    expect(provider.requests).toHaveLength(1);
  });

  it("a scan with the ledger off, or no source on, reads and calls nothing", async () => {
    const provider = lanePromises();
    const { db, sam, p } = await boot(provider);
    let reads = 0;
    p.useSources({
      mail: async () => {
        reads++;
        return mailItems(sam);
      },
    });
    setSetting(db, "promises.enabled", false);
    expect(await p.scan()).toMatchObject({ skipped: "off" });
    setSetting(db, "promises.enabled", true);
    setSetting(db, "promises.sources.mail", false);
    expect(await p.scan()).toMatchObject({ skipped: "no_sources" });
    expect(reads).toBe(0);
    expect(provider.requests).toHaveLength(0);
  });
});

describe("rate limits (table)", () => {
  const NOW = at("2026-11-27T12:00:00.000Z");
  const DAY = 86_400_000;
  const cand = (
    id: string,
    entityId: string | null,
    nudgeCount = 0,
    lastNudgeAt: number | null = null,
  ) => ({
    id,
    entityId,
    nudgeCount,
    lastNudgeAt,
  });
  const cases: {
    name: string;
    candidates: ReturnType<typeof cand>[];
    offers: { id: string; entityId: string | null; at: number }[];
    admitted: string[];
  }[] = [
    {
      name: "three a day",
      candidates: [cand("a", "p1"), cand("b", "p2"), cand("c", "p3"), cand("d", "p4")],
      offers: [],
      admitted: ["a", "b", "c"],
    },
    {
      name: "offers from the last 24 h count against the day",
      candidates: [cand("c", "p3"), cand("d", "p4")],
      offers: [
        { id: "a", entityId: "p1", at: NOW - 3_600_000 },
        { id: "b", entityId: "p2", at: NOW - 5 * 3_600_000 },
      ],
      admitted: ["c"],
    },
    {
      name: "offers older than a day do not",
      candidates: [cand("c", "p3"), cand("d", "p4"), cand("e", "p5")],
      offers: [{ id: "a", entityId: "p1", at: NOW - 25 * 3_600_000 }],
      admitted: ["c", "d", "e"],
    },
    {
      name: "one per person per 7 days: two promises of one person",
      candidates: [cand("a", "p1"), cand("b", "p1")],
      offers: [],
      admitted: ["a"],
    },
    {
      name: "a person offered 6 days ago is held back",
      candidates: [cand("b", "p1"), cand("c", "p2")],
      offers: [{ id: "a", entityId: "p1", at: NOW - 6 * DAY }],
      admitted: ["c"],
    },
    {
      name: "a person offered 8 days ago is not",
      candidates: [cand("b", "p1")],
      offers: [{ id: "a", entityId: "p1", at: NOW - 8 * DAY }],
      admitted: ["b"],
    },
    {
      name: "a nudge sent 3 days ago counts as that person's week",
      candidates: [cand("b", "p1", 1, NOW - 3 * DAY), cand("c", "p2")],
      offers: [],
      admitted: ["c"],
    },
    {
      name: "two sent per promise: a third is never offered",
      candidates: [cand("a", "p1", 2, NOW - 30 * DAY), cand("b", "p2", 1, NOW - 30 * DAY)],
      offers: [],
      admitted: ["b"],
    },
    {
      name: "an offer already on show is not counted twice",
      candidates: [cand("a", "p1"), cand("b", "p2")],
      offers: [{ id: "a", entityId: "p1", at: NOW - 3_600_000 }],
      admitted: ["b"],
    },
    {
      name: "no known person: each promise stands alone",
      candidates: [cand("a", null), cand("b", null)],
      offers: [],
      admitted: ["a", "b"],
    },
  ];
  it.each(cases)("$name", ({ candidates, offers, admitted }) => {
    expect(admitNudges(candidates, offers, NOW).admitted).toEqual(admitted);
  });
});

describe("warning times and quiet hours (table)", () => {
  const quiet = { start: "21:00", end: "09:30", timezone: "UTC" };
  const base = { tz: "UTC", quiet };
  const dueFri17 = at("2026-11-27T17:00:00.000Z");
  const dueFri10 = at("2026-11-27T10:00:00.000Z");
  const made = at("2026-11-20T10:00:00.000Z");
  it("a due time after noon warns at 09:00 on the due day, before noon the working day before at 16:00", () => {
    expect(warningAt(dueFri17, "UTC")).toBe(at("2026-11-27T09:00:00.000Z"));
    expect(warningAt(dueFri10, "UTC")).toBe(at("2026-11-26T16:00:00.000Z"));
    // A Monday morning promise warns the Friday before (the working day before).
    expect(warningAt(at("2026-11-30T10:00:00.000Z"), "UTC")).toBe(at("2026-11-27T16:00:00.000Z"));
  });
  it.each([
    ["before its time waits", "2026-11-27T08:00:00.000Z", dueFri17, made, "wait"],
    ["inside quiet hours waits for their end", "2026-11-27T09:10:00.000Z", dueFri17, made, "wait"],
    ["after quiet hours goes out", "2026-11-27T09:40:00.000Z", dueFri17, made, "send"],
    [
      "quiet hours end past the due time: brief only",
      "2026-11-27T09:40:00.000Z",
      at("2026-11-27T09:20:00.000Z"),
      made,
      "brief_only",
    ],
    [
      "under 2 hours from due: brief only",
      "2026-11-27T15:30:00.000Z",
      dueFri17,
      made,
      "brief_only",
    ],
    [
      "a promise made an hour ago waits for its hour",
      "2026-11-27T13:30:00.000Z",
      dueFri17,
      at("2026-11-27T13:00:00.000Z"),
      "wait",
    ],
    [
      "a promise made 2 hours ago warns",
      "2026-11-27T13:30:00.000Z",
      dueFri17,
      at("2026-11-27T11:00:00.000Z"),
      "send",
    ],
  ] as const)("%s", (_n, now, due, createdMs, kind) => {
    expect(decideWarning({ dueMs: due, createdMs, nowMs: at(now), ...base }).kind).toBe(kind);
  });
  it("with quiet hours off, only the time and the 2-hour rule apply (positive control)", () => {
    expect(
      decideWarning({
        dueMs: dueFri17,
        createdMs: made,
        nowMs: at("2026-11-27T09:10:00.000Z"),
        tz: "UTC",
        quiet: null,
      }).kind,
    ).toBe("send");
  });
});

describe("settings and defaults", () => {
  it("everything is off until it is turned on; the ranges clamp", () => {
    expect(promiseSettings(() => undefined)).toEqual(PROMISE_SETTING_DEFAULTS);
    expect(PROMISE_SETTING_DEFAULTS).toMatchObject({
      enabled: false,
      sources: { mail: false, messages: false, meetings: false, chat: false },
      notify: true,
      graceDays: 1,
      retentionDays: 180,
      callsPerDay: 40,
    });
    const s = promiseSettings(
      (k) =>
        ({
          "promises.enabled": true,
          "promises.graceDays": 99,
          "promises.retentionDays": 1,
          "promises.budget.callsPerDay": 5000,
          "promises.notify": false,
          "promises.sources.mail": true,
        })[k],
    );
    expect(s).toMatchObject({
      enabled: true,
      graceDays: 7,
      retentionDays: 30,
      callsPerDay: 200,
      notify: false,
    });
    expect(s.sources).toEqual({ mail: true, messages: false, meetings: false, chat: false });
  });
});

describe("the brief and Keep in touch", () => {
  it("shows at most 4 lines, only when there are items, and only while the ledger is on", async () => {
    const { clock, db, sam, graph, p } = await boot(lanePromises(), at("2026-11-24T07:00:00.000Z"));
    expect(p.briefLines("brief")).toEqual([]);
    const add = (what: string, dueAt: string | null, direction: "i_owe" | "waiting_on" = "i_owe") =>
      p.store().add({
        direction,
        what,
        counterpartId: sam,
        counterpartLabel: "Sam Lee",
        ...(dueAt === null
          ? { dueKind: "none" as const }
          : { dueAt, dueKind: "explicit" as const, dueConfidence: 1 }),
        provenance: "owner",
        confidence: 1,
        detectedBy: "owner",
        sourceKind: "mail",
        threadKey: `t-${what}`,
        citation: {
          source: "mail",
          sourceRef: `message:<${what}>`,
          quote: what,
          provenance: "owner",
        },
      });
    add("send Dana the budget", "2026-11-24T17:00:00.000Z");
    add("call the plumber", "2026-11-25T11:00:00.000Z");
    add("sign the lease", "2026-11-23T09:00:00.000Z");
    const s = p.store();
    const sug = s.add({
      direction: "waiting_on",
      what: "send the invoice",
      counterpartId: sam,
      counterpartLabel: "Sam Lee",
      dueKind: "none",
      provenance: "untrusted",
      confidence: 0.9,
      detectedBy: "model",
      sourceKind: "mail",
      threadKey: "t-inv",
      citation: {
        source: "mail",
        sourceRef: "message:<inv>",
        quote: "I will send the invoice",
        provenance: "untrusted",
      },
    });
    expect(sug.kind).toBe("created");
    clock.set(at("2026-11-24T08:00:00.000Z"));
    await p.sweep();
    const lines = p.briefLines("brief");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines.map((l) => l.text).join("\n")).toContain("Due today: send Dana the budget");
    expect(lines.map((l) => l.text).join("\n")).toContain("Due tomorrow: call the plumber");
    expect(lines.at(-1)?.text).toBe("1 promise to confirm");
    // A chat channel never gets them; the ledger off, nothing at all.
    expect(p.briefLines("channel")).toEqual([]);
    setSetting(db, "promises.enabled", false);
    expect(p.briefLines("brief")).toEqual([]);
    expect(graph.getEntity(sam)).toBeDefined();
  });

  it("a Messages-sourced promise is a generic line in the brief, never its text", async () => {
    const { clock, sam, p } = await boot(lanePromises(), at("2026-11-24T07:00:00.000Z"));
    p.store().add({
      direction: "i_owe",
      what: "bring the secret cake recipe",
      counterpartId: sam,
      counterpartLabel: "Sam Lee",
      dueAt: "2026-11-24T17:00:00.000Z",
      dueKind: "explicit",
      dueConfidence: 1,
      provenance: "owner",
      confidence: 1,
      detectedBy: "owner",
      sourceKind: "messages",
      threadKey: "chat1",
      citation: {
        source: "messages",
        sourceRef: "messages:1",
        quote: "I'll bring the secret cake recipe",
        provenance: "owner",
      },
    });
    clock.set(at("2026-11-24T08:00:00.000Z"));
    const text = p
      .briefLines("brief")
      .map((l) => l.text)
      .join("\n");
    expect(text).not.toContain("cake");
    expect(text).toContain("open Psyche on your Mac");
  });

  it("the Keep in touch promise kind goes away only while the ledger is on", () => {
    const db = openDb(":memory:");
    const clock = new FakeClock(T0);
    const graph = new GraphStore({ sqlite: db.sqlite, clock });
    const sam = graph.createEntity({
      kind: "person",
      name: "Sam Lee",
      linkedBy: "rule",
      source: "mail",
    }).id;
    graph.addLoop({
      direction: "i_owe",
      text: "send the deck",
      counterpartId: sam,
      status: "open",
      provenance: "owner",
      detectedBy: "owner",
      createdAt: new Date(T0 - 5 * 86_400_000).toISOString(),
    });
    const opts = { now: T0, isExcluded: () => false };
    expect(computeNudges(graph, opts).map((n) => n.kind)).toContain("promise");
    expect(computeNudges(graph, { ...opts, retirePromises: false }).map((n) => n.kind)).toContain(
      "promise",
    );
    expect(
      computeNudges(graph, { ...opts, retirePromises: true }).map((n) => n.kind),
    ).not.toContain("promise");
    db.close();
  });
});

describe("the mail reader", () => {
  const connectors = [{ id: "g1", type: "google", status: "connected" }];
  const tools = (out: Record<string, unknown>): ToolLookup => ({
    get: (name: string) => {
      const bare = name.replace(/^mcp__g1__/, "");
      if (!(bare in out) || !name.startsWith("mcp__g1__")) return undefined;
      return {
        spec: { name } as never,
        execute: async () => ({ isError: false, output: out[bare] }),
      } as never;
    },
  });
  const deps = (t: ToolLookup) => ({
    tools: () => t,
    connectors: () => connectors,
    resolve: (a: string) => (a === "sam@example.com" ? "ent_sam" : null),
    isTwoWay: (id: string) => id === "ent_sam",
  });
  const out = {
    gmail_search_threads: { threads: [{ id: "th1" }] },
    gmail_read_thread: {
      messages: [
        {
          id: "m1",
          from: "Me <me@example.com>",
          to: "sam@example.com",
          date: "2026-11-24T09:00:00Z",
          labelIds: ["SENT"],
          body: "I'll send the deck on Friday.",
        },
        {
          id: "m2",
          from: "Sam Lee <sam@example.com>",
          to: "me@example.com",
          date: "2026-11-24T09:30:00Z",
          labelIds: ["INBOX"],
          body: "I will send the contract Wednesday.",
        },
        {
          id: "m3",
          from: "No Reply <noreply@shop.example>",
          to: "me@example.com",
          date: "2026-11-24T09:40:00Z",
          labelIds: ["INBOX"],
          body: "I will send you offers.",
        },
        {
          id: "m4",
          from: "Stranger <x@nowhere.example>",
          to: "me@example.com",
          date: "2026-11-24T09:50:00Z",
          labelIds: ["INBOX"],
          body: "I will send you spam.",
        },
      ],
    },
  };
  it("the owner's own mail, a two-way person's mail; not automated senders or strangers", async () => {
    const items = await readMailItems(deps(tools(out)), T0 - 86_400_000);
    expect(items.map((i) => [i.author, i.counterpartId])).toEqual([
      ["owner", "ent_sam"],
      ["counterpart", "ent_sam"],
    ]);
    expect(items[0]?.text).toContain("send the deck");
  });
  it("a connector without the tool, or no tools at all, yields nothing (positive control above)", async () => {
    expect(await readMailItems(deps(tools({})), T0 - 86_400_000)).toEqual([]);
    expect(
      await readMailItems({ ...deps(tools(out)), tools: () => undefined }, T0 - 86_400_000),
    ).toEqual([]);
    expect(toolName("g1", "gmail_read_thread")).toBe("mcp__g1__gmail_read_thread");
  });
});

describe("through the real connection", () => {
  async function world() {
    const w = await boot(lanePromises());
    const gateway = (composed as ComposedGateway).gateway;
    const desk = await desktopClient(gateway);
    clients.push(desk);
    const phone = await remoteClient(gateway);
    clients.push(phone);
    const add = (what: string, source: "mail" | "messages", quote: string) =>
      w.p.store().add({
        direction: "i_owe",
        what,
        counterpartId: w.sam,
        counterpartLabel: "Sam Lee",
        dueAt: "2026-11-27T17:00:00.000Z",
        dueKind: "explicit",
        dueConfidence: 1,
        provenance: "owner",
        confidence: 1,
        detectedBy: "owner",
        sourceKind: source,
        threadKey: `t-${what}`,
        citation: {
          source,
          sourceRef: source === "mail" ? `message:<${what}>` : `messages:${what}`,
          quote,
          provenance: "owner",
        },
      });
    const mail = add("send the Q3 deck", "mail", "I'll send the Q3 deck by Friday");
    const chat = add("water the plants", "messages", "I'll water the plants Saturday");
    if (mail.kind !== "created" || chat.kind !== "created") throw new Error("not created");
    return { ...w, desk, phone, mailId: mail.promise.id, chatId: chat.promise.id };
  }

  it("promises.list and get: the desktop shell sees the quote, a remote device a mail promise without it", async () => {
    const w = await world();
    const full = await w.desk.call<{ promise: { citations?: { quote: string }[] } }>(
      "promises.get",
      { id: w.mailId },
    );
    expect(full.promise.citations?.[0]?.quote).toContain("Q3 deck");
    const remote = await w.phone.call<{ promise: Record<string, unknown> }>("promises.get", {
      id: w.mailId,
    });
    expect(remote.promise.what).toBe("send the Q3 deck");
    expect(remote.promise).not.toHaveProperty("citations");
    expect(remote.promise.counterpartId).toBeNull();

    const deskList = await w.desk.call<{ promises: { id: string }[]; hiddenCount: number }>(
      "promises.list",
      { view: "all" },
    );
    expect(deskList.promises.map((p) => p.id).sort()).toEqual([w.mailId, w.chatId].sort());
    const phoneList = await w.phone.call<{ promises: { id: string }[]; hiddenCount: number }>(
      "promises.list",
      { view: "all" },
    );
    expect(phoneList.promises.map((p) => p.id)).toEqual([w.mailId]);
    expect(phoneList.hiddenCount).toBe(1);
  });

  it("a hidden promise is not_found for get and act on a remote device, and counted in summary", async () => {
    const w = await world();
    const get = await w.phone.request("promises.get", { id: w.chatId });
    expect(get).toMatchObject({ ok: false, error: { code: "not_found" } });
    const act = await w.phone.request(
      "promises.act",
      { id: w.chatId, action: { type: "done" } },
      ik(),
    );
    expect(act).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(w.p.store().get(w.chatId)?.status).toBe("open");
    const s = await w.phone.call<{ summary: { yours: number; hiddenCount: number } }>(
      "promises.summary",
      {},
    );
    expect(s.summary).toMatchObject({ yours: 1, hiddenCount: 1 });
    const d = await w.desk.call<{ summary: { yours: number; hiddenCount: number } }>(
      "promises.summary",
      {},
    );
    expect(d.summary).toMatchObject({ yours: 2, hiddenCount: 0 });
  });

  it("delete and mute are desktop shell only", async () => {
    const w = await world();
    for (const [method, params] of [
      ["promises.delete", { id: w.mailId }],
      ["promises.mute", { entityId: w.sam, muted: true }],
    ] as const) {
      const r = await w.phone.request(method, params, ik());
      expect(r).toMatchObject({
        ok: false,
        error: { code: "forbidden", details: { reason: "owner_only" } },
      });
    }
    expect(w.p.store().get(w.mailId)).toBeDefined();
    // Positive control: the desktop shell can.
    expect(await w.desk.call("promises.mute", { entityId: w.sam, muted: true }, ik())).toEqual({
      ok: true,
    });
    expect(await w.desk.call("promises.delete", { id: w.mailId }, ik())).toEqual({ ok: true });
    expect(w.p.store().get(w.mailId)).toBeUndefined();
  });

  it("promises.mute needs exactly one of a person and a thread", async () => {
    const w = await world();
    const both = await w.desk.request(
      "promises.mute",
      { entityId: w.sam, threadRef: "mail|t1", muted: true },
      ik(),
    );
    expect(both).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    const none = await w.desk.request("promises.mute", { muted: true }, ik());
    expect(none).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(await w.desk.call("promises.mute", { threadRef: "mail|t1", muted: true }, ik())).toEqual(
      { ok: true },
    );
  });

  it("promises.add and promises.act are replay-safe: the same key answers the same, once", async () => {
    const w = await world();
    const key = ik();
    const first = await w.desk.call<{ promise: { id: string } }>(
      "promises.add",
      { direction: "i_owe", what: "call Mum" },
      key,
    );
    const again = await w.desk.call<{ promise: { id: string } }>(
      "promises.add",
      { direction: "i_owe", what: "call Mum" },
      key,
    );
    expect(again.promise.id).toBe(first.promise.id);
    expect(
      w.p
        .store()
        .list("all")
        .filter((p) => p.text === "call Mum"),
    ).toHaveLength(1);
    const k2 = ik();
    const a1 = await w.desk.call<{ promise: { status: string } }>(
      "promises.act",
      { id: first.promise.id, action: { type: "done" } },
      k2,
    );
    const a2 = await w.desk.call<{ promise: { status: string } }>(
      "promises.act",
      { id: first.promise.id, action: { type: "done" } },
      k2,
    );
    expect(a1.promise.status).toBe("done");
    expect(a2).toEqual(a1);
    expect(
      w.p
        .store()
        .events(first.promise.id)
        .filter((e) => e.kind === "status"),
    ).toHaveLength(1);
    // A side-effecting method without a key is refused; the read methods need none.
    const noKey = await w.desk.request("promises.add", { direction: "i_owe", what: "no key" });
    expect(noKey).toMatchObject({ ok: false });
    expect(await w.desk.request("promises.summary", {})).toMatchObject({ ok: true });
  });

  it("promises.add from a remote device answers without Memory links", async () => {
    const w = await world();
    const r = await w.phone.call<{ promise: Record<string, unknown> }>(
      "promises.add",
      { direction: "i_owe", what: "email the landlord", counterpartId: w.sam },
      ik(),
    );
    expect(r.promise.counterpartId).toBeNull();
    expect(r.promise.what).toBe("email the landlord");
  });
});

describe("daily.followups.* shims", () => {
  async function shimWorld() {
    const w = await boot(lanePromises());
    const gateway = (composed as ComposedGateway).gateway;
    const desk = await desktopClient(gateway);
    clients.push(desk);
    const phone = await remoteClient(gateway);
    clients.push(phone);
    const add = (what: string, source: "mail" | "messages") => {
      const r = w.p.store().add({
        direction: "i_owe",
        what,
        counterpartId: w.sam,
        counterpartLabel: "Sam Lee",
        dueKind: "none",
        provenance: "owner",
        confidence: 1,
        detectedBy: "owner",
        sourceKind: source,
        threadKey: `t-${what}`,
        citation: { source, sourceRef: `${source}:${what}`, quote: what, provenance: "owner" },
      });
      if (r.kind !== "created") throw new Error("not created");
      return r.promise.id;
    };
    return {
      ...w,
      desk,
      phone,
      mailId: add("send the lease", "mail"),
      chatId: add("buy the stamps", "messages"),
    };
  }

  it("list reads the ledger while it is on, scrubbed for a remote device", async () => {
    const w = await shimWorld();
    const full = await w.desk.call<{ followups: { id: string; text: string }[] }>(
      "daily.followups.list",
      {},
    );
    expect(full.followups.map((f) => f.id).sort()).toEqual([w.mailId, w.chatId].sort());
    const remote = await w.phone.call<{ followups: { id: string }[] }>("daily.followups.list", {});
    expect(remote.followups.map((f) => f.id)).toEqual([w.mailId]);
  });

  it("update acts on the ledger row, and a hidden one is not_found for a remote device", async () => {
    const w = await shimWorld();
    const hidden = await w.phone.request(
      "daily.followups.update",
      { id: w.chatId, action: "done" },
      ik(),
    );
    expect(hidden).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(w.p.store().get(w.chatId)?.status).toBe("open");
    const done = await w.desk.call<{ followup: { status: string } }>(
      "daily.followups.update",
      { id: w.chatId, action: "done" },
      ik(),
    );
    expect(done.followup.status).toBe("done");
    expect(w.p.store().get(w.chatId)?.status).toBe("done");
  });

  it("ingest tracks the owner's own sentence as a suggested ledger promise", async () => {
    const w = await shimWorld();
    const r = await w.desk.call<{ added: { text: string }[] }>(
      "daily.followups.ingest",
      { text: "I'll send the signed lease to the landlord on Friday.", source: "chat" },
      ik(),
    );
    expect(r.added).toHaveLength(1);
    expect(
      w.p
        .store()
        .list("all")
        .some((p) => p.status === "suggested" && p.text.includes("lease")),
    ).toBe(true);
  });

  it("with the ledger off the legacy store answers (positive control)", async () => {
    const w = await shimWorld();
    setSetting(w.db, "promises.enabled", false);
    const r = await w.desk.call<{ followups: unknown[] }>("daily.followups.list", {});
    expect(r.followups).toEqual([]);
  });
});
