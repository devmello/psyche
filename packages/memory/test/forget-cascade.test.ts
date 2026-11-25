import { createHash } from "node:crypto";
import { openDb, type PsycheDb } from "@psyche/db";
import { FakeClock } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  forgetMatcher,
  isStopword,
  isSuppressed,
  mentions,
  minForgetChars,
  phraseHash,
  suppressionFor,
  wordsOf,
} from "../src/forget-cascade.ts";
import {
  applyGraphForget,
  applyGraphReset,
  previewGraphForget,
  previewGraphReset,
} from "../src/graph/forget.ts";
import { GraphStore } from "../src/graph/store.ts";

/**
 * The one matching rule behind forget everywhere (whole words, any script, case-insensitive) and
 * the hashed suppression of persona chunks, as two tables: what must match and near-misses that
 * share a word or a prefix and must not. Then the graph part on its own: preview equals forget,
 * and a name that merely contains the word survives.
 */

const MUST_MATCH: [phrase: string, text: string][] = [
  ["Jordan", "Jordan"],
  ["Jordan", "met jordan at noon"],
  ["Jordan", "JORDAN's party"],
  ["Jordan", "with Jordan, Pat and Alex"],
  ["Jordan", "Jordan Lee"],
  ["Jordan", "email jordan@example.com"],
  ["Jordan Lee", "Jordan   Lee called"],
  ["Jordan Lee", "ask Jordan\nLee"],
  ["Zoë", "Zoë and I"],
  ["李明", "和李明一起"],
];

const MUST_NOT_MATCH: [phrase: string, text: string][] = [
  ["Jordan", "Jordana"],
  ["Jordan", "Jordanian food"],
  ["Jordan", "Transjordan"],
  ["Jordan", "jordan2"],
  ["李明", "李"],
  ["Jordan", "Jorda n"],
  ["Jordan Lee", "Jordan Leeds"],
  ["Jordan Lee", "Jordan and Lee"],
  ["Zoë", "Zoëy"],
];

describe("forgetMatcher", () => {
  it.each(MUST_MATCH)("%j matches %j", (phrase, text) => {
    expect(mentions(forgetMatcher(phrase), text)).toBe(true);
  });
  it.each(MUST_NOT_MATCH)("%j does not match %j", (phrase, text) => {
    expect(mentions(forgetMatcher(phrase), text)).toBe(false);
  });
  it("is stateless and treats a regex-looking phrase literally", () => {
    const m = forgetMatcher("a.b (c)");
    expect(mentions(m, "a.b (c)")).toBe(true);
    expect(mentions(m, "a.b (c)")).toBe(true);
    expect(mentions(m, "axb (c)")).toBe(false);
    expect(mentions(m, null)).toBe(false);
  });
});

describe("hashed suppression of persona chunks", () => {
  const KEY = "k".repeat(64);
  const list = (...phrases: string[]) =>
    phrases.map((p) => suppressionFor(p, KEY)).filter((s) => s !== undefined);
  it.each([
    ["Jordan", "A teacher called Jordan taught me kindness."],
    ["Jordan", "jordan's notes"],
    ["Jordan Lee", "Ask Jordan  Lee first."],
    ["李明", "和李明一起吃饭"],
  ])("%j suppresses %j", (phrase, text) => {
    expect(isSuppressed(text, list(phrase), KEY)).toBe(true);
  });
  it.each([
    ["Jordan", "Jordana taught me kindness."],
    ["Jordan", "I keep things short."],
    ["Jordan Lee", "Jordan alone"],
    ["李明", "和李华一起吃饭"],
  ])("%j leaves %j", (phrase, text) => {
    expect(isSuppressed(text, list(phrase), KEY)).toBe(false);
  });
  it("keeps no plaintext, and the hash is keyed: another install's key gives another hash", () => {
    const s = suppressionFor("Jordan Lee", KEY);
    expect(s).toEqual({ k: 2, h: phraseHash(KEY, wordsOf("jordan lee")) });
    expect(JSON.stringify(s)).not.toMatch(/jordan/i);
    // Not the bare SHA-256 of the words: a list of names cannot be hashed and compared.
    expect(s?.h).not.toBe(createHash("sha256").update("jordan lee").digest("hex"));
    expect(suppressionFor("Jordan Lee", "z".repeat(64))?.h).not.toBe(s?.h);
    // A list made with one key matches nothing under another.
    expect(isSuppressed("Ask Jordan Lee", list("Jordan Lee"), "z".repeat(64))).toBe(false);
  });
});

describe("what a forget refuses", () => {
  it.each([
    "the",
    "The",
    "a",
    "an",
    "and",
    "or",
    "i",
    "me",
    "my",
    "you",
    "it",
    "of",
    "to",
    "in",
    "on",
    "at",
    "is",
  ])("%j is a stopword", (w) => expect(isStopword(w)).toBe(true));
  it.each(["Jordan", "the Jordans", "Theo", "isle", "on call", "李明"])("%j is not", (w) =>
    expect(isStopword(w)).toBe(false),
  );
  it.each([
    ["李明", 2],
    ["李", 2],
    ["ab", 3],
    ["Jordan", 3],
    ["ab李", 2],
  ])("the fewest characters for %j is %d", (w, n) => expect(minForgetChars(w)).toBe(n));
});

describe("graph forget and reset", () => {
  let db: PsycheDb;
  let g: GraphStore;
  beforeEach(() => {
    db = openDb(":memory:");
    g = new GraphStore({ sqlite: db.sqlite, clock: new FakeClock() });
  });
  afterEach(() => db.close());

  const person = (name: string) => g.createEntity({ kind: "person", name, source: "owner" });

  it("previews exactly what it deletes, and leaves Jordana, the owner and other facts", () => {
    const jordan = person("Jordan");
    const jordana = person("Jordana");
    const pat = person("Pat");
    const owner = g.ensureOwnerEntity({ name: "Jordan Owner" });
    g.setFact({ entityId: jordan.id, attribute: "city", value: "Oslo", provenance: "owner" });
    g.setFact({ entityId: jordana.id, attribute: "city", value: "Lima", provenance: "owner" });
    g.setFact({ entityId: pat.id, attribute: "note", value: "Dated Jordan", provenance: "owner" });
    g.setFact({ entityId: pat.id, attribute: "preference", value: "tea", provenance: "owner" });
    g.setFact({
      entityId: owner.id,
      attribute: "note",
      value: "Jordan is my brother",
      provenance: "owner",
    });
    const m = forgetMatcher("Jordan");
    const preview = previewGraphForget(db.sqlite, g, m);
    expect(preview.counts.graphEntities).toBe(1);
    const applied = applyGraphForget(db.sqlite, g, m);
    expect(applied.counts).toEqual(preview.counts);
    expect(g.getEntity(jordan.id)).toBeUndefined();
    expect(g.getEntity(jordana.id)?.name).toBe("Jordana");
    // The owner's own entity is never deleted; the fact that names him is.
    expect(g.getEntity(owner.id)).toBeDefined();
    expect(g.facts(owner.id)).toEqual([]);
    expect(g.facts(pat.id).map((f) => f.value)).toEqual(["tea"]);
    // A second pass finds nothing, and the wrong-fact hash keeps the value from coming back.
    expect(previewGraphForget(db.sqlite, g, m).counts).toMatchObject({
      graphEntities: 0,
      graphFacts: 0,
    });
    expect(g.isRejectedFact(pat.id, "note", "Dated Jordan")).toBe(true);
    const text = JSON.stringify(
      db.sqlite.prepare("SELECT * FROM graph_feedback").all() as unknown[],
    );
    expect(text).not.toMatch(/jordan/i);
  });

  it("reset counts, then erases entities, citations and quarantine together", () => {
    const pat = person("Pat");
    g.setFact({ entityId: pat.id, attribute: "note", value: "x", provenance: "owner" });
    db.sqlite
      .prepare(
        `INSERT INTO graph_citations (id, target_kind, target_id, source, source_ref, quote, start, "end",
           source_hash, provenance, observed_at, created_at)
         VALUES ('c1', 'entity', ?, 'mail', 'r', 'q', 0, 1, 'h', 'untrusted', 'x', 'x')`,
      )
      .run(pat.id);
    db.sqlite
      .prepare(
        `INSERT INTO memory_quarantine (id, source, source_ref, reasons, excerpt, created_at)
         VALUES ('q1', 'mail', 'r', '["x"]', 'e', 'x')`,
      )
      .run();
    const counts = previewGraphReset(db.sqlite);
    expect(counts).toMatchObject({ entities: 1, facts: 1, citations: 1, quarantine: 1 });
    expect(applyGraphReset(db.sqlite)).toEqual(counts);
    expect(previewGraphReset(db.sqlite)).toEqual({
      entities: 0,
      facts: 0,
      edges: 0,
      interactions: 0,
      loops: 0,
      citations: 0,
      quarantine: 0,
    });
  });

  it("reset keeps the blocklist, cursors, wrong-fact corrections, exclusions and trusted senders", () => {
    const ghost = g.createEntity({
      kind: "person",
      name: "Ghost",
      identifiers: [{ kind: "email", value: "ghost@example.com" }],
      source: "owner",
      linkedBy: "owner",
    });
    const pat = person("Pat");
    g.setFact({ entityId: pat.id, attribute: "note", value: "wrong", provenance: "owner" });
    const fact = g.facts(pat.id)[0];
    g.retractFact(fact?.id ?? "");
    g.forget(ghost.id); // blocklists the address (a hash)
    db.sqlite
      .prepare("INSERT INTO graph_cursors (source, cursor, updated_at) VALUES ('mail', '{}', 'x')")
      .run();
    db.sqlite
      .prepare(
        "INSERT INTO graph_exclusions (kind, value_hash, mode, created_at) VALUES ('domain', 'h', 'exclude', 'x')",
      )
      .run();
    expect(g.isBlocked("email", "ghost@example.com")).toBe(true);
    applyGraphReset(db.sqlite);
    const n = (t: string) =>
      (db.sqlite.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect(n("graph_entities")).toBe(0);
    expect(n("graph_facts")).toBe(0);
    // A poll after the reset still cannot bring the forgotten person back (must refuse)...
    expect(g.isBlocked("email", "ghost@example.com")).toBe(true);
    expect(() =>
      g.createEntity({
        kind: "person",
        name: "Ghost",
        identifiers: [{ kind: "email", value: "ghost@example.com" }],
        linkedBy: "rule",
        source: "mail",
      }),
    ).toThrow(/forgotten/);
    // ...and reads from where it stopped, not from the start.
    expect(n("graph_cursors")).toBe(1);
    expect(n("graph_exclusions")).toBe(1);
    expect(
      (
        db.sqlite
          .prepare("SELECT count(*) AS n FROM graph_feedback WHERE kind = 'wrong_fact'")
          .get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });
});
