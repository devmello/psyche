import { openDb } from "@psyche/db";
import { FakeClock } from "@psyche/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { GraphStore } from "../src/graph/store.ts";
import {
  applyDoneSignals,
  type CalendarItem,
  type DoneContext,
  type DoneEvidence,
  type DoneLoop,
  doneQuote,
  evaluateDone,
  type ReplyItem,
  type SentItem,
} from "../src/promises/signals.ts";
import { PromiseStore } from "../src/promises/store.ts";

const DAY = 86_400_000;
const MON = Date.parse("2026-11-23T09:00:00.000Z");
const SAM = "ent_sam";
const DANA = "ent_dana";
const THREAD = "thread-1";

const ctx = (o: Partial<DoneContext> = {}): DoneContext => ({
  afterMs: MON,
  askSuppressed: false,
  askOpen: false,
  ...o,
});
const loop = (o: Partial<DoneLoop> = {}): DoneLoop => ({
  direction: "i_owe",
  whatAction: "send",
  text: "send Sam the budget deck",
  counterpartId: SAM,
  threadKey: THREAD,
  ...o,
});
const sent = (o: Partial<SentItem> = {}): SentItem => ({
  at: MON + DAY,
  channel: "mail",
  ref: "mail:1",
  threadKey: THREAD,
  fromOwner: true,
  toEntityIds: [SAM],
  attachments: ["budget-deck.pdf"],
  links: [],
  ...o,
});
const reply = (o: Partial<ReplyItem> = {}): ReplyItem => ({
  at: MON + DAY,
  channel: "mail",
  ref: "mail:2",
  threadKey: THREAD,
  fromOwner: true,
  ...o,
});
const meeting = (o: Partial<CalendarItem> = {}): CalendarItem => ({
  createdAt: MON + DAY,
  ref: "cal:1",
  title: "Sync with Sam",
  createdByOwner: true,
  attendeeEntityIds: [SAM],
  ...o,
});
const ev = (o: Partial<DoneEvidence> = {}): DoneEvidence => ({
  sent: [],
  replies: [],
  events: [],
  ...o,
});

const kind = (v: ReturnType<typeof evaluateDone>) => v.kind;

describe("evaluateDone: each row of 4.2 fires", () => {
  it("mine, send: the owner sent the promisee a matching attachment", () => {
    const v = evaluateDone(loop(), ev({ sent: [sent()] }), ctx());
    expect(v).toMatchObject({ kind: "auto", closedBy: "auto" });
    expect(v.kind === "auto" && v.evidence.label).toBe("budget-deck.pdf");
  });

  it("mine, send: a link counts, and so does the same address in another thread", () => {
    const link = sent({ attachments: [], links: ["Budget deck on Drive"], threadKey: "other" });
    expect(kind(evaluateDone(loop(), ev({ sent: [link] }), ctx()))).toBe("auto");
  });

  it("mine, send: exactly one attachment closes it even with no shared word", () => {
    const one = sent({ attachments: ["IMG_2231.pdf"] });
    expect(kind(evaluateDone(loop(), ev({ sent: [one] }), ctx()))).toBe("auto");
  });

  it("mine, meet: an event the owner created with the promisee invited", () => {
    const l = loop({ whatAction: "meet", text: "set up a call with Sam" });
    const v = evaluateDone(l, ev({ events: [meeting()] }), ctx());
    expect(v).toMatchObject({ kind: "auto", evidence: { channel: "calendar" } });
  });

  it("mine, reply: the owner replied in the thread", () => {
    const l = loop({ whatAction: "reply", text: "reply to Sam about the lease" });
    expect(kind(evaluateDone(l, ev({ replies: [reply()] }), ctx()))).toBe("auto");
  });

  it("theirs, send: the counterpart sent an attachment", () => {
    const l = loop({ direction: "waiting_on", text: "Sam sends the signed contract" });
    const theirs = sent({
      fromOwner: false,
      fromEntityId: SAM,
      toEntityIds: [],
      attachments: ["signed-contract.pdf"],
    });
    expect(kind(evaluateDone(l, ev({ sent: [theirs] }), ctx()))).toBe("auto");
  });

  it("theirs, reply: the counterpart replied in the thread (reply_seen)", () => {
    const l = loop({ direction: "waiting_on", whatAction: "reply", text: "Sam answers" });
    const v = evaluateDone(
      l,
      ev({ replies: [reply({ fromOwner: false, fromEntityId: SAM })] }),
      ctx(),
    );
    expect(v).toMatchObject({ kind: "auto", closedBy: "reply_seen" });
  });

  it("the owner's own words, with the model's done update, close it", () => {
    const v = evaluateDone(
      loop({ whatAction: "reply", threadKey: null }),
      ev({
        modelDone: [
          { at: MON + DAY, ref: "m:3", channel: "messages", author: "owner", hasAttachment: false },
        ],
      }),
      ctx(),
    );
    expect(kind(v)).toBe("auto");
  });
});

describe("evaluateDone: near-misses never close it", () => {
  it("no attachment: asks", () => {
    const v = evaluateDone(loop(), ev({ sent: [sent({ attachments: [], links: [] })] }), ctx());
    expect(v).toMatchObject({ kind: "ask", reason: "no_attachment" });
  });

  it("several attachments, none about it: asks", () => {
    const many = sent({ attachments: ["a.pdf", "b.pdf"] });
    expect(evaluateDone(loop(), ev({ sent: [many] }), ctx())).toMatchObject({
      kind: "ask",
      reason: "unclear_attachment",
    });
  });

  it("a different person: nothing happens", () => {
    const other = sent({ toEntityIds: [DANA], threadKey: "dana-thread" });
    expect(kind(evaluateDone(loop(), ev({ sent: [other] }), ctx()))).toBe("none");
  });

  it("before the promise: nothing happens", () => {
    const old = sent({ at: MON - DAY });
    expect(kind(evaluateDone(loop(), ev({ sent: [old] }), ctx()))).toBe("none");
    // The boundary itself is not after.
    expect(kind(evaluateDone(loop(), ev({ sent: [sent({ at: MON })] }), ctx()))).toBe("none");
  });

  it("a counterpart who only replies to a send promise: asks", () => {
    const l = loop({ direction: "waiting_on", text: "Sam sends the signed contract" });
    const r = reply({ fromOwner: false, fromEntityId: SAM });
    expect(evaluateDone(l, ev({ replies: [r] }), ctx())).toMatchObject({
      kind: "ask",
      reason: "no_attachment",
    });
  });

  it("the counterpart's attachment from a different person does not close theirs", () => {
    const l = loop({ direction: "waiting_on", text: "Sam sends the signed contract" });
    const dana = sent({
      fromOwner: false,
      fromEntityId: DANA,
      toEntityIds: [],
      attachments: ["signed-contract.pdf"],
    });
    expect(kind(evaluateDone(l, ev({ sent: [dana] }), ctx()))).toBe("none");
  });

  it("a counterpart's 'I've sent it' from the model asks, never closes", () => {
    const l = loop({ direction: "waiting_on", whatAction: "send", text: "Sam sends the contract" });
    const m = {
      at: MON + DAY,
      ref: "m:9",
      channel: "mail" as const,
      author: "counterpart" as const,
      hasAttachment: false,
    };
    expect(evaluateDone(l, ev({ modelDone: [m] }), ctx())).toMatchObject({
      kind: "ask",
      reason: "counterpart_said_done",
    });
  });

  it("an event the owner did not create, or with no creation time, or without the promisee", () => {
    const l = loop({ whatAction: "meet", text: "set up a call with Sam" });
    for (const e of [
      meeting({ createdByOwner: false }),
      meeting({ createdAt: null }),
      meeting({ attendeeEntityIds: [DANA] }),
      meeting({ createdAt: MON - DAY }),
    ])
      expect(kind(evaluateDone(l, ev({ events: [e] }), ctx()))).toBe("none");
  });

  it("an owner reply in another thread does not close a reply promise", () => {
    const l = loop({ whatAction: "reply" });
    expect(kind(evaluateDone(l, ev({ replies: [reply({ threadKey: "x" })] }), ctx()))).toBe("none");
    expect(
      kind(
        evaluateDone(
          loop({ whatAction: "reply", threadKey: null }),
          ev({ replies: [reply({ threadKey: null })] }),
          ctx(),
        ),
      ),
    ).toBe("none");
  });

  it("someone else's message never closes the owner's send promise", () => {
    // Probe 1: Sam replies in the thread with notes.pdf.
    const samReply = sent({
      fromOwner: false,
      fromEntityId: SAM,
      toEntityIds: [],
      attachments: ["notes.pdf"],
    });
    // Probe 2: a stranger mails To: Sam with the owner on Cc. Even a reader that filled in the
    // recipients does not make it the owner's send.
    const stranger = sent({
      fromOwner: false,
      fromEntityId: DANA,
      attachments: ["budget-deck.pdf"],
    });
    // Probe 3: Sam's photo arrives in the Messages chat.
    const photo = sent({
      channel: "messages",
      ref: "messages:1",
      fromOwner: false,
      fromEntityId: SAM,
      toEntityIds: [],
      attachments: ["IMG_0042.heic"],
      attachmentMimes: ["image/heic"],
    });
    for (const m of [samReply, stranger, photo])
      expect(kind(evaluateDone(loop(), ev({ sent: [m] }), ctx()))).toBe("none");
    // Positive control: the same file sent by the owner closes it.
    const own = { ...samReply, fromOwner: true, toEntityIds: [SAM] };
    expect(kind(evaluateDone(loop(), ev({ sent: [own] }), ctx()))).toBe("auto");
  });

  it("waiting_on needs the counterpart as sender and the owner not to be", () => {
    const l = loop({ direction: "waiting_on", text: "Sam sends the signed contract" });
    const fromSam = sent({
      fromOwner: false,
      fromEntityId: SAM,
      toEntityIds: [],
      attachments: ["signed-contract.pdf"],
    });
    expect(kind(evaluateDone(l, ev({ sent: [fromSam] }), ctx()))).toBe("auto");
    // The owner's own send is not Sam delivering, even if a reader tagged Sam as the sender.
    expect(kind(evaluateDone(l, ev({ sent: [{ ...fromSam, fromOwner: true }] }), ctx()))).toBe(
      "none",
    );
    // A stranger's reply in the thread does not close a reply promise; Sam's does.
    const lr = loop({ direction: "waiting_on", whatAction: "reply", text: "Sam answers" });
    const stranger = reply({ fromOwner: false, fromEntityId: DANA });
    expect(kind(evaluateDone(lr, ev({ replies: [stranger] }), ctx()))).toBe("none");
    const sam = reply({ fromOwner: false, fromEntityId: SAM });
    expect(kind(evaluateDone(lr, ev({ replies: [sam] }), ctx()))).toBe("auto");
  });

  it("a lone picture is a signature, not the deck: it asks", () => {
    const png = { attachments: ["image001.png"], attachmentMimes: ["image/png"] };
    expect(evaluateDone(loop(), ev({ sent: [sent(png)] }), ctx())).toMatchObject({
      kind: "ask",
      reason: "unclear_attachment",
    });
    // Waiting on Sam's contract and only his signature image arrives.
    const l = loop({ direction: "waiting_on", text: "Sam sends the signed contract" });
    const theirs = sent({ fromOwner: false, fromEntityId: SAM, toEntityIds: [], ...png });
    expect(kind(evaluateDone(l, ev({ sent: [theirs] }), ctx()))).toBe("ask");
    // Controls: the promise is about a photo, or a document comes with it.
    const photo = loop({ text: "send Sam the photo from Friday" });
    expect(kind(evaluateDone(photo, ev({ sent: [sent(png)] }), ctx()))).toBe("auto");
    const both = sent({
      attachments: ["image001.png", "deck.pdf"],
      attachmentMimes: ["image/png", "application/pdf"],
    });
    expect(kind(evaluateDone(loop(), ev({ sent: [both] }), ctx()))).toBe("auto");
  });

  it("a do promise is never closed by a signal, even the owner's own words", () => {
    const l = loop({ whatAction: "do", text: "pay the invoice" });
    const m = {
      at: MON + DAY,
      ref: "m:4",
      channel: "mail" as const,
      author: "owner" as const,
      hasAttachment: true,
    };
    expect(evaluateDone(l, ev({ sent: [sent()], modelDone: [m] }), ctx())).toMatchObject({
      kind: "ask",
      reason: "do_promise",
    });
    expect(kind(evaluateDone(l, ev({ sent: [sent()] }), ctx()))).toBe("none");
  });

  it("a Not yet holds the ask back, and an open question is not asked twice", () => {
    const e = ev({ sent: [sent({ attachments: [] })] });
    expect(kind(evaluateDone(loop(), e, ctx({ askSuppressed: true })))).toBe("none");
    expect(kind(evaluateDone(loop(), e, ctx({ askOpen: true })))).toBe("none");
    // The positive control: the same evidence asks when nothing holds it back.
    expect(kind(evaluateDone(loop(), e, ctx()))).toBe("ask");
  });

  it("auto beats ask when both are present", () => {
    const e = ev({ sent: [sent({ attachments: [] }), sent({ at: MON + 2 * DAY, ref: "mail:5" })] });
    expect(kind(evaluateDone(loop(), e, ctx()))).toBe("auto");
  });
});

describe("applyDoneSignals on the ledger", () => {
  let clock: FakeClock;
  let store: PromiseStore;
  let id: string;
  beforeEach(() => {
    clock = new FakeClock(MON);
    const db = openDb(":memory:");
    const graph = new GraphStore({ sqlite: db.sqlite, clock });
    store = new PromiseStore({ graph, sqlite: db.sqlite, clock, timezone: "UTC" });
    const sam = graph.createEntity({ kind: "person", name: "Sam Lee" }).id;
    const r = store.add({
      direction: "i_owe",
      what: "send Sam the budget deck",
      counterpartId: sam,
      dueAt: "2026-11-27T17:00:00.000Z",
      provenance: "owner",
      confidence: 0.9,
      detectedBy: "model",
      sourceKind: "mail",
      threadKey: THREAD,
      whatAction: "send",
    });
    if (r.kind !== "created") throw new Error("not created");
    id = r.promise.id;
    // The signals compare entity ids, so use the real one.
    SAM_ID = sam;
  });
  let SAM_ID = "";

  const withSam = (m: SentItem): SentItem => ({ ...m, toEntityIds: [SAM_ID] });

  it("closes it with the evidence kept as a citation, and Undo reopens it", () => {
    clock.set(MON + DAY);
    const out = applyDoneSignals(store, id, ev({ sent: [withSam(sent())] }), "Sam");
    expect(out.kind).toBe("done");
    const row = store.get(id);
    expect(row).toMatchObject({ status: "done", closedBy: "auto" });
    const events = store.events(id);
    const done = events.find((e) => e.kind === "auto_done");
    expect(done?.citationId).not.toBeNull();
    expect(store.citations(id).map((c) => c.quote)).toContain("you sent budget-deck.pdf");
    expect(
      doneQuote({ channel: "mail", ref: "r", label: "x.pdf", at: 0, by: "owner" }, "Sam"),
    ).toBe("you sent x.pdf");

    clock.advance(2 * DAY);
    store.act(id, { action: "reopen" });
    expect(store.get(id)?.status).toBe("open");
    expect(store.events(id).some((e) => e.kind === "undo")).toBe(true);

    // The same send does not close it again; a newer one does.
    expect(applyDoneSignals(store, id, ev({ sent: [withSam(sent())] }), "Sam").kind).toBe("none");
    expect(store.get(id)?.status).toBe("open");
    const again = withSam(sent({ at: clock.now() + 1000, ref: "mail:9" }));
    clock.advance(5000);
    expect(applyDoneSignals(store, id, ev({ sent: [again] }), "Sam").kind).toBe("done");
  });

  it("refuses an undo after 7 days", () => {
    clock.set(MON + DAY);
    applyDoneSignals(store, id, ev({ sent: [withSam(sent())] }), "Sam");
    clock.advance(8 * DAY);
    expect(() => store.act(id, { action: "reopen" })).toThrow(/7 days/);
  });

  it("asks once, then stays quiet until the owner answers", () => {
    clock.set(MON + DAY);
    const plain = ev({ sent: [withSam(sent({ attachments: [] }))] });
    expect(applyDoneSignals(store, id, plain, "Sam").kind).toBe("ask");
    expect(applyDoneSignals(store, id, plain, "Sam").kind).toBe("none");
    expect(store.events(id).filter((e) => e.kind === "asked")).toHaveLength(1);
    expect(store.get(id)?.status).toBe("open");

    store.act(id, { action: "answer", answer: "not_yet" });
    // Held back for 3 days, then it may ask again.
    expect(applyDoneSignals(store, id, plain, "Sam").kind).toBe("none");
    clock.advance(4 * DAY);
    expect(applyDoneSignals(store, id, plain, "Sam").kind).toBe("ask");
  });

  it("a reply_seen done is undoable for 7 days, like the other automatic dones", () => {
    const r = store.add({
      direction: "waiting_on",
      what: "Sam answers about the lease",
      counterpartId: SAM_ID,
      provenance: "untrusted",
      confidence: 0.8,
      detectedBy: "model",
      sourceKind: "mail",
      threadKey: THREAD,
      whatAction: "reply",
    });
    if (r.kind !== "created") throw new Error("not created");
    const rid = r.promise.id;
    store.act(rid, { action: "confirm" });
    clock.set(MON + DAY);
    const theirReply: ReplyItem = reply({ fromOwner: false, fromEntityId: SAM_ID });
    expect(applyDoneSignals(store, rid, ev({ replies: [theirReply] }), "Sam")).toMatchObject({
      kind: "done",
      closedBy: "reply_seen",
    });
    expect(store.get(rid)).toMatchObject({ status: "done", closedBy: "reply_seen" });
    clock.advance(2 * DAY);
    store.act(rid, { action: "reopen" });
    expect(store.events(rid).some((e) => e.kind === "undo")).toBe(true);
    // The same reply does not close it again.
    expect(applyDoneSignals(store, rid, ev({ replies: [theirReply] }), "Sam").kind).toBe("none");
    // And after 7 days the undo window is gone.
    clock.advance(DAY);
    const later = reply({ at: clock.now() + 1, fromOwner: false, fromEntityId: SAM_ID });
    clock.advance(10);
    expect(applyDoneSignals(store, rid, ev({ replies: [later] }), "Sam").kind).toBe("done");
    clock.advance(8 * DAY);
    expect(() => store.act(rid, { action: "reopen" })).toThrow(/7 days/);
  });

  it("a refused action leaves no citation behind", () => {
    store.act(id, { action: "done" });
    const before = store.citations(id).length;
    const evidence = {
      channel: "mail" as const,
      ref: "r",
      quote: "q",
      provenance: "owner" as const,
    };
    expect(() =>
      store.act(
        id,
        { action: "done" },
        { citation: { source: evidence.channel, sourceRef: "r", quote: "q", provenance: "owner" } },
      ),
    ).toThrow();
    expect(store.citations(id)).toHaveLength(before);
  });

  it("skips a promise that is already closed", () => {
    store.act(id, { action: "done" });
    clock.set(MON + DAY);
    expect(applyDoneSignals(store, id, ev({ sent: [withSam(sent())] }), "Sam").kind).toBe("none");
  });
});
