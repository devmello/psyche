import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateResult } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardSync } from "../src/graph/cards.ts";
import { createGraphHandlers, type GraphHandlers } from "../src/graph/handlers.ts";
import { GraphIngester } from "../src/graph/ingest.ts";
import { GraphStore } from "../src/graph/store.ts";
import { meetingPrep } from "../src/graph/tools.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

const WORLD = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "..", "..", "tests", "fixtures", "graph", "world.json"),
    "utf8",
  ),
);

let env: TestEnv;
let graph: GraphStore;
let clock: FakeClock;
let h: GraphHandlers;
let cards: CardSync;

beforeEach(async () => {
  clock = new FakeClock(Date.parse(WORLD.now));
  env = await makeEnv({ clock });
  graph = new GraphStore({ sqlite: env.db.sqlite, clock });
  cards = new CardSync(graph, env.store);
  h = createGraphHandlers(graph, { cards, memory: env.store });
});
afterEach(async () => env.cleanup());

function loadAll() {
  const ingest = new GraphIngester(graph, {
    ownerEmails: WORLD.owner.emails,
    ownerPhones: WORLD.owner.phones,
    clock,
  });
  ingest.ingestContacts(WORLD.contacts);
  ingest.ingestMail(WORLD.mails);
  ingest.ingestEvents(WORLD.events);
  ingest.ingestMessages(WORLD.messages);
}

const id = (name: string) =>
  graph.search(name, { limit: 10 }).find((s) => s.name === name)?.id ?? "";
const count = (sql: string) => (env.db.sqlite.prepare(sql).get() as { n: number }).n;

describe("blocklist (§4.9)", () => {
  it("blocks a whole domain before ingest and shows only masked hints", async () => {
    const added = await h["memory.graph.blocklist.add"]({ kind: "domain", value: "reed.example" });
    validateResult("memory.graph.blocklist.add", added);
    expect(added.entry).toMatchObject({ kind: "domain", hint: "reed.example" });
    loadAll();
    expect(graph.resolveIdentifier("email", "taylor@reed.example")).toBeUndefined();
    expect(id("Taylor Reed")).toBe("");

    await h["memory.entities.forget"]({ id: id("Omar Haddad") });
    const { entries } = await h["memory.graph.blocklist.list"]({});
    validateResult("memory.graph.blocklist.list", { entries });
    const hints = entries.map((e) => e.hint);
    expect(hints).toContain("o•••@hadd.example");
    expect(JSON.stringify(entries)).not.toContain("omar@");

    const removed = await h["memory.graph.blocklist.remove"]({ id: added.entry.id });
    expect(removed).toEqual({ removed: true });
    expect(graph.isBlocked("email", "taylor@reed.example")).toBe(false);
    await expect(
      h["memory.graph.blocklist.add"]({ kind: "domain", value: "not a domain" }),
    ).rejects.toThrow(/domain/);
    await expect(
      h["memory.graph.blocklist.add"]({ kind: "email", value: "nope" }),
    ).rejects.toThrow();
  });
});

describe("delete one source (§4.9)", () => {
  it("removes mail and what came only from it, keeps the owner's facts and other sources", async () => {
    loadAll();
    const sam = id("Sam Lee");
    await h["memory.entities.facts.set"]({ entityId: sam, attribute: "city", value: "Oakland" });
    const { entity: bob } = await h["memory.entities.create"]({ kind: "person", name: "Bob Ng" });
    await cards.write(sam);
    const meetings = count("SELECT count(*) AS n FROM graph_interactions WHERE kind = 'meeting'");
    expect(
      count("SELECT count(*) AS n FROM graph_interactions WHERE kind = 'mail'"),
    ).toBeGreaterThan(0);

    const dry = await h["memory.graph.deleteSource"]({ source: "mail", dryRun: true });
    validateResult("memory.graph.deleteSource", dry);
    expect(count("SELECT count(*) AS n FROM graph_interactions WHERE kind = 'mail'")).toBe(
      dry.removed.interactions,
    );
    const done = await h["memory.graph.deleteSource"]({ source: "mail" });
    expect(done.removed).toEqual(dry.removed);
    expect(done.removed.entities).toBeGreaterThan(0);
    expect(count("SELECT count(*) AS n FROM graph_interactions WHERE kind = 'mail'")).toBe(0);
    expect(
      count(
        "SELECT count(*) AS n FROM graph_identifiers WHERE source = 'mail' AND linked_by != 'owner'",
      ),
    ).toBe(0);
    // Calendar, the contact, the owner's fact and the owner's own entry stay.
    expect(count("SELECT count(*) AS n FROM graph_interactions WHERE kind = 'meeting'")).toBe(
      meetings,
    );
    expect(graph.facts(sam).map((f) => [f.attribute, f.value])).toContainEqual(["city", "Oakland"]);
    expect(graph.getEntity(bob.id)).toBeDefined();
    expect(graph.resolveIdentifier("email", "sam@acme.com")).toBe(sam);
  });

  it("removes Contacts facts and people known only from Contacts", async () => {
    loadAll();
    // A contact never seen in mail, meetings or messages, and one who was (Jules, at a meeting).
    new GraphIngester(graph, { ownerEmails: WORLD.owner.emails, clock }).ingestContacts([
      { id: "C-LEE", name: "Lee Park", emails: ["lee@park.example"], title: "Dentist" },
    ]);
    const only = id("Lee Park");
    const jules = id("Jules Moreau");
    expect(only).not.toBe("");
    const path = (await cards.write(only)) ?? "";
    const result = await h["memory.graph.deleteSource"]({ source: "contacts" });
    expect(result.cardPaths).toContain(path);
    expect(graph.getEntity(only)).toBeUndefined();
    expect(graph.getEntity(jules)).toBeDefined();
    expect(await env.store.readFile(path)).toBeUndefined();
    // Sam Lee is still known from mail, without the Contacts title.
    const sam = id("Sam Lee");
    expect(graph.getEntity(sam)).toBeDefined();
    expect(graph.facts(sam).filter((f) => f.sources.some((s) => s.startsWith("contact:")))).toEqual(
      [],
    );
  });
});

describe("forget everything (§4.9)", () => {
  it("needs the phrase, reports a dry run, then keeps nothing", async () => {
    loadAll();
    await graph.block("domain", "lists.example");
    const path = (await cards.write(id("Sam Lee"))) ?? "";
    await expect(h["memory.graph.forgetAll"]({ confirm: "yes" as never })).rejects.toThrow(
      /forget everything/,
    );
    const dry = await h["memory.graph.forgetAll"]({ confirm: "forget everything", dryRun: true });
    validateResult("memory.graph.forgetAll", dry);
    expect(dry.removed.entities).toBeGreaterThan(10);
    expect(dry.cardPaths).toEqual([path]);
    expect(count("SELECT count(*) AS n FROM graph_entities")).toBe(dry.removed.entities);

    const done = await h["memory.graph.forgetAll"]({ confirm: "forget everything" });
    expect(done.removed).toEqual(dry.removed);
    for (const table of [
      "graph_entities",
      "graph_identifiers",
      "graph_facts",
      "graph_interactions",
      "graph_loops",
      "graph_blocklist",
      "graph_fts",
      "graph_cursors",
    ])
      expect(count(`SELECT count(*) AS n FROM ${table}`)).toBe(0);
    expect(await env.store.readFile(path)).toBeUndefined();
  });
});

describe("meeting prep data (§6.6)", () => {
  it("finds a meeting by its calendar event and returns attendees, loops and history", () => {
    loadAll();
    const event = WORLD.events.find(
      (e: { attendees?: unknown[] }) => (e.attendees?.length ?? 0) > 1,
    );
    const prep = meetingPrep(graph, { source: event.source, externalRef: event.id });
    expect(prep?.meeting.kind).toBe("meeting");
    expect(prep?.attendees.length).toBeGreaterThan(0);
    expect(prep?.attendees.every((a) => !a.entity.isOwner)).toBe(true);
    expect(meetingPrep(graph, { source: event.source, externalRef: "missing" })).toBeUndefined();
  });
});
