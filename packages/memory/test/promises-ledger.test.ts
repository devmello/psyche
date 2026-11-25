import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@psyche/db";
import { PsycheError } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EverythingStore } from "../src/graph/everything.ts";
import { GraphStore } from "../src/graph/store.ts";
import {
  type AddResult,
  type LegacyFollowup,
  type PromiseInput,
  type PromiseRow,
  PromiseStore,
} from "../src/promises/store.ts";
import { copyTables, MEMORY_STORE_TABLES, newKey, openEncrypted } from "../src/secure/encrypted.ts";
import { syncSchema } from "../src/secure/migrate.ts";

const MON = Date.parse("2026-11-23T09:00:00.000Z");
const DAY = 86_400_000;
const FRI = "2026-11-27T17:00:00.000Z";
const at = (iso: string) => Date.parse(iso);

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-ledger-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Env {
  clock: FakeClock;
  sqlite: Database.Database;
  graph: GraphStore;
  store: PromiseStore;
  sam: string;
  dana: string;
  close: () => void;
}

function make(backend: "plain" | "encrypted", file = false): Env {
  const clock = new FakeClock(MON);
  const plain = openDb(file ? join(dir, "plain.sqlite") : ":memory:");
  let sqlite = plain.sqlite;
  let close = () => plain.close();
  if (backend === "encrypted") {
    const enc = openEncrypted(join(dir, "memory.sqlite"), newKey());
    copyTables(enc, plain.sqlite, MEMORY_STORE_TABLES);
    plain.close();
    sqlite = enc;
    close = () => enc.close();
  }
  const graph = new GraphStore({ sqlite, clock });
  const store = new PromiseStore({ graph, sqlite, clock, timezone: "UTC" });
  const sam = graph.createEntity({ kind: "person", name: "Sam Lee" }).id;
  const dana = graph.createEntity({ kind: "person", name: "Dana Kim" }).id;
  return { clock, sqlite, graph, store, sam, dana, close };
}

const created = (r: AddResult): PromiseRow => {
  if (r.kind !== "created") throw new Error(`expected created, got ${r.kind}`);
  return r.promise;
};

describe.each(["plain", "encrypted"] as const)("promise ledger on the %s store", (backend) => {
  let e: Env;
  beforeEach(() => {
    e = make(backend);
  });
  afterEach(() => e.close());

  const input = (o: Partial<PromiseInput> = {}): PromiseInput => ({
    direction: "i_owe",
    what: "send the deck",
    counterpartId: e.sam,
    dueAt: FRI,
    provenance: "owner",
    confidence: 0.9,
    detectedBy: "model",
    sourceKind: "mail",
    ...o,
  });
  const mine = (o: Partial<PromiseInput> = {}) => created(e.store.add(input(o)));
  const theirs = (o: Partial<PromiseInput> = {}) =>
    created(
      e.store.add(
        input({
          direction: "waiting_on",
          what: "deliver the contract",
          provenance: "untrusted",
          confidence: 0.8,
          ...o,
        }),
      ),
    );
  const sweepAt = (iso: string) => {
    e.clock.set(at(iso));
    return e.store.sweep();
  };
  const status = (id: string) => e.store.get(id)?.status;
  const eventKinds = (id: string) => e.store.events(id).map((x) => `${x.kind}:${x.to}`);

  describe("what opens a promise", () => {
    it("opens the owner's own words at the threshold, suggests the rest, drops the weak", () => {
      expect(mine().status).toBe("open");
      expect(mine({ what: "call the bank", confidence: 0.7 }).status).toBe("suggested");
      expect(e.store.add(input({ what: "maybe tidy up", confidence: 0.5 }))).toEqual({
        kind: "rejected",
        reason: "low_confidence",
      });
    });

    it("starts other people's promises as To confirm, even from the owner's own words", () => {
      expect(theirs().status).toBe("suggested");
      expect(
        theirs({ what: "Sam will review the draft", provenance: "owner", confidence: 0.95 }).status,
      ).toBe("suggested");
      // A manual add by the owner is the one way a waiting_on promise opens directly.
      expect(
        mine({
          direction: "waiting_on",
          what: "Dana owes me the keys",
          detectedBy: "owner",
          counterpartId: e.dana,
        }).status,
      ).toBe("open");
    });

    it("writes the ledger columns and a created event", () => {
      const p = mine({
        whatAction: "send",
        dueText: "by Friday",
        threadKey: "tk",
        counterpartLabel: "Sam",
        citation: {
          source: "mail",
          sourceRef: "m1",
          quote: "I will send the deck",
          provenance: "owner",
        },
      });
      expect(p).toMatchObject({
        basis: "promise",
        whatAction: "send",
        dueText: "by Friday",
        dueKind: "explicit",
        threadKey: "tk",
        sourceKind: "mail",
        counterpartLabel: "Sam",
        // A mail promise has no Messages marker, so the W5 scrub lets a remote viewer see it.
        remoteVisible: true,
        nudgeCount: 0,
        state: "open",
      });
      expect(e.store.events(p.id)).toHaveLength(1);
      expect(e.store.citations(p.id)).toEqual([
        expect.objectContaining({ source: "mail", quote: "I will send the deck" }),
      ]);
    });

    it("never marks a Messages promise remote-visible", () => {
      const p = mine({ sourceKind: "messages", what: "reply to the landlord" });
      expect(p.remoteVisible).toBe(false);
      expect(() =>
        e.sqlite.prepare("UPDATE graph_loops SET remote_visible = 1 WHERE id = ?").run(p.id),
      ).toThrow(/CHECK/);
    });
  });

  describe("states (design 4.1)", () => {
    it("confirm moves suggested to open and records the confirm", () => {
      const p = theirs();
      expect(e.store.act(p.id, { action: "confirm" }).status).toBe("open");
      expect(eventKinds(p.id)).toContain("confirmed:open");
      expect(() => e.store.act(p.id, { action: "confirm" })).toThrow(PsycheError);
    });

    it("not a promise dismisses, writes feedback and raises that source's threshold", () => {
      expect(e.store.thresholds().mail).toBe(0.8);
      const p = theirs();
      const r = e.store.act(p.id, { action: "not_promise" });
      expect(r).toMatchObject({ status: "dismissed", closedBy: "owner" });
      expect(e.store.thresholds().mail).toBe(0.82);
      expect(e.store.thresholds().chat).toBe(0.8);
      // 0.81 now only suggests, where it used to open.
      expect(mine({ what: "email the plan", confidence: 0.81 }).status).toBe("suggested");
    });

    it("due soon is computed: the working day before the due day, and only with a confident date", () => {
      const p = mine();
      e.clock.set(at("2026-11-25T23:59:00.000Z"));
      expect(e.store.get(p.id)?.state).toBe("open");
      e.clock.set(at("2026-11-26T00:00:00.000Z"));
      expect(e.store.get(p.id)).toMatchObject({ state: "due_soon", status: "open" });
      // Monday due: the day before is Friday, across the weekend.
      const m = mine({ what: "book the room", dueAt: "2026-11-30T10:00:00.000Z" });
      e.clock.set(at("2026-11-27T00:00:00.000Z"));
      expect(e.store.get(m.id)?.state).toBe("due_soon");
      // A date the model was unsure of shows "No date": never due soon.
      const v = mine({ what: "plan the trip", dueKind: "inferred", dueConfidence: 0.5 });
      expect(e.store.get(v.id)?.state).toBe("open");
    });

    it("warns once, the working day before at 16:00, and again only after the date changes", () => {
      const p = mine();
      expect(sweepAt("2026-11-26T15:59:00.000Z").warned).toEqual([]);
      expect(sweepAt("2026-11-26T16:00:00.000Z").warned).toEqual([p.id]);
      expect(sweepAt("2026-11-26T17:00:00.000Z").warned).toEqual([]);
      expect(e.store.get(p.id)?.warnedAt).not.toBeNull();
      e.store.act(p.id, { action: "set_due", dueAt: "2026-11-30T17:00:00.000Z" });
      expect(e.store.get(p.id)?.warnedAt).toBeNull();
      expect(sweepAt("2026-11-27T16:00:00.000Z").warned).toEqual([p.id]);
    });

    it("never warns about their promises or an uncertain date", () => {
      theirs({ confidence: 0.9 });
      mine({ what: "plan the trip", dueKind: "inferred", dueConfidence: 0.4 });
      expect(sweepAt("2026-11-27T16:30:00.000Z").warned).toEqual([]);
    });

    it("yours breaks at the next 06:00 after the due day, theirs a working day later", () => {
      const m = mine();
      const t = theirs();
      e.store.act(t.id, { action: "confirm" });
      expect(sweepAt("2026-11-28T05:59:00.000Z").broken).toEqual([]);
      expect(sweepAt("2026-11-28T06:00:00.000Z").broken).toEqual([m.id]);
      expect(e.store.get(m.id)).toMatchObject({
        status: "broken",
        brokenAt: "2026-11-28T06:00:00.000Z",
      });
      // Theirs: due Friday, one working day of grace is Monday, late from Tuesday 06:00.
      expect(sweepAt("2026-11-30T23:00:00.000Z").broken).toEqual([]);
      const late = sweepAt("2026-12-01T06:00:00.000Z");
      expect(late.broken).toEqual([t.id]);
      expect(late.nudgeEligible).toContain(t.id);
      // Idempotent: a second sweep changes nothing.
      expect(sweepAt("2026-12-01T07:00:00.000Z").broken).toEqual([]);
      expect(eventKinds(m.id).filter((k) => k === "status:broken")).toHaveLength(1);
    });

    it("done after broken keeps broken_at, so the UI can say done late", () => {
      const p = mine();
      sweepAt("2026-11-28T06:00:00.000Z");
      e.clock.set(at("2026-11-29T10:00:00.000Z"));
      const done = e.store.act(p.id, { action: "done" });
      expect(done).toMatchObject({
        status: "done",
        closedBy: "owner",
        brokenAt: "2026-11-28T06:00:00.000Z",
      });
      expect(done.closedAt).toBe("2026-11-29T10:00:00.000Z");
    });

    it("broken can be released, or reopened by a new date, but not plainly reopened", () => {
      const a = mine({ what: "write the memo" });
      const b = mine({ what: "pay the invoice", counterpartId: e.dana });
      sweepAt("2026-11-28T06:00:00.000Z");
      expect(e.store.act(a.id, { action: "release" })).toMatchObject({
        status: "released",
        closedBy: "released",
      });
      expect(() => e.store.act(b.id, { action: "reopen" })).toThrow(PsycheError);
      const r = e.store.act(b.id, { action: "set_due", dueAt: "2026-12-04T17:00:00.000Z" });
      expect(r).toMatchObject({
        status: "open",
        brokenAt: null,
        dueAt: "2026-12-04T17:00:00.000Z",
      });
    });

    it("more time adds days to the later of the due date and now", () => {
      const p = mine();
      expect(e.store.act(p.id, { action: "more_time", days: 3 }).dueAt).toBe(
        "2026-11-30T17:00:00.000Z",
      );
      sweepAt("2026-12-05T10:00:00.000Z");
      expect(e.store.act(p.id, { action: "more_time", days: 2 }).dueAt).toBe(
        "2026-12-07T10:00:00.000Z",
      );
      expect(() => e.store.act(p.id, { action: "more_time", days: 0 })).toThrow(PsycheError);
    });

    it("snooze wakes in the sweep once the time has passed", () => {
      const p = mine({ dueAt: null, dueKind: "none" });
      e.store.act(p.id, { action: "snooze", until: "2026-11-24T09:00:00.000Z" });
      expect(status(p.id)).toBe("snoozed");
      expect(sweepAt("2026-11-24T08:59:00.000Z").woke).toEqual([]);
      expect(sweepAt("2026-11-24T09:00:00.000Z").woke).toEqual([p.id]);
      expect(e.store.get(p.id)).toMatchObject({ status: "open", snoozedUntil: null });
      expect(() => e.store.act(p.id, { action: "snooze", until: "2020-01-01T00:00:00Z" })).toThrow(
        PsycheError,
      );
    });

    it("an automatic done can be undone for 7 days, not longer", () => {
      const a = mine({ what: "send the slides" });
      const b = mine({ what: "send the notes", counterpartId: e.dana });
      e.store.act(a.id, { action: "done", by: "auto" });
      e.store.act(b.id, { action: "done", by: "auto" });
      expect(e.store.events(a.id).map((x) => x.kind)).toContain("auto_done");
      e.clock.advance(7 * DAY);
      expect(e.store.act(a.id, { action: "reopen" }).status).toBe("open");
      expect(e.store.events(a.id).map((x) => x.kind)).toContain("undo");
      e.clock.advance(1);
      expect(() => e.store.act(b.id, { action: "reopen" })).toThrow(/7 days/);
    });

    it("rejects an action from the wrong state", () => {
      const p = theirs();
      expect(() => e.store.act(p.id, { action: "done" })).toThrow(PsycheError);
      expect(() => e.store.act(p.id, { action: "snooze", until: "2030-01-01T00:00:00Z" })).toThrow(
        PsycheError,
      );
      e.store.act(p.id, { action: "dismiss" });
      expect(() => e.store.act(p.id, { action: "release" })).toThrow(PsycheError);
      expect(() => e.store.act("nope", { action: "done" })).toThrow(/no such promise/);
    });
  });

  describe("no due date", () => {
    it("asks Still on? for yours after 14 days open, then again 14 days after the ask", () => {
      const p = mine({ dueAt: null, dueKind: "none" });
      expect(sweepAt("2026-12-06T08:59:00.000Z").stillOn).toEqual([]);
      expect(sweepAt("2026-12-07T09:00:00.000Z").stillOn).toEqual([p.id]);
      expect(sweepAt("2026-12-07T10:00:00.000Z").stillOn).toEqual([]);
      expect(sweepAt("2026-12-20T09:00:00.000Z").stillOn).toEqual([]);
      expect(sweepAt("2026-12-21T09:00:00.000Z").stillOn).toEqual([p.id]);
    });

    it("answering Yes counts as activity and Not yet does not", () => {
      const p = mine({ dueAt: null, dueKind: "none" });
      sweepAt("2026-12-07T09:00:00.000Z");
      expect(e.store.act(p.id, { action: "answer", answer: "yes" })).toMatchObject({
        status: "open",
      });
      expect(eventKinds(p.id)).toContain("confirmed:still_on");
      // Answered: the same question cannot be answered twice.
      expect(() => e.store.act(p.id, { action: "answer", answer: "yes" })).toThrow(
        /no open question/,
      );
    });

    it("ages out after 60 days without activity and keeps the history", () => {
      const p = mine({ dueAt: null, dueKind: "none" });
      e.clock.set(MON + 59 * DAY);
      expect(e.store.sweep().agedOut).toEqual([]);
      e.clock.set(MON + 60 * DAY);
      expect(e.store.sweep().agedOut).toEqual([p.id]);
      expect(e.store.get(p.id)).toMatchObject({ status: "dismissed", closedBy: "aged_out" });
      expect(e.store.events(p.id).length).toBeGreaterThan(1);
    });

    it("a new mention is activity, so it ages out 60 days after the last one", () => {
      const p = mine({ dueAt: null, dueKind: "none", what: "send the roadmap" });
      e.clock.set(MON + 50 * DAY);
      const again = e.store.add(
        input({ what: "send the roadmap", dueAt: null, dueKind: "none", sourceKind: "chat" }),
      );
      expect(again.kind).toBe("merged");
      e.clock.set(MON + 100 * DAY);
      expect(e.store.sweep().agedOut).toEqual([]);
      e.clock.set(MON + 110 * DAY);
      expect(e.store.sweep().agedOut).toEqual([p.id]);
    });

    it("an uncertain date is treated as no date", () => {
      const p = mine({ dueKind: "inferred", dueConfidence: 0.4, dueText: "sometime next week" });
      expect(sweepAt("2026-12-30T00:00:00.000Z").broken).toEqual([]);
      expect(status(p.id)).toBe("open");
    });

    it("theirs become nudge-eligible after 7 days, and not past two nudges", () => {
      const t = theirs({ dueAt: null, dueKind: "none" });
      e.store.act(t.id, { action: "confirm" });
      expect(sweepAt("2026-11-29T08:59:00.000Z").nudgeEligible).toEqual([]);
      expect(sweepAt("2026-11-30T09:00:00.000Z").nudgeEligible).toEqual([t.id]);
      e.store.recordNudge(t.id, "drafted");
      expect(e.store.get(t.id)?.nudgeCount).toBe(0);
      e.store.recordNudge(t.id, "sent");
      expect(sweepAt("2026-12-01T09:00:00.000Z").nudgeEligible).toEqual([t.id]);
      e.store.recordNudge(t.id, "sent");
      expect(e.store.get(t.id)).toMatchObject({ nudgeCount: 2 });
      expect(sweepAt("2026-12-02T09:00:00.000Z").nudgeEligible).toEqual([]);
    });

    it("a done question held back by Not yet comes back after 3 days", () => {
      const t = theirs({ what: "send me the contract" });
      e.store.act(t.id, { action: "confirm" });
      e.store.recordAsk(t.id, "done");
      e.store.act(t.id, { action: "answer", answer: "not_yet" });
      expect(e.store.askSuppressed(t.id)).toBe(true);
      e.clock.advance(3 * DAY - 1);
      expect(e.store.askSuppressed(t.id)).toBe(true);
      e.clock.advance(1);
      expect(e.store.askSuppressed(t.id)).toBe(false);
      e.store.recordAsk(t.id, "done");
      expect(e.store.act(t.id, { action: "answer", answer: "yes" }).status).toBe("done");
    });
  });

  describe("renegotiation (design 4.3)", () => {
    it("agreed: the date updates, a broken promise reopens, and both citations are kept", () => {
      const p = mine();
      sweepAt("2026-11-28T06:00:00.000Z");
      const r = e.store.renegotiateAgreed(p.id, {
        newDueAt: "2026-11-30T12:00:00.000Z",
        citations: [
          { source: "mail", sourceRef: "m1", quote: "can we do Monday?", provenance: "owner" },
          { source: "mail", sourceRef: "m2", quote: "Monday's fine", provenance: "untrusted" },
        ],
      });
      expect(r).toMatchObject({
        status: "open",
        dueAt: "2026-11-30T12:00:00.000Z",
        brokenAt: null,
        proposedDueAt: null,
      });
      const changed = e.store.events(p.id).find((x) => x.kind === "due_changed");
      expect(changed).toMatchObject({ from: FRI, to: "2026-11-30T12:00:00.000Z" });
      expect(changed?.citationId).not.toBeNull();
      expect(e.store.citations(p.id)).toHaveLength(2);
      // The new Monday due date's warning (Friday 16:00) is already past, so it goes out now,
      // once; the old Friday date no longer breaks the promise.
      expect(sweepAt("2026-11-28T07:00:00.000Z").warned).toEqual([p.id]);
      expect(sweepAt("2026-11-28T08:00:00.000Z").warned).toEqual([]);
      expect(sweepAt("2026-12-01T05:59:00.000Z").broken).toEqual([]);
      expect(sweepAt("2026-12-01T06:00:00.000Z").broken).toEqual([p.id]);
    });

    it("proposed: the date is stored beside the old one, which stands, until accepted", () => {
      const t = theirs();
      e.store.act(t.id, { action: "confirm" });
      const r = e.store.renegotiateProposed(t.id, {
        proposedDueAt: "2026-12-01T09:00:00.000Z",
        citation: {
          source: "mail",
          sourceRef: "m3",
          quote: "can I send it Monday?",
          provenance: "untrusted",
        },
      });
      expect(r).toMatchObject({ dueAt: FRI, proposedDueAt: "2026-12-01T09:00:00.000Z" });
      expect(e.store.events(t.id).map((x) => x.kind)).toContain("due_proposed");
      // The proposal does not move the break time.
      expect(sweepAt("2026-12-01T06:00:00.000Z").broken).toEqual([t.id]);
      const accepted = e.store.act(t.id, { action: "accept_proposed" });
      expect(accepted).toMatchObject({
        status: "open",
        dueAt: "2026-12-01T09:00:00.000Z",
        proposedDueAt: null,
      });
    });

    it("proposed by the owner for their own promise: the date stands, and Keep clears it", () => {
      const p = mine();
      e.store.renegotiateProposed(p.id, { proposedDueAt: "2026-12-02T09:00:00.000Z", by: "owner" });
      expect(e.store.get(p.id)).toMatchObject({
        dueAt: FRI,
        proposedDueAt: "2026-12-02T09:00:00.000Z",
      });
      const kept = e.store.act(p.id, { action: "reject_proposed" });
      expect(kept).toMatchObject({ dueAt: FRI, proposedDueAt: null });
      expect(() => e.store.act(p.id, { action: "accept_proposed" })).toThrow(PsycheError);
    });

    it("refuses to renegotiate a closed promise or a bad date", () => {
      const p = mine();
      expect(() => e.store.renegotiateAgreed(p.id, { newDueAt: "soon" })).toThrow(PsycheError);
      e.store.act(p.id, { action: "done" });
      expect(() => e.store.renegotiateAgreed(p.id, { newDueAt: FRI })).toThrow(/closed/);
      expect(() => e.store.renegotiateProposed(p.id, { proposedDueAt: FRI })).toThrow(/closed/);
    });
  });

  describe("dedupe across sources (design 3.4)", () => {
    it("merges a repeat of the exact promise into one row with two citations", () => {
      const p = mine({
        citation: {
          source: "mail",
          sourceRef: "m1",
          quote: "I'll send the deck",
          provenance: "owner",
        },
      });
      const r = e.store.add(
        input({
          sourceKind: "meeting",
          citation: {
            source: "transcripts",
            sourceRef: "t1",
            quote: "send the deck Friday",
            provenance: "owner",
          },
        }),
      );
      expect(r).toMatchObject({ kind: "merged", promise: { id: p.id } });
      expect(e.store.citations(p.id)).toHaveLength(2);
      expect(e.store.events(p.id).map((x) => x.kind)).toContain("source_added");
      expect(e.store.list("all")).toHaveLength(1);
    });

    it.each([
      ["a reorder with the same content words", "send Sam the deck", {}],
      ["extra stopwords and punctuation", "I'll send the deck, please!", {}],
      ["a due date a day later", "send the deck", { dueAt: "2026-11-28T17:00:00.000Z" }],
    ])("merges %s", (_name, what, over) => {
      const p = mine();
      const r = e.store.add(input({ what, ...over }));
      expect(r).toMatchObject({ kind: "merged", promise: { id: p.id } });
    });

    it.each([
      ["another counterpart", {}, { counterpartId: "dana" }],
      ["the other direction", { direction: "waiting_on", provenance: "untrusted" }, {}],
      ["a due date 3 days apart", { dueAt: "2026-11-30T18:00:00.000Z" }, {}],
      ["a due date against none", { dueAt: null, dueKind: "none" }, {}],
      ["different content", { what: "book the venue downtown" }, {}],
    ])("keeps apart %s", (_name, over, special) => {
      mine({ what: "send the deck" });
      const o = { ...over } as Partial<PromiseInput>;
      if ("counterpartId" in special) o.counterpartId = e.dana;
      // "over" is a content word: the text alone would merge, so only the other field keeps them apart.
      const r = e.store.add(input({ what: "send over the deck", ...o }));
      expect(r.kind).toBe("created");
      expect(e.store.list("all")).toHaveLength(2);
    });

    it("keeps apart two made more than 14 days apart", () => {
      mine({ dueAt: null, dueKind: "none" });
      e.clock.advance(15 * DAY);
      const r = e.store.add(input({ dueAt: null, dueKind: "none" }));
      // Same exact promise text: the exact key still finds it (rule 1), the fuzzy window is rule 3.
      expect(r.kind).toBe("merged");
      const other = e.store.add(input({ what: "ship the deck", dueAt: null, dueKind: "none" }));
      expect(other.kind).toBe("created");
    });

    it("queues a middling overlap as a same_as question instead of merging", () => {
      const a = mine({ what: "send the deck" });
      const r = e.store.add(input({ what: "send the invoice" }));
      expect(r).toMatchObject({ kind: "created", sameAsCandidate: a.id });
      const b = (r as { promise: PromiseRow }).promise;
      expect(e.store.pendingSameAs()).toEqual([[b.id, a.id]]);
      e.store.resolveSameAs(b.id);
      expect(e.store.pendingSameAs()).toEqual([]);
    });

    it("takes the more explicit due date and never overwrites a different one silently", () => {
      const p = mine({ dueAt: null, dueKind: "none", what: "send the roadmap" });
      e.store.add(input({ what: "send the roadmap", dueAt: FRI, dueKind: "explicit" }));
      expect(e.store.get(p.id)).toMatchObject({ dueAt: FRI, dueKind: "explicit" });
      // An inferred date does not displace an explicit one.
      e.store.add(
        input({
          what: "send the roadmap",
          dueAt: "2026-11-28T09:00:00.000Z",
          dueKind: "inferred",
          dueConfidence: 0.7,
        }),
      );
      expect(e.store.get(p.id)?.dueAt).toBe(FRI);
      expect(e.store.events(p.id).filter((x) => x.kind === "due_changed")).toHaveLength(1);
    });

    it("never extracts a deleted or rejected promise again", () => {
      const p = mine();
      e.store.delete(p.id);
      expect(e.store.add(input())).toEqual({ kind: "rejected", reason: "not_a_promise" });
      const t = theirs();
      e.store.act(t.id, { action: "not_promise" });
      expect(
        e.store.add(
          input({
            direction: "waiting_on",
            what: "deliver the contract",
            provenance: "untrusted",
            confidence: 0.8,
          }),
        ),
      ).toMatchObject({
        kind: "rejected",
      });
    });
  });

  describe("thresholds from feedback", () => {
    it("recomputes from the store: not-a-promise raises, confirms lower, within the clamp", () => {
      const things = [
        "bring apples",
        "fix the bicycle",
        "sign lease papers",
        "return library books",
      ];
      for (let i = 0; i < 4; i += 1) {
        const t = theirs({ what: things[i] as string, counterpartId: e.dana });
        e.store.act(t.id, { action: i % 2 === 0 ? "not_promise" : "confirm" });
      }
      // 2 not_promise (+0.04) and 2 confirms (-0.02) on mail.
      expect(e.store.thresholds().mail).toBe(0.82);
      // Feedback older than 90 days stops counting.
      e.clock.advance(91 * DAY);
      expect(e.store.thresholds().mail).toBe(0.8);
    });
  });

  describe("the follow-ups import", () => {
    const item = (o: Partial<LegacyFollowup> = {}): LegacyFollowup => ({
      id: "fu_1",
      text: "send Dana the budget",
      source: "sent_mail",
      status: "open",
      createdAt: "2026-11-10T10:00:00.000Z",
      dueAt: "2026-11-25T10:00:00.000Z",
      ...o,
    });

    it("maps open, snoozed, done, dismissed and awaiting-reply, and runs twice safely", () => {
      const items = [
        item(),
        item({
          id: "fu_2",
          text: "ring the plumber",
          source: "message",
          status: "snoozed",
          snoozedUntil: "2026-11-30T09:00:00.000Z",
          dueAt: undefined,
        }),
        item({ id: "fu_3", text: "file the report", status: "done", dueAt: undefined }),
        item({
          id: "fu_4",
          text: "order the cake",
          source: "manual",
          status: "dismissed",
          dueAt: undefined,
        }),
        item({
          id: "fu_5",
          text: "Waiting for a reply from Sam: the lease",
          source: "awaiting_reply",
          dueAt: undefined,
        }),
      ];
      expect(items.map((i) => e.store.importFollowup(i))).toEqual(Array(5).fill("added"));
      expect(items.map((i) => e.store.importFollowup(i))).toEqual(Array(5).fill("exists"));
      const rows = e.sqlite
        .prepare(
          "SELECT status, basis, direction, source_kind, detected_by, provenance, snoozed_until, due_kind FROM graph_loops ORDER BY created_at, id",
        )
        .all();
      expect(rows).toHaveLength(5);
      expect(rows[0]).toMatchObject({
        status: "open",
        basis: "promise",
        direction: "i_owe",
        source_kind: "mail",
        detected_by: "rule",
        provenance: "owner",
        due_kind: "explicit",
      });
      expect(rows[1]).toMatchObject({
        status: "snoozed",
        source_kind: "messages",
        snoozed_until: "2026-11-30T09:00:00.000Z",
        due_kind: "none",
      });
      expect(rows[2]).toMatchObject({ status: "done" });
      expect(rows[3]).toMatchObject({ status: "dismissed", source_kind: "manual" });
      expect(rows[4]).toMatchObject({ basis: "ask", direction: "waiting_on" });
      // The imported open one is a normal promise: it breaks on schedule.
      expect(sweepAt("2026-11-26T06:00:00.000Z").broken).toHaveLength(1);
    });

    it("skips text the store filters out, and says so", () => {
      expect(e.store.importFollowup(item({ id: "fu_9", text: "" }))).toBe("skipped");
    });
  });

  describe("retention and delete", () => {
    const old = (iso: string) => e.clock.set(at(iso));

    it("expires suggested at 30 days and deletes closed after 180, keeping open and broken", () => {
      const sug = theirs({ what: "bring the keys", counterpartId: e.dana });
      const done = mine({ what: "pay the bill" });
      e.store.act(done.id, { action: "done" });
      const open = mine({
        what: "plan the offsite",
        counterpartId: e.dana,
        dueAt: null,
        dueKind: "none",
      });
      const broken = mine({ what: "sign the lease", dueAt: "2026-11-24T10:00:00.000Z" });
      sweepAt("2026-11-25T06:00:00.000Z");
      expect(status(broken.id)).toBe("broken");
      old("2026-12-22T09:00:00.000Z");
      expect(e.store.retain()).toMatchObject({ suggestedExpired: 0, closedDeleted: 0 });
      e.clock.set(MON + 30 * DAY + 1);
      expect(e.store.retain().suggestedExpired).toBe(1);
      expect(e.store.get(sug.id)).toBeUndefined();
      e.clock.set(MON + 179 * DAY);
      expect(e.store.retain().closedDeleted).toBe(0);
      e.clock.set(MON + 181 * DAY);
      const r = e.store.retain();
      expect(r.closedDeleted).toBe(1);
      expect(e.store.get(done.id)).toBeUndefined();
      expect(e.store.get(open.id)).toBeDefined();
      expect(e.store.get(broken.id)).toBeDefined();
    });

    it("clears citation quotes 30 days after closing, and only for closed rows", () => {
      const c = {
        source: "mail" as const,
        sourceRef: "m1",
        quote: "I will pay it",
        provenance: "owner" as const,
      };
      const closed = mine({ what: "pay the bill", citation: c });
      const open = mine({
        what: "plan the offsite",
        counterpartId: e.dana,
        citation: { ...c, sourceRef: "m2" },
      });
      e.store.act(closed.id, { action: "done" });
      e.clock.advance(29 * DAY);
      expect(e.store.retain().quotesCleared).toBe(0);
      e.clock.advance(2 * DAY);
      expect(e.store.retain().quotesCleared).toBe(1);
      expect(e.store.citations(closed.id)).toEqual([expect.objectContaining({ quote: "" })]);
      expect(e.store.citations(open.id)[0]?.quote).toBe("I will pay it");
      expect(e.store.retain().quotesCleared).toBe(0);
    });

    it("leaves asks and requests to the older rules", () => {
      e.graph.addLoop({
        direction: "waiting_on",
        text: "answer about the lease",
        status: "suggested",
        provenance: "untrusted",
        detectedBy: "rule",
        counterpartId: e.sam,
      });
      e.clock.advance(400 * DAY);
      expect(e.store.retain()).toMatchObject({ suggestedExpired: 0, closedDeleted: 0 });
      expect(e.graph.loops({ status: ["suggested"] })).toHaveLength(1);
    });

    it("is reached from EverythingStore.runRetention when the policy carries promises", () => {
      const em = new EverythingStore({ sqlite: e.sqlite, graph: e.graph, clock: e.clock });
      const sug = theirs({ what: "bring the keys", counterpartId: e.dana });
      e.clock.advance(31 * DAY);
      const policy = {
        pendingDays: 30,
        untrustedAcceptedMonths: 0,
        quarantineDays: 30,
        runLogDays: 30,
      };
      expect(em.runRetention(policy).promises).toBeUndefined();
      expect(e.store.get(sug.id)).toBeDefined();
      // The undo table is part of the moved set, so retention also runs on the encrypted file.
      e.sqlite
        .prepare("INSERT INTO memory_work_undo (fact_id, entity_id, created_at) VALUES (?, ?, ?)")
        .run("f_old", e.sam, new Date(e.clock.now() - 10 * DAY).toISOString());
      e.sqlite
        .prepare("INSERT INTO memory_work_undo (fact_id, entity_id, created_at) VALUES (?, ?, ?)")
        .run("f_new", e.sam, new Date(e.clock.now() - DAY).toISOString());
      const r = em.runRetention({ ...policy, promises: {} });
      expect(e.sqlite.prepare("SELECT fact_id FROM memory_work_undo").all()).toEqual([
        { fact_id: "f_new" },
      ]);
      expect(r.promises).toMatchObject({ suggestedExpired: 1 });
      expect(e.store.get(sug.id)).toBeUndefined();
    });

    it("delete removes the loop, citations and events, and keeps only a text-free feedback row", () => {
      const p = mine({
        what: "send the zebra-secret-contract",
        citation: {
          source: "mail",
          sourceRef: "m1",
          quote: "I will send the zebra-secret-contract",
          provenance: "owner",
        },
      });
      e.store.act(p.id, { action: "snooze", until: "2026-11-25T09:00:00.000Z" });
      e.store.delete(p.id);
      expect(e.store.get(p.id)).toBeUndefined();
      for (const sql of [
        "SELECT count(*) n FROM graph_loops",
        "SELECT count(*) n FROM graph_loop_events",
        "SELECT count(*) n FROM graph_citations WHERE target_kind = 'loop'",
      ])
        expect(e.sqlite.prepare(sql).get()).toEqual({ n: 0 });
      const fb = e.sqlite
        .prepare(
          "SELECT kind, entity_id, other_id, key_hash FROM graph_feedback WHERE kind = 'not_promise'",
        )
        .all() as Record<string, unknown>[];
      expect(fb).toHaveLength(1);
      expect(fb[0]).toMatchObject({ entity_id: null, other_id: null });
      expect(JSON.stringify(fb)).not.toContain("zebra");
      // Deleted feedback does not count toward any source's threshold.
      expect(e.store.thresholds().mail).toBe(0.8);
    });

    it("delete and retention hold secure_delete on, and give the setting back", () => {
      const before = Number(e.sqlite.pragma("secure_delete", { simple: true }));
      const calls: string[] = [];
      const original = e.sqlite.pragma.bind(e.sqlite);
      const spy = vi.spyOn(e.sqlite, "pragma");
      spy.mockImplementation(((...args: Parameters<typeof original>) => {
        calls.push(String(args[0]));
        return original(...args);
      }) as typeof e.sqlite.pragma);
      const a = mine({ what: "send the contract" });
      e.store.delete(a.id);
      expect(calls).toContain("secure_delete = ON");
      calls.length = 0;
      const sug = theirs({ what: "bring the keys", counterpartId: e.dana });
      e.clock.advance(31 * DAY);
      expect(e.store.retain().suggestedExpired).toBe(1);
      expect(e.store.get(sug.id)).toBeUndefined();
      expect(calls).toContain("secure_delete = ON");
      spy.mockRestore();
      expect(Number(e.sqlite.pragma("secure_delete", { simple: true }))).toBe(before);
    });
  });
});

describe("memory_work_undo in the encrypted store", () => {
  it("is a moved table, and an encrypted file made before it gains it from syncSchema", () => {
    expect(MEMORY_STORE_TABLES).toContain("memory_work_undo");
    const plain = openDb(":memory:");
    const enc = openEncrypted(join(dir, "old.sqlite"), newKey());
    copyTables(
      enc,
      plain.sqlite,
      MEMORY_STORE_TABLES.filter((t) => t !== "memory_work_undo"),
    );
    expect(syncSchema(enc, plain.sqlite, MEMORY_STORE_TABLES)).toContain("memory_work_undo");
    expect(enc.prepare("SELECT count(*) n FROM memory_work_undo").get()).toEqual({ n: 0 });
    enc.close();
    plain.close();
  });
});

describe("secure_delete leaves no trace in a plain database file", () => {
  const SECRET = "quokkaquokkaquokka-contract-9f3";
  const bytes = (d: string) =>
    readdirSync(d)
      .filter((f) => f.startsWith("plain.sqlite"))
      .map((f) => readFileSync(join(d, f)).toString("latin1"))
      .join("");

  it("a hard delete zeroes the freed pages (and a raw delete without it does not)", () => {
    const e = make("plain", true);
    e.sqlite.pragma("secure_delete = OFF");
    // Control: without secure_delete the text survives a plain DELETE.
    const control = created(
      e.store.add({
        direction: "i_owe",
        what: `control ${SECRET}`,
        counterpartId: e.dana,
        provenance: "owner",
        confidence: 0.9,
        detectedBy: "model",
        sourceKind: "mail",
      }),
    );
    e.sqlite.prepare("DELETE FROM graph_loops WHERE id = ?").run(control.id);
    e.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    expect(bytes(dir)).toContain(SECRET);

    const p = created(
      e.store.add({
        direction: "i_owe",
        what: `real ${SECRET.replace("quokka", "wombat")}`,
        counterpartId: e.sam,
        provenance: "owner",
        confidence: 0.9,
        detectedBy: "model",
        sourceKind: "mail",
        citation: {
          source: "mail",
          sourceRef: "m1",
          quote: `I will send ${SECRET.replace("quokka", "wombat")}`,
          provenance: "owner",
        },
      }),
    );
    e.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    expect(bytes(dir)).toContain("wombatquokkaquokka");
    e.store.delete(p.id);
    expect(bytes(dir)).not.toContain("wombatquokkaquokka");
    expect(Number(e.sqlite.pragma("secure_delete", { simple: true }))).toBe(0);
    e.close();
  });
});
