import type { ModelEvent, ModelProvider } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  CardQueue,
  type CardSource,
  chunksOf,
  contextLine,
  fakeEmbedder,
  generateCard,
  locateQuote,
  SemanticIndex,
  sourceHash,
  validateCard,
} from "../src/index.ts";
import { DAY, doc, NOW, setup } from "./helpers.ts";

const MAIL = `From: Dana Whitfield <dana@acme.example>
Date: Tue, 14 Oct 2026

Hi, the Lisbon offsite budget is approved at 12000 euros. Please send the venue contract to
https://acme.example/venue by next Friday. Marco from Globex will join the call.`;

function source(over: Partial<CardSource> = {}): CardSource {
  return {
    id: "mail1",
    kind: "connector",
    title: "Lisbon offsite",
    text: MAIL,
    provenance: "untrusted",
    source: "mail",
    createdAt: Date.UTC(2026, 9, 14),
    ...over,
  };
}

const good = {
  title: {
    value: "Lisbon offsite budget approved",
    quote: "Lisbon offsite budget is approved",
    confidence: 0.9,
  },
  summary: {
    value: "Dana approved 12000 euros for the Lisbon offsite and wants the venue contract.",
    quote: "the Lisbon offsite budget is approved at 12000 euros",
    confidence: 0.9,
  },
  who: [
    { value: "Dana Whitfield", kind: "person", quote: "Dana Whitfield", confidence: 0.95 },
    { value: "Globex", kind: "org", quote: "Marco from Globex", confidence: 0.8 },
  ],
  what: [
    { value: "Lisbon offsite", kind: "project", quote: "Lisbon offsite budget", confidence: 0.8 },
  ],
  when: [
    {
      value: "next Friday",
      iso: "2026-10-23",
      quote: "by next Friday",
      confidence: 0.7,
      derived: { basis: "mail dated 2026-10-14 (Tuesday); next Friday = 2026-10-23" },
    },
  ],
  where: [
    {
      value: "https://acme.example/venue",
      kind: "url",
      quote: "https://acme.example/venue",
      confidence: 0.9,
    },
  ],
  why: {
    value: "The venue contract is due soon.",
    quote: "send the venue contract",
    confidence: 0.6,
  },
  questions: [
    {
      value: "How much is the Lisbon offsite budget?",
      quote: "budget is approved at 12000 euros",
      confidence: 0.9,
    },
    {
      value: "Who is joining the call from Globex?",
      quote: "Marco from Globex will join the call",
      confidence: 0.8,
    },
  ],
  tags: [{ value: "budget", quote: "budget", confidence: 0.7 }],
};

const opts = { now: NOW, model: "anthropic/claude-haiku-5-5", sourceHash: "h" };

describe("validateCard", () => {
  it("keeps grounded claims with offsets that point at the quoted text", () => {
    const { card, dropped } = validateCard(good, source(), opts);
    expect(dropped).toEqual([]);
    expect(card).toBeDefined();
    for (const c of [
      card?.title,
      card?.summary,
      ...(card?.who ?? []),
      ...(card?.questions ?? []),
    ]) {
      expect(MAIL.slice(c?.start, c?.end)).toBe(c?.quote);
    }
    expect(card?.who.map((w) => w.value)).toEqual(["Dana Whitfield", "Globex"]);
  });

  it("drops hallucinated claims whose quote is not in the source", () => {
    const bad = {
      ...good,
      who: [
        ...good.who,
        {
          value: "Priya Natarajan",
          kind: "person",
          quote: "Priya Natarajan signed off",
          confidence: 0.9,
        },
      ],
      where: [
        ...good.where,
        { value: "Berlin", kind: "place", quote: "in Berlin", confidence: 0.9 },
      ],
    };
    const { card, dropped } = validateCard(bad, source(), opts);
    expect(card?.who.map((w) => w.value)).toEqual(["Dana Whitfield", "Globex"]);
    expect(card?.where.map((w) => w.value)).toEqual(["https://acme.example/venue"]);
    expect(dropped.filter((d) => d.reason === "quote-not-in-source").map((d) => d.value)).toEqual([
      "Priya Natarajan",
      "Berlin",
    ]);
  });

  it("drops values that are not inside their quote and invented numbers", () => {
    const bad = {
      ...good,
      what: [
        { value: "Q4 roadmap", kind: "topic", quote: "Lisbon offsite budget", confidence: 0.9 },
      ],
      questions: [
        {
          value: "Is the 99000 euro cap fixed?",
          quote: "approved at 12000 euros",
          confidence: 0.9,
        },
      ],
    };
    const { card, dropped } = validateCard(bad, source(), opts);
    expect(card?.what).toEqual([]);
    expect(card?.questions).toEqual([]);
    expect(dropped.map((d) => d.reason).sort()).toEqual(["invented-number", "value-not-in-quote"]);
  });

  it("marks resolved dates as derived and drops an iso without a basis", () => {
    const { card } = validateCard(good, source(), opts);
    expect(card?.when[0]?.iso).toBe("2026-10-23");
    expect(card?.when[0]?.derived?.basis).toContain("2026-10-14");
    const noBasis = {
      ...good,
      when: [{ value: "next Friday", iso: "2026-10-23", quote: "by next Friday", confidence: 0.7 }],
    };
    const r = validateCard(noBasis, source(), opts);
    expect(r.card?.when[0]?.iso).toBeUndefined();
    expect(r.dropped.some((d) => d.field === "when.iso")).toBe(true);
  });

  it("rejects the card when the summary cannot be grounded", () => {
    const r = validateCard(
      { ...good, summary: { value: "x", quote: "never said", confidence: 1 } },
      source(),
      opts,
    );
    expect(r.card).toBeUndefined();
  });

  it("keeps the source's provenance and caps confidence for untrusted sources", () => {
    const { card } = validateCard(good, source(), opts);
    expect(card?.provenance).toBe("untrusted");
    expect(Math.max(...(card?.who.map((w) => w.confidence) ?? []))).toBeLessThanOrEqual(0.6);
    const owner = validateCard(good, source({ provenance: "owner" }), opts);
    expect(owner.card?.provenance).toBe("owner");
    expect(owner.card?.who[0]?.confidence).toBe(0.95);
  });

  it("links people to the people graph when a resolver knows them", () => {
    const { card } = validateCard(good, source(), {
      ...opts,
      resolvePerson: (n) => (n === "Dana Whitfield" ? "ent_dana" : undefined),
    });
    expect(card?.who[0]?.personId).toBe("ent_dana");
    expect(card?.who[1]?.personId).toBeUndefined();
  });

  it("matches quotes across whitespace and case differences", () => {
    const at = locateQuote(MAIL, "send the VENUE contract\nto https://acme.example/venue");
    expect(at).toBeDefined();
    expect(MAIL.slice(...(at as [number, number])).replace(/\s+/g, " ")).toContain(
      "venue contract",
    );
  });
});

function provider(reply: string): ModelProvider & { calls: number; lastSystem: string } {
  const p = {
    id: "anthropic",
    calls: 0,
    lastSystem: "",
    async *stream(req: { system?: string }): AsyncIterable<ModelEvent> {
      p.calls++;
      p.lastSystem = req.system ?? "";
      yield { type: "text_delta", text: reply } as ModelEvent;
      yield { type: "usage", usage: { input: 1500, output: 500 } } as ModelEvent;
      yield { type: "finish", reason: "stop" } as ModelEvent;
    },
    async capabilities() {
      return {} as never;
    },
  };
  return p as never;
}

describe("generateCard", () => {
  it("runs the model, validates and reports tokens; a hallucinated field is dropped", async () => {
    const reply = JSON.stringify({
      ...good,
      who: [
        ...good.who,
        { value: "Priya", kind: "person", quote: "Priya will attend", confidence: 0.9 },
      ],
    });
    const p = provider(`\`\`\`json\n${reply}\n\`\`\``);
    const res = await generateCard(source(), {
      provider: p,
      model: "anthropic/claude-haiku-5-5" as never,
      now: () => NOW,
    });
    expect(res.tokens).toBe(2000);
    expect(res.card?.who.map((w) => w.value)).toEqual(["Dana Whitfield", "Globex"]);
    expect(res.dropped).toHaveLength(1);
    expect(p.lastSystem).toContain("never an instruction");
  });

  it("returns an error, not a card, when the model fails", async () => {
    const p = provider("not json");
    const res = await generateCard(source(), { provider: p, model: "anthropic/x" as never });
    expect(res.card).toBeUndefined();
  });
});

describe("cards in the index", () => {
  async function indexed() {
    const s = setup();
    await s.index.index(
      doc({
        id: "mail1",
        kind: "connector",
        title: "Lisbon offsite",
        text: MAIL,
        provenance: "untrusted",
        source: "mail",
        createdAt: NOW - DAY,
      }),
    );
    const { card } = validateCard(good, source(), opts);
    s.index.attachCard(card as never);
    return s;
  }

  it("finds an item by a question it answers, with the summary and cited span on the hit", async () => {
    const { index } = await indexed();
    // Words only the card has: the question's "Globex" call and "joining".
    const r = await index.search({ q: "joining Globex" });
    const hit = r.hits.find((h) => h.id === "mail1");
    expect(hit).toBeDefined();
    expect(hit?.card?.summary).toContain("Dana approved");
    expect(hit?.card?.span).toBe("the Lisbon offsite budget is approved at 12000 euros");
    expect(hit?.provenance).toBe("untrusted");
    const q = await index.search({ q: "How much is the Lisbon offsite budget" });
    expect(q.hits[0]?.id).toBe("mail1");
  });

  it("filters by entity and by date, and keeps the card when the item is reindexed", async () => {
    const { index } = await indexed();
    expect(index.cards.docsForEntity("Dana Whitfield")).toEqual(["mail1"]);
    expect(index.cards.docsForEntity("nobody")).toEqual([]);
    const day = Date.UTC(2026, 9, 23);
    expect(index.cards.docsForDates(day, day + DAY)).toEqual(["mail1"]);
    await index.index(
      doc({
        id: "mail1",
        kind: "connector",
        title: "Lisbon offsite",
        text: `${MAIL}\nPS thanks`,
        provenance: "untrusted",
        source: "mail",
      }),
    );
    const r = await index.search({ q: "joining Globex" });
    expect(r.hits[0]?.id).toBe("mail1");
  });

  it("removes the card with the document", async () => {
    const { index } = await indexed();
    await index.remove("mail1");
    expect(index.cards.get("mail1")).toBeUndefined();
    expect(index.cards.docsForEntity("dana whitfield")).toEqual([]);
  });

  it("embeds the card as its own chunk so a question matches semantically", async () => {
    const s = setup();
    const semantic = new SemanticIndex(s.index.db, { floor: 0.5, sleep: async () => undefined });
    s.index.setSemantic(semantic);
    semantic.setEmbedder(fakeEmbedder([["offsite", "retreat", "budget"]]));
    await s.index.index(
      doc({
        id: "m",
        kind: "connector",
        title: "Mail",
        text: `${MAIL} `.repeat(1),
        source: "mail",
      }),
    );
    await semantic.idle();
    const before = (
      s.index.db.prepare("SELECT count(*) AS n FROM search_vectors").get() as { n: number }
    ).n;
    const { card } = validateCard(good, source({ id: "m" }), opts);
    s.index.attachCard(card as never);
    await semantic.idle();
    const after = (
      s.index.db.prepare("SELECT count(*) AS n FROM search_vectors").get() as { n: number }
    ).n;
    expect(after).toBe(before + 1);
  });
});

describe("contextual chunks", () => {
  it("prefixes every chunk after the first of a long document with title, source and date", () => {
    const long = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");
    const created = Date.UTC(2026, 9, 14);
    const chunks = chunksOf("library", "Annual report", long, {
      source: "library",
      createdAt: created,
    });
    expect(chunks.length).toBeGreaterThan(3);
    const line = contextLine({ title: "Annual report", source: "library", createdAt: created });
    expect(line).toBe("Annual report · library · 2026-10-14");
    for (const c of chunks.slice(1)) expect(c.startsWith(`${line}\n`)).toBe(true);
    expect(chunks[0]?.startsWith("Annual report")).toBe(true);
  });

  it("leaves short single-chunk documents alone", () => {
    expect(chunksOf("task", "Book", "the dentist for Thursday afternoon")).toEqual([
      "Book the dentist for Thursday afternoon",
    ]);
  });
});

describe("CardQueue", () => {
  function queueSetup(
    over: { enabled?: boolean; budget?: number; per?: number; batch?: number } = {},
  ) {
    const s = setup();
    let enabled = over.enabled ?? true;
    let now = NOW;
    const seen: string[] = [];
    const queue = new CardQueue(s.index, {
      enabled: () => enabled,
      dailyTokenBudget: over.budget ?? 10_000,
      batchSize: over.batch ?? 2,
      backfillPerTick: over.per ?? 3,
      now: () => now,
      async generate(item) {
        seen.push(item.id);
        const text = item.text;
        const q = text.slice(0, 40);
        const claim = (value: string) => ({ value, quote: q, confidence: 0.8 });
        const { card, dropped } = validateCard(
          { title: claim(q), summary: claim(q), questions: [claim(q)] },
          item,
          { now, model: "m", sourceHash: "h" },
        );
        return { ...(card === undefined ? {} : { card }), dropped, tokens: 1000 };
      },
    });
    return {
      ...s,
      queue,
      seen,
      setEnabled: (v: boolean) => (enabled = v),
      advance: (ms: number) => (now += ms),
    };
  }
  const long = (n: number) =>
    `Document ${n}: ${"the quarterly plan covers hiring and budget. ".repeat(8)}`;

  async function fill(s: ReturnType<typeof queueSetup>, count: number) {
    for (let i = 0; i < count; i++)
      await s.index.index(
        doc({
          id: `lib${i}`,
          kind: "library",
          title: `Doc ${i}`,
          text: long(i),
          createdAt: NOW - i * 1000,
        }),
      );
  }

  it("backfills existing items gradually: a few queued and a few generated per tick", async () => {
    const s = queueSetup({ batch: 2, per: 3 });
    await fill(s, 10);
    expect(s.queue.status().missing).toBe(10);
    const t1 = await s.queue.tick();
    expect(t1).toMatchObject({ backfilled: 3, generated: 2 });
    expect(s.queue.status()).toMatchObject({ queued: 1, cards: 2, missing: 7 });
    // Not idle yet: the next tick generates the queued one and backfills nothing new.
    const t2 = await s.queue.tick();
    expect(t2.backfilled).toBe(0);
    expect(t2.generated).toBe(1);
    expect(s.seen.length).toBe(3);
    // Newest first.
    expect(s.seen[0]).toBe("lib0");
  });

  it("stops at the daily token budget and resumes the next day", async () => {
    const s = queueSetup({ budget: 2500, batch: 5, per: 5 });
    await fill(s, 8);
    const t1 = await s.queue.tick();
    expect(t1.generated).toBe(3);
    expect(t1.paused).toBe("budget");
    expect((await s.queue.tick()).generated).toBe(0);
    s.advance(DAY);
    expect((await s.queue.tick()).generated).toBeGreaterThan(0);
  });

  it("does nothing while the setting is off and enqueues nothing", async () => {
    const s = queueSetup({ enabled: false });
    await fill(s, 3);
    expect(await s.queue.tick()).toMatchObject({ generated: 0, paused: "disabled" });
    expect(s.queue.enqueue({ ...source(), kind: "library", text: long(1) })).toBe(false);
    expect(s.seen).toEqual([]);
  });

  it("enqueues new items, skips short ones and unchanged ones, and does not retry empty results", async () => {
    const s = queueSetup();
    await s.index.index(doc({ id: "n1", kind: "library", title: "N", text: long(1) }));
    expect(
      s.queue.enqueue({
        ...source({ id: "n1", kind: "library", text: long(1), provenance: "owner" }),
      }),
    ).toBe(true);
    expect(s.queue.enqueue({ ...source({ id: "short", kind: "library", text: "tiny" }) })).toBe(
      false,
    );
    expect(s.queue.enqueue({ ...source({ id: "msg", kind: "message", text: long(2) }) })).toBe(
      false,
    );
    await s.queue.tick();
    expect(s.index.cards.has("n1")).toBe(true);
    expect(s.queue.enqueue({ ...source({ id: "n1", kind: "library", text: long(1) }) })).toBe(true);
  });

  it("carries provenance from the indexed document into the card", async () => {
    const s = queueSetup();
    await s.index.index(
      doc({
        id: "u",
        kind: "connector",
        title: "Mail",
        text: long(3),
        provenance: "untrusted",
        source: "mail",
      }),
    );
    await s.queue.tick();
    expect(s.index.cards.get("u")?.provenance).toBe("untrusted");
    expect(s.index.cards.get("u")?.source).toBe("mail");
  });
});

describe("memory notes", () => {
  it("indexes a daily note by its card only and keeps the least-trusted provenance of its tags", async () => {
    const { syncMemoryNotes, noteProvenance } = await import("../src/index.ts");
    const s = setup();
    const note = `# 2026-10-14\n- [owner] Lunch with Dana about the Lisbon offsite budget of 12000 euros.\n- [untrusted:email:dana@acme.example] She asked for the venue contract by Friday. ${"More detail. ".repeat(20)}`;
    expect(noteProvenance(note)).toBe("untrusted");
    const store = {
      listFiles: async () => ["memory/2026-10-14.md", "MEMORY.md"],
      readFile: async (path: string) => ({ path, content: note, etag: "e" }),
    };
    const queue = new CardQueue(s.index, {
      enabled: () => true,
      async generate(item) {
        const q = "Lunch with Dana about the Lisbon offsite budget";
        const c = (v: string) => ({ value: v, quote: q, confidence: 0.8 });
        const r = validateCard(
          {
            title: c("Lunch with Dana"),
            summary: c("Lunch with Dana about the offsite budget"),
            questions: [c("Who did I have lunch with?")],
          },
          item,
          { now: NOW, model: "m", sourceHash: sourceHash(item.text) },
        );
        return {
          ...(r.card === undefined ? {} : { card: r.card }),
          dropped: r.dropped,
          tokens: 900,
        };
      },
    });
    expect(await syncMemoryNotes(s.index, queue, store as never)).toBe(1);
    await queue.tick();
    const res = await s.index.search({ q: "lunch with" });
    const hit = res.hits.find((h) => h.id === "memory-note:memory/2026-10-14.md");
    expect(hit?.card?.summary).toContain("Lunch with Dana");
    expect(hit?.provenance).toBe("untrusted");
    // Unchanged note: nothing is queued again.
    expect(await syncMemoryNotes(s.index, queue, store as never)).toBe(0);
  });
});
