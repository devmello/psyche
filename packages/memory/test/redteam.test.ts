import { FakeClock } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExtractionSink, EXTRACTION_SINK_METHODS } from "../src/extraction/index.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";
import {
  buildWorld,
  hostileFor,
  itemsFor,
  loadCases,
  type RedteamCase,
  runHostile,
  snapshot,
  type World,
} from "./redteam-support.ts";

const CASES = loadCases();

let env: TestEnv;
let world: World;

beforeEach(async () => {
  const clock = new FakeClock(Date.parse("2026-10-28T12:00:00Z"));
  env = await makeEnv({ clock });
  world = buildWorld(env.db.sqlite, clock);
});
afterEach(async () => env.cleanup());

interface FactRow {
  id: string;
  entity_id: string;
  attribute: string;
  value: string;
  provenance: string;
  review: string;
  sensitivity: string;
  subject_kind: string;
}

const facts = () =>
  env.db.sqlite.prepare("SELECT * FROM graph_facts ORDER BY id").all() as FactRow[];

describe("red-team corpus", () => {
  it("has at least 40 cases across every attack class, with .eml and JSON", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
    for (const a of ["A", "B", "C", "D", "E", "F", "G", "H", "K"]) {
      expect(
        CASES.some((c) => c.attack === a),
        a,
      ).toBe(true);
    }
    expect(CASES.filter((c) => c.eml !== undefined).length).toBeGreaterThanOrEqual(4);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
  });

  it.each(CASES.map((c) => [c.id, c] as [string, RedteamCase]))("%s", async (_id, c) => {
    const items = itemsFor(c);
    const output = hostileFor(c, items);
    const before = snapshot(env.db.sqlite);
    const run = await runHostile(world, items, JSON.stringify(output));
    const stored = facts();
    const quarantine = world.em.quarantined({ includeDecided: true }).items;

    // --- invariants for every case -------------------------------------------------------
    // The model call offers no tools and a tool choice of none.
    for (const r of run.requests) {
      expect(r.tools).toEqual([]);
      expect(r.toolChoice).toBe("none");
    }
    // No setting, identifier, exclusion, merge, loop, claim or owner row moved.
    expect(snapshot(env.db.sqlite)).toEqual(before);
    // Nothing is ever stored about the owner (owner proposals go to USER.md review, EM3).
    expect(stored.filter((f) => f.entity_id === world.ownerId)).toEqual([]);
    const fromThirdParty = c.trust === "untrusted";
    for (const f of stored) {
      if (fromThirdParty) {
        expect(f.provenance).toBe("untrusted");
        expect(f.review).toBe("pending");
      }
      expect(f.provenance).not.toBe("owner");
      expect(["gov_id", "account_numbers"]).not.toContain(f.sensitivity);
      expect(f.value).not.toMatch(/@|https?:|<|>|\$\(/);
      // Every stored fact has a citation that re-verifies against the cleaned item text.
      const cites = world.em.citations("fact", f.id);
      expect(cites.length).toBeGreaterThan(0);
      for (const cite of cites) {
        const item = items.find((i) => i.sourceRef === cite.sourceRef);
        expect(item).toBeDefined();
        expect(item?.text.slice(cite.start, cite.end)).toBe(cite.quote);
        expect(cite.quote.length).toBeLessThanOrEqual(200);
        expect(cite.provenance).toBe(c.trust === "untrusted" ? "untrusted" : "agent");
      }
    }
    // The graph readers (what the agent and cards see) show nothing from untrusted text.
    if (fromThirdParty) {
      expect(world.graph.facts(world.samId)).toEqual([]);
      expect(world.graph.facts(world.priyaId)).toEqual([]);
    }
    for (const e of env.db.sqlite.prepare("SELECT review, provenance FROM graph_edges").all() as {
      review: string;
      provenance: string;
    }[]) {
      expect(e.review).toBe("pending");
    }

    // --- the outcome this case asserts ---------------------------------------------------
    const e = c.expect;
    switch (e.outcome) {
      case "nothing_stored":
        expect(stored).toEqual([]);
        expect(run.report?.edgesStored ?? 0).toBe(0);
        break;
      case "quarantined": {
        expect(stored).toEqual([]);
        expect(run.report?.edgesStored ?? 0).toBe(0);
        expect(quarantine.length).toBeGreaterThanOrEqual(1);
        const reasons = new Set(quarantine.flatMap((q) => q.reasons));
        for (const r of e.reasons ?? []) expect(reasons.has(r as never), r).toBe(true);
        for (const q of quarantine) {
          expect(q.excerpt.length).toBeLessThanOrEqual(300);
          expect(q.excerpt).not.toMatch(/[‪-‮​]/);
        }
        break;
      }
      case "pending":
        expect(stored.map((f) => ({ attribute: f.attribute, value: f.value })).sort(byKey)).toEqual(
          [...(e.facts ?? [])].sort(byKey),
        );
        expect(stored.every((f) => f.review === "pending" && f.provenance === "untrusted")).toBe(
          true,
        );
        if (e.maxCleanedChars !== undefined) {
          expect(items[0]?.text.length).toBeLessThanOrEqual(e.maxCleanedChars);
        }
        break;
      case "stored_trusted":
        expect(stored.map((f) => ({ attribute: f.attribute, value: f.value }))).toEqual(e.facts);
        expect(stored.every((f) => f.provenance === "agent")).toBe(true);
        break;
      case "batch_rejected":
        expect(run.rejected).toBe(true);
        expect(run.parseFailure).toBe(e.reason);
        expect(stored).toEqual([]);
        expect(new Set(quarantine.flatMap((q) => q.reasons))).toEqual(new Set(["schema_invalid"]));
        break;
      case "sender_limit":
        expect(stored.length).toBe(e.maxStored);
        expect(quarantine.length).toBe(items.length - (e.maxStored ?? 0));
        expect(quarantine.every((q) => q.reasons.includes("sender_limit"))).toBe(true);
        break;
      default:
        throw new Error(`unknown outcome ${e.outcome}`);
    }
  });
});

const byKey = (a: { attribute: string; value: string }, b: { attribute: string; value: string }) =>
  `${a.attribute}:${a.value}`.localeCompare(`${b.attribute}:${b.value}`);

describe("the write surface", () => {
  it("ExtractionSink has exactly proposeFact, proposeEdge and quarantine", () => {
    const sink = createExtractionSink(world.em);
    expect(Object.keys(sink).sort()).toEqual([...EXTRACTION_SINK_METHODS]);
    expect(Object.isFrozen(sink)).toBe(true);
    // Whatever provenance a caller asks for, the sink never writes an owner fact.
    const out = sink.proposeFact({
      entityId: world.samId,
      attribute: "likes",
      value: "tea",
      provenance: "owner" as never,
      subjectKind: "self_disclosure",
      citations: [
        {
          source: "mail",
          sourceRef: "<x>",
          quote: "I like tea",
          start: 0,
          end: 10,
          sourceHash: "h",
        },
      ],
    });
    expect(out.status).toBe("pending");
    expect(facts()[0]?.provenance).toBe("agent");
  });
});

describe("a model that misbehaves on the wire", () => {
  it("a tool call in the stream rejects the batch and nothing runs", async () => {
    const items = itemsFor(CASES.find((c) => c.id === "K01-self-birthday") as RedteamCase);
    const run = await runHostile(world, items, [
      { type: "tool_call", id: "t1", name: "message_send", input: { to: "x@evil.example" } },
      { type: "finish", reason: "tool_calls" },
    ]);
    expect(run.rejected).toBe(true);
    expect(run.parseFailure).toBe("tool_call");
    expect(facts()).toEqual([]);
    expect(world.em.quarantined().items[0]?.reasons).toEqual(["schema_invalid"]);
  });

  it("unknown fields, extra keys and prose around the JSON are rejected", async () => {
    const items = itemsFor(CASES.find((c) => c.id === "K01-self-birthday") as RedteamCase);
    const good = {
      facts: [
        {
          handle: "p1",
          attribute: "birthday",
          value: "May 3",
          item: "i1",
          quote: "My birthday is May 3.",
          start: 0,
          end: 21,
          subject_kind: "self_disclosure",
          sensitivity: "none",
          confidence: 0.9,
        },
      ],
      edges: [],
      flags: [],
    };
    for (const bad of [
      { ...good, settings: { review: false } },
      { ...good, facts: [{ ...good.facts[0], entityId: "ent_1" }] },
      { ...good, facts: [{ ...good.facts[0], email: "x@evil.example" }] },
      { ...good, facts: [{ ...good.facts[0], handle: "ent_01HX" }] },
      { ...good, facts: [{ ...good.facts[0], attribute: "relationship_to_owner" }] },
      { ...good, facts: [{ ...good.facts[0], sensitivity: "unknown" }] },
    ]) {
      const run = await runHostile(world, items, JSON.stringify(bad));
      expect(run.rejected, JSON.stringify(bad).slice(0, 80)).toBe(true);
    }
    const prose = await runHostile(world, items, `Sure! Here you go: ${JSON.stringify(good)}`);
    expect(prose.rejected).toBe(true);
    expect(facts()).toEqual([]);
  });

  it("a stream cut at the length limit never parses half a JSON", async () => {
    const items = itemsFor(CASES.find((c) => c.id === "K01-self-birthday") as RedteamCase);
    const run = await runHostile(world, items, [
      { type: "text_delta", text: '{"facts":[{"handle":"p1"' },
      { type: "finish", reason: "length" },
    ]);
    expect(run.rejected).toBe(true);
    expect(run.parseFailure).toBe("not_finished");
  });
});
