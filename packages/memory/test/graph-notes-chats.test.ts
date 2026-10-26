import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraphIngester } from "../src/graph/ingest.ts";
import { type GraphSourceAdapter, runGraphPoll } from "../src/graph/poll.ts";
import { GraphStore } from "../src/graph/store.ts";
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
let ingest: GraphIngester;

beforeEach(async () => {
  clock = new FakeClock(Date.parse(WORLD.now));
  env = await makeEnv({ clock });
  graph = new GraphStore({ sqlite: env.db.sqlite, clock });
  ingest = new GraphIngester(graph, {
    ownerEmails: WORLD.owner.emails,
    ownerPhones: WORLD.owner.phones,
    clock,
  });
  ingest.ingestContacts(WORLD.contacts);
});
afterEach(async () => env.cleanup());

const id = (name: string) =>
  graph.search(name, { limit: 10 }).find((s) => s.name === name)?.id ?? "";
const count = (kind: string) =>
  (
    env.db.sqlite
      .prepare("SELECT count(*) AS n FROM graph_interactions WHERE kind = ?")
      .get(kind) as { n: number }
  ).n;
const entities = () =>
  (env.db.sqlite.prepare("SELECT count(*) AS n FROM graph_entities").get() as { n: number }).n;

const note = (noteId: string, title: string, modifiedAt = "2026-10-17T10:00:00.000Z") => ({
  source: "apple:notes",
  id: noteId,
  title,
  modifiedAt,
});

describe("notes (§5.1 Notes: titles become mentioned links)", () => {
  it("links notes titled with a known name, never creates anyone, and follows renames", () => {
    const before = entities();
    const report = ingest.ingestNotes([
      note("n1", "Dana Fox — offsite plan"),
      note("n2", "Groceries"),
      note("n3", "Lunch with Zed Unknownperson"),
    ]);
    expect(report.interactions).toBe(1);
    expect(entities()).toBe(before);
    const dana = graph.interactions(id("Dana Fox"));
    expect(dana).toHaveLength(1);
    expect(dana[0]).toMatchObject({ kind: "note", subject: "Dana Fox — offsite plan" });
    expect(dana[0]?.participants).toEqual([{ entityId: id("Dana Fox"), role: "mentioned" }]);
    // Renamed so it no longer names anyone: the link goes.
    ingest.ingestNotes([note("n1", "Offsite plan")]);
    expect(graph.interactions(id("Dana Fox"))).toHaveLength(0);
  });

  it("skips ambiguous names, hidden people and blocklisted ones", () => {
    // "Sam" alone matches two people: no link.
    ingest.ingestNotes([note("n1", "Call Sam")]);
    expect(count("note")).toBe(0);
    graph.updateEntity(id("Nina Patel"), { hidden: true });
    graph.block("domain", "studiomo.example");
    ingest.ingestNotes([note("n2", "Nina Patel feedback"), note("n3", "Mo Chen quote")]);
    expect(count("note")).toBe(0);
  });

  it("a note never counts as the owner's words (its text may be pasted from anywhere)", () => {
    ingest.ingestNotes([note("n1", "Dana Fox — offsite plan")]);
    expect(graph.interactions(id("Dana Fox"))[0]?.direction).not.toBe("out");
  });
});

describe("chats with Psyche (§5.1: the owner's own words)", () => {
  const chat = (threadId: string, text: string, date = "2026-10-17T09:00:00.000Z") => ({
    source: "psyche:chat",
    threadId,
    date,
    text,
    link: `/chat/${threadId}`,
  });

  it("one interaction per thread and day, merging names across passes, words not stored", () => {
    ingest.ingestChats([
      chat("T1", "Remind me to call Rita Gomez about the tiles"),
      chat("T1", "and ask Mo Chen for the drawings", "2026-10-17T11:00:00.000Z"),
      chat("T2", "what's the weather"),
    ]);
    expect(count("chat")).toBe(1);
    const rita = graph.interactions(id("Rita Gomez"))[0];
    expect(rita).toMatchObject({ kind: "chat", direction: "out", subject: null });
    expect(rita?.participants.map((p) => p.entityId).sort()).toEqual(
      [id("Rita Gomez"), id("Mo Chen")].sort(),
    );
    expect(JSON.stringify(graph.interactions(id("Rita Gomez")))).not.toContain("tiles");
    // A later pass the same day keeps the earlier names.
    ingest.ingestChats([chat("T1", "Dana Fox too", "2026-10-17T15:00:00.000Z")]);
    expect(count("chat")).toBe(1);
    expect(graph.interactions(id("Rita Gomez"))[0]?.participants).toHaveLength(3);
  });
});

describe("toggle, delete one source and retention", () => {
  const adapters = (): GraphSourceAdapter[] => [
    {
      id: "notes:apple",
      source: "notes",
      pull: async () => ({ notes: [note("n1", "Dana Fox — offsite plan")], cursor: { at: 1 } }),
    },
    {
      id: "chats:psyche",
      source: "chats",
      pull: async () => ({
        chats: [
          {
            source: "psyche:chat",
            threadId: "T1",
            date: "2026-10-17T09:00:00.000Z",
            text: "ask Rita Gomez",
          },
        ],
        cursor: { at: 1 },
      }),
    },
  ];

  it("polls notes and chats only when turned on", async () => {
    await runGraphPoll(graph, adapters(), { enabled: { mail: true }, clock });
    expect(count("note") + count("chat")).toBe(0);
    await runGraphPoll(graph, adapters(), { enabled: { notes: true, chats: true }, clock });
    expect(count("note")).toBe(1);
    expect(count("chat")).toBe(1);
  });

  it("deleteSource removes their links and keeps the people", async () => {
    await runGraphPoll(graph, adapters(), { enabled: { notes: true, chats: true }, clock });
    const notes = graph.deleteSource("notes");
    expect(notes.removed).toMatchObject({ interactions: 1, entities: 0 });
    expect(count("note")).toBe(0);
    expect(graph.deleteSource("chats").removed.interactions).toBe(1);
    expect(count("chat")).toBe(0);
    expect(graph.getEntity(id("Dana Fox"))).toBeDefined();
    expect(graph.getEntity(id("Rita Gomez"))).toBeDefined();
  });

  it("retention deletes old note and chat links", () => {
    ingest.ingestNotes([note("old", "Dana Fox notes", "2024-01-01T00:00:00.000Z")]);
    expect(count("note")).toBe(1);
    graph.retention();
    expect(count("note")).toBe(0);
  });
});
